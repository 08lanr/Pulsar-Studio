// The CrazyDramas hub (overnight spec item 10, 2026-09-24): one page that
// lists every film and title once — every workspace film the scanner sees,
// every Studio title, and every series live on crazydramas.com that matches
// neither — with where it stands in Studio, where it stands on crazydramas,
// its episodes, and ONE button for the next step:
//
//   Import → Upload to crazydramas → Publish → Open on site
//
// Films that are not ready to import (a narrated work folder, a render in
// progress, a film not delivered yet) are not rows: they fold into one
// "Not ready (n)" line with their reasons.
//
// Two halves. `buildHub` is pure: it takes what the loader read and decides
// every row, its words (as codes the screen puts into words) and its action,
// so the rules have unit tests. `loadCrazydramasHub` reads — the workspace
// scan with every company's titles (`listFilmsForHub`), the titles, their
// crazydramas statuses (the same reading every screen uses) and their upload
// ledgers, and the series the sweep saw that match no title — and calls it.
// Nothing here writes, and nothing reaches crazydramas: the statuses are the
// recorded snapshots.

import { systemSession, type Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { mediaUrl } from "@/lib/data/storage";
import { listFilmsForHub, type HubFilmRow, type ImportProgress } from "@/lib/film-import/import";
import type { FilmScanState, ScanReason } from "@/lib/film-import/types";
import type { CdPublication, Title, TitleSummary } from "@/lib/types";
import { ACTIVE_LEDGER_STEPS } from "./publish-types";
import type { CrazydramasState, CrazydramasStatus } from "./match";
import { shownPosterUrl } from "./pick";
import { rowsByEpisode } from "./publish";
import { KNOWN_LIVE_SERIES, titleKey } from "./slug";
import { crazydramasSweepStatus, listUnmatchedCrazydramas, loadCrazydramasStatus, type UnmatchedSeries } from "./sweep";
import { crazydramasPublicUrl } from "./transport";

// ---- what a row says ---------------------------------------------------------------------------------------------

/** Where the film or title stands in Studio. */
export type HubInStudio =
  | { code: "not_imported" }
  /** Imported from the workspace; `update` when its files or plan changed since (a re-render: update on Import films). */
  | { code: "imported"; episodes: number; update: boolean }
  /** A title made in Studio (New title), not from the workspace. */
  | { code: "made_in_studio"; episodes: number }
  | { code: "not_in_studio" };

/** Where it stands on crazydramas.com, from the newest recorded read (never a fresh request). */
export type HubOnCd =
  /** Live: `episodes` published on the site; `match` of `of` Studio episodes the same length (null when Studio cannot tell). */
  | { code: "live"; episodes: number; match: number | null; of: number | null; state: CrazydramasState | null; cms: boolean }
  /** Studio's draft series: `uploaded` of `of` episodes on crazydramas, `publishable` of them verified and waiting, `uploading` on their way, `failed` stopped. */
  | { code: "draft"; uploaded: number; of: number; publishable: number; uploading: number; failed: number; cms: boolean }
  /** Nothing on crazydramas; `certain` false when only the public read answered (it cannot tell a draft from nothing). */
  | { code: "not_uploaded"; certain: boolean }
  | { code: "archived"; cms: boolean }
  /** A slug nobody has read yet. */
  | { code: "not_checked" }
  /** No slug yet: Studio picks one when the upload form opens. */
  | { code: "no_slug" }
  | { code: "check_failed" }
  /** The slug now answers for another series, or the series is linked to another title. */
  | { code: "elsewhere" }
  /** A film nobody imported, with no series of its name on the site; `read` false while the catalog has not been read (so nobody knows yet). */
  | { code: "before_import"; read: boolean };

/** The one button of a row. */
export type HubAction =
  | { kind: "import"; source_ref: string }
  /** Open "Upload to crazydramas" in place (the series form, the uploads). */
  | { kind: "upload"; title_id: string }
  /** Uploads on their way: open the progress in place. */
  | { kind: "uploading"; title_id: string; n: number; of: number }
  /** Verified episodes wait (`n` of them), or — `n` 0 — every episode went out and the series itself is still a draft: open the publish step in place. */
  | { kind: "publish"; title_id: string; n: number }
  | { kind: "open_site"; url: string }
  /** Something to look at on the title's CrazyDramas section (a failed read, a slug that moved). */
  | { kind: "check"; title_id: string }
  /** A title with no episode video: nothing to upload yet. */
  | { kind: "add_episodes"; title_id: string }
  | { kind: "none" };

export type HubRow = {
  key: string;
  kind: "film" | "title" | "series";
  name: string;
  /** The name's language ("en" for an English name, "zh-CN" for a title known only in Chinese). */
  lang: "en" | "zh-CN";
  /** A second line: the source title, the folder, the Chinese name or the slug (`sub_kind` says which). */
  sub: string | null;
  sub_kind: "source_title" | "folder" | "name_zh" | "slug" | null;
  company: string | null;
  producer_id: string | null;
  /** A same-origin or https picture for the row; null when there is none. */
  poster: string | null;
  /** The title's own cover in Studio (the upload form's poster default), when it has one. */
  cover_url: string | null;
  source_ref: string | null;
  title_id: string | null;
  slug: string | null;
  public_url: string | null;
  in_studio: HubInStudio;
  on_cd: HubOnCd;
  /** Studio's episodes (a film's delivered episodes before import), or the site's for a series Studio does not have. */
  episodes: number | null;
  action: HubAction;
  /** A running (or just finished) import of this film. */
  progress: ImportProgress | null;
};

/** A film that cannot be imported yet, for the folded "Not ready (n)" line. */
export type HubNotReady = { key: string; name: string; source_ref: string; state: FilmScanState; reason: ScanReason | null; note: string | null };

export type Hub = {
  rows: HubRow[];
  not_ready: HubNotReady[];
  /** WORKSPACE_ROOT is set (films are listed). */
  workspace: boolean;
  /** The sweep has read the crazydramas catalog in this process (the series rows are known); false before any read. */
  catalog_read: boolean;
};

// ---- what the loader hands the builder ---------------------------------------------------------------------------

/** A title with the facts the hub reads. */
export type HubTitleInput = Pick<TitleSummary, "id" | "name_zh" | "name_en" | "producer_id" | "producer_name_zh" | "producer_name_en" | "episodes_ingested"> & {
  source_ref: string | null;
  crazydramas_slug: string | null;
  cover_url: string | null;
  episodes_with_video: number;
};

/** The upload ledger of one title, counted per episode's live row. */
export type HubLedger = { active: number; verified: number; published: number; failed: number };

export type HubStatusInput = Pick<CrazydramasStatus, "state" | "detail" | "note" | "slug" | "counts"> & {
  series: Pick<NonNullable<CrazydramasStatus["series"]>, "managed_by" | "status" | "episode_count" | "poster_url"> | null;
};

export type HubInput = {
  workspace: boolean;
  films: readonly HubFilmRow[];
  titles: readonly HubTitleInput[];
  statuses: ReadonlyMap<string, HubStatusInput>;
  ledgers: ReadonlyMap<string, HubLedger>;
  /** Series the sweep read that match no title the session reads; null before any read. Films nobody imported are matched against them. */
  unmatched: readonly UnmatchedSeries[] | null;
  /** Whether the series no film matches are rows of their own (the staff desk; a producer's page matches films against them but lists none). */
  series_rows: boolean;
  catalog_read: boolean;
  /** Who may import films and drive the uploads (a staff administrator, the company's approver). */
  can_act: boolean;
  /** A film's poster thumbnail route (the portal's). */
  film_poster: (ref: string) => string;
  /** The public page of a slug. */
  public_url: (slug: string) => string;
  /** How a series poster may be shown (fixture mode withholds a foreign picture). */
  series_poster?: (url: string | null) => string | null;
};

const READY_TO_IMPORT: ReadonlySet<FilmScanState> = new Set(["READY"]);
const IN_STUDIO: ReadonlySet<FilmScanState> = new Set(["IMPORTED", "K_CHANGED"]);

/** The ledger counted per episode (each episode's live row, `rowsByEpisode`). */
export function ledgerCounts(rows: readonly CdPublication[]): HubLedger {
  const out: HubLedger = { active: 0, verified: 0, published: 0, failed: 0 };
  for (const row of rowsByEpisode(rows).values()) {
    if ((ACTIVE_LEDGER_STEPS as readonly string[]).includes(row.step)) out.active += 1;
    else if (row.step === "verified") out.verified += 1;
    else if (row.step === "published") out.published += 1;
    else if (row.step === "failed") out.failed += 1;
  }
  return out;
}

const LIVE_STATES: ReadonlySet<CrazydramasState> = new Set(["live_complete", "live_partial", "live_differs", "live_unverified", "local_newer"]);

/** What the recorded reading and the ledger say about the series, in the hub's words. */
export function onCdOf(status: HubStatusInput | null | undefined, ledger: HubLedger | null | undefined, studioEpisodes: number): HubOnCd {
  if (!status || !status.slug) return { code: "no_slug" };
  const cms = status.series?.managed_by === "cms";
  const l = ledger ?? { active: 0, verified: 0, published: 0, failed: 0 };
  if (status.note === "slug_reassigned") return { code: "elsewhere" };
  if (LIVE_STATES.has(status.state)) {
    const c = status.counts;
    const match = status.state === "live_unverified" ? null : c.same_length + c.close + c.identical;
    return { code: "live", episodes: c.live, match, of: status.state === "live_unverified" ? null : c.studio, state: status.state, cms };
  }
  if (status.state === "read_failed") return { code: "check_failed" };
  if (status.state === "not_checked") return l.active + l.verified + l.published + l.failed > 0 ? draftOf(l, studioEpisodes, cms) : { code: "not_checked" };
  if (status.state === "not_live") {
    if (status.detail === "archived") return { code: "archived", cms };
    // Studio's own ledger proves a draft even when only the public read answered (it cannot see drafts).
    if (status.detail === "draft" || l.active + l.verified + l.published + l.failed > 0) return draftOf(l, studioEpisodes, cms);
    return { code: "not_uploaded", certain: status.detail === "not_uploaded" };
  }
  return { code: "no_slug" };
}

function draftOf(l: HubLedger, studioEpisodes: number, cms: boolean): HubOnCd {
  return { code: "draft", uploaded: l.verified + l.published, of: studioEpisodes, publishable: l.verified, uploading: l.active, failed: l.failed, cms };
}

/** The next step of a Studio title, from where it stands on crazydramas. */
export function titleAction(titleId: string, onCd: HubOnCd, ledger: HubLedger | null | undefined, withVideo: number, publicUrl: string | null, canAct: boolean): HubAction {
  const l = ledger ?? { active: 0, verified: 0, published: 0, failed: 0 };
  const onTheirWay = l.active;
  const sent = l.active + l.verified + l.published;
  if (onCd.code === "live") {
    // A CMS series is read-only for Studio: the site is the only next step.
    if (!onCd.cms && canAct) {
      if (onTheirWay > 0) return { kind: "uploading", title_id: titleId, n: l.verified + l.published, of: withVideo };
      if (l.verified > 0) return { kind: "publish", title_id: titleId, n: l.verified };
      // Studio's own live series with episodes still to send (a partial upload): the rest go up the same way.
      if (onCd.state === "live_partial" && sent < withVideo) return { kind: "upload", title_id: titleId };
    }
    return publicUrl ? { kind: "open_site", url: publicUrl } : { kind: "none" };
  }
  if (onCd.code === "check_failed" || onCd.code === "elsewhere") return { kind: "check", title_id: titleId };
  if (onCd.code === "archived") return { kind: "check", title_id: titleId };
  if (onCd.code === "draft" && onCd.cms) return { kind: "check", title_id: titleId };
  if (withVideo === 0) return { kind: "add_episodes", title_id: titleId };
  if (!canAct) return { kind: "none" };
  if (onTheirWay > 0) return { kind: "uploading", title_id: titleId, n: l.verified + l.published, of: withVideo };
  if (l.verified > 0 && sent >= withVideo) return { kind: "publish", title_id: titleId, n: l.verified };
  if (sent < withVideo) return { kind: "upload", title_id: titleId };
  if (l.verified > 0) return { kind: "publish", title_id: titleId, n: l.verified };
  // Every episode went out and was published, and the series is still a draft ("Also publish the series" left unticked,
  // or its own call failed after the batches): publishing the series is the step left, not another upload.
  if (onCd.code === "draft" && !onCd.cms && l.published > 0 && l.verified === 0 && sent >= withVideo) return { kind: "publish", title_id: titleId, n: 0 };
  return { kind: "upload", title_id: titleId };
}

/** The live series a film nobody imported would link to: its slug, the working-name table, or the same title. */
function seriesForFilm(film: HubFilmRow, series: readonly UnmatchedSeries[]): UnmatchedSeries | null {
  const keys = [film.display_title, film.source_title, film.folder.replace(/[-_]+/g, " ")].map(titleKey).filter(Boolean);
  const known = KNOWN_LIVE_SERIES.find((k) => keys.includes(titleKey(k.working)))?.slug ?? null;
  return series.find((s) => s.slug === film.crazydramas_slug || s.slug === known || keys.includes(titleKey(s.title))) ?? null;
}

const ACTION_ORDER: Record<HubAction["kind"], number> = { publish: 0, uploading: 1, upload: 2, import: 3, check: 4, add_episodes: 5, open_site: 6, none: 7 };

/**
 * Every row of the hub, pure. A film imported by a company is one row with
 * its title (a film two companies imported is two); a title with no film in
 * the workspace (made in Studio, or its folder is gone) is a row of its own;
 * a live series is a row only when no film and no title matches it. Rows that
 * need something done come first (publish, uploads, upload, import), then the
 * rest, each group by name.
 */
export function buildHub(input: HubInput): Hub {
  const rows: HubRow[] = [];
  const notReady: HubNotReady[] = [];
  const series = input.unmatched ?? [];
  const usedSeries = new Set<string>();
  const titlesById = new Map(input.titles.map((t) => [t.id, t]));
  const titlesSeen = new Set<string>();
  const seriesPoster = input.series_poster ?? ((u: string | null) => u);

  const companyOf = (t: HubTitleInput) => t.producer_name_en || t.producer_name_zh || null;

  const titleRow = (t: HubTitleInput, film: HubFilmRow | null): HubRow => {
    titlesSeen.add(t.id);
    const status = input.statuses.get(t.id) ?? null;
    const ledger = input.ledgers.get(t.id) ?? null;
    const episodes = Math.max(t.episodes_ingested, 0);
    const onCd = onCdOf(status, ledger, t.episodes_with_video);
    const slug = status?.slug ?? t.crazydramas_slug ?? null;
    if (slug) usedSeries.add(slug);
    const publicUrl = slug && (onCd.code === "live") ? input.public_url(slug) : null;
    const imported = !!t.source_ref;
    const name = t.name_en || t.name_zh;
    return {
      key: `title:${t.id}`,
      kind: film ? "film" : "title",
      name,
      lang: t.name_en ? "en" : "zh-CN",
      sub: film?.source_title ?? (t.name_en && t.name_zh !== t.name_en ? t.name_zh : null) ?? null,
      sub_kind: film?.source_title ? "source_title" : t.name_en && t.name_zh !== t.name_en ? "name_zh" : null,
      company: companyOf(t),
      producer_id: t.producer_id,
      poster: t.cover_url ?? (film?.poster_ref ? input.film_poster(film.poster_ref) : null) ?? seriesPoster(status?.series?.poster_url ?? null),
      cover_url: t.cover_url,
      source_ref: t.source_ref ?? film?.source_ref ?? null,
      title_id: t.id,
      slug,
      public_url: publicUrl,
      in_studio: imported ? { code: "imported", episodes, update: film?.state === "K_CHANGED" } : { code: "made_in_studio", episodes },
      on_cd: onCd,
      episodes,
      action: titleAction(t.id, onCd, ledger, t.episodes_with_video, publicUrl, input.can_act),
      progress: film?.progress ?? null,
    };
  };

  for (const film of input.films) {
    const title = film.imported ? titlesById.get(film.imported.title_id) ?? null : null;
    if (title) {
      rows.push(titleRow(title, film));
      continue;
    }
    if (film.imported || IN_STUDIO.has(film.state)) continue; // a title this session cannot see
    if (!READY_TO_IMPORT.has(film.state)) {
      notReady.push({ key: `film:${film.source_ref}`, name: film.display_title, source_ref: film.source_ref, state: film.state, reason: film.reason, note: film.warnings[0] ?? null });
      continue;
    }
    const live = seriesForFilm(film, series);
    if (live) usedSeries.add(live.slug);
    rows.push({
      key: `film:${film.source_ref}`,
      kind: "film",
      name: film.display_title,
      lang: "en",
      sub: film.source_title ?? film.folder,
      sub_kind: film.source_title ? "source_title" : "folder",
      company: null,
      producer_id: null,
      poster: film.poster_ref ? input.film_poster(film.poster_ref) : null,
      cover_url: null,
      source_ref: film.source_ref,
      title_id: null,
      slug: live?.slug ?? film.crazydramas_slug,
      public_url: live ? live.public_url : null,
      in_studio: { code: "not_imported" },
      // A series no Studio title holds was made in the CMS; one another company's title holds is live, and who made it is not this page's to say.
      on_cd: live ? { code: "live", episodes: live.episode_count, match: null, of: null, state: null, cms: !live.held } : { code: "before_import", read: input.catalog_read },
      episodes: film.episodes,
      action: input.can_act ? { kind: "import", source_ref: film.source_ref } : { kind: "none" },
      progress: film.progress,
    });
  }

  for (const t of input.titles) if (!titlesSeen.has(t.id)) rows.push(titleRow(t, null));

  for (const s of input.series_rows ? series : []) {
    if (usedSeries.has(s.slug) || s.held) continue;
    rows.push({
      key: `series:${s.slug}`,
      kind: "series",
      name: s.title,
      lang: "en",
      sub: s.slug,
      sub_kind: "slug",
      company: null,
      producer_id: null,
      poster: seriesPoster(s.poster_url),
      cover_url: null,
      source_ref: null,
      title_id: null,
      slug: s.slug,
      public_url: s.public_url,
      in_studio: { code: "not_in_studio" },
      on_cd: { code: "live", episodes: s.episode_count, match: null, of: null, state: null, cms: true },
      episodes: s.episode_count,
      action: { kind: "open_site", url: s.public_url },
      progress: null,
    });
  }

  rows.sort((a, b) => ACTION_ORDER[a.action.kind] - ACTION_ORDER[b.action.kind] || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  notReady.sort((a, b) => a.source_ref.localeCompare(b.source_ref));
  return { rows, not_ready: notReady, workspace: input.workspace, catalog_read: input.catalog_read };
}

// ---- the loader ----------------------------------------------------------------------------------------------------

export type HubOptions = {
  /** Which portal's poster route the film thumbnails use. */
  portal: "admin" | "producer";
  can_act: boolean;
};

/**
 * Everything the hub shows for one session: the workspace films against the
 * titles the session can read, the statuses and ledgers of those titles, and
 * (staff) the live series that match none. A title list read fails the page;
 * the workspace and the unmatched list fail soft (the rows they would add are
 * left out, and the page says the workspace is not set).
 */
export async function loadCrazydramasHub(session: Session, opts: HubOptions): Promise<Hub> {
  const data = getData();
  const sys = systemSession();
  // The series nobody's title matches are rows on the staff desk only; a staff preview of the producer page leaves them out too.
  const staffList = session.kind === "staff" && opts.portal === "admin";
  const summaries = await data.listTitles(session);
  // Both portals match the films nobody imported against the live series, so a film whose show is live never reads
  // "Not on CrazyDramas". A producer's session reads no title-less snapshot, so the producer page reads them as the
  // system, counting as matched only the titles this session reads (another company's series is live, not "nobody's").
  const readUnmatched = staffList ? listUnmatchedCrazydramas(session) : listUnmatchedCrazydramas(sys, { titleIds: new Set(summaries.map((t) => t.id)) });
  const [films, unmatched] = await Promise.all([
    listFilmsForHub(session, {}, summaries).catch(() => ({ configured: false, films: [] as HubFilmRow[] })),
    readUnmatched.catch(() => null),
  ]);
  const titles: HubTitleInput[] = summaries.map((t) => ({
    id: t.id,
    name_zh: t.name_zh,
    name_en: t.name_en,
    producer_id: t.producer_id,
    producer_name_zh: t.producer_name_zh,
    producer_name_en: t.producer_name_en,
    episodes_ingested: t.episodes_ingested,
    source_ref: t.source_ref ?? null,
    crazydramas_slug: t.crazydramas_slug ?? null,
    cover_url: mediaUrl(t.cover_path ?? null),
    episodes_with_video: t.episodes_with_video ?? 0,
  }));
  const statuses = new Map<string, HubStatusInput>();
  const ledgers = new Map<string, HubLedger>();
  await Promise.all(
    titles.map(async (t) => {
      if (!t.crazydramas_slug) return;
      const status = await loadCrazydramasStatus(session, { id: t.id, crazydramas_slug: t.crazydramas_slug } as Title);
      statuses.set(t.id, status);
      ledgers.set(t.id, ledgerCounts(await data.getCdPublications(sys, t.id)));
    })
  );
  const catalogRead = unmatched !== null && (unmatched.length > 0 || crazydramasSweepStatus().lastAt !== null);
  const posterRoute = opts.portal === "admin" ? "/api/admin/films/poster" : "/api/producer/films/poster";
  return buildHub({
    workspace: films.configured,
    films: films.films,
    titles,
    statuses,
    ledgers,
    unmatched,
    series_rows: staffList,
    catalog_read: catalogRead,
    can_act: opts.can_act,
    film_poster: (ref) => `${posterRoute}?ref=${encodeURIComponent(ref)}`,
    public_url: crazydramasPublicUrl,
    series_poster: shownPosterUrl,
  });
}
