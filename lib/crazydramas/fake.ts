// The crazydramas fake (plan A2; phase 5, "Upload to crazydramas"): a
// deterministic crazydramas.com that fixture mode and every test talk to
// instead of the network. Two faces, one store:
//
// 1. The reads of phase 3a — a catalog that mirrors the fixture workspace
//    under tests/fixtures/workspace (the READY film there is `fixture-film`:
//    three episodes of 120, 150 and 180 frames at 30 fps, which is what the
//    import's `ffprobe -count_packets` measures on cut/eps), so fixture mode
//    and the e2e server show every chip state with no network:
//
//      fixture-film              live, complete, every episode "same length"
//      fixture-film-partial      episode 3 is not on crazydramas
//      fixture-film-differs      episode 1 is one older render (+3, "close"), episode 2 is another length
//      fixture-film-processing   episode 3 is still processing on Mux
//      fixture-film-draft        404: nothing uploaded (the public API could not tell it from a draft)
//      fixture-film-broken       the series read fails (in the catalog, unreadable)
//
//    plus the three real series that match no Studio title today, with their
//    placeholder posters, so the staff mirror has something to list. Every
//    one of these was "made in the CMS" (`managed_by: "cms"`): Studio may
//    read them and never change them, as on the live site. The series read
//    answers as the AUTHENTICATED read (`read_via: "studio"`, spec §7: drafts
//    visible, a 404 is "not uploaded"); `readVia = "public"` makes it answer
//    as the public API does (published series and episodes only).
//
// 2. The Studio API of crazydramas docs/STUDIO_API.md, every route, modelled
//    on its service (apps/web/lib/studio-service.ts on crazydramas main):
//    PUT series (create as a Studio draft, update only Studio's own, the
//    title guard `series_title_exists`, `iap_product_id` format and
//    uniqueness, `series_not_draft` without update_live), the episode upload
//    (the decision table: reused, upload_in_progress, episode_busy,
//    webhook_pending, replace_required, replace, episode_changed), the upload
//    status (`episode_is_current`, `ready`, `webhook_pending`), sync, cancel,
//    publish (episodes_not_ready, series_archived, no_published_episodes,
//    the partial `episodes_changed`) and unpublish; the auth answers
//    (not_configured, missing_token, bad_token, insufficient_scope,
//    backend_not_configured) and the 5xx ones (db_error, internal,
//    mux_error) through switches. And Mux behind it: a direct upload whose
//    URL (`fake-mux://upload/<id>`) takes resumable chunk PUTs the way a
//    Google Cloud Storage session does (Content-Range, 308 with `Range:
//    bytes=0-N`, a non-final chunk persisted only up to a multiple of
//    256 KiB, the status query `bytes */total`), the asset created after the
//    last byte, and the webhook turning the episode ready (matched on the
//    upload id for asset_created, on the passthrough for asset.ready).
//
// Nothing here is a credential and nothing reaches a network — the posters
// are two SVGs under public/crazydramas-fake/, served by the app itself, so
// the browser's <img> never asks crazydramas.com in fixture mode or e2e; no
// playback id or thumbnail URL ever leaves the fake through the reads (the
// series read is whitelisted like the live one). The store is in memory: a
// dev-server restart forgets series Studio created in fixture mode while the
// persisted fixture ledger remembers them (fixture mode only).

import { createHash, type Hash } from "node:crypto";
import { z } from "zod";
import type { PlatformDrama, PlatformEpisode, PlatformManagedBy } from "@/lib/types";
import { CrazydramasApiError, type ChunkAnswer, type ChunkRange, type CrazydramasStudioTransport, type CrazydramasTransport, type ImageCheck, type StudioHttpAnswer } from "./transport";
import { type CatalogEntry, isMockSlug, type SeriesRead } from "./types";
import { fakeStatsReport } from "./fake-stats";

/** (frames + MUX_FRAME_OFFSET) / fps to three decimals, the way Mux reports a length. */
const muxLength = (frames: number, fps = 30, offset = 2) => Math.round(((frames + offset) / fps) * 1000) / 1000;

/** The fixture film's frame counts, as ffprobe counts them on tests/fixtures/workspace/low-quality/fixture-film/cut/eps. */
const FIXTURE_FRAMES = [120, 150, 180];

/** Same-origin stand-ins for the platform's poster art; the `-placeholder` name keeps `poster_placeholder` true for the three real series. */
export const FAKE_POSTER_URL = "/crazydramas-fake/poster.svg";
export const FAKE_PLACEHOLDER_POSTER_URL = "/crazydramas-fake/poster-placeholder.svg";

/** The resumable upload quantum: a non-final chunk is persisted only up to a multiple of it (GCS). */
export const FAKE_UPLOAD_QUANTUM = 256 * 1024;

/** meta.creator_id on every upload Studio creates (crazydramas STUDIO_CREATOR_ID). */
const STUDIO_CREATOR_ID = "pulsar-studio";
/** crazydramas BUSY_SHELL_MS: a row set to uploading this recently may be a CMS upload between its row write and its Mux call. */
const BUSY_SHELL_MS = 2 * 60 * 1000;

// ---- the seed: the phase 3a series, as rows of the platform ------------------------------------------------

type SeedSeries = { id: string; slug: string; title: string; episodes: (number | null)[]; statuses?: string[]; placeholder?: boolean; fails?: boolean };

const SEED: SeedSeries[] = [
  { id: "f1000000-0000-4000-8000-000000000001", slug: "fixture-film", title: "Fixture Film", episodes: FIXTURE_FRAMES.map((f) => muxLength(f)) },
  { id: "f1000000-0000-4000-8000-000000000002", slug: "fixture-film-partial", title: "Fixture Film (partial)", episodes: FIXTURE_FRAMES.slice(0, 2).map((f) => muxLength(f)) },
  { id: "f1000000-0000-4000-8000-000000000003", slug: "fixture-film-differs", title: "Fixture Film (differs)", episodes: [muxLength(FIXTURE_FRAMES[0], 30, 3), 5.5, muxLength(FIXTURE_FRAMES[2])] },
  { id: "f1000000-0000-4000-8000-000000000004", slug: "fixture-film-processing", title: "Fixture Film (processing)", episodes: [muxLength(FIXTURE_FRAMES[0]), muxLength(FIXTURE_FRAMES[1]), null], statuses: ["ready", "ready", "processing"] },
  { id: "f1000000-0000-4000-8000-000000000006", slug: "fixture-film-broken", title: "Fixture Film (unreadable)", episodes: [], fails: true },
  // The three live series with no Studio title (plan A4, the staff mirror), as the catalog listed them on 2026-09-23.
  { id: "ad79296b-e500-4a7b-a53a-bf0af576bc46", slug: "he-mocked-her-crush-on-him-and-sent-her", title: "He Mocked Her Crush on Him and Sent Her", episodes: Array.from({ length: 25 }, (_, i) => 90 + (i % 7) * 5.1), placeholder: true },
  { id: "cd441acd-4269-41e3-83ec-e3cc43c25859", slug: "he-treated-our-love-like-a-prank", title: "He Treated Our Love Like a Prank", episodes: Array.from({ length: 28 }, (_, i) => 88 + (i % 5) * 6.2), placeholder: true },
  { id: "3eac5840-6c66-4e47-a8e5-32cefa9cb49e", slug: "ever-since-i-played-that-game-paranormal", title: "Ever Since I Played That Game (Paranormal)", episodes: Array.from({ length: 60 }, (_, i) => 95 + (i % 9) * 3.3), placeholder: true },
];

/** The fixture slugs, for the e2e specs and the docs: one per chip state. */
export const FAKE_SLUGS = {
  complete: "fixture-film",
  partial: "fixture-film-partial",
  differs: "fixture-film-differs",
  processing: "fixture-film-processing",
  draft: "fixture-film-draft",
  broken: "fixture-film-broken",
} as const;

// ---- the platform's rows ---------------------------------------------------------------------------------------

export type FakeDrama = {
  id: string;
  slug: string;
  title: string;
  original_title: string | null;
  tagline: string | null;
  description: string | null;
  genre: string[];
  language: string;
  status: "draft" | "published" | "archived";
  free_episode_count: number;
  series_price_cents: number | null;
  iap_product_id: string | null;
  cta_mode: string;
  poster_url: string | null;
  poster_blurhash: string | null;
  sort_order: number;
  managed_by: PlatformManagedBy;
  created_at: string;
  updated_at: string;
  /** When the series last went live (the public read's cache lag counts from here); absent for the seeded ones. */
  live_since?: number;
};

export type FakeEpisode = {
  id: string;
  drama_id: string;
  episode_number: number;
  title: string | null;
  status: "uploading" | "processing" | "ready" | "failed";
  is_published: boolean;
  mux_upload_id: string | null;
  mux_asset_id: string | null;
  mux_playback_id: string | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  updated_at: string;
  /** When the episode was last published (the public read's cache lag counts from here); absent for the seeded ones. */
  published_since?: number;
};

export type FakeUpload = {
  id: string;
  url: string;
  status: "waiting" | "asset_created" | "errored" | "cancelled" | "timed_out";
  asset_id: string | null;
  error: string | null;
  timeout: number;
  passthrough: string | null;
  meta: { external_id?: string; title?: string; creator_id?: string };
  /** What Studio declared on the upload call (only echoed on crazydramas; the fake derives the asset's length from it). */
  declared: { bytes: number | null; frames: number | null };
  /** Bytes persisted so far and the total the first chunk named. */
  received: number;
  total: number | null;
  hash: Hash;
  /** SHA-256 of the bytes received, once complete. */
  received_sha256: string | null;
};

export type FakeAsset = {
  id: string;
  status: "preparing" | "ready" | "errored";
  duration: number | null;
  meta: FakeUpload["meta"];
  passthrough: string | null;
  playback_ids: { id: string; policy: string }[];
  errors: unknown;
  created_at: string;
  /** Status reads left before it turns ready (Mux processing, modelled). */
  reads_left: number;
  upload_id: string;
  /** The length Mux will report once ready. */
  pending_duration: number;
};

/** One chunk PUT the fake received, for the tests. */
export type FakeChunkLog = { upload_id: string; first: number | null; last: number | null; total: number; bytes: number; status: number; acked: number | null };

/** A 5xx or other answer switched on for the next call(s). */
type FailSwitch = { status: number; code: string; error: string; match?: RegExp; times: number };

const iso = (ms: number) => new Date(ms).toISOString();

/** crazydramas titleKey: title comparison that ignores case, spacing and punctuation. */
function titleKey(title: string | null | undefined): string {
  return (title ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// ---- the contract's bodies (STUDIO_API.md; crazydramas studio-service.ts) --------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UPLOAD_ID_RE = /^[A-Za-z0-9]{1,128}$/;
const IAP_PRODUCT_ID_RE = /^[a-z0-9][a-z0-9_.]{0,39}$/;
const MAX_EPISODE = 500;

const httpsUrl = z.string().trim().url().max(2000).refine((u) => u.startsWith("https://"), { message: "must be an https URL" });
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const SeriesPutBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    original_title: optionalText(200),
    tagline: optionalText(300),
    description: optionalText(5000),
    genre: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
    language: z.string().trim().min(2).max(16).optional(),
    free_episode_count: z.number().int().min(0).max(MAX_EPISODE).optional(),
    series_price_cents: z.number().int().min(0).max(100_000).nullable().optional(),
    iap_product_id: z.string().trim().regex(IAP_PRODUCT_ID_RE, "must be at most 40 characters of lowercase letters, digits, _ and . (e.g. cd.series.short_name)").nullable().optional(),
    cta_mode: z.enum(["app", "web_checkout", "waitlist"]).optional(),
    poster_url: httpsUrl.nullable().optional(),
    poster_blurhash: z.string().trim().min(6).max(200).nullable().optional(),
    update_live: z.boolean().optional(),
  })
  .strict();

const UploadBody = z
  .object({
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters").transform((s) => s.toLowerCase()),
    bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    frames: z.number().int().positive().optional(),
    replace: z.boolean().optional(),
  })
  .strict();

const episodeList = z.array(z.number().int().min(1).max(MAX_EPISODE)).max(MAX_EPISODE);
const PublishBody = z.object({ episodes: episodeList.optional(), publish_series: z.boolean().optional() }).strict().refine((b) => (b.episodes?.length ?? 0) > 0 || b.publish_series === true, { message: "list episodes and/or set publish_series" });
const UnpublishBody = z.object({ episodes: episodeList.optional(), unpublish_series: z.boolean().optional() }).strict().refine((b) => (b.episodes?.length ?? 0) > 0 || b.unpublish_series === true, { message: "list episodes and/or set unpublish_series" });

const PUT_FIELDS = ["title", "original_title", "tagline", "description", "genre", "language", "free_episode_count", "series_price_cents", "iap_product_id", "cta_mode", "poster_url", "poster_blurhash"] as const;
const FAKE_BLURHASH = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";

function fail(status: number, code: string, error: string, extra: Record<string, unknown> = {}): StudioHttpAnswer {
  return { status, body: { error, code, ...extra } };
}

function badRequest(error: z.ZodError): StudioHttpAnswer {
  return fail(400, "bad_request", "Invalid request body", { issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return (a ?? null) === (b ?? null);
}

const uniqueSorted = (nums: number[] | undefined) => [...new Set(nums ?? [])].sort((a, b) => a - b);

type Media = { state: "empty" | "in_flight" | "ready" | "dead"; upload: FakeUpload | null; asset: FakeAsset | null };

/** CRAZYDRAMAS_FAKE_PUBLIC_LAG_MS (fixture mode): how far the fake's public read trails a publish; 0 when unset or not a number. */
function fakePublicLagMs(): number {
  const n = Number(process.env.CRAZYDRAMAS_FAKE_PUBLIC_LAG_MS ?? "");
  return Number.isFinite(n) && n > 0 ? Math.min(n, 120_000) : 0;
}

/** The rule of the fake poster check (the poster-check route's fixture answer): an https image name answers 200, one named "missing" 404. */
const IMAGE_NAME = /\.(jpe?g|png|webp|avif|gif)$/i;

// ---- the fake ------------------------------------------------------------------------------------------------------

/** The fixture transport: the reads and the Studio API answer from one in-memory crazydramas, with no network. */
export class FakeCrazydramasTransport implements CrazydramasTransport, CrazydramasStudioTransport {
  readonly mode = "fake" as const;
  /** The phase 3a reads, in order. */
  readonly calls: { what: "catalog" | "series" | "public"; slug?: string }[] = [];
  /** Every Studio API request, in order (method, path and the status answered; never a body). */
  readonly requests: { method: string; path: string; status: number }[] = [];
  /** Every chunk PUT to a fake Mux upload URL. */
  readonly chunks: FakeChunkLog[] = [];
  /** Tests: make the next catalog read fail. */
  failCatalogOnce = false;
  /** `studio` (the default: the token is configured) or `public` (the public API's view: published only, no managed_by). */
  readVia: "studio" | "public" = "studio";
  /** Auth as crazydramas would answer it: `ok`, or one of the contract's refusals for every route. */
  auth: "ok" | "not_configured" | "missing_token" | "bad_token" | "read_only" | "backend_not_configured" = "ok";
  /** Status reads of an upload before its asset turns ready (Mux processing). */
  readyAfterReads = 1;
  /** The webhook never arrives: rows stay behind Mux until someone syncs (webhook_pending). */
  webhookMissed = false;
  /** The next asset errors instead of turning ready. */
  assetErrors = false;
  /** Frames added to the next assets' length (a file Mux measures otherwise: verify fails). */
  durationOffsetFrames = 0;
  /** The next asset's meta.external_id, when a test wants it to disagree with the sha Studio sent. */
  externalIdOverride: string | null = null;
  /** The next non-final chunk is persisted this many bytes short of what was sent (the storage may persist fewer). */
  persistShortOnce = 0;
  /** The next PUT create for a new slug loses a race (409 conflict_retry). */
  raceNextCreate = false;
  /** The next upload call finds the row written mid-call (409 episode_changed, the new upload cancelled). */
  raceNextUpload = false;
  /** The episodes that stop being ready between publish's check and its write (the partial episodes_changed). */
  flipOnPublish: number[] = [];
  /** Called after every chunk the fake persisted (tests: a CMS takeover, a crash). */
  onChunk: ((log: FakeChunkLog) => void) | null = null;
  /** The clock (episode_busy's two minutes). */
  now: () => number = () => Date.now();
  /**
   * The public API's cache (up to 60 s on the live site): a series or an
   * episode published less than this long ago is not in `publicSeries` yet.
   * 0 by default (tests); fixture mode reads CRAZYDRAMAS_FAKE_PUBLIC_LAG_MS so
   * the publish progress can be seen waiting.
   */
  publicLagMs = fakePublicLagMs();

  private dramas: FakeDrama[] = [];
  private episodes: FakeEpisode[] = [];
  private uploads = new Map<string, FakeUpload>();
  private assets = new Map<string, FakeAsset>();
  private failing = new Set<string>();
  private switches: FailSwitch[] = [];
  private fpsBySha = new Map<string, number>();
  private seq = 0;

  constructor() {
    this.seed();
  }

  /** Back to the seed: every switch off, every call forgotten, the store rebuilt. */
  reset(): void {
    this.calls.length = 0;
    this.requests.length = 0;
    this.chunks.length = 0;
    this.failCatalogOnce = false;
    this.readVia = "studio";
    this.auth = "ok";
    this.readyAfterReads = 1;
    this.webhookMissed = false;
    this.assetErrors = false;
    this.durationOffsetFrames = 0;
    this.externalIdOverride = null;
    this.persistShortOnce = 0;
    this.raceNextCreate = false;
    this.raceNextUpload = false;
    this.flipOnPublish = [];
    this.onChunk = null;
    this.now = () => Date.now();
    this.publicLagMs = fakePublicLagMs();
    this.switches = [];
    this.fpsBySha.clear();
    this.seed();
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq.toString(36).padStart(6, "0")}`;
  }

  private uuid(): string {
    this.seq += 1;
    return `fa4e0000-0000-4000-8000-${this.seq.toString(16).padStart(12, "0")}`;
  }

  private seed(): void {
    this.dramas = [];
    this.episodes = [];
    this.uploads.clear();
    this.assets.clear();
    this.failing.clear();
    const at = "2026-09-01T00:00:00.000Z";
    for (const s of SEED) {
      this.dramas.push({
        id: s.id,
        slug: s.slug,
        title: s.title,
        original_title: null,
        tagline: null,
        description: null,
        genre: [],
        language: "en",
        status: "published",
        free_episode_count: Math.min(5, s.episodes.length || 3),
        series_price_cents: 999,
        iap_product_id: `crazydrama.series.${s.slug.replace(/-/g, "_")}`,
        cta_mode: "web_checkout",
        poster_url: s.placeholder ? FAKE_PLACEHOLDER_POSTER_URL : FAKE_POSTER_URL,
        poster_blurhash: "LIDuMMRk9G=_}=ay-QxZr;xZ={NG",
        sort_order: 0,
        managed_by: "cms",
        created_at: at,
        updated_at: at,
      });
      if (s.fails) this.failing.add(s.slug);
      s.episodes.forEach((duration, i) => {
        const status = (s.statuses?.[i] ?? "ready") as FakeEpisode["status"];
        this.episodes.push({
          id: this.uuid(),
          drama_id: s.id,
          episode_number: i + 1,
          title: null,
          status,
          is_published: true,
          mux_upload_id: null,
          mux_asset_id: status === "ready" ? this.id("ASSETcms") : null,
          mux_playback_id: status === "ready" ? this.id("PLAYcms") : null,
          duration_seconds: duration,
          thumbnail_url: null,
          updated_at: at,
        });
      });
    }
  }

  // ---- test switches and views ----------------------------------------------------------------------------------

  /** Answer the next `times` Studio API calls (whose path matches, when given) with this error: db_error / internal (500), mux_error (502), or any code. */
  failNext(code: string, opts: { status?: number; match?: RegExp; times?: number; error?: string } = {}): void {
    const status = opts.status ?? (code === "mux_error" ? 502 : 500);
    this.switches.push({ status, code, error: opts.error ?? `fake ${code}`, match: opts.match, times: opts.times ?? 1 });
  }

  /** The platform's view of one series, for assertions: the drama, its episode rows and every upload made on them. */
  seriesState(slug: string): { drama: FakeDrama; episodes: FakeEpisode[]; uploads: FakeUpload[] } | null {
    const drama = this.dramas.find((d) => d.slug === slug);
    if (!drama) return null;
    const episodes = this.episodes.filter((e) => e.drama_id === drama.id).sort((a, b) => a.episode_number - b.episode_number);
    const ids = new Set(episodes.map((e) => e.id));
    const uploads = [...this.uploads.values()].filter((u) => u.passthrough && ids.has(u.passthrough));
    return { drama: { ...drama }, episodes: episodes.map((e) => ({ ...e })), uploads };
  }

  /** The uploads Studio created for one episode, oldest first. */
  uploadsFor(slug: string, n: number): FakeUpload[] {
    const state = this.seriesState(slug);
    const ep = state?.episodes.find((e) => e.episode_number === n);
    if (!state || !ep) return [];
    return state.uploads.filter((u) => u.passthrough === ep.id && u.meta.creator_id === STUDIO_CREATOR_ID);
  }

  getUpload(id: string): FakeUpload | null {
    return this.uploads.get(id) ?? null;
  }

  getAsset(id: string): FakeAsset | null {
    return this.assets.get(id) ?? null;
  }

  /** A series made in the CMS (managed_by cms), with ready, published episodes: Studio may read it, never change it. */
  addCmsSeries(slug: string, title: string, durations: number[], opts: { status?: FakeDrama["status"]; original_title?: string | null } = {}): FakeDrama {
    const at = iso(this.now());
    const drama: FakeDrama = { id: this.uuid(), slug, title, original_title: opts.original_title ?? null, tagline: null, description: null, genre: [], language: "en", status: opts.status ?? "published", free_episode_count: 5, series_price_cents: 999, iap_product_id: null, cta_mode: "app", poster_url: null, poster_blurhash: null, sort_order: 0, managed_by: "cms", created_at: at, updated_at: at };
    this.dramas.push(drama);
    durations.forEach((d, i) => this.episodes.push({ id: this.uuid(), drama_id: drama.id, episode_number: i + 1, title: null, status: "ready", is_published: true, mux_upload_id: null, mux_asset_id: this.id("ASSETcms"), mux_playback_id: this.id("PLAYcms"), duration_seconds: d, thumbnail_url: null, updated_at: at }));
    return { ...drama };
  }

  /** Jayden's one SQL line: hand a series to Studio (or take it back). */
  setManagedBy(slug: string, managedBy: PlatformManagedBy): void {
    const drama = this.dramas.find((d) => d.slug === slug);
    if (!drama) throw new Error(`fake: no series ${slug}`);
    drama.managed_by = managedBy;
  }

  /** The CMS archives (or restores) a series. */
  setSeriesStatus(slug: string, status: FakeDrama["status"]): void {
    const drama = this.dramas.find((d) => d.slug === slug);
    if (!drama) throw new Error(`fake: no series ${slug}`);
    drama.status = status;
  }

  /**
   * A CMS upload starts on the episode (the contract's known race): the CMS
   * route upserts the row to `uploading` and writes its own mux_upload_id
   * without any condition, so Studio's upload is no longer the row's
   * (`episode_is_current: false`).
   */
  takeOver(slug: string, n: number): string {
    const drama = this.dramas.find((d) => d.slug === slug);
    const row = drama && this.episodes.find((e) => e.drama_id === drama.id && e.episode_number === n);
    if (!drama || !row) throw new Error(`fake: no episode ${slug} ${n}`);
    const upload = this.createUpload(row.id, { title: `${slug} ep${n}` }, { bytes: null, frames: null });
    row.mux_upload_id = upload.id;
    row.status = "uploading";
    row.updated_at = iso(this.now());
    return upload.id;
  }

  /** Mux times an upload out (an hour with no complete PUT). */
  expireUpload(uploadId: string): void {
    const u = this.uploads.get(uploadId);
    if (u && u.status === "waiting") u.status = "timed_out";
  }

  /** Every asset still processing finishes now, and the webhook runs unless it is switched off. */
  settleAll(): void {
    for (const a of this.assets.values()) if (a.status === "preparing") this.finishAsset(a);
  }

  /**
   * The file facts only the file itself holds (its frame rate): the uploader
   * tells the fake, so the asset's length is what Mux would measure on those
   * frames. The live transport has no such method; Mux reads the file.
   */
  hintFileFacts(sha256: string, facts: { fps: number | null }): void {
    if (facts.fps && facts.fps > 0) this.fpsBySha.set(sha256.toLowerCase(), facts.fps);
  }

  // ---- the phase 3a reads -------------------------------------------------------------------------------------

  private platformDrama(d: FakeDrama, count: number, withManaged: boolean): PlatformDrama {
    return {
      id: d.id,
      slug: d.slug,
      title: d.title,
      status: d.status,
      language: d.language,
      free_episode_count: d.free_episode_count,
      series_price_cents: d.series_price_cents,
      iap_product_id: d.iap_product_id,
      poster_url: d.poster_url,
      poster_blurhash: d.poster_blurhash,
      episode_count: count,
      cta_mode: d.cta_mode,
      ...(withManaged ? { managed_by: d.managed_by } : {}),
    };
  }

  async catalog(): Promise<CatalogEntry[]> {
    this.calls.push({ what: "catalog" });
    if (this.failCatalogOnce) {
      this.failCatalogOnce = false;
      throw new CrazydramasApiError("crazydramas did not answer (timeout, DNS or a refused connection).");
    }
    return this.dramas
      .filter((d) => d.status === "published" && !isMockSlug(d.slug))
      // The unreadable series lists the three episodes the catalog named for it (its series read fails).
      .map((d) => this.platformDrama(d, this.failing.has(d.slug) ? 3 : this.episodes.filter((e) => e.drama_id === d.id && e.is_published).length, false));
  }

  async series(slug: string): Promise<SeriesRead> {
    this.calls.push({ what: "series", slug });
    const drama = this.dramas.find((d) => d.slug === slug);
    const studio = this.readVia === "studio";
    if (!drama || isMockSlug(slug) || (!studio && drama.status !== "published")) return { http_status: 404, drama: null, episodes: null, read_via: this.readVia };
    if (this.failing.has(slug)) throw new CrazydramasApiError("crazydramas answered HTTP 502.", 502);
    const rows = this.episodes.filter((e) => e.drama_id === drama.id && (studio || e.is_published)).sort((a, b) => a.episode_number - b.episode_number);
    const episodes: PlatformEpisode[] = rows.map((e) => ({ n: e.episode_number, duration_s: e.duration_seconds, status: e.status, is_published: e.is_published }));
    return { http_status: 200, drama: this.platformDrama(drama, episodes.length, studio), episodes, read_via: this.readVia };
  }

  /** The public read (`GET /api/dramas/<slug>`): published only, and nothing published within `publicLagMs` (the cache). */
  async publicSeries(slug: string): Promise<SeriesRead> {
    this.calls.push({ what: "public", slug });
    const drama = this.dramas.find((d) => d.slug === slug);
    const cutoff = this.now() - this.publicLagMs;
    const seen = (at: number | undefined) => at === undefined || at <= cutoff;
    if (!drama || isMockSlug(slug) || drama.status !== "published" || !seen(drama.live_since)) return { http_status: 404, drama: null, episodes: null, read_via: "public" };
    if (this.failing.has(slug)) throw new CrazydramasApiError("crazydramas answered HTTP 502.", 502);
    const rows = this.episodes.filter((e) => e.drama_id === drama.id && e.is_published && seen(e.published_since)).sort((a, b) => a.episode_number - b.episode_number);
    const episodes: PlatformEpisode[] = rows.map((e) => ({ n: e.episode_number, duration_s: e.duration_seconds, status: e.status, is_published: e.is_published }));
    return { http_status: 200, drama: this.platformDrama(drama, episodes.length, false), episodes, read_via: "public" };
  }

  // ---- the Studio API -----------------------------------------------------------------------------------------

  async request(method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<StudioHttpAnswer> {
    const answer = this.route(method, path, body);
    this.requests.push({ method, path, status: answer.status });
    return JSON.parse(JSON.stringify(answer)) as StudioHttpAnswer;
  }

  private route(method: string, path: string, body: unknown): StudioHttpAnswer {
    const write = method !== "GET";
    if (this.auth === "not_configured") return fail(503, "not_configured", "Studio API not configured");
    if (this.auth === "missing_token") return fail(401, "missing_token", "Missing bearer token");
    if (this.auth === "bad_token") return fail(401, "bad_token", "Invalid token");
    if (this.auth === "read_only" && write) return fail(403, "insufficient_scope", "The read token cannot write");
    if (this.auth === "backend_not_configured") return fail(503, "backend_not_configured", "Supabase and Mux must both be configured");
    const sw = this.switches.find((s) => !s.match || s.match.test(path));
    if (sw) {
      sw.times -= 1;
      if (sw.times <= 0) this.switches.splice(this.switches.indexOf(sw), 1);
      return fail(sw.status, sw.code, sw.error);
    }
    if (write && typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return fail(400, "bad_json", "Body is not valid JSON");
      }
    }
    const raw = body ?? {};
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/api\/studio\/series\/([^/]+)$/))) {
      const key = decodeURIComponent(m[1]);
      if (method === "GET") return this.getSeries(key);
      if (method === "PUT") return this.putSeries(key, raw);
    }
    if ((m = path.match(/^\/api\/studio\/series\/([^/]+)\/episodes\/([^/]+)\/upload$/)) && method === "POST") return this.createEpisodeUpload(decodeURIComponent(m[1]), decodeURIComponent(m[2]), raw);
    if ((m = path.match(/^\/api\/studio\/series\/([^/]+)\/publish$/)) && method === "POST") return this.publish(decodeURIComponent(m[1]), raw);
    if ((m = path.match(/^\/api\/studio\/series\/([^/]+)\/unpublish$/)) && method === "POST") return this.unpublish(decodeURIComponent(m[1]), raw);
    if ((m = path.match(/^\/api\/studio\/uploads\/([^/]+)$/)) && method === "GET") return this.getUploadStatus(decodeURIComponent(m[1]));
    if ((m = path.match(/^\/api\/studio\/uploads\/([^/]+)\/sync$/)) && method === "POST") return this.syncUpload(decodeURIComponent(m[1]));
    if ((m = path.match(/^\/api\/studio\/uploads\/([^/]+)\/cancel$/)) && method === "POST") return this.cancelUpload(decodeURIComponent(m[1]));
    // The stats report (2026-09-24): invented, deterministic numbers over the fake's own series.
    if (path === "/api/studio/stats" && method === "GET") return { status: 200, body: fakeStatsReport(this.dramas, this.episodes) };
    return fail(404, "not_found", "No such route");
  }

  private findDrama(key: string): FakeDrama | null {
    if (UUID_RE.test(key)) {
      const byId = this.dramas.find((d) => d.id === key.toLowerCase());
      if (byId) return byId;
    }
    return this.dramas.find((d) => d.slug === key) ?? null;
  }

  private seriesOut(d: FakeDrama) {
    return { ...d, genre: [...d.genre] };
  }

  private episodeOut(e: FakeEpisode) {
    return { id: e.id, drama_id: e.drama_id, episode_number: e.episode_number, title: e.title, status: e.status, is_published: e.is_published, mux_upload_id: e.mux_upload_id, mux_asset_id: e.mux_asset_id, playback_id: e.mux_playback_id, duration_seconds: e.duration_seconds, updated_at: e.updated_at };
  }

  private uploadOut(u: FakeUpload) {
    return { id: u.id, status: u.status, asset_id: u.asset_id, error: u.error, timeout: u.timeout, passthrough: u.passthrough, meta: { ...u.meta }, from_studio: u.meta.creator_id === STUDIO_CREATOR_ID };
  }

  private assetOut(a: FakeAsset) {
    return { id: a.id, status: a.status, duration: a.duration, meta: { ...a.meta }, passthrough: a.passthrough, playback_ids: a.playback_ids.map((p) => ({ ...p })), errors: a.errors, created_at: a.created_at };
  }

  private notStudio(drama: FakeDrama): StudioHttpAnswer | null {
    if (drama.managed_by === "studio") return null;
    return fail(403, "series_not_studio", `Series "${drama.slug}" is managed in the CMS; Studio can read it but not change it. Nothing was changed`, { series: { id: drama.id, slug: drama.slug, status: drama.status, managed_by: drama.managed_by } });
  }

  private titleTwin(titles: (string | null | undefined)[], excludeId: string | null): FakeDrama | null {
    const wanted = new Set(titles.map(titleKey).filter(Boolean));
    if (!wanted.size) return null;
    return this.dramas.find((d) => d.id !== excludeId && (wanted.has(titleKey(d.title)) || (d.original_title !== null && wanted.has(titleKey(d.original_title))))) ?? null;
  }

  private titleExists(twin: FakeDrama): StudioHttpAnswer {
    return fail(409, "series_title_exists", `A series with this title already exists as "${twin.slug}" (${twin.status}); use that slug or a different title. Nothing was changed`, { existing: { id: twin.id, slug: twin.slug, title: twin.title, status: twin.status, managed_by: twin.managed_by } });
  }

  private iapTaken(id: unknown): StudioHttpAnswer {
    return fail(409, "iap_product_id_taken", `Another series already uses iap_product_id "${String(id)}"; product ids are one per series. Nothing was changed`, { iap_product_id: id });
  }

  private getSeries(key: string): StudioHttpAnswer {
    const drama = this.findDrama(key);
    if (!drama) return fail(404, "series_not_found", `No series with slug or id "${key}"`);
    if (this.failing.has(drama.slug)) return fail(500, "db_error", "read series: fake failure");
    const episodes = this.episodes.filter((e) => e.drama_id === drama.id).sort((a, b) => a.episode_number - b.episode_number);
    return { status: 200, body: { series: this.seriesOut(drama), episodes: episodes.map((e) => this.episodeOut(e)) } };
  }

  private putSeries(slug: string, raw: unknown): StudioHttpAnswer {
    if (UUID_RE.test(slug)) return fail(400, "bad_slug", "PUT takes the series slug, not its id");
    if (slug.length > 80 || !SLUG_RE.test(slug)) return fail(400, "bad_slug", "Slug must be lowercase letters and digits joined by single hyphens (max 80)");
    const parsed = SeriesPutBody.safeParse(raw);
    if (!parsed.success) return badRequest(parsed.error);
    const body = parsed.data;
    const existing = this.dramas.find((d) => d.slug === slug) ?? null;
    const at = iso(this.now());
    if (!existing) {
      if (!body.title) return fail(400, "title_required", "title is required to create a series");
      if (this.raceNextCreate) {
        this.raceNextCreate = false;
        return fail(409, "conflict_retry", "A series with this slug was created at the same moment; retry the PUT");
      }
      const twin = this.titleTwin([body.title, body.original_title], null);
      if (twin) return this.titleExists(twin);
      const iap = body.iap_product_id ?? null;
      if (iap && this.dramas.some((d) => d.iap_product_id === iap)) return this.iapTaken(iap);
      const posterUrl = body.poster_url ?? null;
      const drama: FakeDrama = {
        id: this.uuid(),
        slug,
        title: body.title,
        original_title: body.original_title ?? null,
        tagline: body.tagline ?? null,
        description: body.description ?? null,
        genre: body.genre ?? [],
        language: body.language ?? "en",
        status: "draft",
        free_episode_count: body.free_episode_count ?? 5,
        series_price_cents: body.series_price_cents === undefined ? 999 : body.series_price_cents,
        iap_product_id: iap,
        cta_mode: body.cta_mode ?? "app",
        poster_url: posterUrl,
        poster_blurhash: body.poster_blurhash !== undefined ? body.poster_blurhash : posterUrl ? FAKE_BLURHASH : null,
        sort_order: 0,
        managed_by: "studio",
        created_at: at,
        updated_at: at,
      };
      this.dramas.push(drama);
      const changed = ["slug", "managed_by", "title", "original_title", "tagline", "description", "genre", "language", "status", "free_episode_count", "series_price_cents", "iap_product_id", "poster_url", "poster_blurhash", ...(body.cta_mode ? ["cta_mode"] : [])];
      return { status: 201, body: { created: true, changed, series: this.seriesOut(drama) } };
    }
    const refused = this.notStudio(existing);
    if (refused) return refused;
    const patch: Record<string, unknown> = {};
    for (const field of PUT_FIELDS) {
      const value = body[field];
      if (value === undefined) continue;
      if (!sameValue(existing[field], value)) patch[field] = value;
    }
    const isDraft = existing.status === "draft";
    if (Object.keys(patch).length > 0 && !isDraft && !body.update_live) return fail(409, "series_not_draft", `Series is ${existing.status}; send update_live:true to change its metadata`, { status: existing.status, would_change: Object.keys(patch) });
    if ("title" in patch || "original_title" in patch) {
      const twin = this.titleTwin(["title" in patch ? (patch.title as string) : null, "original_title" in patch ? (patch.original_title as string | null) : null], existing.id);
      if (twin) return this.titleExists(twin);
    }
    if ("iap_product_id" in patch && patch.iap_product_id && this.dramas.some((d) => d.id !== existing.id && d.iap_product_id === patch.iap_product_id)) return this.iapTaken(patch.iap_product_id);
    if (body.poster_blurhash === undefined && (isDraft || body.update_live)) {
      const nextPoster = body.poster_url !== undefined ? body.poster_url : existing.poster_url;
      if (!nextPoster) {
        if (existing.poster_blurhash !== null) patch.poster_blurhash = null;
      } else if ((nextPoster !== existing.poster_url || !existing.poster_blurhash) && existing.poster_blurhash !== FAKE_BLURHASH) {
        patch.poster_blurhash = FAKE_BLURHASH;
      }
    }
    const changed = Object.keys(patch);
    if (changed.length) Object.assign(existing, patch, { updated_at: at });
    return { status: 200, body: { created: false, changed, series: this.seriesOut(existing) } };
  }

  private createUpload(passthrough: string, meta: FakeUpload["meta"], declared: FakeUpload["declared"]): FakeUpload {
    const id = this.id("UP");
    const upload: FakeUpload = { id, url: `fake-mux://upload/${id}`, status: "waiting", asset_id: null, error: null, timeout: 3600, passthrough, meta, declared, received: 0, total: null, hash: createHash("sha256"), received_sha256: null };
    this.uploads.set(id, upload);
    return upload;
  }

  private inspectMedia(row: FakeEpisode): Media {
    if (!row.mux_upload_id && !row.mux_asset_id && !row.mux_playback_id) return { state: "empty", upload: null, asset: null };
    const upload = row.mux_upload_id ? this.uploads.get(row.mux_upload_id) ?? null : null;
    if (upload) {
      if (upload.status === "errored" || upload.status === "cancelled" || upload.status === "timed_out") return { state: "dead", upload, asset: null };
      if (upload.status === "asset_created" && upload.asset_id) {
        const asset = this.assets.get(upload.asset_id) ?? null;
        if (!asset) return { state: "dead", upload, asset: null };
        if (asset.status === "preparing") return { state: "in_flight", upload, asset };
        return { state: asset.status === "ready" ? "ready" : "dead", upload, asset };
      }
      return { state: "in_flight", upload, asset: null };
    }
    if (row.mux_asset_id && (row.status === "uploading" || row.status === "processing")) {
      const asset = this.assets.get(row.mux_asset_id) ?? null;
      if (asset?.status === "preparing") return { state: "in_flight", upload: null, asset };
      if (asset) return { state: asset.status === "ready" ? "ready" : "dead", upload: null, asset };
      return { state: "dead", upload: null, asset: null };
    }
    return { state: row.status === "ready" ? "ready" : "dead", upload: null, asset: null };
  }

  private isStudioUploadOf(upload: FakeUpload | null, sha256: string, episodeId: string): boolean {
    return !!upload && upload.meta.creator_id === STUDIO_CREATOR_ID && upload.meta.external_id === sha256 && upload.passthrough === episodeId;
  }

  private createEpisodeUpload(key: string, nRaw: string, raw: unknown): StudioHttpAnswer {
    if (!/^[1-9][0-9]{0,2}$/.test(nRaw) || Number(nRaw) > MAX_EPISODE) return fail(400, "bad_episode_number", `Episode number must be 1-${MAX_EPISODE}`);
    const n = Number(nRaw);
    const parsed = UploadBody.safeParse(raw);
    if (!parsed.success) return badRequest(parsed.error);
    const { sha256, bytes, frames, replace = false } = parsed.data;
    const drama = this.findDrama(key);
    if (!drama) return fail(404, "series_not_found", `No series with slug or id "${key}"`);
    const refused = this.notStudio(drama);
    if (refused) return refused;
    const row = this.episodes.find((e) => e.drama_id === drama.id && e.episode_number === n) ?? null;
    if (!row) return this.startUpload(drama, n, sha256, bytes, frames ?? null, null, false);
    const media = this.inspectMedia(row);
    const current = { state: media.state, episode_status: row.status, upload_id: row.mux_upload_id, upload_status: media.upload?.status ?? null, asset_id: media.upload?.asset_id ?? row.mux_asset_id, asset_status: media.asset?.status ?? null, from_studio: media.upload?.meta.creator_id === STUDIO_CREATOR_ID };
    const age = this.now() - Date.parse(row.updated_at);
    if (media.state !== "in_flight" && row.status === "uploading" && age < BUSY_SHELL_MS) {
      return fail(409, "episode_busy", `Episode ${n} was just set to uploading by someone else (a CMS upload starting?); nothing was changed. Retry in a few minutes`, { upload_id: row.mux_upload_id, current });
    }
    if (media.state === "empty") return this.startUpload(drama, n, sha256, bytes, frames ?? null, row, false);
    const sameFile = this.isStudioUploadOf(media.upload, sha256, row.id);
    if (media.state === "in_flight") {
      if (sameFile && media.upload) {
        const waiting = media.upload.status === "waiting";
        return { status: 200, body: { reused: true, created: false, episode_id: row.id, drama_id: drama.id, episode_number: n, upload_id: media.upload.id, upload_url: waiting ? media.upload.url : null, upload_status: media.upload.status, status: row.status, is_published: row.is_published, sha256, bytes, frames: frames ?? null, changed: [] } };
      }
      return fail(409, "upload_in_progress", `Episode ${n} has an upload in progress (${row.mux_upload_id ?? current.asset_id}); nothing was changed`, { upload_id: row.mux_upload_id, current });
    }
    if (sameFile && media.state === "ready" && media.upload && !(row.status === "ready" && row.mux_asset_id === media.upload.asset_id)) {
      return fail(409, "webhook_pending", `Episode ${n}'s upload of this file is ready in Mux but the episode row has not recorded it (webhook missed or late); POST /api/studio/uploads/${media.upload.id}/sync. Nothing was changed`, { upload_id: media.upload.id, asset_id: media.upload.asset_id ?? null, current });
    }
    if (sameFile && media.state === "ready" && media.upload) {
      return { status: 200, body: { reused: true, created: false, episode_id: row.id, drama_id: drama.id, episode_number: n, upload_id: media.upload.id, upload_url: null, upload_status: media.upload.status, status: row.status, is_published: row.is_published, asset_id: row.mux_asset_id, playback_id: row.mux_playback_id, duration_seconds: row.duration_seconds, sha256, bytes, frames: frames ?? null, changed: [] } };
    }
    if (!replace) return fail(409, "replace_required", `Episode ${n} already has media (${media.state}); send replace:true to upload a new version`, { upload_id: row.mux_upload_id, current });
    return this.startUpload(drama, n, sha256, bytes, frames ?? null, row, true);
  }

  private startUpload(drama: FakeDrama, n: number, sha256: string, bytes: number, frames: number | null, existing: FakeEpisode | null, replace: boolean): StudioHttpAnswer {
    const changed: string[] = [];
    let inserted = false;
    let row: FakeEpisode;
    const at = iso(this.now());
    if (existing) row = existing;
    else {
      row = { id: this.uuid(), drama_id: drama.id, episode_number: n, title: null, status: "uploading", is_published: false, mux_upload_id: null, mux_asset_id: null, mux_playback_id: null, duration_seconds: null, thumbnail_url: null, updated_at: at };
      this.episodes.push(row);
      inserted = true;
      changed.push("episode_created");
    }
    const upload = this.createUpload(row.id, { external_id: sha256, title: `${drama.slug} ep${n}`, creator_id: STUDIO_CREATOR_ID }, { bytes, frames });
    if (this.raceNextUpload) {
      this.raceNextUpload = false;
      upload.status = "cancelled";
      return fail(409, "episode_changed", `Episode ${n} changed while the upload was being created (another upload?); nothing was written`, { upload_id: row.mux_upload_id, cancelled_upload_id: upload.id });
    }
    const previousAssetId = replace ? row.mux_asset_id : null;
    const previousPlaybackId = replace ? row.mux_playback_id : null;
    if (row.status !== "uploading") changed.push("status");
    row.status = "uploading";
    row.mux_upload_id = upload.id;
    if (row.mux_asset_id) {
      row.mux_asset_id = null;
      changed.push("mux_asset_id");
    }
    row.updated_at = at;
    changed.push("mux_upload_created", "mux_upload_id");
    return {
      status: 201,
      body: { reused: false, created: true, episode_id: row.id, drama_id: drama.id, episode_number: n, upload_id: upload.id, upload_url: upload.url, upload_status: upload.status, status: row.status, is_published: row.is_published, episode_created: inserted, replaced: replace, previous_asset_id: previousAssetId, previous_playback_id: previousPlaybackId, sha256, bytes, frames, changed },
    };
  }

  private episodeForUpload(upload: FakeUpload): FakeEpisode | null {
    return this.episodes.find((e) => e.mux_upload_id === upload.id) ?? (upload.passthrough ? this.episodes.find((e) => e.id === upload.passthrough) ?? null : null);
  }

  private getUploadStatus(uploadId: string): StudioHttpAnswer {
    if (!UPLOAD_ID_RE.test(uploadId)) return fail(400, "bad_upload_id", "Not a Mux upload id");
    const upload = this.uploads.get(uploadId);
    if (!upload) return fail(404, "upload_not_found", `Mux has no upload ${uploadId}`);
    const asset = upload.asset_id ? this.assets.get(upload.asset_id) ?? null : null;
    // Mux processing, modelled: each status read brings a preparing asset one step closer to ready.
    if (asset && asset.status === "preparing") {
      asset.reads_left -= 1;
      if (asset.reads_left <= 0) this.finishAsset(asset);
    }
    const row = this.episodeForUpload(upload);
    const isCurrent = !!row && row.mux_upload_id === upload.id;
    const rowHasAsset = !!row && !!asset && row.mux_asset_id === asset.id;
    const ready = isCurrent && rowHasAsset && row!.status === "ready" && asset!.status === "ready";
    const webhookPending = isCurrent && !!asset && ((asset.status === "ready" && !ready) || (asset.status === "errored" && row!.status !== "failed"));
    return { status: 200, body: { upload: this.uploadOut(upload), asset: asset ? this.assetOut(asset) : null, episode: row ? this.episodeOut(row) : null, episode_is_current: isCurrent, ready, webhook_pending: webhookPending } };
  }

  private syncUpload(uploadId: string): StudioHttpAnswer {
    if (!UPLOAD_ID_RE.test(uploadId)) return fail(400, "bad_upload_id", "Not a Mux upload id");
    const upload = this.uploads.get(uploadId);
    if (!upload) return fail(404, "upload_not_found", `Mux has no upload ${uploadId}`);
    if (upload.meta.creator_id !== STUDIO_CREATOR_ID) return fail(409, "not_studio_upload", "Studio did not create this upload, so it is never synced here; nothing was changed");
    const row = this.episodes.find((e) => e.mux_upload_id === uploadId);
    if (!row) return fail(409, "upload_not_current", "No episode row holds this upload any more (superseded?); nothing was changed");
    const owner = this.dramas.find((d) => d.id === row.drama_id);
    const refused = owner ? this.notStudio(owner) : null;
    if (refused) return refused;
    if (!upload.asset_id) return { status: 200, body: { changed: [], upload_status: upload.status, episode: this.episodeOut(row) } };
    const asset = this.assets.get(upload.asset_id);
    if (!asset) return fail(502, "mux_error", `Mux has no asset ${upload.asset_id}`);
    const patch: Partial<FakeEpisode> =
      asset.status === "ready"
        ? { mux_asset_id: asset.id, mux_playback_id: asset.playback_ids[0]?.id ?? null, duration_seconds: asset.duration, thumbnail_url: null, status: "ready" }
        : asset.status === "errored"
          ? { mux_asset_id: asset.id, status: "failed" }
          : { mux_asset_id: asset.id, status: "processing" };
    const changed = Object.keys(patch).filter((k) => !sameValue(row[k as keyof FakeEpisode], patch[k as keyof FakeEpisode]));
    if (changed.length) Object.assign(row, patch, { updated_at: iso(this.now()) });
    return { status: 200, body: { changed, upload_status: upload.status, asset: this.assetOut(asset), episode: this.episodeOut(row) } };
  }

  private cancelUpload(uploadId: string): StudioHttpAnswer {
    if (!UPLOAD_ID_RE.test(uploadId)) return fail(400, "bad_upload_id", "Not a Mux upload id");
    const upload = this.uploads.get(uploadId);
    if (!upload) return fail(404, "upload_not_found", `Mux has no upload ${uploadId}`);
    if (upload.meta.creator_id !== STUDIO_CREATOR_ID) return fail(409, "not_studio_upload", "Studio did not create this upload, so it is never cancelled here; nothing was changed");
    const holder = this.episodes.find((e) => e.mux_upload_id === uploadId);
    if (holder) return fail(409, "upload_is_current", "An episode row still holds this upload; only an upload that another upload has taken over can be cancelled. Nothing was changed", { episode_id: holder.id });
    if (upload.status === "cancelled" || upload.status === "timed_out" || upload.status === "errored") return { status: 200, body: { cancelled: false, upload: this.uploadOut(upload), changed: [] } };
    if (upload.status !== "waiting") return fail(409, "upload_complete", "Mux already has every byte of this upload, so it cannot be cancelled; tell the operator. Nothing was changed", { upload_status: upload.status, asset_id: upload.asset_id });
    upload.status = "cancelled";
    return { status: 200, body: { cancelled: true, upload: this.uploadOut(upload), changed: ["mux_upload_cancelled"] } };
  }

  private publish(key: string, raw: unknown): StudioHttpAnswer {
    const parsed = PublishBody.safeParse(raw);
    if (!parsed.success) return badRequest(parsed.error);
    const numbers = uniqueSorted(parsed.data.episodes);
    const seriesToo = parsed.data.publish_series === true;
    const drama = this.findDrama(key);
    if (!drama) return fail(404, "series_not_found", `No series with slug or id "${key}"`);
    const refused = this.notStudio(drama);
    if (refused) return refused;
    const episodes = this.episodes.filter((e) => e.drama_id === drama.id);
    const byNumber = new Map(episodes.map((e) => [e.episode_number, e]));
    const notReady = numbers
      .map((n) => ({ n, e: byNumber.get(n) }))
      .filter(({ e }) => !e || e.status !== "ready" || !e.mux_playback_id)
      .map(({ n, e }) => ({ episode_number: n, status: e ? e.status : "missing", has_playback_id: !!e?.mux_playback_id }));
    if (notReady.length) return fail(409, "episodes_not_ready", "Only ready episodes can be published; nothing was changed", { not_ready: notReady });
    if (seriesToo && drama.status === "archived") return fail(409, "series_archived", "Series is archived; un-archive it in the CMS first. Nothing was changed");
    const liveAfter = episodes.filter((e) => e.is_published || numbers.includes(e.episode_number)).length;
    if (seriesToo && drama.status !== "published" && liveAfter === 0) return fail(409, "no_published_episodes", "A series cannot go live with no published episodes; list the ready ones. Nothing was changed");
    const toPublish = numbers.filter((n) => !byNumber.get(n)!.is_published);
    const already = numbers.filter((n) => byNumber.get(n)!.is_published);
    // The partial result: an episode that stops being ready between the check and the write (a replace started).
    for (const n of this.flipOnPublish) {
      const e = byNumber.get(n);
      if (e) e.status = "uploading";
    }
    this.flipOnPublish = [];
    const published: number[] = [];
    for (const n of toPublish) {
      const e = byNumber.get(n)!;
      if (e.status === "ready") {
        e.is_published = true;
        e.published_since = this.now();
        e.updated_at = iso(this.now());
        published.push(n);
      }
    }
    const changed: string[] = published.length ? ["episodes.is_published"] : [];
    const missed = toPublish.filter((n) => !published.includes(n));
    const before = drama.status;
    if (seriesToo && drama.status === "draft" && missed.length === 0) {
      drama.status = "published";
      drama.live_since = this.now();
      changed.push("series.status");
    }
    const out = { series: { id: drama.id, slug: drama.slug, status_before: before, status: drama.status }, published, already_published: already, changed };
    if (missed.length) return { status: 409, body: { error: "Some episodes stopped being ready while publishing; the others were published and the series status was left as it was", code: "episodes_changed", not_published: missed, ...out } };
    return { status: 200, body: out };
  }

  private unpublish(key: string, raw: unknown): StudioHttpAnswer {
    const parsed = UnpublishBody.safeParse(raw);
    if (!parsed.success) return badRequest(parsed.error);
    const numbers = uniqueSorted(parsed.data.episodes);
    const seriesToo = parsed.data.unpublish_series === true;
    const drama = this.findDrama(key);
    if (!drama) return fail(404, "series_not_found", `No series with slug or id "${key}"`);
    const refused = this.notStudio(drama);
    if (refused) return refused;
    const byNumber = new Map(this.episodes.filter((e) => e.drama_id === drama.id).map((e) => [e.episode_number, e]));
    const missing = numbers.filter((n) => !byNumber.has(n));
    if (missing.length) return fail(404, "episodes_not_found", "Some episodes do not exist; nothing was changed", { missing });
    const hide = numbers.filter((n) => byNumber.get(n)!.is_published);
    const already = numbers.filter((n) => !byNumber.get(n)!.is_published);
    for (const n of hide) byNumber.get(n)!.is_published = false;
    const changed: string[] = hide.length ? ["episodes.is_published"] : [];
    const before = drama.status;
    if (seriesToo && drama.status === "published") {
      drama.status = "draft";
      changed.push("series.status");
    }
    return { status: 200, body: { series: { id: drama.id, slug: drama.slug, status_before: before, status: drama.status }, unpublished: hide, already_unpublished: already, changed } };
  }

  // ---- Mux: the resumable upload and the asset ------------------------------------------------------------------

  async putUploadChunk(uploadUrl: string, chunk: Uint8Array | null, range: ChunkRange | { total: number }): Promise<ChunkAnswer> {
    const m = uploadUrl.match(/^fake-mux:\/\/upload\/([A-Za-z0-9]+)$/);
    const upload = m ? this.uploads.get(m[1]) : undefined;
    const log = (status: number, acked: number | null): ChunkAnswer => {
      const entry: FakeChunkLog = { upload_id: upload?.id ?? "?", first: "first" in range ? range.first : null, last: "first" in range ? range.last : null, total: range.total, bytes: chunk?.byteLength ?? 0, status, acked };
      this.chunks.push(entry);
      if (chunk && status !== 404 && status !== 410 && status !== 400) this.onChunk?.(entry);
      return { status, acked };
    };
    if (!upload) return log(404, null);
    if (upload.status === "cancelled" || upload.status === "timed_out" || upload.status === "errored") return log(410, null);
    const complete = upload.status === "asset_created";
    if (upload.total !== null && range.total !== upload.total) return log(400, null);
    if (!chunk || !("first" in range)) {
      if (complete) return log(200, null);
      return log(308, upload.received > 0 ? upload.received : null);
    }
    if (complete) return log(200, null);
    if (chunk.byteLength !== range.last - range.first + 1) return log(400, null);
    upload.total ??= range.total;
    // Bytes at an offset already persisted are ignored; a chunk that starts past the persisted end is not taken at all.
    if (range.first > upload.received) return log(308, upload.received > 0 ? upload.received : null);
    let fresh = chunk.subarray(upload.received - range.first);
    const endsUpload = range.last + 1 === upload.total;
    if (!endsUpload) {
      let keep = fresh.byteLength;
      if (this.persistShortOnce > 0) {
        keep = Math.max(0, keep - this.persistShortOnce);
        this.persistShortOnce = 0;
      }
      // A non-final chunk is persisted only up to a multiple of 256 KiB (the storage's quantum).
      const end = Math.floor((upload.received + keep) / FAKE_UPLOAD_QUANTUM) * FAKE_UPLOAD_QUANTUM;
      fresh = fresh.subarray(0, Math.max(0, end - upload.received));
    }
    upload.hash.update(fresh);
    upload.received += fresh.byteLength;
    if (upload.received === upload.total) {
      upload.received_sha256 = upload.hash.digest("hex");
      this.completeUpload(upload);
      return log(200, null);
    }
    return log(308, upload.received > 0 ? upload.received : null);
  }

  /** The last byte arrived: Mux creates the asset, and `video.upload.asset_created` (matched on the upload id) marks the row processing. */
  private completeUpload(upload: FakeUpload): void {
    const fps = (upload.meta.external_id && this.fpsBySha.get(upload.meta.external_id)) || 30;
    const frames = upload.declared.frames;
    const duration = frames ? Math.round(((frames + 2 + this.durationOffsetFrames) / fps) * 1000) / 1000 : 60;
    const asset: FakeAsset = {
      id: this.id("ASSET"),
      status: "preparing",
      duration: null,
      meta: { ...upload.meta, ...(this.externalIdOverride ? { external_id: this.externalIdOverride } : {}) },
      passthrough: upload.passthrough,
      playback_ids: [],
      errors: null,
      created_at: iso(this.now()),
      reads_left: Math.max(0, this.readyAfterReads),
      upload_id: upload.id,
      pending_duration: duration,
    };
    this.externalIdOverride = null;
    this.assets.set(asset.id, asset);
    upload.status = "asset_created";
    upload.asset_id = asset.id;
    if (!this.webhookMissed) {
      const row = this.episodes.find((e) => e.mux_upload_id === upload.id);
      if (row) {
        row.mux_asset_id = asset.id;
        row.status = "processing";
        row.updated_at = iso(this.now());
      }
    }
    if (asset.reads_left <= 0) this.finishAsset(asset);
  }

  /** Mux finishes processing; the webhook's asset.ready (matched on the passthrough) gives the episode this asset — whoever else uploaded since. */
  private finishAsset(asset: FakeAsset): void {
    if (this.assetErrors) {
      this.assetErrors = false;
      asset.status = "errored";
      asset.errors = { type: "invalid_input", messages: ["fake: the file could not be read"] };
    } else {
      asset.status = "ready";
      asset.duration = asset.pending_duration;
      asset.playback_ids = [{ id: this.id("PLAY"), policy: "public" }];
    }
    if (this.webhookMissed) return;
    const row = asset.passthrough ? this.episodes.find((e) => e.id === asset.passthrough) : undefined;
    if (!row) return;
    if (asset.status === "ready") Object.assign(row, { mux_asset_id: asset.id, mux_playback_id: asset.playback_ids[0].id, duration_seconds: asset.duration, thumbnail_url: null, status: "ready", updated_at: iso(this.now()) });
    else if (row.mux_upload_id === asset.upload_id) Object.assign(row, { mux_asset_id: asset.id, status: "failed", updated_at: iso(this.now()) });
  }

  async checkImage(url: string): Promise<ImageCheck> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, status: null, content_type: null, reason: "That is not a web address." };
    }
    if (parsed.protocol !== "https:") return { ok: false, status: null, content_type: null, reason: "The poster must be an https:// address." };
    const name = decodeURIComponent(parsed.pathname.split("/").pop() ?? "");
    if (!IMAGE_NAME.test(name)) return { ok: false, status: 200, content_type: "text/html", reason: "It answers text/html, not an image." };
    if (/missing/i.test(name)) return { ok: false, status: 404, content_type: "text/html", reason: "It answers HTTP 404, not 200." };
    const ext = name.split(".").pop()!.toLowerCase();
    return { ok: true, status: 200, content_type: ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`, reason: null };
  }
}

// One instance per process (Next bundles lib/ per route): parked on globalThis like the TikTok fake.
const holder = globalThis as unknown as { __studioCrazydramasFake?: FakeCrazydramasTransport };
// A fake parked by an older build (a hot reload) lacks the Studio API: replace it.
if (holder.__studioCrazydramasFake && typeof (holder.__studioCrazydramasFake as Partial<FakeCrazydramasTransport>).request !== "function") delete holder.__studioCrazydramasFake;
export const fakeCrazydramasTransport: FakeCrazydramasTransport = holder.__studioCrazydramasFake ??= new FakeCrazydramasTransport();
