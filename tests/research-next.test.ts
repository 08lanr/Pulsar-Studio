import { test } from "node:test";
import assert from "node:assert/strict";

import { FRESH_DAYS, freshReasons, whatToMakeNext } from "@/lib/research/next";
import { TAXONOMY_VERSION } from "@/lib/research/taxonomy";
import { metricByKey } from "@/lib/research/registry";
import type { MarketSnapshot, MarketTitle, Observation, PlatformRun } from "@/lib/research/types";

// ---- factories ----------------------------------------------------------------------

const o = (value: number, observed_at: string, source_field = "read_count", unit: Observation["unit"] = "views"): Observation => ({ value, source_field, unit, observed_at, evidence: "observed" });
const T = (ids: MarketTitle["tropes"][number]["id"][]) => ids.map((id) => ({ id, evidence: "observed" as const, via: id }));

function mt(over: Partial<MarketTitle> & { key: string; platform: MarketTitle["platform"] }): MarketTitle {
  return {
    platform_id: over.key.split("-")[1] ?? over.key,
    title: over.key,
    blurb: "A quiet bakery owner discovers the family friend who robbed her is her fiancé's brother.",
    cover: null,
    url: "https://example.test/x",
    companies: [],
    audience: null,
    episode_count: null,
    paywall_episode: null,
    episode_seconds: null,
    episode_seconds_basis: null,
    released_at: null,
    platform_new: false,
    platform_tags: [],
    tropes: [],
    metrics: { views: null, saves: null, rating: null },
    placements: [],
    ...over,
  };
}

function run(id: PlatformRun["id"], title_count: number): PlatformRun {
  return { id, status: "ok", fetched_at: "2026-09-08T04:00:00.000Z", source_urls: [], title_count, with_views: title_count, collection: { surface: "public_web", locale: "en", audience_geography: "unknown" }, detail_coverage: null, stale_from_run: null, error: null };
}

function snap(observed_at: string, titles: MarketTitle[], run_id = `${observed_at}T04-00-00Z`): MarketSnapshot {
  const platforms = Array.from(new Set(titles.map((t) => t.platform))).map((p) => run(p, titles.filter((t) => t.platform === p).length));
  return { schema_version: 2, run_id, observed_at, taxonomy_version: TAXONOMY_VERSION, engine_version: "2.0", platforms, titles } as MarketSnapshot;
}

const DAY1 = "2026-09-07";
const DAY2 = "2026-09-08";
const at1 = `${DAY1}T04:00:00.000Z`;
const at2 = `${DAY2}T04:00:00.000Z`;

// Two platforms; the old catalog leans CEO, the fresh cohort leans revenge.
function day2(): MarketTitle[] {
  const rs = (n: number, over: Partial<MarketTitle> = {}) => mt({ key: `reelshort-${n}`, platform: "reelshort", metrics: { views: o(1000 + n, at2), saves: null, rating: null }, ...over });
  const db = (n: number, over: Partial<MarketTitle> = {}) => mt({ key: `dramabox-${n}`, platform: "dramabox", metrics: { views: o(500 + n, at2, "viewCount"), saves: null, rating: null }, ...over });
  return [
    // fresh on ReelShort: flagged new, in the New shelf, with a baseline yesterday
    rs(1, { platform_new: true, tropes: T(["revenge", "secret_identity"]), placements: [{ list: "new", name: "New", rank: 1, chart: false }, { list: "top", name: "TOP", rank: 3, chart: true }], metrics: { views: o(4000, at2), saves: null, rating: null } }),
    rs(2, { platform_new: true, tropes: T(["revenge", "family_drama"]), placements: [{ list: "new", name: "New", rank: 2, chart: false }], metrics: { views: o(3000, at2), saves: null, rating: null } }),
    rs(3, { platform_new: true, tropes: T(["revenge"]), placements: [{ list: "new", name: "New", rank: 3, chart: false }] }),
    // fresh on ReelShort but first seen today (no baseline)
    rs(4, { platform_new: true, tropes: T(["contract_marriage"]) }),
    // old ReelShort back catalog, all CEO
    ...[5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((n) => rs(n, { tropes: T(["ceo_billionaire"]), placements: [{ list: "top", name: "TOP", rank: n, chart: true }] })),
    // DramaBox: released this week, in the newest list
    db(1, { released_at: DAY2, tropes: T(["revenge", "werewolf"]), placements: [{ list: "newest", name: "Newest", rank: 1, chart: false }] }),
    db(2, { released_at: "2026-08-20", tropes: T(["werewolf"]), placements: [{ list: "trending", name: "Trending", rank: 2, chart: true }] }),
    // DramaBox old release: not fresh
    db(3, { released_at: "2025-01-01", tropes: T(["ceo_billionaire"]), placements: [{ list: "trending", name: "Trending", rank: 1, chart: true }] }),
    // a counter that went down: anomaly, never a mover
    db(4, { released_at: "2025-06-01", tropes: T(["ceo_billionaire"]), metrics: { views: o(100, at2, "viewCount"), saves: null, rating: null } }),
  ];
}

function day1(): MarketTitle[] {
  const today = day2();
  return today
    .filter((t) => t.key !== "reelshort-4" && t.key !== "dramabox-1")
    .map((t) => {
      const v = t.metrics.views;
      const start = t.key === "reelshort-1" ? 2000 : t.key === "reelshort-2" ? 2500 : t.key === "dramabox-4" ? 900 : v ? v.value - 10 : null;
      return { ...t, metrics: { ...t.metrics, views: v && start != null ? o(start, at1, v.source_field, v.unit) : null } };
    });
}

// ---- fresh reasons --------------------------------------------------------------------

test("fresh reasons are observed and every one is kept", () => {
  const t = mt({ key: "dramabox-x", platform: "dramabox", platform_new: true, released_at: "2026-09-01", placements: [{ list: "newest", name: "Newest", rank: 4, chart: false }] });
  const reasons = freshReasons(t, DAY2, DAY2, true);
  assert.deepEqual(reasons.map((r) => r.kind), ["platform_new", "released", "new_list", "first_seen"]);
  assert.equal((reasons[1] as { days_ago: number }).days_ago, 7);
});

test(`a release older than ${FRESH_DAYS} days is not fresh, and first-seen needs history`, () => {
  const old = mt({ key: "dramabox-y", platform: "dramabox", released_at: "2026-01-01" });
  assert.deepEqual(freshReasons(old, DAY2, DAY2, false), []);
  const seenOnly = mt({ key: "dramabox-z", platform: "dramabox" });
  assert.deepEqual(freshReasons(seenOnly, DAY2, DAY2, false), []);
  assert.deepEqual(freshReasons(seenOnly, DAY2, DAY2, true).map((r) => r.kind), ["first_seen"]);
});

// ---- one day: nothing invented ----------------------------------------------------------

test("with one published day the board collects history: no growth, no movers, no first-seen", () => {
  const latest = snap(DAY2, day2());
  const board = whatToMakeNext({ latest, previous: null, history: [latest], days: [[DAY2, latest.run_id]] });
  assert.equal(board.window.state, "collecting_history");
  assert.ok(board.platforms.every((p) => p.movers.length === 0));
  for (const p of board.platforms) for (const x of p.titles) {
    assert.equal(x.growth.state, "collecting_history");
    assert.equal(x.first_seen, null);
    assert.ok(!x.reasons.some((r) => r.kind === "first_seen"));
  }
  assert.ok(board.tropes.every((s) => s.growth_pct === null && s.n_growth === 0));
  // ranked by prominence within the platform: the charted fresh listing leads ReelShort
  assert.equal(board.platforms.find((p) => p.platform === "reelshort")!.titles[0].title.key, "reelshort-1");
});

// ---- two days: growth, first seen, movers, anomalies ---------------------------------------

test("with two days growth is per platform, first-seen listings have no baseline, and a decrease is never a mover", () => {
  const latest = snap(DAY2, day2());
  const previous = snap(DAY1, day1());
  const board = whatToMakeNext({ latest, previous, history: [previous, latest], days: [[DAY1, previous.run_id], [DAY2, latest.run_id]] });
  assert.deepEqual(board.window, { state: "ok", start: DAY1, end: DAY2, days: 1 });
  const rs = board.platforms.find((p) => p.platform === "reelshort")!;
  const db = board.platforms.find((p) => p.platform === "dramabox")!;
  // fresh cohort: 4 ReelShort (3 flagged + baseline, 1 first seen), 2 DramaBox releases within 30 days
  assert.equal(rs.fresh, 4);
  assert.equal(db.fresh, 2);
  // ranked by views added per day within ReelShort: r1 (+2000) before r2 (+500)
  assert.deepEqual(rs.titles.slice(0, 2).map((x) => x.title.key), ["reelshort-1", "reelshort-2"]);
  const r1 = rs.titles[0];
  assert.equal(r1.growth.state, "ok");
  if (r1.growth.state === "ok") { assert.equal(r1.growth.per_day, 2000); assert.equal(r1.growth.growth_pct, 100); }
  assert.equal(r1.first_seen, DAY1);
  assert.equal(r1.chart?.state, "ok");
  // first seen today: reason recorded, growth has no baseline (not zero)
  const r4 = rs.titles.find((x) => x.title.key === "reelshort-4")!;
  assert.ok(r4.reasons.some((r) => r.kind === "first_seen" && r.date === DAY2));
  assert.equal(r4.growth.state, "no_baseline");
  const d1 = db.titles.find((x) => x.title.key === "dramabox-1")!;
  assert.equal(d1.days_since_release, 0);
  assert.equal(d1.growth.state, "no_baseline");
  // movers are within a platform and exclude the decreased counter
  assert.ok(rs.movers.every((x) => x.title.platform === "reelshort"));
  assert.equal(rs.movers[0].title.key, "reelshort-1");
  assert.ok(!db.movers.some((x) => x.title.key === "dramabox-4"));
  assert.equal(db.titles.find((x) => x.title.key === "dramabox-4"), undefined);
});

// ---- story types of the fresh cohort ---------------------------------------------------------

test("story-type shares use the fresh cohort as denominator, lift compares with every listing, and the catalog is counted", () => {
  const latest = snap(DAY2, day2());
  const previous = snap(DAY1, day1());
  const board = whatToMakeNext({
    latest,
    previous,
    history: [previous, latest],
    days: [[DAY1, previous.run_id], [DAY2, latest.run_id]],
    catalog: [{ id: "mine-1", tropes: ["revenge", "rebirth"] }, { id: "mine-2", tropes: ["ceo_billionaire"] }],
  });
  const revenge = board.tropes.find((s) => s.id === "revenge")!;
  assert.equal(board.fresh_sample, 6);
  assert.equal(revenge.fresh_titles, 4);
  assert.equal(revenge.fresh_sample, 6);
  assert.equal(revenge.titles, 4);
  assert.equal(revenge.sample, 18);
  assert.equal(revenge.lift, null, "lift needs at least 10 fresh listings");
  assert.deepEqual(revenge.by_platform, { reelshort: 3, dramabox: 1 });
  assert.deepEqual(revenge.catalog_ids, ["mine-1"]);
  // growth is the median across the fresh revenge listings with a baseline: r1 +100%, r2 +20%, r3 +1%
  assert.equal(revenge.n_growth, 3);
  assert.equal(revenge.growth_pct, 20);
  // the co-launched trope is the most frequent partner among fresh revenge listings
  assert.ok(["secret_identity", "family_drama", "werewolf"].includes(revenge.pair!));
  assert.equal(revenge.pair_titles, 1);
  // CEO dominates the back catalog but not the launches
  const ceo = board.tropes.find((s) => s.id === "ceo_billionaire");
  assert.equal(ceo, undefined, "no fresh listing carries it, so it is not a launch signal");
  // most launched first
  assert.equal(board.tropes[0].id, "revenge");
});

test("views added are summed per platform across every listing of the trope, only where a baseline exists", () => {
  const latest = snap(DAY2, day2());
  const previous = snap(DAY1, day1());
  const board = whatToMakeNext({ latest, previous, history: [previous, latest], days: [[DAY1, previous.run_id], [DAY2, latest.run_id]] });
  const revenge = board.tropes.find((s) => s.id === "revenge")!;
  const rs = revenge.views_added.find((v) => v.platform === "reelshort")!;
  // r1 +2000, r2 +500, r3 +10: three listings, three baselines
  assert.equal(rs.listings, 3);
  assert.equal(rs.with_baseline, 3);
  assert.equal(rs.delta, 2510);
  assert.equal(rs.per_day, 2510);
  assert.equal(rs.start_total, 2000 + 2500 + 993);
  assert.equal(rs.growth_pct, Math.round((2510 / 5493) * 1000) / 10);
  assert.deepEqual(rs.top, ["reelshort-1", "reelshort-2", "reelshort-3"]);
  // DramaBox's only revenge listing was first seen today: no baseline, no invented zero growth
  const db = revenge.views_added.find((v) => v.platform === "dramabox")!;
  assert.equal(db.listings, 1);
  assert.equal(db.with_baseline, 0);
  assert.equal(db.delta, 0);
  assert.equal(db.growth_pct, null);
  // never pooled across platforms
  assert.equal(revenge.views_added.length, 2);
  // one published day: nothing
  const one = whatToMakeNext({ latest, previous: null, history: [latest], days: [[DAY2, latest.run_id]] });
  assert.deepEqual(one.tropes.find((s) => s.id === "revenge")!.views_added, []);
  assert.equal(metricByKey("trope_views_added")?.evidence, "observed");
});

test("lift is computed once the fresh cohort has ten listings", () => {
  const titles = [
    ...Array.from({ length: 10 }, (_, i) => mt({ key: `reelshort-f${i}`, platform: "reelshort", platform_new: true, tropes: T(i < 8 ? ["revenge"] : ["ceo_billionaire"]) })),
    ...Array.from({ length: 10 }, (_, i) => mt({ key: `reelshort-o${i}`, platform: "reelshort", tropes: T(i < 2 ? ["revenge"] : ["ceo_billionaire"]) })),
  ];
  const latest = snap(DAY2, titles);
  const board = whatToMakeNext({ latest, previous: null, history: [latest], days: [[DAY2, latest.run_id]] });
  const revenge = board.tropes.find((s) => s.id === "revenge")!;
  assert.equal(revenge.fresh_share, 0.8);
  assert.equal(revenge.share, 0.5);
  assert.equal(revenge.lift, 1.6);
  const ceo = board.tropes.find((s) => s.id === "ceo_billionaire")!;
  assert.equal(ceo.lift, 0.4);
});

test("the board's metrics are in the registry with their status rules", () => {
  assert.equal(metricByKey("fresh_share")?.status_rule, "catalog");
  assert.equal(metricByKey("fresh_share")?.evidence, "inferred");
  assert.equal(metricByKey("fresh_growth")?.status_rule, "history");
});
