// "Upload to crazydramas" (phase 5; Ruobin's decisions in the publish spec,
// crazydramas docs/STUDIO_API.md the contract, plan A6 the design): Studio
// creates a DRAFT series on crazydramas.com, uploads its episodes to Mux in
// the background, and publishes exactly the episodes a person lists. Six
// entry points, one per route under /api/titles/[id]/crazydramas/:
//
//   getPublishState     GET  …/publish          where the series and every episode stand
//   saveSeries          PUT  …/series           create the draft, or update Studio's own
//   queueUploads        POST …/uploads          plan episodes for the background uploader
//   cancelUploads       POST …/uploads/cancel   a person's Stop
//   publishEpisodes     POST …/publish          exactly the listed, verified episodes
//   unpublishEpisodes   POST …/unpublish
//
// and the uploader itself: advanceCdPublication (one ledger row, one pass of
// the state machine), runTitleUploads (one title, one upload at a time),
// scheduleCrazydramasUploads (fire-and-forget, as lib/clips/run.ts) and
// resumeCrazydramasUploads (the scheduler's tick: rows no worker runs).
//
// What it never does (spec §2, §5, §6, §11): publish on upload (a replace of
// an episode that is ALREADY published goes live when its asset is ready —
// the contract keeps is_published — and the ledger says so); write to a
// series made in the CMS (refused before any call; a series taken back into
// the CMS gets no further write, from the fresh read before each one); write
// to, or show, a series another title's link holds, or an orphan holding
// anyone else's episodes (foreign: `conflict`); upload, publish or unpublish
// on a series the title's own link does not hold (`series_unlinked`: only the
// series write claims one); mix two series in one title's ledger, or move a
// title off a show already on crazydramas (`repointed`); write anything
// from fixture mode but the fake, or from Supabase mode without
// CRAZYDRAMAS_LIVE_WRITES=enabled; create a series whose title is already on
// the site (the working-name table and the public catalog are checked first;
// crazydramas' own series_title_exists is the backstop); create a second Mux
// upload for a file whose upload is still alive (the ledger's upload id is
// asked for first; a repeat of the upload call with the same sha answers the
// same upload); send bytes from anywhere but the local-tier hardlink
// (`localPathOf`); send the last chunk after a CMS upload took the episode
// over; publish an episode whose asset failed verification; delete anything.
// No upload URL and no playback id ever reaches a row, a log or a response.

import { open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { isSystemSession, systemSession, type Session } from "@/lib/auth";
import { getData, isDataError } from "@/lib/data";
import { forbidden, invalid } from "@/lib/data/errors";
import { isLocalTierPath, localPathOf } from "@/lib/data/storage";
import type { CdPublication, Episode, PlatformLink, Title } from "@/lib/types";
import { cdLeaseHeldByOther, cdLeaseLive, isActiveStep } from "./ledger";
import { FRAME_RULE, MUX_FRAME_OFFSET, frameDelta, inferFps, matchEpisodes, verdictForDelta, type LedgerRow } from "./match";
import { crazydramasTransport } from "./pick";
import {
  SeriesBodySchema,
  UploadsBodySchema,
  CancelBodySchema,
  PublishBodySchema,
  UnpublishBodySchema,
  needsReplace,
  suggestIapProductId,
  suggestPosterUrl,
  type CdSeries,
  type CdSeriesState,
  type FormDefaults,
  type PublishEpisode,
  type PublishState,
} from "./publish-types";
import { studioClient, cdWriteGate, crazydramasStudioMode, isTransient, type GetSeriesAnswer, type StudioClient, type StudioFail, type StudioEpisode, type UploadStatusAnswer } from "./studio-client";
import { checkCrazydramasTitle, loadCrazydramasStatus, resolveReadSlug } from "./sweep";
import { crazydramasBaseUrl } from "./transport";
import { PLATFORM } from "./types";

// ---- constants ----------------------------------------------------------------------------------------------

/** The resumable-upload quantum (Mux / GCS): every chunk but the last is a multiple of 256 KiB. */
export const MUX_CHUNK_QUANTUM = 256 * 1024;
/** Studio's chunk: 64 × 256 KiB = 16 MiB (the CMS's uploader uses 30 MiB; a smaller chunk loses less on a failed PUT). */
export const CD_CHUNK_BYTES = 64 * MUX_CHUNK_QUANTUM;
/** Uploads sending bytes at once on this machine (spec §8). */
export const CD_MAX_CONCURRENT = 2;
/** STUDIO_API.md step 4: poll the upload every 5–10 s. */
export const CD_POLL_MS = 7_000;
/** STUDIO_API.md step 4: `webhook_pending` for a minute, then sync. */
export const CD_SYNC_AFTER_MS = 60_000;
/** A transient refusal waits at most this long before the next try, and fails the row after this many in a row. */
export const CD_MAX_BACKOFF_MS = 10 * 60_000;
export const CD_MAX_ATTEMPTS = 8;
/** STUDIO_API.md: episode_busy clears after two minutes. */
const EPISODE_BUSY_WAIT_MS = 2 * 60_000 + 5_000;
/** How long the live series read is reused by the screens' poll (the uploader never uses it). */
const SERIES_CACHE_MS = 20_000;

/**
 * The shows that were live before Studio could write (STUDIO_API.md, "Which
 * series Studio may change", 2026-09-23): the working name (the pipeline's
 * folder name) and the live slug. Checked before Studio creates a series,
 * together with the public catalog; crazydramas' `series_title_exists` only
 * catches identical titles and a working name is rarely the live title.
 */
export const KNOWN_LIVE_SERIES: readonly { working: string; slug: string }[] = [
  { working: "Forced to Marry the Mafia Boss", slug: "forced-to-marry-the-mafia-boss" },
  { working: "he mocked her crush on him and sent her", slug: "he-mocked-her-crush-on-him-and-sent-her" },
  { working: "he treated our love like a prank", slug: "he-treated-our-love-like-a-prank" },
  { working: "My New billionare husband", slug: "my-new-billionaire-husband" },
  { working: "One night with the billionare who hated women", slug: "one-night-with-the-billionaire-who-hated-women" },
  { working: "Ever Since I Played That Game Paranormal", slug: "ever-since-i-played-that-game-paranormal" },
  { working: "she returned with her son", slug: "i-came-back-with-his-abandoned-son-to-ruin-his-wedding" },
  { working: "the cold ceo", slug: "hired-as-his-secretary-claimed-as-his-wife" },
];

/** The sentence spec §3 asks for, beside the extra confirm. */
export const PAID_WARNING = "Paid episodes can be streamed free until the paywall fix is live on crazydramas.";

/** CRAZYDRAMAS_PAYWALL_LIVE=1: paid episodes publish without the extra confirm (spec §3). */
export function paywallLive(): boolean {
  return process.env.CRAZYDRAMAS_PAYWALL_LIVE === "1";
}

// ---- refusals -----------------------------------------------------------------------------------------------

/** A refusal the routes answer as `{error, code, ...details}` with `status`: crazydramas' codes pass through with their words, Studio adds its own. */
export class CdPublishError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CdPublishError";
  }
  body(): Record<string, unknown> {
    return { ...this.details, error: this.message, code: this.code };
  }
}

export function isCdPublishError(e: unknown): e is CdPublishError {
  return e instanceof CdPublishError || (typeof e === "object" && e !== null && (e as { name?: string }).name === "CdPublishError");
}

/** A crazydramas refusal, passed through: its status, code, words and details (never a URL: the contract puts none in an error). */
function passThrough(fail: StudioFail): CdPublishError {
  const { error: _e, code: _c, ...details } = fail.body;
  return new CdPublishError(fail.status || 502, fail.code, fail.error, details);
}

// ---- who may act ----------------------------------------------------------------------------------------------

/** The approver of the title's company or a staff administrator (the system too); a foreign title is not found first. */
function canPublish(session: Session): boolean {
  if (isSystemSession(session)) return true;
  if (session.kind === "staff") return session.staffRole === "admin";
  return session.producerRole === "approver";
}

async function requirePublisher(session: Session, titleId: string): Promise<Title> {
  const detail = await getData().getTitle(session, titleId); // not_found for a foreign title, before anything else
  if (!canPublish(session)) throw forbidden(session.kind === "staff" ? "Staff administrators only" : "Requires the approver role");
  return detail.title;
}

function requireWrites(): void {
  const gate = cdWriteGate();
  if (!gate.enabled) throw new CdPublishError(409, "writes_disabled", gate.reason ?? "Writes to crazydramas are disabled.", { reason: gate.reason });
}

// ---- small helpers --------------------------------------------------------------------------------------------

/** crazydramas titleKey: case, spacing and punctuation ignored. */
export function titleKey(title: string | null | undefined): string {
  return (title ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * The slug and link the publish flow works under. `repointed`: the title
 * left its own empty Studio draft for the slug it names now, and works there
 * with no link. `held`: the title names another slug than its link's, but the
 * link holds a show already on crazydramas, so the title stays on the link
 * and every write is refused.
 */
type PublishTarget = { slug: string | null; link: PlatformLink | null; repointed: boolean; held: HeldLink | null };
type HeldLink = { slug: string; title: string | null; why: string; names: string };

/**
 * Does a series hold media this title's uploads did not put there? Every
 * episode it has must carry an upload id of this title's ledger (a current or
 * a replaced one); an episode with no upload id (a CMS upload starting, an
 * episode the CMS made) or another upload is someone else's.
 */
function foreignMedia(episodes: readonly StudioEpisode[], rows: readonly CdPublication[]): boolean {
  const ours = new Set(rows.flatMap((r) => [r.upload_id, r.previous_upload_id]).filter((id): id is string => !!id));
  return episodes.some((e) => !e.mux_upload_id || !ours.has(e.mux_upload_id));
}

/**
 * Read as the phase 3a section reads it (resolveReadSlug without a
 * catalog): the link's slug once a link exists. A title re-pointed in Studio
 * (film-meta's slug edited while a link exists: `title_edited`) follows its
 * own slug, with no link, only away from a series that is not a show on
 * crazydramas yet: a Studio draft holding nothing but this title's own
 * uploads (the typo fix; its series write then moves the link, and a title
 * whose uploads went there still writes nothing, `repointed`). A link to a
 * series made in the CMS, a published one or one holding anyone else's
 * episodes is `held`: the title stays on it — both sections never disagree
 * into a second series of a show that is already on the site — and every
 * write is refused. The abandoned series is read (a GET) unless the link
 * already says it is the CMS's; a read that fails holds the title (the
 * screens' poll) or passes the failure through (a write, `onFail: "throw"`).
 */
async function publishTarget(client: StudioClient | null, title: Title, linked: PlatformLink | null, rows: readonly CdPublication[], opts: { fresh?: boolean; onFail: "hold" | "throw" }): Promise<PublishTarget> {
  const read = resolveReadSlug(title, linked, null);
  if (!read) return { slug: null, link: null, repointed: false, held: null };
  if (read.reason !== "title_edited" || !linked) return { slug: read.slug, link: linked, repointed: false, held: null };
  const stay = (why: string, name: string | null): PublishTarget => ({ slug: linked.slug, link: linked, repointed: false, held: { slug: linked.slug, title: name, why, names: read.slug } });
  const follow: PublishTarget = { slug: read.slug, link: null, repointed: true, held: null };
  if (linked.managed_by === "cms") return stay("a series made in the crazydramas CMS", null);
  if (!client) return stay("a series Studio could not read now", null);
  const old = await readSeries(client, linked.cd_drama_id, { fresh: opts.fresh });
  if (!old.found) {
    if (!old.fail) return follow; // the linked series is gone: nothing on the site to make a second one of
    if (opts.onFail === "throw") throw passThrough(old.fail);
    return stay("a series Studio could not read now", null);
  }
  const s = old.answer.series;
  if (s.managed_by !== "studio") return stay("a series made in the crazydramas CMS", s.title);
  if (s.status !== "draft") return stay(s.status === "published" ? "a published series" : `a series whose status is ${s.status}`, s.title);
  if (foreignMedia(old.answer.episodes, rows)) return stay("a series holding episodes this title did not upload", s.title);
  return follow;
}

/** A write for a `held` title: refused before any write is sent, naming the series the title is on. */
function heldRefusal(held: HeldLink): CdPublishError {
  return new CdPublishError(
    409,
    "repointed",
    `This title's slug in film-meta.json now names "${held.names}", but the title is on crazydramas as "${held.slug}" (${held.why}); Studio does not make a second series of a show that is already on crazydramas, nor move the title off it. Set the slug back in the film's film-meta.json, or ask the operator. Nothing was sent.`,
    { existing: { slug: held.slug, title: held.title } },
  );
}

/**
 * The ledger is one series per title (its key is title × episode × file):
 * while the title holds rows of another series than the one it writes to —
 * it was re-pointed after uploading to the old one, or that series is gone —
 * Studio writes nothing rather than mix two series in one title's uploads.
 * Refused before any write is sent.
 */
function requireOneSeriesLedger(rows: readonly CdPublication[], dramaId: string | null): void {
  const id = dramaId?.toLowerCase() ?? null;
  if (rows.some((r) => r.cd_drama_id !== id)) {
    throw new CdPublishError(409, "repointed", "This title's uploads went to another crazydramas series than the one its slug names now; Studio does not mix two series in one title's uploads. Set the slug back in the film's film-meta.json, or ask staff to resolve it. Nothing was sent.");
  }
}

/**
 * A Studio series no link holds (an orphan: a title's link moved off it) is
 * claimable by a title's series write only while it holds nothing but that
 * title's own uploads; with anyone else's episodes it is foreign, as a
 * series another title holds is (`conflict`, in words that name no title).
 */
function orphanRefusal(slug: string): CdPublishError {
  return new CdPublishError(409, "conflict", `${slug} holds episodes this title did not upload and no title is linked to it; Studio does not take it over. Staff can resolve it. Nothing was sent.`);
}

function languageOf(locale: string | null | undefined): string {
  const code = (locale ?? "en").split(/[-_]/)[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(code) ? code : "en";
}

function genresOf(genre: string | null | undefined): string[] {
  return (genre ?? "")
    .split(/[·,/|、]/)
    .map((g) => g.trim())
    .filter((g) => g.length > 0 && g.length <= 40)
    .slice(0, 12);
}

const nowIso = (now: () => number = Date.now) => new Date(now()).toISOString();

// ---- the live series read (the screens' poll reuses it for 20 s) --------------------------------------------------

/** One read of the series; `at` is when it was asked (a ledger row written after it is newer than what it says). */
type SeriesRead = ({ found: true; answer: GetSeriesAnswer } | { found: false; fail: StudioFail | null }) & { at: number };

const cache = (globalThis as unknown as { __studioCdSeriesCache?: Map<string, { at: number; read: SeriesRead }> }).__studioCdSeriesCache ??= new Map();

/** Forget the cached reads (after Studio's own write, or a pass of the uploader): the next poll reads crazydramas again. Keyed by slug or drama id, so all go. */
export function forgetSeriesRead(): void {
  cache.clear();
}

async function readSeries(client: StudioClient, key: string, opts: { fresh?: boolean } = {}): Promise<SeriesRead> {
  const cacheable = client.mode === "live";
  const hit = cacheable && !opts.fresh ? cache.get(key) : undefined;
  if (hit && Date.now() - hit.at < SERIES_CACHE_MS) return hit.read;
  const at = Date.now();
  const r = await client.getSeries(key);
  const read: SeriesRead = r.ok ? { found: true, answer: r.data, at } : r.status === 404 && r.code === "series_not_found" ? { found: false, fail: null, at } : { found: false, fail: r, at };
  if (cacheable && (read.found || !read.fail)) cache.set(key, { at, read });
  return read;
}

/**
 * Is the drama a read answered another title's? Another title's link holds
 * it, or this title's link names a different drama. "One film is one title
 * per company", so two companies' titles can carry one slug; the one whose
 * link holds the series owns it, and to every other title it is foreign:
 * nothing of it is shown and every write is refused (`conflict`), in words
 * that name no other title.
 */
async function heldElsewhere(titleId: string, link: PlatformLink | null, dramaId: string): Promise<boolean> {
  const id = dramaId.toLowerCase();
  if (link && link.cd_drama_id.toLowerCase() !== id) return true;
  return (await getData().listPlatformLinks(systemSession(), PLATFORM)).some((l) => l.cd_drama_id.toLowerCase() === id && l.title_id !== titleId);
}

/**
 * Is the answer a Studio series no link holds (not another title's — that is
 * heldElsewhere — nor this title's own link's) holding episodes this title's
 * uploads did not put there? Then it is foreign to this title as well: only an
 * orphan with nothing but this title's own uploads (an empty draft included)
 * may be shown to it and claimed by its series write.
 */
function orphanHeldByNobody(answer: GetSeriesAnswer, linked: PlatformLink | null, rows: readonly CdPublication[]): boolean {
  if (answer.series.managed_by !== "studio") return false;
  if (linked && linked.cd_drama_id.toLowerCase() === answer.series.id.toLowerCase()) return false;
  return foreignMedia(answer.episodes, rows);
}

function heldElsewhereRefusal(): CdPublishError {
  return new CdPublishError(409, "conflict", "This series is linked to a different title; staff can resolve it. Nothing was sent.");
}

/**
 * Does a verified or published ledger row still describe crazydramas? Only
 * while the episode, in a read asked after the row's last write, holds the
 * row's asset: a replace (Studio's own, or a CMS re-upload) moves the
 * episode to another asset, and the row no longer proves what viewers get.
 */
function rowStale(row: CdPublication, cd: StudioEpisode | null, readAt: number): boolean {
  if (row.step !== "verified" && row.step !== "published") return false;
  if (!(Date.parse(row.updated_at) < readAt)) return false; // written since the read: the read cannot judge it
  return !cd || !row.asset_id || cd.mux_asset_id !== row.asset_id;
}

/** The series as the route answers it: the contract's fields, nothing else. */
function seriesOut(s: CdSeries): CdSeries {
  return { ...s, genre: [...(s.genre ?? [])] };
}

// ---- GET …/publish ---------------------------------------------------------------------------------------------

export type PublishStateOut = PublishState & {
  /** The caller may press the buttons (the title's approver, a staff administrator). */
  can_write: boolean;
  /** The frame rule the verify step applies, with its calibration caveat. */
  frame_rule: typeof FRAME_RULE;
  paid_warning: string;
};

/** The latest row per episode worth showing: the active one, else the newest not superseded. */
function rowsByEpisode(rows: readonly CdPublication[]): Map<number, CdPublication> {
  const out = new Map<number, CdPublication>();
  for (const r of rows) {
    if (r.step === "superseded") continue;
    const have = out.get(r.episode_number);
    if (!have) out.set(r.episode_number, r);
    else if (isActiveStep(r.step) && !isActiveStep(have.step)) out.set(r.episode_number, r);
    else if (isActiveStep(r.step) === isActiveStep(have.step) && r.created_at >= have.created_at) out.set(r.episode_number, r);
  }
  return out;
}

/** The ledger rows that prove what is on crazydramas, in the match's shape. */
function ledgerFor(rows: readonly CdPublication[]): LedgerRow[] {
  return rows.filter((r) => r.step === "verified" || r.step === "published").map((r) => ({ episode_number: r.episode_number, uploaded_sha256: r.sha256, mux_duration_s: r.duration_s }));
}

function seriesStateFrom(slug: string | null, series: CdSeries | { status: string; managed_by: string | null } | null): CdSeriesState {
  if (!slug) return "not_linked";
  if (!series) return "not_uploaded";
  if (series.managed_by === "cms") return "cms_managed";
  return series.status === "published" ? "published" : "draft";
}

/**
 * Where the title's series and each episode stand, for the section's poll:
 * the live Studio read when reads are allowed (cached 20 s in live mode),
 * else the phase 3a reading; the ledger's rows; Studio's files. Whoever reads
 * the title may ask (`can_write` says whether the buttons are theirs). A
 * series another title holds reads `linked_elsewhere`, with nothing of it.
 */
export async function getPublishState(session: Session, titleId: string, opts: { client?: StudioClient } = {}): Promise<PublishStateOut> {
  const data = getData();
  const detail = await data.getTitle(session, titleId); // a foreign title is not found
  const title = detail.title;
  const sys = systemSession();
  const [episodes, allRows, linked] = await Promise.all([data.listTitleEpisodes(sys, titleId), data.getCdPublications(sys, titleId), data.getPlatformLink(sys, titleId, PLATFORM)]);
  const gate = cdWriteGate();
  const mode = crazydramasStudioMode();
  const client = opts.client ?? studioClient();
  // A title held on its link (re-pointed away from a show already on crazydramas) shows that series, and no button is its.
  const { slug, link, repointed, held } = await publishTarget(mode.read !== "off" ? client : null, title, linked, allRows, { onFail: "hold" });

  let series: CdSeries | null = null;
  let cdEpisodes: StudioEpisode[] | null = null;
  /** The live read answered: the series (found) or a 404 (nothing uploaded). Otherwise the phase 3a reading stands in. */
  let definite = false;
  /** The series the slug answers is another title's, or an orphan holding anyone else's episodes: nothing of it (series, episodes, form values) is shown here. */
  let foreign = false;
  let readAt = 0;
  if (slug && mode.read !== "off") {
    const read = await readSeries(client, link?.cd_drama_id ?? slug);
    readAt = read.at;
    if (read.found && ((await heldElsewhere(titleId, link, read.answer.series.id)) || orphanHeldByNobody(read.answer, linked, allRows))) {
      foreign = true;
      definite = true;
    } else if (read.found) {
      series = seriesOut(read.answer.series);
      cdEpisodes = read.answer.episodes;
      definite = true;
    } else if (!read.fail) {
      cdEpisodes = [];
      definite = true;
    }
  }
  let status: Awaited<ReturnType<typeof loadCrazydramasStatus>> | null = null;
  let known: { status: string; managed_by: string | null } | null = null;
  if (slug && !definite) {
    // A held title's reading is its link's (the series it is on), not the edited slug's.
    const reading: Title = held ? { ...title, crazydramas_slug: held.slug } : title;
    status = await loadCrazydramasStatus(session, reading, episodes);
    if (status.state === "not_checked") {
      // Never read: one check now (the system records it; the 30-second rule stands), then the caller's own reading.
      await checkCrazydramasTitle(sys, titleId).catch(() => undefined);
      status = await loadCrazydramasStatus(session, reading, episodes);
    }
    if (status.series) known = { status: status.series.status, managed_by: status.series.managed_by };
  }
  const seriesState: CdSeriesState = foreign ? "linked_elsewhere" : seriesStateFrom(slug, series ?? known);
  // The ledger rows of the series shown: a re-pointed title keeps its old series' rows, which say nothing of this one.
  const dramaId = (series?.id ?? link?.cd_drama_id ?? null)?.toLowerCase() ?? null;
  const rows = dramaId ? allRows.filter((r) => r.cd_drama_id === dramaId) : repointed ? [] : allRows;

  const cdByN = new Map((cdEpisodes ?? []).map((e) => [e.episode_number, e]));
  // With a live read, a verified or published row whose asset the episode no longer holds reads as replaced (queueUploads
  // supersedes it); without one the ledger stands.
  const current = cdEpisodes ? rows.filter((r) => !rowStale(r, cdByN.get(r.episode_number) ?? null, readAt)) : rows;
  const byN = rowsByEpisode(current);
  const freeCount = series?.free_episode_count ?? status?.series?.free_episode_count ?? 5;
  const studioByN = new Map(episodes.map((e) => [e.number, e]));
  const numbers = [...new Set([...studioByN.keys(), ...cdByN.keys(), ...byN.keys()])].sort((a, b) => a - b);

  // The verdict per episode: from the live read when there is one, else from the phase 3a reading.
  const verdicts = new Map<number, string>();
  if (cdEpisodes) {
    const m = matchEpisodes(episodes, cdEpisodes.map((e) => ({ n: e.episode_number, duration_s: e.duration_seconds, status: e.status, is_published: e.is_published })), { free_episode_count: freeCount, ledger: ledgerFor(current) });
    for (const r of m.episodes) verdicts.set(r.n, r.verdict);
  } else if (status) {
    for (const r of status.episodes) verdicts.set(r.n, r.verdict);
  }

  const out: PublishEpisode[] = numbers.map((n) => {
    const ep = studioByN.get(n);
    const row = byN.get(n) ?? null;
    const cd = cdByN.get(n) ?? null;
    const statusEp = status?.episodes.find((e) => e.n === n)?.live ?? null;
    const recordedSha = current.filter((r) => r.episode_number === n && (r.step === "verified" || r.step === "published")).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.sha256 ?? null;
    const cdHasMedia = !!cd && (cd.status === "ready" || cd.status === "failed");
    const replaceNeeded = !!ep?.video_sha256 && (recordedSha ? recordedSha !== ep.video_sha256 : cdHasMedia && !(row && isActiveStep(row.step) && row.sha256 === ep.video_sha256));
    return {
      n,
      studio_frames: ep?.video_frames ?? null,
      ledger_step: row?.step ?? null,
      cd_status: cd?.status ?? statusEp?.status ?? null,
      is_published: cd?.is_published ?? statusEp?.is_published ?? false,
      is_free: n <= freeCount,
      verdict: verdicts.get(n) ?? null,
      bytes_sent: row ? row.bytes_acked : null,
      bytes_total: row ? row.bytes : ep?.video_bytes ?? null,
      error: row?.error ?? null,
      error_code: row?.error_code ?? null,
      duration_s: row?.duration_s ?? cd?.duration_seconds ?? statusEp?.duration_s ?? null,
      replace_needed: replaceNeeded,
    };
  });

  const defaults: FormDefaults = {
    slug,
    title: series?.title ?? title.name_en ?? title.name_zh,
    tagline: series ? series.tagline ?? null : title.logline_en ?? null,
    description: series ? series.description ?? null : title.synopsis_en ?? null,
    genre: series ? [...(series.genre ?? [])] : genresOf(title.genre),
    language: series?.language ?? languageOf(title.source_locale),
    free_episode_count: series?.free_episode_count ?? 5,
    series_price_cents: series?.series_price_cents ?? 999,
    iap_product_id: series ? series.iap_product_id ?? null : slug ? suggestIapProductId(slug) : null,
    poster_url: series ? series.poster_url ?? null : slug ? suggestPosterUrl(slug, crazydramasBaseUrlSafe()) : null,
  };

  return {
    series_state: seriesState,
    series,
    form_defaults: defaults,
    episodes: out,
    writes_enabled: gate.enabled,
    ...(gate.enabled ? {} : { writes_disabled_reason: gate.reason ?? "Writes to crazydramas are disabled." }),
    paywall_live: paywallLive(),
    uploading: rows.some((r) => isActiveStep(r.step)),
    can_write: canPublish(session) && !foreign && !held,
    frame_rule: FRAME_RULE,
    paid_warning: PAID_WARNING,
  };
}

function crazydramasBaseUrlSafe(): string {
  try {
    return crazydramasBaseUrl();
  } catch {
    return "https://crazydramas.com";
  }
}

/** Spec §5: a series made in the CMS is read-only for Studio; refused before any write is sent. */
function cmsRefusal(series: Pick<CdSeries, "slug" | "managed_by">): CdPublishError {
  return new CdPublishError(403, "series_not_studio", "This series was made in the crazydramas CMS; Studio can read it but not change it. Ask Jayden to hand it over (one SQL line) to manage it from Studio. Nothing was sent.", { series: { slug: series.slug, managed_by: series.managed_by } });
}

// ---- PUT …/series ------------------------------------------------------------------------------------------------

/**
 * Before Studio creates a series: is the show already on the site under
 * another name? The working-name table and the public catalog, by the
 * title, the film's folder name and the name being sent. A match is refused
 * as crazydramas refuses one (`series_title_exists` with `existing`), before
 * any write; a catalog Studio cannot read refuses too (ask again, or ask the
 * operator) — never guessed.
 */
async function liveTwin(title: Title, name: string, slug: string): Promise<{ slug: string; title: string } | null> {
  const folder = title.source_ref?.split("/").pop() ?? null;
  const keys = new Set([title.name_en, title.name_zh, folder, name].map(titleKey).filter(Boolean));
  for (const known of KNOWN_LIVE_SERIES) {
    if (known.slug === slug) continue; // the slug itself is read live; a 404 there means it is not this one
    if (keys.has(titleKey(known.working)) || keys.has(titleKey(known.slug))) return { slug: known.slug, title: known.working };
  }
  let catalog;
  try {
    catalog = await crazydramasTransport().catalog();
  } catch {
    throw new CdPublishError(503, "catalog_unreadable", "Studio could not read the crazydramas catalog to check this show is not already live; try again in a minute. Nothing was changed.");
  }
  for (const d of catalog) {
    if (d.slug === slug) continue;
    if (keys.has(titleKey(d.title)) || keys.has(titleKey(d.slug))) return { slug: d.slug, title: d.title };
  }
  return null;
}

export type SaveSeriesResult = { series: CdSeries; created: boolean; changed: string[] };

/**
 * Create the draft series (PUT, spec §1b), or update Studio's own draft. The
 * slug is the title's (film-meta's `crazydramas_slug`, or the link's once
 * linked, whose series is read by its drama id; a re-pointed title's own,
 * whose write moves the link); a title without one is `not_linked`, one
 * whose uploads went to another series, or one held on a link to a show
 * already on crazydramas, is `repointed`. A series made in the CMS is refused
 * before any call, a series another title holds and an orphan holding anyone
 * else's episodes are `conflict`; a poster must answer 200 image/* before it
 * is sent (spec §4). On success the link records the drama id and
 * `managed_by: studio`, and one check refreshes the section's reading.
 */
export async function saveSeries(session: Session, titleId: string, input: unknown, opts: { client?: StudioClient } = {}): Promise<SaveSeriesResult> {
  const title = await requirePublisher(session, titleId);
  const parsed = SeriesBodySchema.safeParse(input);
  if (!parsed.success) throw new CdPublishError(400, "bad_request", "Invalid request body", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  const body = parsed.data;
  requireWrites();
  const data = getData();
  const sys = systemSession();
  const client = opts.client ?? studioClient();
  const [linked, rows] = await Promise.all([data.getPlatformLink(sys, titleId, PLATFORM), data.getCdPublications(sys, titleId)]);
  // A re-pointed title works under the slug it names now, with no link: its write creates (or updates) that series and moves
  // the link. One held on its link (it is on crazydramas already, as a show a second series would duplicate) writes nothing.
  const { slug, link, held } = await publishTarget(client, title, linked, rows, { fresh: true, onFail: "throw" });
  if (!slug) throw new CdPublishError(409, "not_linked", "This title has no crazydramas slug; add it to the film's film-meta.json and import the film again. Nothing was sent.");
  if (held) throw heldRefusal(held);
  // The link already says the series is the CMS's (an authenticated read recorded it): refused before any call.
  if (link?.managed_by === "cms") throw cmsRefusal({ slug: link.slug, managed_by: "cms" });

  // The link's series is read by its drama id (a CMS rename of the slug is then the same series, updated under its new slug).
  const read = await readSeries(client, link?.cd_drama_id ?? slug, { fresh: true });
  if (!read.found && read.fail) throw passThrough(read.fail);
  const existing = read.found ? read.answer.series : null;
  if (read.found && existing) {
    if (existing.managed_by !== "studio") throw cmsRefusal(existing);
    const holder = (await data.listPlatformLinks(sys, PLATFORM)).find((l) => l.cd_drama_id === existing.id.toLowerCase() && l.title_id !== titleId);
    if (holder) throw new CdPublishError(409, "conflict", `${existing.slug} is a series linked to a different title; staff can resolve it. Nothing was sent.`);
    if (orphanHeldByNobody(read.answer, linked, rows)) throw orphanRefusal(existing.slug);
  }
  requireOneSeriesLedger(rows, existing?.id ?? null);
  if (!existing) {
    const twin = await liveTwin(title, body.title, slug);
    if (twin) {
      throw new CdPublishError(409, "series_title_exists", `This show looks already live on crazydramas as "${twin.slug}"; Studio does not create a second series. Ask the operator. Nothing was sent.`, { existing: { slug: twin.slug, title: twin.title } });
    }
  }

  const posterChanged = body.poster_url !== undefined && body.poster_url !== null && body.poster_url !== (existing?.poster_url ?? null);
  if (posterChanged) {
    const check = await client.checkImage(body.poster_url!);
    if (!check.ok) throw new CdPublishError(400, "poster_unreachable", `The poster ${check.reason ?? "does not answer with an image"} Nothing was sent.`, { poster: { status: check.status, content_type: check.content_type } });
  }

  const put = {
    title: body.title,
    ...(body.tagline !== undefined ? { tagline: body.tagline } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.genre !== undefined ? { genre: body.genre } : {}),
    ...(body.language !== undefined ? { language: body.language } : {}),
    ...(body.free_episode_count !== undefined ? { free_episode_count: body.free_episode_count } : {}),
    ...(body.series_price_cents !== undefined ? { series_price_cents: body.series_price_cents } : {}),
    ...(body.iap_product_id !== undefined ? { iap_product_id: body.iap_product_id } : {}),
    ...(body.poster_url !== undefined ? { poster_url: body.poster_url } : {}),
    // Plan A6: every series Studio makes sells through the web checkout; the contract's create default is "app".
    ...(existing ? {} : { cta_mode: "web_checkout" as const }),
  };
  const r = await client.putSeries(existing?.slug ?? slug, put, { managed_by: existing ? (existing.managed_by as "studio" | "cms") : null });
  forgetSeriesRead();
  if (!r.ok) throw passThrough(r);
  const series = seriesOut(r.data.series);
  await data.upsertPlatformLink(sys, { title_id: titleId, platform: PLATFORM, slug: series.slug, title_slug: title.crazydramas_slug?.trim() || series.slug, cd_drama_id: series.id, managed_by: "studio" });
  await checkCrazydramasTitle(sys, titleId, { force: true }).catch((e) => console.warn(`[crazydramas] after the series write, the check failed: ${(e as Error).message}`));
  return { series, created: r.data.created, changed: r.data.changed };
}

// ---- POST …/uploads ------------------------------------------------------------------------------------------------

/**
 * The series Studio may write for this title, read fresh: missing →
 * series_missing, another title's → conflict (it is foreign to this one:
 * refused in words that name no other title), the CMS's → series_not_studio,
 * one the title's own link does not hold → series_unlinked (only the series
 * write claims a series, after its checks for holders; an orphan holding
 * anyone else's episodes is conflict), one while the title's ledger holds
 * another series' rows, or a title held on a link to a show already on
 * crazydramas → repointed; no call is made to write. A re-pointed title
 * reads the slug it names now. `at` is when the read was asked.
 */
async function writableSeries(client: StudioClient, title: Title, linked: PlatformLink | null): Promise<{ answer: GetSeriesAnswer; at: number }> {
  const rows = await getData().getCdPublications(systemSession(), title.id);
  const { slug, link, held } = await publishTarget(client, title, linked, rows, { fresh: true, onFail: "throw" });
  if (!slug) throw new CdPublishError(409, "not_linked", "This title has no crazydramas slug; add it to the film's film-meta.json and import the film again. Nothing was sent.");
  if (held) throw heldRefusal(held);
  // The link already says the series is the CMS's (an authenticated read recorded it): refused before any call.
  if (link?.managed_by === "cms") throw cmsRefusal({ slug: link.slug, managed_by: "cms" });
  const read = await readSeries(client, link?.cd_drama_id ?? slug, { fresh: true });
  if (!read.found) {
    if (read.fail) throw passThrough(read.fail);
    throw new CdPublishError(409, "series_missing", "Create the draft series on crazydramas first. Nothing was sent.");
  }
  const series = read.answer.series;
  if (await heldElsewhere(title.id, link, series.id)) throw heldElsewhereRefusal();
  if (series.managed_by !== "studio") throw cmsRefusal(series);
  // Every write goes to the series the title's own link holds: a re-pointed title's new series, or one no link holds, is
  // claimed by the series write alone (which checks for holders first), never by an upload, a publish or an unpublish.
  const linkHolds = !!linked && linked.cd_drama_id.toLowerCase() === series.id.toLowerCase();
  if (!linkHolds && orphanHeldByNobody(read.answer, linked, rows)) throw orphanRefusal(series.slug);
  requireOneSeriesLedger(rows, series.id);
  if (!linkHolds) throw new CdPublishError(409, "series_unlinked", "Save the series details first; that moves this title's link to the series. Nothing was sent.");
  return { answer: read.answer, at: read.at };
}

export type QueueResult = { queued: number[]; skipped: { n: number; reason: string }[] };

/**
 * Plan the listed episodes (or all of them) for the background uploader
 * (spec §1c). Uploading never publishes. An episode is refused, with the
 * reason, when Studio has no imported file for it (the bytes are read from
 * the local-tier link only), when that file is already on crazydramas or
 * already uploaded and verified (while the episode still holds that asset),
 * when an older file of it is still uploading, or when crazydramas already
 * holds media for it and the caller did not ask for `replace` (spec §10: the
 * viewer warning comes first). A failed row of the same file is retried
 * where it stopped.
 */
export async function queueUploads(session: Session, titleId: string, input: unknown, opts: { client?: StudioClient; schedule?: boolean } = {}): Promise<QueueResult> {
  const title = await requirePublisher(session, titleId);
  const parsed = UploadsBodySchema.safeParse(input);
  if (!parsed.success) throw new CdPublishError(400, "bad_request", "Invalid request body", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  const body = parsed.data;
  requireWrites();
  const data = getData();
  const sys = systemSession();
  const link = await data.getPlatformLink(sys, titleId, PLATFORM);
  const client = opts.client ?? studioClient();
  const { answer, at: readAt } = await writableSeries(client, title, link);
  const series = answer.series;
  const cdByN = new Map(answer.episodes.map((e) => [e.episode_number, e]));
  const episodes = await data.listTitleEpisodes(sys, titleId);
  const byN = new Map(episodes.map((e) => [e.number, e]));
  const wanted = body.episodes === "all" ? episodes.filter((e) => isLocalTierPath(e.video_path)).map((e) => e.number) : [...new Set(body.episodes)].sort((a, b) => a - b);
  const rows = await data.getCdPublications(sys, titleId);
  const queued: number[] = [];
  const skipped: { n: number; reason: string }[] = [];

  for (const n of wanted) {
    const ep = byN.get(n);
    if (!ep) {
      skipped.push({ n, reason: `Studio has no episode ${n}` });
      continue;
    }
    const why = uploadableWhy(ep);
    if (why) {
      skipped.push({ n, reason: why });
      continue;
    }
    const cd = cdByN.get(n) ?? null;
    // A verified or published row whose asset the episode no longer holds (a replace since, Studio's or the CMS's) proves
    // nothing any more: it is superseded, so the file can be sent again — with replace, since crazydramas holds media.
    const stale = rows.filter((r) => r.episode_number === n && rowStale(r, cd, readAt));
    for (const r of stale) await data.updateCdPublication(sys, r.id, { revision: r.revision, step: "superseded" });
    const mine = rows.filter((r) => r.episode_number === n && r.step !== "superseded" && !stale.includes(r));
    const active = mine.find((r) => isActiveStep(r.step));
    if (active) {
      if (active.sha256 === ep.video_sha256) queued.push(n);
      else skipped.push({ n, reason: `an earlier file of episode ${n} is still uploading; stop it first` });
      continue;
    }
    if (mine.some((r) => r.step === "published" && r.sha256 === ep.video_sha256)) {
      skipped.push({ n, reason: `episode ${n}: this file is already on crazydramas` });
      continue;
    }
    if (mine.some((r) => r.step === "verified" && r.sha256 === ep.video_sha256)) {
      skipped.push({ n, reason: `episode ${n}: this file is already uploaded and verified` });
      continue;
    }
    const failed = mine.filter((r) => r.step === "failed" && r.sha256 === ep.video_sha256).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    const cdHasMedia = !!cd && (cd.status === "ready" || cd.status === "failed");
    if (failed) {
      // A Retry: the same file, where it stopped. With an upload id recorded the uploader asks for it first and never
      // creates a second one, and it replaces only its own dead upload by itself, so a Retry is always safe to queue.
      // A row that stopped because someone else's upload holds the episode (a takeover, replace_required) never inherits
      // its old `replace`: overwriting that media takes a person's fresh Replace, after the viewer warning, and then a new
      // upload over it (the dead one is kept as previous_upload_id).
      const theirs = needsReplace(failed.error_code);
      const overwrite = theirs && body.replace === true;
      await data.updateCdPublication(sys, failed.id, {
        revision: failed.revision,
        step: failed.upload_id && !overwrite ? "upload_created" : "planned",
        ...(overwrite && failed.upload_id ? { upload_id: null, previous_upload_id: failed.upload_id, bytes_acked: 0 } : {}),
        error: null,
        error_code: null,
        cancel_requested: false,
        attempts: 0,
        next_attempt_at: null,
        replace: theirs ? overwrite : failed.replace || body.replace === true,
      });
      queued.push(n);
      continue;
    }
    if (cdHasMedia && !body.replace) {
      skipped.push({ n, reason: `episode ${n} already has media on crazydramas: send it again with replace (the viewer warning applies)` });
      continue;
    }
    const fps = inferFps(ep.video_frames, ep.duration_ms);
    await data.createCdPublication(sys, {
      title_id: titleId,
      episode_id: ep.id,
      episode_number: n,
      cd_drama_id: series.id,
      slug: series.slug,
      sha256: ep.video_sha256!,
      bytes: ep.video_bytes!,
      frames: ep.video_frames ?? null,
      fps,
      source_path: ep.video_path!,
      replace: cdHasMedia && body.replace === true,
      created_by: isSystemSession(session) ? null : session.userId,
    });
    queued.push(n);
  }
  if (queued.length && opts.schedule !== false) scheduleCrazydramasUploads(titleId);
  return { queued, skipped };
}

/** Why an episode cannot be uploaded, or null: the file must be the imported local-tier link with its hash, size and frame count. */
function uploadableWhy(ep: Episode): string | null {
  if (!ep.video_path || !isLocalTierPath(ep.video_path)) return `episode ${ep.number} is not an imported file (Studio uploads only the local-tier link of an imported episode)`;
  if (!ep.video_sha256 || !ep.video_bytes) return `episode ${ep.number} has no recorded SHA-256 or size; import the film again`;
  if (!ep.video_frames) return `episode ${ep.number} has no frame count, so Studio could not verify the upload; import the film again`;
  if (!inferFps(ep.video_frames, ep.duration_ms)) return `episode ${ep.number}'s frame rate cannot be told from its frames and length`;
  return null;
}

// ---- POST …/uploads/cancel ------------------------------------------------------------------------------------------

/**
 * A person's Stop: every queued or sending upload of the title, or one
 * episode's. A row that has not sent its last byte stops before its next
 * chunk (the unfinished upload on crazydramas expires within the hour and
 * never reaches the episode); one whose bytes are all at Mux cannot be
 * stopped — only unpublished.
 */
export async function cancelUploads(session: Session, titleId: string, input: unknown): Promise<{ cancelled: number[] }> {
  await requirePublisher(session, titleId);
  const parsed = CancelBodySchema.safeParse(input ?? {});
  if (!parsed.success) throw new CdPublishError(400, "bad_request", "Invalid request body", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  const data = getData();
  const sys = systemSession();
  const rows = (await data.getCdPublications(sys, titleId)).filter((r) => (r.step === "planned" || r.step === "upload_created") && (parsed.data.episode === undefined || r.episode_number === parsed.data.episode));
  const cancelled: number[] = [];
  for (const r of rows) {
    const after = await data.requestCdPublicationCancel(sys, r.id);
    if (after.cancel_requested || after.error_code === "cancelled") cancelled.push(r.episode_number);
  }
  return { cancelled: [...new Set(cancelled)].sort((a, b) => a - b) };
}

// ---- POST …/publish and …/unpublish ------------------------------------------------------------------------------------

export type PublishResult = { published: number[]; not_published: number[]; already_published: number[]; series_status: string };

/** Rows that become `published` supersede every older verified or published row of the same episode. */
async function markPublished(titleId: string, numbers: readonly number[], now = Date.now): Promise<void> {
  if (!numbers.length) return;
  const data = getData();
  const sys = systemSession();
  const rows = await data.getCdPublications(sys, titleId);
  for (const n of numbers) {
    const mine = rows.filter((r) => r.episode_number === n && (r.step === "verified" || r.step === "published")).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const [newest, ...older] = mine;
    if (!newest) continue;
    if (newest.step !== "published") await data.updateCdPublication(sys, newest.id, { revision: newest.revision, step: "published", published_at: nowIso(now) });
    for (const o of older) await data.updateCdPublication(sys, o.id, { revision: o.revision, step: "superseded" });
  }
}

/** A newly verified row of an episode that is not published: every older verified or published row of it is superseded. */
async function supersedeOlder(row: CdPublication): Promise<void> {
  const data = getData();
  const sys = systemSession();
  for (const o of await data.getCdPublications(sys, row.title_id)) {
    if (o.id === row.id || o.episode_number !== row.episode_number || (o.step !== "verified" && o.step !== "published")) continue;
    await data.updateCdPublication(sys, o.id, { revision: o.revision, step: "superseded" });
  }
}

/**
 * Publish exactly the listed episodes (spec §1d, §2), and the series with
 * them when asked. Each must be one Studio uploaded and VERIFIED, whose
 * asset the episode still holds in the fresh read (a failed verification,
 * or a replace since, blocks it: `not_verified`, before any call). Paid episodes
 * (past the series' free count) need `confirm_paid` until
 * CRAZYDRAMAS_PAYWALL_LIVE=1 (spec §3: `paid_needs_confirm`). crazydramas'
 * partial `episodes_changed` is recorded for what it did publish and
 * answered as the same 409.
 */
export async function publishEpisodes(session: Session, titleId: string, input: unknown, opts: { client?: StudioClient } = {}): Promise<PublishResult> {
  const title = await requirePublisher(session, titleId);
  const parsed = PublishBodySchema.safeParse(input);
  if (!parsed.success) throw new CdPublishError(400, "bad_request", "Invalid request body", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  const body = parsed.data;
  requireWrites();
  const data = getData();
  const sys = systemSession();
  const link = await data.getPlatformLink(sys, titleId, PLATFORM);
  const client = opts.client ?? studioClient();
  const { answer } = await writableSeries(client, title, link);
  const series = answer.series;
  const cdByN = new Map(answer.episodes.map((e) => [e.episode_number, e]));
  const numbers = [...new Set(body.episodes)].sort((a, b) => a - b);
  const byN = rowsByEpisode(await data.getCdPublications(sys, titleId));
  // Verified means verified AND still on the episode: the fresh read's episode must hold the very asset Studio checked
  // (a replace since, Studio's own or a CMS re-upload, is not what Studio verified).
  const holds = (n: number, row: CdPublication) => !!row.asset_id && cdByN.get(n)?.mux_asset_id === row.asset_id;
  const unverified = numbers
    .map((n) => ({ n, row: byN.get(n) ?? null }))
    .filter(({ n, row }) => !row || (row.step !== "verified" && row.step !== "published") || !holds(n, row))
    .map(({ n, row }) => ({
      episode_number: n,
      step: row?.step ?? null,
      error: row && (row.step === "verified" || row.step === "published") ? `episode ${n} on crazydramas now holds another file than the one Studio verified; upload it again` : row?.error ?? null,
    }));
  if (unverified.length) {
    throw new CdPublishError(409, "not_verified", `Only episodes Studio uploaded and verified can be published; not ${unverified.map((u) => u.episode_number).join(", ")}. Nothing was sent.`, { not_verified: unverified });
  }
  const paid = numbers.filter((n) => n > series.free_episode_count);
  if (paid.length && body.confirm_paid !== true && !paywallLive()) {
    throw new CdPublishError(409, "paid_needs_confirm", `Episodes ${paid.join(", ")} are paid. ${PAID_WARNING} Confirm to publish them. Nothing was sent.`, { paid, free_episode_count: series.free_episode_count });
  }
  const r = await client.publish(series.id, { ...(numbers.length ? { episodes: numbers } : {}), publish_series: body.publish_series }, { managed_by: "studio" });
  forgetSeriesRead();
  if (!r.ok) {
    if (r.code === "episodes_changed") {
      const published = Array.isArray(r.body.published) ? (r.body.published as number[]) : [];
      const already = Array.isArray(r.body.already_published) ? (r.body.already_published as number[]) : [];
      await markPublished(titleId, [...published, ...already]);
      await checkCrazydramasTitle(sys, titleId, { force: true }).catch(() => undefined);
      const seriesStatus = (r.body.series as { status?: string } | undefined)?.status ?? series.status;
      throw new CdPublishError(409, "episodes_changed", r.error, { published, not_published: Array.isArray(r.body.not_published) ? r.body.not_published : [], already_published: already, series_status: seriesStatus });
    }
    throw passThrough(r);
  }
  await markPublished(titleId, [...r.data.published, ...r.data.already_published]);
  await checkCrazydramasTitle(sys, titleId, { force: true }).catch(() => undefined);
  return { published: r.data.published, not_published: [], already_published: r.data.already_published, series_status: r.data.series.status };
}

export type UnpublishResult = { unpublished: number[]; already_unpublished: number[]; series_status: string };

/** Hide the listed episodes (and set a published series back to draft when asked); their ledger rows go back to `verified`. */
export async function unpublishEpisodes(session: Session, titleId: string, input: unknown, opts: { client?: StudioClient } = {}): Promise<UnpublishResult> {
  const title = await requirePublisher(session, titleId);
  const parsed = UnpublishBodySchema.safeParse(input);
  if (!parsed.success) throw new CdPublishError(400, "bad_request", "Invalid request body", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  const body = parsed.data;
  requireWrites();
  const data = getData();
  const sys = systemSession();
  const link = await data.getPlatformLink(sys, titleId, PLATFORM);
  const client = opts.client ?? studioClient();
  const { answer } = await writableSeries(client, title, link);
  const r = await client.unpublish(answer.series.id, { ...(body.episodes?.length ? { episodes: [...new Set(body.episodes)].sort((a, b) => a - b) } : {}), ...(body.unpublish_series ? { unpublish_series: true } : {}) }, { managed_by: "studio" });
  forgetSeriesRead();
  if (!r.ok) throw passThrough(r);
  const hidden = new Set([...r.data.unpublished, ...r.data.already_unpublished]);
  for (const row of await data.getCdPublications(sys, titleId)) {
    if (row.step === "published" && hidden.has(row.episode_number)) await data.updateCdPublication(sys, row.id, { revision: row.revision, step: "verified", published_at: null });
  }
  await checkCrazydramasTitle(sys, titleId, { force: true }).catch(() => undefined);
  return { unpublished: r.data.unpublished, already_unpublished: r.data.already_unpublished, series_status: r.data.series.status };
}

// ---- the uploader: one row, one pass ---------------------------------------------------------------------------------

/** A test's stand-in for a process that dies at a named point: the lease stays held, nothing is released. */
export class SimulatedCrash extends Error {
  constructor(readonly point: string) {
    super(`simulated crash at ${point}`);
    this.name = "SimulatedCrash";
  }
}

export type CrashPoint = "after_upload_call" | "after_chunk" | "after_last_chunk" | "after_ready" | "before_verify";

export type UploaderOptions = {
  /** The lease owner; one per worker. */
  owner?: string;
  client?: StudioClient;
  /** A multiple of 256 KiB (CD_CHUNK_BYTES by default). */
  chunkBytes?: number;
  pollMs?: number;
  syncAfterMs?: number;
  /** How long one pass waits for Mux to finish processing before it leaves the row for the next pass (0: one look). */
  waitReadyMs?: number;
  /** The claim's lease (ten minutes by default). */
  leaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Tests: die at a point (throw SimulatedCrash from the hook) the way a killed process would. */
  crash?: (point: CrashPoint, row: CdPublication) => void;
};

export type AdvanceOutcome = { row: CdPublication; outcome: "done" | "waiting" | "skipped" };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** This worker's name: host, pid and a random tail (two runners in one process are two owners). */
export function uploaderOwner(): string {
  return `${hostname()}:${process.pid}:cd:${Math.random().toString(36).slice(2, 8)}`;
}

class LostRow extends Error {
  constructor(readonly row: CdPublication, message: string) {
    super(message);
  }
}

/**
 * One pass of the state machine for one ledger row (spec §8–10; STUDIO_API.md
 * "What Studio must do, per episode"). The row is claimed (CAS + lease; a
 * stale lease is adopted), each step is persisted before the next external
 * call, and the pass ends at a terminal step (verified / published / failed),
 * at a wait (a transient refusal, or Mux still processing), or when the row
 * is someone else's. Never throws for a crazydramas answer; a SimulatedCrash
 * leaves the lease held, as a dead process would.
 */
export async function advanceCdPublication(rowId: string, opts: UploaderOptions = {}): Promise<AdvanceOutcome> {
  const chunk = opts.chunkBytes ?? CD_CHUNK_BYTES;
  if (!Number.isInteger(chunk) || chunk <= 0 || chunk % MUX_CHUNK_QUANTUM !== 0) throw invalid("chunkBytes must be a positive multiple of 256 KiB");
  const data = getData();
  const sys = systemSession();
  const owner = opts.owner ?? uploaderOwner();
  const now = opts.now ?? Date.now;
  let row = await data.getCdPublication(sys, rowId);
  if (!isActiveStep(row.step)) return { row, outcome: "done" };
  if (row.next_attempt_at && Date.parse(row.next_attempt_at) > now() && row.lease_owner !== owner) return { row, outcome: "waiting" };
  const claimed = await data.claimCdPublication(sys, rowId, { owner, revision: row.revision, leaseMs: opts.leaseMs });
  if (!claimed) return { row: await data.getCdPublication(sys, rowId), outcome: "skipped" };
  row = claimed;
  let crashed = false;
  try {
    return await new Pass(row, owner, opts).run();
  } catch (e) {
    if (e instanceof SimulatedCrash) {
      crashed = true;
      throw e;
    }
    if (e instanceof LostRow) return { row: e.row, outcome: "skipped" };
    // An unexpected failure (a file that vanished, a bug): the row fails with the reason instead of spinning.
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[crazydramas] upload of ${row.slug} ep${row.episode_number} failed: ${message}`);
    try {
      const fresh = await data.getCdPublication(sys, rowId);
      if (!isActiveStep(fresh.step)) return { row: fresh, outcome: "done" };
      // Only while the row is still leased to this worker (the rule save() follows): one another worker adopted — and may have
      // released since, leaving it on a backoff — is that worker's to judge, never failed by a worker that lost it.
      if (fresh.lease_owner !== owner) return { row: fresh, outcome: "skipped" };
      return { row: await data.updateCdPublication(sys, rowId, { revision: fresh.revision, owner, step: "failed", error: message.slice(0, 500), error_code: "internal" }), outcome: "done" };
    } catch {
      return { row: await data.getCdPublication(sys, rowId), outcome: "done" };
    }
  } finally {
    if (!crashed) {
      await data.releaseCdPublication(sys, rowId, { owner }).catch(() => undefined);
      forgetSeriesRead();
    }
  }
}

/** One pass over one row: the steps, the saves, the waits. */
class Pass {
  private readonly data = getData();
  private readonly sys = systemSession();
  private readonly client: StudioClient;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly chunkBytes: number;
  /** The upload URL, in memory only (a capability): from the upload call's answer, never from a row. */
  private url: string | null = null;
  private pendingSince: number | null = null;

  constructor(private row: CdPublication, private readonly owner: string, private readonly opts: UploaderOptions) {
    this.client = opts.client ?? studioClient();
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.chunkBytes = opts.chunkBytes ?? CD_CHUNK_BYTES; // checked by advanceCdPublication before the claim
  }

  private crash(point: CrashPoint): void {
    this.opts.crash?.(point, this.row);
  }

  /**
   * A revision-conditional write under the lease; a moved revision is re-read
   * (a person's Stop), a lost lease ends the pass. Lost means the row is no
   * longer leased to this worker, live or not: another worker adopted it
   * (and may have released it since) — this one never carries on without
   * its lease; a later claim picks the row up.
   */
  private async save(patch: Omit<Parameters<ReturnType<typeof getData>["updateCdPublication"]>[2], "revision" | "owner">): Promise<CdPublication> {
    for (let attempt = 0; ; attempt++) {
      try {
        this.row = await this.data.updateCdPublication(this.sys, this.row.id, { ...patch, revision: this.row.revision, owner: this.owner, renew: this.opts.leaseMs ?? true });
        return this.row;
      } catch (e) {
        if (!isDataError(e) || e.code !== "conflict" || attempt >= 3) throw e;
        const fresh = await this.data.getCdPublication(this.sys, this.row.id);
        if (fresh.lease_owner !== this.owner) throw new LostRow(fresh, "the row is no longer leased to this worker");
        if (!isActiveStep(fresh.step)) throw new LostRow(fresh, `the row is ${fresh.step}`);
        this.row = fresh;
        if (fresh.cancel_requested && patch.step !== "failed") return this.cancelled();
      }
    }
  }

  private async fail(code: string, error: string): Promise<AdvanceOutcome> {
    await this.save({ step: "failed", error_code: code, error });
    return { row: this.row, outcome: "done" };
  }

  private async cancelled(): Promise<CdPublication> {
    this.row = await this.data.updateCdPublication(this.sys, this.row.id, {
      revision: this.row.revision,
      owner: this.owner,
      step: "failed",
      error_code: "cancelled",
      error: this.row.upload_id ? "Stopped by a person before the last chunk; the unfinished upload on crazydramas expires within the hour and nothing reached the episode." : "Stopped by a person before anything was sent.",
    });
    return this.row;
  }

  /** A transient refusal: wait (backoff, or the answer's own delay) and try again on a later pass; after CD_MAX_ATTEMPTS in a row, fail. */
  private async wait(code: string, error: string, delayMs?: number): Promise<AdvanceOutcome> {
    const attempts = this.row.attempts + 1;
    if (attempts > CD_MAX_ATTEMPTS) return this.fail(code, `${error} (gave up after ${CD_MAX_ATTEMPTS} tries; Retry to try again)`);
    const delay = delayMs ?? Math.min(CD_MAX_BACKOFF_MS, 30_000 * 2 ** (attempts - 1));
    await this.save({ attempts, error, error_code: code, next_attempt_at: new Date(this.now() + delay).toISOString() });
    return { row: this.row, outcome: "waiting" };
  }

  /**
   * Our upload died (timed out, errored, cancelled, its asset errored, or Mux
   * forgot it): plan a new one with replace — the contract's remedy — but
   * only while the episode still holds OUR dead upload (`ours`: the upload
   * status says episode_is_current). When someone else's upload is on the
   * episode now, Studio never replaces it on its own, whatever the row's
   * `replace` says (a replace a person confirmed was over the media that was
   * there then, not over what took the episode since): the row fails
   * `replace_required` and a person decides (a fresh Replace, after the
   * viewer warning). At most three new uploads in a row.
   */
  private async dead(why: string, ours: boolean): Promise<AdvanceOutcome | null> {
    if (this.row.cancel_requested) {
      await this.cancelled();
      return { row: this.row, outcome: "done" };
    }
    if (!ours) {
      return this.fail("replace_required", `${why}, and episode ${this.row.episode_number} on crazydramas now holds another upload; Studio does not replace it on its own. Replace it (the viewer warning applies) if Studio's file should win.`);
    }
    if (this.row.previous_upload_id && this.row.attempts >= 3) return this.fail("upload_dead", `${why}; three uploads of this file died, Retry to try again`);
    await this.save({ step: "planned", upload_id: null, previous_upload_id: this.row.upload_id, replace: true, bytes_acked: 0, attempts: this.row.attempts + 1, error: `${why}; a new upload is created`, error_code: "upload_dead" });
    this.url = null;
    return null;
  }

  async run(): Promise<AdvanceOutcome> {
    for (let guard = 0; guard < 50; guard++) {
      if (this.row.cancel_requested && (this.row.step === "planned" || this.row.step === "upload_created")) {
        await this.cancelled();
        return { row: this.row, outcome: "done" };
      }
      let r: AdvanceOutcome | null;
      switch (this.row.step) {
        case "planned":
          r = await this.createUpload();
          break;
        case "upload_created":
          r = await this.sendBytes();
          break;
        case "bytes_sent":
          r = await this.waitReady();
          break;
        case "asset_ready":
          r = await this.verify();
          break;
        default:
          return { row: this.row, outcome: "done" };
      }
      if (r) return r;
    }
    return { row: this.row, outcome: "waiting" };
  }

  // ---- step 2: the upload call ----

  private async createUpload(): Promise<AdvanceOutcome | null> {
    // Persisted before the call: a lost answer is settled by repeating it with the same sha (crazydramas answers the same upload).
    await this.save({ attempted_at: new Date(this.now()).toISOString() });
    this.client.hintFileFacts(this.row.sha256, { fps: this.row.fps });
    for (let round = 0; round < 3; round++) {
      // The fresh read before the write: a series taken back into the CMS since the queue (or since an earlier episode of
      // this title) gets no upload call.
      const theirs = await this.stillStudios("upload");
      if (theirs) return theirs;
      const r = await this.client.createUpload(this.row.cd_drama_id, this.row.episode_number, { sha256: this.row.sha256, bytes: this.row.bytes, ...(this.row.frames ? { frames: this.row.frames } : {}), ...(this.row.replace ? { replace: true } : {}) }, { managed_by: "studio" });
      this.crash("after_upload_call");
      if (r.ok) {
        const d = r.data;
        this.url = d.upload_url;
        const allThere = d.upload_url === null;
        await this.save({
          step: allThere ? "bytes_sent" : "upload_created",
          upload_id: d.upload_id,
          cd_episode_id: d.episode_id,
          ...(d.replaced && d.previous_asset_id && !this.row.previous_asset_id ? { previous_asset_id: d.previous_asset_id } : {}),
          bytes_acked: allThere ? this.row.bytes : this.row.bytes_acked,
          attempts: 0,
          error: null,
          error_code: null,
          next_attempt_at: null,
        });
        // A replace clears the episode's asset at once (STUDIO_API.md, Replace): an older verified or published row of it
        // describes crazydramas no more, whatever this upload turns into.
        if (d.replaced) await supersedeOlder(this.row);
        return null;
      }
      if (r.code === "webhook_pending" && typeof r.body.upload_id === "string") {
        // This very file is ready in Mux but the row has not heard: sync, then repeat the call (it answers reused).
        const back = await this.stillStudios("sync");
        if (back) return back;
        await this.client.syncUpload(r.body.upload_id, { managed_by: "studio" });
        continue;
      }
      if (r.code === "episode_busy") return this.wait(r.code, r.error, EPISODE_BUSY_WAIT_MS);
      if (isTransient(r)) return this.wait(r.code, r.error);
      return this.fail(r.code, r.error);
    }
    return this.wait("webhook_pending", "crazydramas kept answering webhook_pending after a sync");
  }

  // ---- step 3: the bytes ----

  private async uploadStatus(): Promise<{ ok: true; status: UploadStatusAnswer } | { ok: false; outcome: AdvanceOutcome | null }> {
    const st = await this.client.getUpload(this.row.upload_id!);
    if (st.ok) return { ok: true, status: st.data };
    if (st.code === "upload_not_found") return { ok: false, outcome: await this.dead("Mux no longer knows the upload", false) };
    if (isTransient(st)) return { ok: false, outcome: await this.wait(st.code, st.error) };
    return { ok: false, outcome: await this.fail(st.code, st.error) };
  }

  /** Does the episode still hold our upload? (A dead session's answer cannot tell; the upload status can.) */
  private async oursNow(): Promise<boolean> {
    const st = await this.client.getUpload(this.row.upload_id!);
    return st.ok && st.data.episode_is_current;
  }

  /**
   * STUDIO_API.md step 3: a CMS upload took the episode over before the last
   * chunk. Do not send it; cancel ours (unless the series is the CMS's now:
   * then nothing is sent to it, not even the cancel); tell the operator.
   */
  private async takenOverBeforeLast(): Promise<AdvanceOutcome> {
    const theirs = await this.stillStudios("cancel");
    if (theirs) return theirs;
    const c = await this.client.cancelUpload(this.row.upload_id!);
    const note = c.ok ? "Studio's upload was cancelled" : `cancelling Studio's upload answered ${c.code}`;
    return this.fail("taken_over", `A CMS upload took episode ${this.row.episode_number} over before Studio's last chunk; the last chunk was not sent and ${note}, so nothing of Studio's reaches the episode. Tell the operator.`);
  }

  /**
   * Is the series still Studio's? A take-back (Jayden sets managed_by back
   * to cms, STUDIO_API.md) makes it a CMS series, which Studio never writes
   * to (spec §5), yet the upload's URL stays live for an hour and the webhook
   * would put Studio's last chunk on the episode. Asked before every write
   * the uploader sends to crazydramas (the upload call, a sync, the URL
   * re-request of a resume, a cancel), before the last chunk and before a row
   * is marked verified: a GET, allowed in every mode. Null while the series
   * is Studio's; otherwise the pass's outcome (a take-back fails the row
   * `series_not_studio`; nothing is sent to the series, not even a cancel,
   * which it would refuse).
   */
  private async stillStudios(when: "upload" | "resume" | "cancel" | "last_chunk" | "sync" | "verify"): Promise<AdvanceOutcome | null> {
    const r = await this.client.getSeries(this.row.cd_drama_id);
    if (r.ok) {
      if (r.data.series.managed_by === "studio") return null;
      const n = this.row.episode_number;
      const said: Record<typeof when, string> = {
        upload: `The series was taken back into the crazydramas CMS before Studio asked for episode ${n}'s upload; nothing was sent to the series. Studio does not write to a CMS series. Tell the operator.`,
        resume: `The series was taken back into the crazydramas CMS while episode ${n} was uploading; Studio sent nothing more, so nothing of Studio's reaches the episode, and the unfinished upload on crazydramas expires within the hour. Studio does not write to a CMS series. Tell the operator.`,
        cancel: `A CMS upload took episode ${n} over and the series was taken back into the crazydramas CMS; the last chunk was not sent and nothing more went to the series, not even a cancel, so nothing of Studio's reaches the episode, and the unfinished upload expires within the hour. Tell the operator.`,
        last_chunk: `The series was taken back into the crazydramas CMS while Studio was sending episode ${n}; the last chunk was not sent, so nothing of Studio's reaches the episode, and the unfinished upload on crazydramas expires within the hour. Studio does not write to a CMS series. Tell the operator.`,
        sync: `The series was taken back into the crazydramas CMS after Studio's bytes of episode ${n} reached Mux; Studio does not ask crazydramas to sync them, and neither verifies nor publishes the episode on a CMS series (it may play Studio's file once crazydramas hears from Mux). Tell the operator.`,
        verify: `The series was taken back into the crazydramas CMS after Studio's bytes of episode ${n} reached Mux, so the episode there may play Studio's file; Studio neither verifies nor publishes it on a CMS series. Tell the operator.`,
      };
      return this.fail("series_not_studio", said[when]);
    }
    if (isTransient(r)) return this.wait(r.code, r.error);
    return this.fail(r.code, r.error);
  }

  private async sendBytes(): Promise<AdvanceOutcome | null> {
    const first = await this.uploadStatus();
    if (!first.ok) return first.outcome;
    const u = first.status;
    if (u.upload.status === "errored" || u.upload.status === "cancelled" || u.upload.status === "timed_out") return this.dead(`the upload ${u.upload.status === "timed_out" ? "timed out" : u.upload.status}`, u.episode_is_current);
    // A Retry of a row whose asset errored: the bytes are in Mux but unusable, so a new upload (with replace, if still ours).
    if (u.upload.status === "asset_created" && u.asset?.status === "errored") return this.dead("Mux could not process the file", u.episode_is_current);
    if (u.upload.status === "asset_created") {
      await this.save({ step: "bytes_sent", bytes_acked: this.row.bytes, attempts: 0, error: null, error_code: null, next_attempt_at: null });
      return null;
    }
    if (!u.episode_is_current) return this.takenOverBeforeLast();
    if (!this.url) {
      // After a restart the URL is gone (it is never stored): the same call with the same sha answers the same upload and its
      // URL. It only asks for the URL of an upload known to be waiting, so it never sends `replace`: if the upload died
      // since the status read (its hour ran out), crazydramas answers replace_required instead of creating a second
      // upload, and the dead upload goes the way every dead upload goes.
      const theirs = await this.stillStudios("resume");
      if (theirs) return theirs;
      const again = await this.client.createUpload(this.row.cd_drama_id, this.row.episode_number, { sha256: this.row.sha256, bytes: this.row.bytes, ...(this.row.frames ? { frames: this.row.frames } : {}) }, { managed_by: "studio" });
      if (!again.ok) {
        if (again.code === "replace_required") return this.dead("the upload is no longer waiting", await this.oursNow());
        if (again.code === "webhook_pending" && again.body.upload_id === this.row.upload_id) {
          // Every byte is in Mux already and crazydramas has not heard: the wait's sync settles it.
          await this.save({ step: "bytes_sent", bytes_acked: this.row.bytes, attempts: 0, error: null, error_code: null, next_attempt_at: null });
          return null;
        }
        if (again.code === "episode_busy") return this.wait(again.code, again.error, EPISODE_BUSY_WAIT_MS);
        if (isTransient(again)) return this.wait(again.code, again.error);
        return this.fail(again.code, again.error);
      }
      if (again.data.upload_id !== this.row.upload_id) {
        return this.fail("upload_mismatch", `crazydramas answered upload ${again.data.upload_id} for a file whose upload ${this.row.upload_id} is still waiting; nothing more was sent. Tell the operator.`);
      }
      if (!again.data.upload_url) {
        await this.save({ step: "bytes_sent", bytes_acked: this.row.bytes, attempts: 0, error: null, error_code: null, next_attempt_at: null });
        return null;
      }
      this.url = again.data.upload_url;
    }

    // The file: the local-tier link only, and still the file the row names.
    const abs = localPathOf(this.row.source_path);
    const facts = await stat(abs).catch(() => null);
    if (!facts?.isFile()) return this.fail("file_missing", `episode ${this.row.episode_number}'s file is not in the local tier any more; import the film again`);
    if (facts.size !== this.row.bytes) return this.fail("file_changed", `episode ${this.row.episode_number}'s file is ${facts.size} bytes, not the ${this.row.bytes} Studio planned; nothing more was sent`);
    if ((await sha256Of(abs)) !== this.row.sha256) return this.fail("file_changed", `episode ${this.row.episode_number}'s file no longer has the SHA-256 Studio planned; nothing more was sent`);

    const total = this.row.bytes;
    // Where to start: what the storage says it has (it may be ahead of the ledger after a crash, or behind a short persist).
    let offset = await this.persistedOffset(total);
    if (offset === null) return this.wait("unreachable", "the Mux upload did not answer the status query");
    if (offset === -1) return this.dead("the upload URL no longer takes bytes", await this.oursNow());
    if (offset !== this.row.bytes_acked) await this.save({ bytes_acked: offset });
    const fh = await open(abs, "r");
    let stalls = 0;
    try {
      while (offset < total) {
        const end = Math.min(offset + this.chunkBytes, total);
        const last = end === total;
        if (last) {
          // STUDIO_API.md step 3: immediately before the last chunk, is the episode still ours?
          const st = await this.uploadStatus();
          if (!st.ok) return st.outcome;
          if (!st.status.episode_is_current) return this.takenOverBeforeLast();
          const theirs = await this.stillStudios("last_chunk");
          if (theirs) return theirs;
          const fresh = await this.data.getCdPublication(this.sys, this.row.id);
          if (fresh.cancel_requested) {
            this.row = fresh;
            await this.cancelled();
            return { row: this.row, outcome: "done" };
          }
        }
        const buf = Buffer.alloc(end - offset);
        const { bytesRead } = await fh.read(buf, 0, buf.byteLength, offset);
        if (bytesRead !== buf.byteLength) return this.fail("file_changed", `episode ${this.row.episode_number}'s file ended early; nothing more was sent`);
        const a = await this.client.putChunk(this.url!, buf, { first: offset, last: end - 1, total });
        this.crash(last ? "after_last_chunk" : "after_chunk");
        let next: number;
        if (a.status === 200 || a.status === 201) next = total;
        else if (a.status === 308) next = a.acked ?? 0;
        else if (a.status === 404 || a.status === 410) return this.dead("the upload URL no longer takes bytes", await this.oursNow());
        else if (a.status === 0 || a.status >= 500) {
          const q = await this.persistedOffset(total);
          if (q === -1) return this.dead("the upload URL no longer takes bytes", await this.oursNow());
          if (q === null) return this.wait("unreachable", "the Mux upload stopped answering mid-file");
          next = q;
        } else return this.fail("chunk_refused", `the Mux upload refused a chunk (HTTP ${a.status}); nothing more was sent`);
        stalls = next > offset ? 0 : stalls + 1;
        if (stalls > 5) return this.wait("upload_stalled", "the Mux upload stopped taking bytes");
        offset = next;
        await this.save({ bytes_acked: offset });
        if (this.row.step !== "upload_created") return null; // a Stop landed on the save
        await new Promise<void>((r) => setImmediate(r)); // pacing: let the rest of the server breathe between chunks
      }
    } finally {
      await fh.close().catch(() => undefined);
    }
    await this.save({ step: "bytes_sent", bytes_acked: total, attempts: 0, error: null, error_code: null, next_attempt_at: null });
    return null;
  }

  /** The storage's offset (the empty status PUT): a number, null for no answer, -1 when the session is gone. A complete upload answers the total. */
  private async persistedOffset(total: number): Promise<number | null> {
    const q = await this.client.queryUpload(this.url!, total);
    if (q.status === 200 || q.status === 201) return total;
    if (q.status === 308) return q.acked ?? 0;
    if (q.status === 404 || q.status === 410) return -1;
    return null;
  }

  // ---- step 4: wait for ready ----

  private async waitReady(): Promise<AdvanceOutcome | null> {
    const deadline = this.now() + (this.opts.waitReadyMs ?? 0);
    const pollMs = this.opts.pollMs ?? CD_POLL_MS;
    const syncAfter = this.opts.syncAfterMs ?? CD_SYNC_AFTER_MS;
    for (;;) {
      const st = await this.uploadStatus();
      if (!st.ok) return st.outcome;
      const u = st.status;
      if (!u.episode_is_current) {
        return this.fail("taken_over_late", `Studio's bytes are in Mux, but a CMS upload has taken episode ${this.row.episode_number} since; Studio neither syncs nor publishes it. Tell the operator (the CMS upload may need re-running once Studio's asset has settled).`);
      }
      if (u.asset?.status === "errored" || (u.upload.status === "errored")) return this.fail("asset_errored", `Mux could not process episode ${this.row.episode_number}'s file`);
      if (u.ready && u.asset) {
        this.crash("after_ready");
        await this.save({ step: "asset_ready", asset_id: u.asset.id, duration_s: u.asset.duration, attempts: 0, error: null, error_code: null, next_attempt_at: null });
        return null;
      }
      if (u.webhook_pending) {
        this.pendingSince ??= this.now();
        // The row's own clock survives a restart: the first time this pass saw it pending, or the row's last attempt.
        if (this.now() - this.pendingSince >= syncAfter || (this.row.error_code === "webhook_pending" && this.row.attempted_at && this.now() - Date.parse(this.row.attempted_at) >= syncAfter)) {
          const theirs = await this.stillStudios("sync");
          if (theirs) return theirs;
          const s = await this.client.syncUpload(this.row.upload_id!, { managed_by: "studio" });
          if (!s.ok && !isTransient(s)) return this.fail(s.code, s.error);
          this.pendingSince = null;
          continue;
        }
        if (this.row.error_code !== "webhook_pending") await this.save({ error_code: "webhook_pending", error: "Mux has the asset; waiting for crazydramas to hear", attempted_at: new Date(this.now()).toISOString() });
      }
      if (this.now() + pollMs > deadline) {
        await this.save({ next_attempt_at: new Date(this.now() + pollMs).toISOString() });
        return { row: this.row, outcome: "waiting" };
      }
      await this.sleep(pollMs);
    }
  }

  // ---- step 5: verify ----

  private async verify(): Promise<AdvanceOutcome | null> {
    this.crash("before_verify");
    const st = await this.uploadStatus();
    if (!st.ok) return st.outcome;
    const u = st.status;
    if (!u.episode_is_current) return this.fail("taken_over_late", `A CMS upload has taken episode ${this.row.episode_number} since Studio's asset was ready; Studio does not publish it. Tell the operator.`);
    if (!u.asset || u.asset.status !== "ready") return this.fail("verify_failed", `Mux has no ready asset for episode ${this.row.episode_number} any more`);
    const liveNote = u.episode?.is_published ? ` Episode ${this.row.episode_number} is published and now plays this asset: unpublish it, or upload the right file with replace.` : "";
    const externalOk = u.asset.meta?.external_id === this.row.sha256;
    if (!externalOk) return this.fail("verify_failed", `Mux's external_id for episode ${this.row.episode_number} is not the SHA-256 of Studio's file; never published.${liveNote}`);
    const d = frameDelta(u.asset.duration, this.row.fps, this.row.frames);
    const verdict = verdictForDelta(d);
    if (verdict !== "same_length") {
      const said = d === null ? "Studio could not compare the lengths (no frame count or frame rate)" : `round(${u.asset.duration} s × ${this.row.fps} fps) − ${this.row.frames} frames = ${d >= 0 ? "+" : ""}${d}, not the +${MUX_FRAME_OFFSET} Mux adds`;
      return this.fail("verify_failed", `Episode ${this.row.episode_number}'s length on Mux does not pass the frame rule: ${said} (the rule is calibrated on one film, ${FRAME_RULE.calibrated_on}; confirm it on this upload before trusting it). Never published.${liveNote}`);
    }
    // A series taken back into the CMS since: never marked verified (nothing Studio verified may be published there).
    const theirs = await this.stillStudios("verify");
    if (theirs) return theirs;
    await this.save({ step: "verified", asset_id: u.asset.id, duration_s: u.asset.duration, verify: { external_id_ok: true, d_frames: d, verdict }, error: null, error_code: null });
    // A replace of an episode that is already published is live the moment its asset is ready (the contract keeps
    // is_published): the ledger says so instead of pretending a publish is still to come. Either way the episode now
    // holds this asset, so an older row of it no longer describes crazydramas: it is superseded.
    if (u.episode?.is_published) await markPublished(this.row.title_id, [this.row.episode_number], this.now);
    else await supersedeOlder(this.row);
    return { row: await this.data.getCdPublication(this.sys, this.row.id), outcome: "done" };
  }
}

/** The SHA-256 of a file, streamed. */
async function sha256Of(abs: string): Promise<string> {
  const fh = await open(abs, "r");
  try {
    const hash = createHash("sha256");
    for await (const chunk of fh.createReadStream({ highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    await fh.close().catch(() => undefined);
  }
}

// ---- one title, in the background ------------------------------------------------------------------------------------

type Registry = { titles: Map<string, Promise<RunSummary>>; again: Set<string>; sending: number };
const registry = ((globalThis as unknown as { __studioCdUploads?: Registry }).__studioCdUploads ??= { titles: new Map(), again: new Set(), sending: 0 });

export type RunSummary = { title_id: string; passes: number; verified: number[]; failed: number[]; waiting: number[] };

/** This process's lease owners start so (uploaderOwner): its own runners are counted in `registry.sending`, never twice. */
const PROCESS_OWNER_PREFIX = `${hostname()}:${process.pid}:`;

/** Rows sending bytes on other workers — other processes, or another Studio server on the shared database (a live lease in planned / upload_created that is not this process's). */
async function othersSending(owner: string, now: number): Promise<number> {
  const rows = await getData().listActiveCdPublications(systemSession());
  return rows.filter((r) => (r.step === "planned" || r.step === "upload_created") && r.lease_owner && r.lease_owner !== owner && !r.lease_owner.startsWith(PROCESS_OWNER_PREFIX) && cdLeaseLive(r, now)).length;
}

/**
 * One title's uploads, one at a time (spec §8): the lowest due episode that
 * still has bytes to send, after a quick look at every episode waiting for
 * Mux; at most CD_MAX_CONCURRENT titles send at once on this machine (this
 * process's count plus live leases of other workers). A row another live
 * worker holds is left to it, and while that worker sends one of the title's
 * episodes no other starts here; a pass that moves nothing (a lost claim
 * included) sleeps before the next look. Returns when nothing is left to do,
 * or after `maxPasses` / `maxRunMs`.
 */
export async function runTitleUploads(titleId: string, opts: UploaderOptions & { maxPasses?: number; maxRunMs?: number } = {}): Promise<RunSummary> {
  const data = getData();
  const sys = systemSession();
  const owner = opts.owner ?? uploaderOwner();
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const pollMs = opts.pollMs ?? CD_POLL_MS;
  const until = now() + (opts.maxRunMs ?? 6 * 60 * 60_000);
  const summary: RunSummary = { title_id: titleId, passes: 0, verified: [], failed: [], waiting: [] };
  const pass = { ...opts, owner, waitReadyMs: opts.waitReadyMs ?? 0 };
  for (; summary.passes < (opts.maxPasses ?? 10_000); summary.passes++) {
    const rows = (await data.getCdPublications(sys, titleId)).filter((r) => isActiveStep(r.step));
    if (!rows.length) break;
    const t = now();
    // A row another live worker holds is that worker's until its lease ends (another Studio server on the shared
    // database, or this server's previous process within its ten-minute lease): not looked at, not claimed.
    const due = rows.filter((r) => (!r.next_attempt_at || Date.parse(r.next_attempt_at) <= t) && !cdLeaseHeldByOther(r, owner, t));
    let progressed = false;
    for (const r of due.filter((x) => x.step === "bytes_sent" || x.step === "asset_ready")) {
      const out = await advanceCdPublication(r.id, pass);
      if (out.outcome === "done") progressed = true;
    }
    // One upload per title: while another worker sends one of this title's episodes, no other episode of it starts here.
    const sendingElsewhere = rows.some((r) => (r.step === "planned" || r.step === "upload_created") && cdLeaseHeldByOther(r, owner, t));
    const next = sendingElsewhere ? undefined : due.filter((r) => r.step === "planned" || r.step === "upload_created").sort((a, b) => a.episode_number - b.episode_number)[0];
    if (next) {
      // The slot is reserved before anything is awaited, so two runners of this process that start together never both
      // see a free one; over the cap, it is handed back and the runner waits.
      registry.sending += 1;
      try {
        if (registry.sending + (await othersSending(owner, t)) <= CD_MAX_CONCURRENT) {
          // A lost claim (another worker took the row first) is no progress: the runner waits before it looks again.
          const out = await advanceCdPublication(next.id, pass);
          if (out.outcome !== "skipped") progressed = true;
        }
      } finally {
        registry.sending -= 1;
      }
    }
    if (!progressed) {
      if (now() > until) break;
      // The next look: at the soonest wait still to come, at most pollMs away. A row that was due and made no progress (another
      // worker's, over the cap) is looked at again after pollMs — never at once, so a pass that does nothing always sleeps.
      const waits = rows.map((r) => (r.next_attempt_at ? Date.parse(r.next_attempt_at) - now() : pollMs)).filter((ms) => Number.isFinite(ms) && ms > 0);
      await sleep(Math.min(pollMs, ...waits));
    }
  }
  // Per episode, its current row (the active one, else the newest not superseded).
  for (const r of rowsByEpisode(await data.getCdPublications(sys, titleId)).values()) {
    if (r.step === "verified" || r.step === "published") summary.verified.push(r.episode_number);
    else if (r.step === "failed") summary.failed.push(r.episode_number);
    else if (isActiveStep(r.step)) summary.waiting.push(r.episode_number);
  }
  for (const list of [summary.verified, summary.failed, summary.waiting]) list.sort((a, b) => a - b);
  return summary;
}

const underTest = () => !!process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === "test";

/**
 * Fire-and-forget, as the clip cutter's schedule: one runner per title in
 * this process (a second call while one runs asks it to look again when it
 * ends). `CRAZYDRAMAS_UPLOADS=off` disables it; under node:test it runs only
 * when a test asks (`force`).
 */
export function scheduleCrazydramasUploads(titleId: string, opts: { force?: boolean } = {}): void {
  if (process.env.CRAZYDRAMAS_UPLOADS === "off") return;
  if (underTest() && !opts.force) return;
  if (registry.titles.has(titleId)) {
    registry.again.add(titleId);
    return;
  }
  const run = runTitleUploads(titleId)
    .then((s) => {
      if (s.verified.length || s.failed.length) console.log(`[crazydramas] uploads of ${titleId}: verified ${s.verified.join(", ") || "none"}; failed ${s.failed.join(", ") || "none"}; waiting ${s.waiting.join(", ") || "none"}`);
      return s;
    })
    .catch((e) => {
      console.error(`[crazydramas] the uploads of ${titleId} stopped: ${e instanceof Error ? e.message : String(e)}`);
      return { title_id: titleId, passes: 0, verified: [], failed: [], waiting: [] } as RunSummary;
    })
    .finally(() => {
      registry.titles.delete(titleId);
      if (registry.again.delete(titleId)) scheduleCrazydramasUploads(titleId, opts);
    });
  registry.titles.set(titleId, run);
}

/** True while this process runs the title's uploads. */
export function uploadsRunning(titleId: string): boolean {
  return registry.titles.has(titleId);
}

/**
 * The scheduler's step (from tickCrazydramas): every title with an active
 * row that no live lease holds and whose wait is due gets a runner — a
 * restart, a dead worker's stale lease, a Mux wait that came due.
 */
export async function resumeCrazydramasUploads(opts: { now?: () => number } = {}): Promise<string[]> {
  if (process.env.CRAZYDRAMAS_UPLOADS === "off" || underTest()) return [];
  if (crazydramasStudioMode().write === "off") return [];
  const now = (opts.now ?? Date.now)();
  const rows = await getData().listActiveCdPublications(systemSession());
  const titles = [...new Set(rows.filter((r) => !cdLeaseLive(r, now) && (!r.next_attempt_at || Date.parse(r.next_attempt_at) <= now)).map((r) => r.title_id))];
  for (const id of titles) if (!registry.titles.has(id)) scheduleCrazydramasUploads(id);
  return titles;
}

/** Tests: forget the runners and the series cache. */
export function resetCrazydramasUploads(): void {
  registry.titles.clear();
  registry.again.clear();
  registry.sending = 0;
  cache.clear();
}
