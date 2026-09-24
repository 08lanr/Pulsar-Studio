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
import { forbidden } from "@/lib/data/errors";
import type { Episode, PlatformDrama, PlatformEpisode, PlatformLink, PlatformSnapshot, Title } from "@/lib/types";
import { crazydramasStatusFor, isHotState, type CrazydramasStatus } from "./match";
import { crazydramasTransport } from "./pick";
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
 * The title's own reads of a slug, newest first, as the session may see
 * them. "One film is one title per company", so two companies' titles can
 * carry one slug and each check records a row on its own title: the other
 * title's rows (its refusal, say) are never this title's reading, whoever
 * reads — and a producer's session lists only its own company's rows anyway.
 */
async function titleSnapshots(session: Session, titleId: string, slug: string): Promise<PlatformSnapshot[]> {
  const rows = await getData().listPlatformSnapshots(session, PLATFORM, slug);
  return rows.filter((s) => s.title_id === titleId);
}

/**
 * A title's crazydramas status from what the data layer holds: the link,
 * the title's snapshots of the slug (newest first) and the episode rows.
 * The caller's session decides what it may read (a foreign title is not
 * found). Pass the episodes when a page already has them.
 *
 * The slug read is the one a check would read now (resolveReadSlug without
 * a catalog): the link's, or — when the person re-pointed the title in
 * Studio and the new slug has not answered 200 yet — the title's own, with
 * no link, so the screens say "not checked yet" or "not live" under the
 * slug the title carries instead of staying on the old drama with a frozen
 * checked time (the phase 3a review, round two).
 */
export async function loadCrazydramasStatus(session: Session, title: Title, episodes?: readonly Episode[]): Promise<CrazydramasStatus> {
  const data = getData();
  const slug = title.crazydramas_slug?.trim() || null;
  const link = slug ? await data.getPlatformLink(session, title.id, PLATFORM) : null;
  const read = resolveReadSlug(title, link, null);
  if (!read) return crazydramasStatusFor(title, episodes ?? [], null, null);
  const eps = episodes ?? (await data.listTitleEpisodes(session, title.id));
  const snapshots = await titleSnapshots(session, title.id, read.slug);
  return crazydramasStatusFor(title, eps, snapshots, read.reason === "title_edited" ? null : link);
}

/** The statuses of many titles (the catalog page, the Import rows), one map by title id, read side by side; titles with no slug read `not_linked` without a query. */
export async function loadCrazydramasStatuses(session: Session, titles: readonly Title[]): Promise<Map<string, CrazydramasStatus>> {
  const statuses = await Promise.all(titles.map((title) => loadCrazydramasStatus(session, title)));
  return new Map(titles.map((title, i) => [title.id, statuses[i]]));
}

// ---- which slug to read -------------------------------------------------------------------------------

export type ReadSlug = { slug: string; reason: "title" | "link" | "catalog" | "title_edited" };

/**
 * Which slug a check reads, pure (plan A2: after the first 200 the title is
 * matched by the drama id, because the CMS can rename a slug):
 *   no link                      the title's own slug
 *   link, Studio's slug is not the one the link was made under (title_slug), nor the link's, nor the platform's
 *                                Studio's slug (the person re-pointed the title)
 *   link, the catalog lists the drama id under another slug   that slug (a CMS rename, followed)
 *   link, otherwise              the link's slug
 * The link's title_slug is what tells a re-point from a film-meta that still
 * carries the pre-rename slug: after a followed rename the link's slug is
 * the platform's and its title_slug is still the title's own, so the title's
 * unchanged slug is not an edit and every later check keeps reading the
 * platform's slug (the phase 3a review).
 */
export function resolveReadSlug(title: Pick<Title, "crazydramas_slug">, link: PlatformLink | null, catalog: readonly CatalogEntry[] | null): ReadSlug | null {
  const own = title.crazydramas_slug?.trim() || null;
  if (!link) return own ? { slug: own, reason: "title" } : null;
  const listed = catalog?.find((d) => d.id === link.cd_drama_id) ?? null;
  const platformSlug = listed?.slug ?? link.slug;
  if (own && own !== link.title_slug && own !== link.slug && own !== platformSlug) return { slug: own, reason: "title_edited" };
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

/** What the public read shows of a series: a published one's facts without `managed_by`, its published episodes; null for one the site does not show. */
function publicView(drama: PlatformDrama, episodes: readonly PlatformEpisode[]): { drama: PlatformDrama; episodes: PlatformEpisode[] } | null {
  if (drama.status !== "published") return null;
  const shown = episodes.filter((e) => e.is_published);
  const { managed_by: _managed, ...facts } = drama;
  return { drama: { ...facts, episode_count: shown.length }, episodes: shown };
}

function errorText(e: unknown): string {
  if (e instanceof CrazydramasApiError) return e.message;
  if (isDataError(e)) return e.message;
  if (e instanceof Error) return e.message.slice(0, 300);
  return String(e).slice(0, 300);
}

/**
 * One title, one read: the caller's session says whether the title is
 * theirs to see (a foreign title is not found; a viewer-role producer is
 * refused, as CLAUDE.md keeps viewers read-only and a check writes a row);
 * the system records. On a 200 with no link yet, the link is made with the
 * drama id the platform returned; a link whose slug the platform renamed
 * follows the catalog; a title whose slug the person re-pointed in Studio
 * moves its link to the drama that slug now answers with (refused, in the
 * snapshot's error, when another title holds that drama). A failed request
 * is a snapshot with its error and no body — the screens show the last good
 * read marked stale. The status answered is read as the caller: the rows
 * their session may see, never another company's reads of the same slug.
 */
export async function checkCrazydramasTitle(session: Session, titleId: string, opts: CheckOptions = {}): Promise<CheckResult> {
  const data = getData();
  const sys = systemSession();
  const now = opts.now ?? Date.now;
  const detail = await data.getTitle(session, titleId); // not_found for a foreign title, before anything is read or written
  if (session.kind === "producer" && (session.producerRole ?? "viewer") === "viewer") throw forbidden("Requires the reviewer role");
  const title = detail.title;
  const link = await data.getPlatformLink(sys, titleId, PLATFORM);
  const episodes = await data.listTitleEpisodes(sys, titleId);
  const transport = opts.transport ?? crazydramasTransport();
  // The reading of one slug: the link goes with it only when it is the link's slug; a re-point that answered 404 (or a
  // followed rename whose read failed) reads under the slug that was read, with no link, so the answer never names the
  // old drama as if it were still this title's (the phase 3a review, round two).
  const statusOf = async (slug: string, current: PlatformLink | null) => {
    const link = current?.slug === slug ? current : null;
    return crazydramasStatusFor(link ? title : { crazydramas_slug: slug }, episodes, await titleSnapshots(session, titleId, slug), link);
  };

  /** The 30-second rule on one slug: the seconds to wait, or null. Judged on every read of the slug (the system's view), so two companies cannot hammer one slug together. */
  const tooSoon = async (slug: string): Promise<CheckResult | null> => {
    if (opts.force) return null;
    const newest = (await data.listPlatformSnapshots(sys, PLATFORM, slug, { limit: 1 }))[0];
    if (!newest) return null;
    const age = now() - Date.parse(newest.read_at);
    if (!(age >= 0 && age < CHECK_MIN_AGE_MS)) return null;
    return { outcome: "too_soon", title_id: titleId, slug, retry_after_s: Math.ceil((CHECK_MIN_AGE_MS - age) / 1000), status: await statusOf(slug, link) };
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
        // The first 200 makes the link; a re-pointed title moves it (title_slug becomes the slug the person set); a followed
        // rename updates its slug and keeps title_slug — or records the title's own slug when the link already accepted it
        // (film-meta brought up to date with the first rename before a second one), so the next check still knows the
        // title's own slug is not an edit.
        try {
          const own = title.crazydramas_slug?.trim() || null;
          const titleSlug = !link || read.reason === "title_edited" ? read.slug : own && (own === link.title_slug || own === link.slug) ? own : link.title_slug;
          currentLink = await data.upsertPlatformLink(sys, { title_id: titleId, platform: PLATFORM, slug: read.slug, title_slug: titleSlug, cd_drama_id: answer.drama.id, ...(answer.drama.managed_by !== undefined ? { managed_by: answer.drama.managed_by } : {}) });
          linked = !link || currentLink.cd_drama_id !== link.cd_drama_id;
        } catch (e) {
          if (!isDataError(e) || e.code !== "conflict") throw e;
          // Said without naming the other title: "one film is one title per company" means it may be another company's.
          error = `${read.slug} is a series linked to a different title, so the link was not moved; staff can resolve it`;
        }
      }
      // An authenticated read says who manages the series (phase 5): the link keeps it current (Jayden handing a series over,
      // or taking it back, changes it), so a write is refused before any call when the series is the CMS's.
      const managed = answer.drama.managed_by;
      if (managed !== undefined && currentLink && currentLink.cd_drama_id === answer.drama.id && (currentLink.managed_by ?? null) !== managed) {
        try {
          currentLink = await data.upsertPlatformLink(sys, { title_id: titleId, platform: PLATFORM, slug: currentLink.slug, title_slug: currentLink.title_slug, cd_drama_id: currentLink.cd_drama_id, managed_by: managed });
        } catch (e) {
          if (!isDataError(e)) throw e;
        }
      }
      if (error) {
        // A 200 that could not be linked is another title's drama. It keeps the refusal and at most what the public read
        // shows of it — a published series' public facts, its published episodes — never the authenticated read's draft,
        // archived or unpublished facts or who manages it (phase 5); a series the site does not show keeps no body at all.
        const seen = publicView(answer.drama, answer.episodes);
        snapshot = seen
          ? await data.recordPlatformSnapshot(sys, { platform: PLATFORM, slug: read.slug, cd_drama_id: answer.drama.id, title_id: titleId, http_status: 200, drama: seen.drama, episodes: seen.episodes, error, read_via: answer.read_via ?? null })
          : await data.recordPlatformSnapshot(sys, { platform: PLATFORM, slug: read.slug, cd_drama_id: link?.cd_drama_id ?? null, title_id: titleId, http_status: null, error, read_via: answer.read_via ?? null });
      } else {
        snapshot = await data.recordPlatformSnapshot(sys, { platform: PLATFORM, slug: read.slug, cd_drama_id: answer.drama.id, title_id: titleId, http_status: 200, drama: answer.drama, episodes: answer.episodes, error, read_via: answer.read_via ?? null });
      }
    } else {
      snapshot = await data.recordPlatformSnapshot(sys, { platform: PLATFORM, slug: read.slug, cd_drama_id: link?.cd_drama_id ?? null, title_id: titleId, http_status: 404, read_via: answer.read_via ?? null });
    }
  } catch (e) {
    if (isDataError(e)) throw e; // a refused row is a bug, never a "read failure"
    const status = e instanceof CrazydramasApiError ? e.status ?? null : null;
    snapshot = await data.recordPlatformSnapshot(sys, { platform: PLATFORM, slug: read.slug, cd_drama_id: link?.cd_drama_id ?? null, title_id: titleId, http_status: status === 200 ? null : status, error: errorText(e) });
  }
  const status = await statusOf(read.slug, currentLink);
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
          await data.recordPlatformSnapshot(sys, { platform: PLATFORM, slug: entry.slug, cd_drama_id: answer.drama.id, title_id: null, http_status: 200, drama: answer.drama, episodes: answer.episodes, read_via: answer.read_via ?? null });
        } else {
          await data.recordPlatformSnapshot(sys, { platform: PLATFORM, slug: entry.slug, cd_drama_id: entry.id, title_id: null, http_status: 404, read_via: answer.read_via ?? null });
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
  // Phase 5: every tick also wakes the uploads to crazydramas that no worker is running (a restart, a stale lease, a wait
  // that is due). Fire and forget; imported here so this module never loads the uploader for a page that only reads.
  void import("./publish").then((m) => m.resumeCrazydramasUploads()).catch((e) => console.warn(`[crazydramas] resuming uploads failed: ${errorText(e)}`));
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
    // Live means published: an authenticated read also sees drafts and archived series, which are not on the site.
    if (r.title_id || r.http_status !== 200 || !r.drama || r.error || linked.has(r.drama.id) || r.drama.status !== "published") continue;
    out.push({
      slug: r.slug,
      cd_drama_id: r.drama.id,
      title: r.drama.title,
      episode_count: r.episodes ? r.episodes.filter((e) => e.is_published).length : r.drama.episode_count,
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
