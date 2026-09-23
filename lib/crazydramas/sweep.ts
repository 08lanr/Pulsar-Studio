// The refresh (decision 2026-09-23, "the crazydramas connection"; plan A5):
// one function checks one title — the public read, the link on the first
// 200, the snapshot row as the record — and three callers run it:
//
//   Check now          POST /api/titles/[id]/crazydramas/check, refused while
//                      a snapshot of that slug is younger than 30 s
//   the sweep          tickCrazydramas() from the scheduler's tick: once an
//                      hour, every 15 minutes while any title is live_partial
//                      or live_differs (an episode not ready reads partial);
//                      one catalog GET plus one GET per linked or catalog
//                      slug, in sequence; the last twenty rows per slug kept
//   the import         checkAfterImport() once a successful import set a slug,
//                      failure-soft
//
// No job kind: a public GET costs no model money, studio.jobs.target_id is
// NOT NULL, and producers cannot read jobs. The snapshot row is the record.
// Every write here is the system actor's; the caller's session is used for
// the one read that says whether the title is theirs to see.

import { systemSession, type Session } from "@/lib/auth";
import { getData, isDataError } from "@/lib/data";
import type { Episode, PlatformLink, PlatformSnapshot, Title } from "@/lib/types";
import { crazydramasTransport } from "./index";
import { crazydramasStatusFor, isHotState, type CrazydramasStatus } from "./match";
import { CrazydramasApiError, crazydramasPublicUrl, type CrazydramasTransport } from "./transport";
import { type CatalogEntry, PLATFORM } from "./types";

/** Check now is refused while a snapshot of the slug is younger than this (plan A5). */
export const CHECK_MIN_AGE_MS = 30_000;
/** The sweep's cadence: hourly, or every 15 minutes while a title is partial or differs. */
export const SWEEP_EVERY_MS = 60 * 60 * 1000;
export const SWEEP_HOT_EVERY_MS = 15 * 60 * 1000;

const log = (m: string) => console.log(`[crazydramas] ${m}`);

// ---- the reading the screens load -------------------------------------------------------------------

/**
 * A title's crazydramas status from what the data layer holds: the link,
 * the slug's snapshots (newest first) and the episode rows. The caller's
 * session decides what it may read (a foreign title is not found). Pass the
 * episodes when a page already has them.
 */
export async function loadCrazydramasStatus(session: Session, title: Title, episodes?: readonly Episode[]): Promise<CrazydramasStatus> {
  const data = getData();
  const slug = title.crazydramas_slug?.trim() || null;
  const link = slug ? await data.getPlatformLink(session, title.id, PLATFORM) : null;
  if (!slug && !link) return crazydramasStatusFor(title, episodes ?? [], null, null);
  const eps = episodes ?? (await data.listTitleEpisodes(session, title.id));
  const snapshots = await data.listPlatformSnapshots(session, PLATFORM, link?.slug ?? slug!);
  return crazydramasStatusFor(title, eps, snapshots, link);
}

/** The statuses of many titles (the catalog page), one map by title id; titles with no slug read `not_linked` without a query. */
export async function loadCrazydramasStatuses(session: Session, titles: readonly Title[]): Promise<Map<string, CrazydramasStatus>> {
  const out = new Map<string, CrazydramasStatus>();
  for (const title of titles) out.set(title.id, await loadCrazydramasStatus(session, title));
  return out;
}

// ---- which slug to read -------------------------------------------------------------------------------

export type ReadSlug = { slug: string; reason: "title" | "link" | "catalog" | "title_edited" };

/**
 * Which slug a check reads, pure (plan A2: after the first 200 the title is
 * matched by the drama id, because the CMS can rename a slug):
 *   no link                      the title's own slug
 *   link, the catalog lists the drama id under another slug   that slug (a CMS rename, followed)
 *   link, Studio's slug edited away from the link's and the platform's   Studio's slug (the person re-pointed the title)
 *   link, otherwise              the link's slug
 */
export function resolveReadSlug(title: Pick<Title, "crazydramas_slug">, link: PlatformLink | null, catalog: readonly CatalogEntry[] | null): ReadSlug | null {
  const own = title.crazydramas_slug?.trim() || null;
  if (!link) return own ? { slug: own, reason: "title" } : null;
  const listed = catalog?.find((d) => d.id === link.cd_drama_id) ?? null;
  const platformSlug = listed?.slug ?? link.slug;
  if (own && own !== link.slug && own !== platformSlug) return { slug: own, reason: "title_edited" };
  if (listed && listed.slug !== link.slug) return { slug: listed.slug, reason: "catalog" };
  return { slug: link.slug, reason: "link" };
}

// ---- one check ------------------------------------------------------------------------------------------

export type CheckOptions = {
  /** Skip the 30-second rule (the sweep, the after-import check). */
  force?: boolean;
  /** The catalog the sweep already read, so one check needs no second catalog GET; null when the catalog read failed. */
  catalog?: readonly CatalogEntry[] | null;
  transport?: CrazydramasTransport;
  now?: () => number;
};

export type CheckResult =
  | { outcome: "checked"; title_id: string; slug: string; http_status: number | null; error: string | null; linked: boolean; snapshot: PlatformSnapshot; status: CrazydramasStatus }
  | { outcome: "too_soon"; title_id: string; slug: string; retry_after_s: number; status: CrazydramasStatus }
  | { outcome: "not_linked"; title_id: string; status: CrazydramasStatus };

function errorText(e: unknown): string {
  if (e instanceof CrazydramasApiError) return e.message;
  if (isDataError(e)) return e.message;
  if (e instanceof Error) return e.message.slice(0, 300);
  return String(e).slice(0, 300);
}

/**
 * One title, one read: the caller's session says whether the title is
 * theirs to see; the system records. On a 200 with no link yet, the link is
 * made with the drama id the platform returned; a link whose slug the
 * platform renamed follows the catalog; a title whose slug the person
 * re-pointed in Studio moves its link to the drama that slug now answers
 * with (refused, in the snapshot's error, when another title holds that
 * drama). A failed request is a snapshot with its error and no body — the
 * screens show the last good read marked stale.
 */
export async function checkCrazydramasTitle(session: Session, titleId: string, opts: CheckOptions = {}): Promise<CheckResult> {
  const data = getData();
  const sys = systemSession();
  const now = opts.now ?? Date.now;
  const detail = await data.getTitle(session, titleId); // not_found for a foreign title, before anything is read or written
  const title = detail.title;
  const link = await data.getPlatformLink(sys, titleId, PLATFORM);
  const episodes = await data.listTitleEpisodes(sys, titleId);
  const transport = opts.transport ?? crazydramasTransport();

  /** The 30-second rule on one slug: the seconds to wait, or null. */
  const tooSoon = async (slug: string): Promise<CheckResult | null> => {
    if (opts.force) return null;
    const newest = (await data.listPlatformSnapshots(sys, PLATFORM, slug, { limit: 1 }))[0];
    if (!newest) return null;
    const age = now() - Date.parse(newest.read_at);
    if (!(age >= 0 && age < CHECK_MIN_AGE_MS)) return null;
    const status = crazydramasStatusFor(title, episodes, await data.listPlatformSnapshots(sys, PLATFORM, slug), link);
    return { outcome: "too_soon", title_id: titleId, slug, retry_after_s: Math.ceil((CHECK_MIN_AGE_MS - age) / 1000), status };
  };

  // The rule first, on the slug known before any request, so a refused Check now costs nothing.
  const early = resolveReadSlug(title, link, null);
  if (!early) return { outcome: "not_linked", title_id: titleId, status: crazydramasStatusFor(title, episodes, null, null) };
  const refusedEarly = await tooSoon(early.slug);
  if (refusedEarly) return refusedEarly;

  // The catalog, when a link exists and the caller did not bring one: it is how a CMS rename is followed. Its failure is not the check's.
  let catalog: readonly CatalogEntry[] | null = opts.catalog ?? null;
  if (link && opts.catalog === undefined) {
    try {
      catalog = await transport.catalog();
    } catch {
      catalog = null;
    }
  }
  const read = resolveReadSlug(title, link, catalog) ?? early;
  if (read.slug !== early.slug) {
    const refused = await tooSoon(read.slug);
    if (refused) return refused;
  }

  let snapshot: PlatformSnapshot;
  let linked = false;
  let currentLink = link;
  try {
    const answer = await transport.series(read.slug);
    if (answer.http_status === 200) {
      let error: string | null = null;
      const sameDrama = !!link && link.cd_drama_id === answer.drama.id;
      if (!link || read.reason === "title_edited" || (sameDrama && read.slug !== link.slug)) {
        // The first 200 makes the link; a re-pointed title moves it; a followed rename updates its slug.
        try {
          currentLink = await data.upsertPlatformLink(sys, { title_id: titleId, platform: PLATFORM, slug: read.slug, cd_drama_id: answer.drama.id });
          linked = !link || currentLink.cd_drama_id !== link.cd_drama_id;
        } catch (e) {
          if (!isDataError(e) || e.code !== "conflict") throw e;
          error = `${read.slug} is drama ${answer.drama.id}, which another title is linked to; the link was not moved`;
        }
      }
      // A 200 that could not be linked keeps its body AND the refusal: the reading shows it as a failed read with that sentence.
      snapshot = await data.recordPlatformSnapshot(sys, { platform: PLATFORM, slug: read.slug, cd_drama_id: answer.drama.id, title_id: titleId, http_status: 200, drama: answer.drama, episodes: answer.episodes, error });
    } else {
      snapshot = await data.recordPlatformSnapshot(sys, { platform: PLATFORM, slug: read.slug, cd_drama_id: link?.cd_drama_id ?? null, title_id: titleId, http_status: 404 });
    }
  } catch (e) {
    if (isDataError(e)) throw e; // a refused row is a bug, never a "read failure"
    const status = e instanceof CrazydramasApiError ? e.status ?? null : null;
    snapshot = await data.recordPlatformSnapshot(sys, { platform: PLATFORM, slug: read.slug, cd_drama_id: link?.cd_drama_id ?? null, title_id: titleId, http_status: status === 200 ? null : status, error: errorText(e) });
  }
  const snapshots = await data.listPlatformSnapshots(sys, PLATFORM, read.slug);
  const status = crazydramasStatusFor(title, episodes, snapshots, currentLink);
  return { outcome: "checked", title_id: titleId, slug: read.slug, http_status: snapshot.http_status, error: snapshot.error, linked, snapshot, status };
}

/** The import's one check after a successful run that set a slug: never throws, never delays the import's answer. */
export async function checkAfterImport(titleId: string): Promise<void> {
  try {
    const r = await checkCrazydramasTitle(systemSession(), titleId, { force: true });
    if (r.outcome === "checked") log(`after import: ${r.slug} → ${r.status.state}${r.error ? ` (${r.error})` : ""}`);
  } catch (e) {
    console.warn(`[crazydramas] after-import check of ${titleId} failed: ${errorText(e)}`);
  }
}

// ---- the sweep ------------------------------------------------------------------------------------------

export type SweepSummary = {
  at: string;
  /** Series in the catalog, or null when the catalog read failed (the per-title reads still ran on their link slugs). */
  catalog: number | null;
  titles: number;
  /** Catalog series matching no title, read and recorded with no title id. */
  unmatched: number;
  states: Record<string, number>;
  /** A title is partial or differs (or something failed): the next sweep is in 15 minutes, not an hour. */
  hot: boolean;
  pruned: number;
  errors: string[];
};

/**
 * One catalog GET, then one GET per linked title in sequence, then one per
 * catalog series that matches no title (the staff mirror's list), then the
 * prune. Never throws for a single read; the summary carries every error.
 */
export async function sweepCrazydramas(opts: { transport?: CrazydramasTransport; now?: () => number } = {}): Promise<SweepSummary> {
  const data = getData();
  const sys = systemSession();
  const transport = opts.transport ?? crazydramasTransport();
  const summary: SweepSummary = { at: new Date().toISOString(), catalog: null, titles: 0, unmatched: 0, states: {}, hot: false, pruned: 0, errors: [] };

  let catalog: CatalogEntry[] | null = null;
  try {
    catalog = await transport.catalog();
    summary.catalog = catalog.length;
  } catch (e) {
    summary.errors.push(`catalog: ${errorText(e)}`);
  }

  const titles = await data.listTitlesWithPlatformSlug(sys, PLATFORM);
  const links = await data.listPlatformLinks(sys, PLATFORM);
  const readSlugs = new Set<string>();
  for (const title of titles) {
    try {
      const r = await checkCrazydramasTitle(sys, title.id, { force: true, catalog, transport, now: opts.now });
      summary.titles += 1;
      if (r.outcome === "checked") {
        readSlugs.add(r.slug);
        summary.states[r.status.state] = (summary.states[r.status.state] ?? 0) + 1;
        if (isHotState(r.status.state)) summary.hot = true;
        if (r.error) summary.errors.push(`${r.slug}: ${r.error}`);
      }
    } catch (e) {
      summary.errors.push(`${title.crazydramas_slug}: ${errorText(e)}`);
    }
  }

  if (catalog) {
    const linkedIds = new Set(links.map((l) => l.cd_drama_id));
    const titleSlugs = new Set(titles.map((t) => t.crazydramas_slug!.trim()));
    for (const entry of catalog) {
      if (linkedIds.has(entry.id) || titleSlugs.has(entry.slug) || readSlugs.has(entry.slug)) continue;
      try {
        const answer = await transport.series(entry.slug);
        if (answer.http_status === 200) {
          await data.recordPlatformSnapshot(sys, { platform: PLATFORM, slug: entry.slug, cd_drama_id: answer.drama.id, title_id: null, http_status: 200, drama: answer.drama, episodes: answer.episodes });
        } else {
          await data.recordPlatformSnapshot(sys, { platform: PLATFORM, slug: entry.slug, cd_drama_id: entry.id, title_id: null, http_status: 404 });
        }
        summary.unmatched += 1;
      } catch (e) {
        if (isDataError(e)) {
          summary.errors.push(`${entry.slug}: ${errorText(e)}`);
          continue;
        }
        const status = e instanceof CrazydramasApiError ? e.status ?? null : null;
        await data.recordPlatformSnapshot(sys, { platform: PLATFORM, slug: entry.slug, cd_drama_id: entry.id, title_id: null, http_status: status === 200 ? null : status, error: errorText(e) }).catch(() => undefined);
        summary.errors.push(`${entry.slug}: ${errorText(e)}`);
      }
    }
  }

  try {
    summary.pruned = await data.prunePlatformSnapshots(sys, PLATFORM);
  } catch (e) {
    summary.errors.push(`prune: ${errorText(e)}`);
  }
  if (summary.errors.length) summary.hot = true;
  return summary;
}

// ---- the scheduler's step ----------------------------------------------------------------------------

type SweepState = { running: boolean; lastAt: number | null; nextAt: number; lastSummary: SweepSummary | null };
const holder = globalThis as unknown as { __studioCrazydramasSweep?: SweepState };
function state(): SweepState {
  return (holder.__studioCrazydramasSweep ??= { running: false, lastAt: null, nextAt: 0, lastSummary: null });
}

/** When the next sweep is due after one that ran at `at`: 15 minutes while hot, else an hour. */
export function nextSweepAt(at: number, hot: boolean): number {
  return at + (hot ? SWEEP_HOT_EVERY_MS : SWEEP_EVERY_MS);
}

export function crazydramasSweepStatus(): { lastAt: string | null; nextAt: string | null; lastSummary: SweepSummary | null } {
  const s = state();
  return { lastAt: s.lastAt ? new Date(s.lastAt).toISOString() : null, nextAt: s.lastAt ? new Date(s.nextAt).toISOString() : null, lastSummary: s.lastSummary };
}

export type TickResult = { ran: boolean; skipped?: "tests" | "disabled" | "not_due" | "running"; summary?: SweepSummary };

/**
 * Step 5 of the scheduler's tick (lib/tiktok/scheduler.ts). Skipped under
 * SCHEDULER_DISABLED=1 and under node:test; runs when due, and the summary
 * decides whether the next one is in an hour or in 15 minutes.
 */
export async function tickCrazydramas(opts: { now?: () => number } = {}): Promise<TickResult> {
  if (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === "test") return { ran: false, skipped: "tests" };
  if (process.env.SCHEDULER_DISABLED === "1") return { ran: false, skipped: "disabled" };
  const s = state();
  const now = (opts.now ?? Date.now)();
  if (s.running) return { ran: false, skipped: "running" };
  if (now < s.nextAt) return { ran: false, skipped: "not_due" };
  s.running = true;
  try {
    const summary = await sweepCrazydramas({ now: opts.now });
    s.lastAt = now;
    s.nextAt = nextSweepAt(now, summary.hot);
    s.lastSummary = summary;
    log(`sweep: catalog ${summary.catalog ?? "failed"}, ${summary.titles} titles, ${summary.unmatched} unmatched, ${summary.pruned} pruned${summary.errors.length ? `, ${summary.errors.length} errors` : ""}; next in ${summary.hot ? 15 : 60} min`);
    return { ran: true, summary };
  } finally {
    s.running = false;
  }
}

/** Tests only: forget the cadence. */
export function resetCrazydramasSweep(): void {
  delete holder.__studioCrazydramasSweep;
}

/** One row of the staff mirror (GET /api/admin/crazydramas/unmatched, the Import films desk): a catalog series that matches no title. */
export type UnmatchedSeries = {
  slug: string;
  cd_drama_id: string;
  title: string;
  episode_count: number;
  free_episode_count: number;
  series_price_cents: number | null;
  iap_product_set: boolean;
  poster_url: string | null;
  poster_placeholder: boolean;
  public_url: string;
  /** When the sweep read it ("observed"). */
  read_at: string;
};

/**
 * The series live on crazydramas that match no Studio title (plan A4.4),
 * from the newest snapshot per slug the sweep recorded with no title, minus
 * any drama a link holds. Null when no read has happened yet (nothing to
 * say, rather than "none"); staff only — a producer's session reads no
 * title-less row, so for them the answer is empty.
 */
export async function listUnmatchedCrazydramas(session: Session): Promise<UnmatchedSeries[] | null> {
  const data = getData();
  const rows = await data.listLatestPlatformSnapshots(session, PLATFORM);
  if (!rows.length) return null;
  const linked = new Set((await data.listPlatformLinks(session, PLATFORM)).map((l) => l.cd_drama_id));
  const out: UnmatchedSeries[] = [];
  for (const r of rows) {
    if (r.title_id || r.http_status !== 200 || !r.drama || r.error || linked.has(r.drama.id)) continue;
    out.push({
      slug: r.slug,
      cd_drama_id: r.drama.id,
      title: r.drama.title,
      episode_count: r.episodes?.length ?? r.drama.episode_count,
      free_episode_count: r.drama.free_episode_count,
      series_price_cents: r.drama.series_price_cents,
      iap_product_set: !!r.drama.iap_product_id,
      poster_url: r.drama.poster_url,
      poster_placeholder: !!r.drama.poster_url && r.drama.poster_url.includes("-placeholder"),
      public_url: crazydramasPublicUrl(r.slug),
      read_at: r.read_at,
    });
  }
  return out;
}
