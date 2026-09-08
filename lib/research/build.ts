// The snapshot builder, as a pure function: collector artifacts in, a
// validated snapshot (or a list of validation errors) out. The script
// scripts/research/build-snapshot.ts does the file I/O and publication;
// tests call this directly with hand-built artifacts.
//
// Rules (docs/market-desk-plan.md, phase 1):
// - A platform whose artifact is missing or failed is CARRIED FORWARD from
//   the previous published snapshot with status `stale`, never dropped.
// - Fewer listings than MIN_TITLES → `partial`.
// - List membership is merged first; flags are derived after, so encounter
//   order cannot change a listing's fields.
// - Every counter becomes an Observation with the platform's field name,
//   the unit, and the read time of the page it came from.

import { TAXONOMY_VERSION, assignTropes, audienceFromTags } from "./taxonomy";
import {
  MIN_TITLES,
  SNAPSHOT_SCHEMA_VERSION,
  marketSnapshotSchema,
  type CompanyLink,
  type MarketSnapshot,
  type MarketTitle,
  type Observation,
  type Placement,
  type Platform,
  type PlatformRun,
} from "./types";

export const BUILDER_VERSION = "2.0";

const NOT_DRAMA = new Set(["Podcast", "Reality Show"]);

/** 0.1 collector artifacts carry no chart flag; the platform list ids decide. */
const CHART_LISTS = new Set(["top", "trending", "must-sees", "home-top"]);

export type RawList = { list: string; name: string; chart?: boolean; fetched_at?: string; books: Record<string, unknown>[] };
export type RawArtifact = Record<string, unknown>;
export type RawFailure = { platform: Platform; failed_at: string; error: string };

export type BuildInput = {
  runId: string;
  artifacts: Partial<Record<Platform, RawArtifact | null>>;
  failures: Partial<Record<Platform, RawFailure | null>>;
  previous: MarketSnapshot | null;
  now?: string;
};

export type BuildResult = {
  snapshot: MarketSnapshot;
  errors: string[];
  manifest: {
    run_id: string;
    builder_version: string;
    taxonomy_version: string;
    built_at: string;
    platforms: Record<string, unknown>;
    validation: { ok: boolean; errors: string[] };
  };
};

function isChart(list: RawList): boolean {
  if (typeof list.chart === "boolean") return list.chart;
  return CHART_LISTS.has(list.list) || list.name === "TOP";
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : []);
const bool = (v: unknown): boolean => v === true;
const validStamp = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

function obs(value: number | null, source_field: string, unit: Observation["unit"], observed_at: string): Observation | null {
  return value == null ? null : { value, source_field, unit, observed_at, evidence: "observed" };
}

function addPlacement(map: Map<string, MarketTitle>, key: string, placement: Placement) {
  const row = map.get(key);
  if (row && !row.placements.some((p) => p.list === placement.list)) row.placements.push(placement);
}

// ---- ReelShort ------------------------------------------------------------------------------

export function buildReelshort(raw: RawArtifact): MarketTitle[] {
  const map = new Map<string, MarketTitle>();
  const runFetched = String(raw.fetched_at);
  const lists: RawList[] = [
    ...((raw.lists as RawList[]) ?? []),
    ...(((raw.shelves as { shelf_id: string; name: string; fetched_at?: string; books: Record<string, unknown>[] }[]) ?? []).map((s) => ({
      list: `shelf-${s.shelf_id}`,
      name: s.name,
      chart: s.name === "TOP",
      fetched_at: s.fetched_at,
      books: s.books,
    }))),
  ];
  for (const list of lists) {
    const fetched = validStamp(list.fetched_at) ?? runFetched;
    for (const b of list.books) {
      const id = str(b.book_id);
      if (!id) continue;
      const key = `reelshort-${id}`;
      const platform_tags = strs(b.themes);
      if (platform_tags.some((t) => NOT_DRAMA.has(t))) continue; // ReelTalk podcasts and reality clips share the shelves
      if (!map.has(key)) {
        const title = str(b.title) ?? "";
        const blurb = str(b.blurb) ?? "";
        map.set(key, {
          key,
          platform: "reelshort",
          platform_id: id,
          title,
          blurb,
          cover: str(b.cover),
          url: `https://www.reelshort.com/episodes/episode-1-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${id}`,
          companies: [],
          audience: audienceFromTags(platform_tags),
          episode_count: num(b.episode_count),
          paywall_episode: num(b.paid_start),
          episode_seconds: num(b.ep1_duration_s),
          episode_seconds_basis: num(b.ep1_duration_s) == null ? null : "episode_1",
          released_at: null,
          platform_new: bool(b.is_new),
          platform_tags,
          tropes: assignTropes({ platform_tags, title, blurb }),
          metrics: {
            views: obs(num(b.read_count), "read_count", "views", fetched),
            saves: obs(num(b.collect_count), "collect_count", "collects", fetched),
            rating: null,
          },
          placements: [],
        });
      }
      addPlacement(map, key, { list: list.list, name: list.name, rank: Number(b.rank) || 0, chart: isChart(list) });
    }
  }
  for (const row of map.values()) {
    if (row.placements.some((p) => p.name === "Reel Original")) {
      row.companies.push({ name: "ReelShort (Crazy Maple Studio)", role: "platform_original", evidence: "inferred", via: "Reel Original shelf" });
    }
  }
  return Array.from(map.values());
}

// ---- DramaBox --------------------------------------------------------------------------------

export function buildDramabox(raw: RawArtifact): MarketTitle[] {
  const map = new Map<string, MarketTitle>();
  const runFetched = String(raw.fetched_at);
  const details = new Map<string, Record<string, unknown>>();
  for (const d of (raw.details as Record<string, unknown>[]) ?? []) {
    const id = str(d.book_id);
    if (id) details.set(id, d);
  }
  const lists = (raw.lists as RawList[]) ?? [];
  for (const list of lists) {
    const cardFetched = validStamp(list.fetched_at) ?? runFetched;
    for (const b of list.books) {
      const id = str(b.book_id);
      if (!id) continue;
      const key = `dramabox-${id}`;
      if (!map.has(key)) {
        const d = details.get(id) ?? {};
        const audienceTag = str(b.audience) ?? str(b.lead);
        const platform_tags = Array.from(new Set([...strs(b.tags), ...strs(b.genres), ...strs(d.tags), ...strs(d.genres), ...(audienceTag ? [audienceTag] : [])]));
        const title = str(d.title) ?? str(b.title) ?? "";
        const blurb = str(d.blurb) ?? str(b.blurb) ?? "";
        const author = str(b.author) ?? str(d.author);
        const detailFetched = validStamp(d.fetched_at) ?? runFetched;
        const hasDetail = details.has(id);
        const companies: CompanyLink[] = author ? [{ name: author, role: "publisher", evidence: "observed", via: "author field" }] : [];
        map.set(key, {
          key,
          platform: "dramabox",
          platform_id: id,
          title,
          blurb,
          cover: str(d.cover) ?? str(b.cover),
          url: `https://www.dramaboxapp.com/film/${id}`,
          companies,
          audience: audienceFromTags(platform_tags),
          episode_count: num(d.episode_count) ?? num(b.episode_count),
          paywall_episode: num(d.paid_start),
          episode_seconds: num(d.avg_episode_s),
          episode_seconds_basis: num(d.avg_episode_s) == null ? null : "listed_average",
          released_at: (str(d.shelf_time) ?? str(b.shelf_time))?.slice(0, 10) ?? null,
          platform_new: false,
          platform_tags,
          tropes: assignTropes({ platform_tags, title, blurb }),
          metrics: {
            // Card viewCount is a different small display number; only the film page's counter is a view metric.
            views: hasDetail ? obs(num(d.view_count), "viewCount", "views", detailFetched) : null,
            saves: hasDetail ? obs(num(d.follow_count), "followCount", "follows", detailFetched) : obs(num(b.follow_count), "followCount", "follows", cardFetched),
            rating: obs(num(b.rating) ?? num(d.rating), "ratings", "rating", cardFetched),
          },
          placements: [],
        });
      }
      addPlacement(map, key, { list: list.list, name: list.name, rank: Number(b.rank) || 0, chart: isChart(list) });
    }
  }
  // Flags from merged membership, so order cannot matter.
  for (const row of map.values()) row.platform_new = row.placements.some((p) => p.list === "newest");
  return Array.from(map.values());
}

// ---- assembly -------------------------------------------------------------------------------

const BUILDERS: Record<Platform, (raw: RawArtifact) => MarketTitle[]> = { reelshort: buildReelshort, dramabox: buildDramabox };

function platformRun(platform: Platform, raw: RawArtifact, rows: MarketTitle[]): PlatformRun {
  const coverage = raw.detail_coverage as { requested?: number; fetched?: number } | undefined;
  return {
    id: platform,
    status: rows.length >= MIN_TITLES[platform] ? "ok" : "partial",
    fetched_at: String(raw.fetched_at),
    source_urls: strs(raw.source_urls),
    title_count: rows.length,
    with_views: rows.filter((t) => t.metrics.views != null).length,
    collection: { surface: "public_web", locale: "en", audience_geography: "unknown" },
    detail_coverage: coverage ? { requested: Number(coverage.requested ?? 0), fetched: Number(coverage.fetched ?? 0) } : null,
    stale_from_run: null,
    error: null,
  };
}

export function buildSnapshot(input: BuildInput): BuildResult {
  const now = input.now ?? new Date().toISOString();
  const platforms: PlatformRun[] = [];
  const titles: MarketTitle[] = [];
  const manifestPlatforms: Record<string, unknown> = {};
  let anyFresh = false;
  let latestFetch = "";
  for (const platform of ["reelshort", "dramabox"] as Platform[]) {
    const raw = input.artifacts[platform] ?? null;
    const failed = input.failures[platform] ?? null;
    if (raw && validStamp(raw.fetched_at)) {
      const rows = BUILDERS[platform](raw);
      const run = platformRun(platform, raw, rows);
      platforms.push(run);
      titles.push(...rows);
      anyFresh = true;
      if (run.fetched_at > latestFetch) latestFetch = run.fetched_at;
      manifestPlatforms[platform] = { status: run.status, titles: rows.length, with_views: run.with_views, detail_coverage: run.detail_coverage };
      continue;
    }
    const error = failed?.error ?? (raw ? "artifact has no valid fetched_at" : "no artifact for this run");
    const prevRun = input.previous?.platforms.find((p) => p.id === platform) ?? null;
    if (input.previous && prevRun && prevRun.status !== "failed") {
      const rows = input.previous.titles.filter((t) => t.platform === platform);
      platforms.push({ ...prevRun, status: "stale", stale_from_run: prevRun.stale_from_run ?? input.previous.run_id, error });
      titles.push(...rows);
      manifestPlatforms[platform] = { status: "stale", from_run: prevRun.stale_from_run ?? input.previous.run_id, error };
    } else {
      platforms.push({
        id: platform,
        status: "failed",
        fetched_at: now,
        source_urls: [],
        title_count: 0,
        with_views: 0,
        collection: { surface: "public_web", locale: "en", audience_geography: "unknown" },
        detail_coverage: null,
        stale_from_run: null,
        error,
      });
      manifestPlatforms[platform] = { status: "failed", error };
    }
  }
  const observed_at = (latestFetch || input.runId.replace(/T.*$/, "")).slice(0, 10);
  titles.sort((a, b) => a.key.localeCompare(b.key));
  const snapshot: MarketSnapshot = { schema_version: SNAPSHOT_SCHEMA_VERSION, run_id: input.runId, observed_at, taxonomy_version: TAXONOMY_VERSION, platforms, titles };

  const errors: string[] = [];
  if (!anyFresh) errors.push("no platform produced a fresh artifact in this run");
  const parsed = marketSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) for (const issue of parsed.error.issues.slice(0, 20)) errors.push(`${issue.path.join(".")}: ${issue.message}`);
  const keys = new Set<string>();
  for (const t of titles) {
    if (keys.has(t.key)) errors.push(`duplicate key ${t.key}`);
    keys.add(t.key);
  }
  return {
    snapshot,
    errors,
    manifest: { run_id: input.runId, builder_version: BUILDER_VERSION, taxonomy_version: TAXONOMY_VERSION, built_at: now, platforms: manifestPlatforms, validation: { ok: errors.length === 0, errors } },
  };
}
