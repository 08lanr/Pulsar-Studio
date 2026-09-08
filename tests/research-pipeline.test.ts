import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSnapshot, type RawArtifact } from "@/lib/research/build";
import { counterMovement, firstSeen, hasHistory, rankMovement } from "@/lib/research/history";
import { STALE_AFTER_DAYS, snapshotAgeDays, statusFor } from "@/lib/research/registry";
import type { MarketView } from "@/lib/research/snapshot";
import { TAXONOMY_VERSION } from "@/lib/research/taxonomy";
import type { MarketSnapshot, MarketTitle } from "@/lib/research/types";

// Pipeline scenarios from docs/market-desk-plan.md: same-day repeated runs,
// partial platform failure, missing/zero/reset counters, insufficient
// history, irregular intervals, duplicate newest ordering, stale inputs.

const RUN1 = "2026-09-07T04-00-00Z";
const RUN2 = "2026-09-07T18-00-00Z";
const RUN3 = "2026-09-10T04-00-00Z";

function rsArtifact(fetched_at: string, books: Record<string, unknown>[]): RawArtifact {
  return {
    platform: "reelshort",
    fetched_at,
    source_urls: ["https://www.reelshort.com/"],
    shelves: [],
    lists: [{ list: "top", name: "TOP", chart: true, fetched_at, books }],
  };
}

function rsBook(i: number, over: Record<string, unknown> = {}) {
  return { rank: i, book_id: `rs${i}`, title: `Reel ${i}`, blurb: "A billionaire hides his identity.", themes: ["Female", "Billionaire"], episode_count: 60, read_count: 1000 * (200 - i), collect_count: 10, paid_start: 10, is_new: false, ep1_duration_s: 120, ...over };
}

function manyBooks(n: number) {
  return Array.from({ length: n }, (_, i) => rsBook(i + 1));
}

function dbArtifact(fetched_at: string, lists: { list: string; name: string; chart: boolean; books: Record<string, unknown>[] }[], details: Record<string, unknown>[] = []): RawArtifact {
  return { platform: "dramabox", fetched_at, source_urls: ["https://www.dramaboxapp.com/"], genres: [], lists: lists.map((l) => ({ ...l, fetched_at })), details, detail_coverage: { requested: lists.flatMap((l) => l.books).length, fetched: details.length } };
}

const dbCard = (id: string, over: Record<string, unknown> = {}) => ({ rank: 1, book_id: id, title: `Box ${id}`, blurb: "Revenge.", tags: ["Revenge"], genres: [], audience: "F-Drama", episode_count: 80, follow_count: 5, author: "Webfic", ...over });
const dbDetail = (id: string, over: Record<string, unknown> = {}) => ({ book_id: id, title: `Box ${id}`, blurb: "Revenge.", tags: ["Revenge"], genres: [], view_count: 100, follow_count: 5, avg_episode_s: 80, paid_start: 12, shelf_time: "2026-09-01 10:00:00", ...over });

test("a complete run validates and publishes both platforms as ok", () => {
  const r = buildSnapshot({
    runId: RUN1,
    artifacts: { reelshort: rsArtifact("2026-09-07T04:00:00.000Z", manyBooks(120)), dramabox: dbArtifact("2026-09-07T04:05:00.000Z", [{ list: "trending", name: "Trending", chart: true, books: Array.from({ length: 40 }, (_, i) => dbCard(`d${i}`, { rank: i + 1 })) }], [dbDetail("d0")]) },
    failures: {},
    previous: null,
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.snapshot.observed_at, "2026-09-07");
  assert.deepEqual(r.snapshot.platforms.map((p) => p.status), ["ok", "ok"]);
  assert.equal(r.snapshot.taxonomy_version, TAXONOMY_VERSION);
  const d0 = r.snapshot.titles.find((t) => t.key === "dramabox-d0")!;
  assert.equal(d0.metrics.views?.source_field, "viewCount");
  assert.equal(d0.metrics.saves?.unit, "follows");
  assert.equal(d0.episode_seconds_basis, "listed_average");
  assert.equal(d0.companies[0].role, "publisher");
  const rs1 = r.snapshot.titles.find((t) => t.key === "reelshort-rs1")!;
  assert.equal(rs1.metrics.saves?.unit, "collects");
  assert.equal(rs1.episode_seconds_basis, "episode_1");
  assert.equal(rs1.audience, "female");
  assert.equal(r.snapshot.platforms[1].detail_coverage?.fetched, 1);
});

test("partial platform failure: the failed platform is carried forward as stale, never dropped", () => {
  const first = buildSnapshot({ runId: RUN1, artifacts: { reelshort: rsArtifact("2026-09-07T04:00:00.000Z", manyBooks(120)), dramabox: dbArtifact("2026-09-07T04:05:00.000Z", [{ list: "trending", name: "Trending", chart: true, books: Array.from({ length: 40 }, (_, i) => dbCard(`d${i}`)) }]) }, failures: {}, previous: null });
  const second = buildSnapshot({ runId: RUN3, artifacts: { reelshort: rsArtifact("2026-09-10T04:00:00.000Z", manyBooks(120)) }, failures: { dramabox: { platform: "dramabox", failed_at: "2026-09-10T04:05:00.000Z", error: "HTTP 503" } }, previous: first.snapshot });
  assert.deepEqual(second.errors, []);
  const db = second.snapshot.platforms.find((p) => p.id === "dramabox")!;
  assert.equal(db.status, "stale");
  assert.equal(db.stale_from_run, RUN1);
  assert.equal(db.error, "HTTP 503");
  assert.equal(db.fetched_at, "2026-09-07T04:05:00.000Z", "the stale platform keeps its original read time");
  assert.equal(second.snapshot.titles.filter((t) => t.platform === "dramabox").length, 40);
  assert.equal(second.snapshot.observed_at, "2026-09-10");
});

test("a run with no fresh artifact fails validation and publishes nothing", () => {
  const r = buildSnapshot({ runId: RUN2, artifacts: {}, failures: { reelshort: { platform: "reelshort", failed_at: "x", error: "timeout" } }, previous: null });
  assert.ok(r.errors.some((e) => e.includes("no platform produced")));
  assert.equal(r.manifest.validation.ok, false);
});

test("stale input: an artifact without a valid timestamp is treated as failed", () => {
  const bad = rsArtifact("not-a-date", manyBooks(120));
  const r = buildSnapshot({ runId: RUN1, artifacts: { reelshort: bad }, failures: {}, previous: null });
  assert.equal(r.snapshot.platforms.find((p) => p.id === "reelshort")?.status, "failed");
  assert.ok(r.errors.length > 0);
});

test("fewer listings than the floor is partial, and duplicate keys fail validation", () => {
  const r = buildSnapshot({ runId: RUN1, artifacts: { reelshort: rsArtifact("2026-09-07T04:00:00.000Z", manyBooks(5)) }, failures: {}, previous: null });
  assert.equal(r.snapshot.platforms[0].status, "partial");
  assert.deepEqual(r.errors, []);
});

test("DramaBox newest flag does not depend on encounter order", () => {
  const home = { list: "home-top", name: "Top Hits", chart: true, books: [dbCard("n1"), dbCard("n2")] };
  const newest = { list: "newest", name: "New on DramaBox", chart: false, books: [dbCard("n1"), dbCard("n3")] };
  const a = buildSnapshot({ runId: RUN1, artifacts: { dramabox: dbArtifact("2026-09-07T04:00:00.000Z", [home, newest]) }, failures: {}, previous: null }).snapshot;
  const b = buildSnapshot({ runId: RUN1, artifacts: { dramabox: dbArtifact("2026-09-07T04:00:00.000Z", [newest, home]) }, failures: {}, previous: null }).snapshot;
  for (const s of [a, b]) {
    assert.equal(s.titles.find((t) => t.key === "dramabox-n1")?.platform_new, true, "on the newest list regardless of order");
    assert.equal(s.titles.find((t) => t.key === "dramabox-n2")?.platform_new, false);
    assert.equal(s.titles.find((t) => t.key === "dramabox-n3")?.platform_new, true);
    assert.equal(s.titles.find((t) => t.key === "dramabox-n1")?.placements.length, 2);
  }
});

test("a zero counter is an observation; a missing counter is null", () => {
  const r = buildSnapshot({ runId: RUN1, artifacts: { reelshort: rsArtifact("2026-09-07T04:00:00.000Z", [rsBook(1, { read_count: 0 }), rsBook(2, { read_count: null }), ...manyBooks(120).slice(2)]) }, failures: {}, previous: null });
  const t1 = r.snapshot.titles.find((t) => t.key === "reelshort-rs1")!;
  const t2 = r.snapshot.titles.find((t) => t.key === "reelshort-rs2")!;
  assert.equal(t1.metrics.views?.value, 0);
  assert.equal(t2.metrics.views, null);
});

// ---- history contracts -------------------------------------------------------------

function title(over: Partial<MarketTitle>): MarketTitle {
  return { key: "reelshort-1", platform: "reelshort", platform_id: "1", title: "x", blurb: "", cover: null, url: "https://e.test", companies: [], audience: null, episode_count: null, paywall_episode: null, episode_seconds: null, episode_seconds_basis: null, released_at: null, platform_new: false, platform_tags: [], tropes: [], metrics: { views: null, saves: null, rating: null }, placements: [], ...over };
}
const obs = (value: number, observed_at: string, source_field = "read_count", unit: "views" | "follows" = "views") => ({ value, source_field, unit, observed_at, evidence: "observed" as const });

test("insufficient history: every movement is collecting_history", () => {
  const cur = title({ metrics: { views: obs(10, "2026-09-07T00:00:00Z"), saves: null, rating: null } });
  assert.equal(counterMovement("views", cur, null, false).state, "collecting_history");
  assert.equal(rankMovement("top", cur, null, false).state, "collecting_history");
  assert.equal(hasHistory([["2026-09-07", RUN1]]), false);
  assert.equal(hasHistory([["2026-09-07", RUN1], ["2026-09-07", RUN2]]), false, "two runs on one day are one day");
  assert.equal(hasHistory([["2026-09-07", RUN1], ["2026-09-10", RUN3]]), true);
});

test("counter velocity uses the actual elapsed interval; first-seen has no baseline; decreases are anomalies", () => {
  const prev = title({ metrics: { views: obs(100, "2026-09-07T04:00:00Z"), saves: null, rating: null } });
  const cur = title({ metrics: { views: obs(400, "2026-09-10T04:00:00Z"), saves: null, rating: null } });
  const mv = counterMovement("views", cur, prev, true);
  assert.equal(mv.state, "ok");
  if (mv.state === "ok") {
    assert.equal(mv.elapsed_days, 3, "irregular interval reported as it is");
    assert.equal(mv.per_day, 100);
    assert.equal(mv.growth_pct, 300);
  }
  assert.deepEqual(counterMovement("views", cur, null, true), { state: "no_baseline", reason: "first_seen" });
  const reset = counterMovement("views", title({ metrics: { views: obs(50, "2026-09-10T04:00:00Z"), saves: null, rating: null } }), prev, true);
  assert.equal(reset.state, "anomaly");
  const zeroStart = counterMovement("views", cur, title({ metrics: { views: obs(0, "2026-09-07T04:00:00Z"), saves: null, rating: null } }), true);
  assert.equal(zeroStart.state, "ok");
  if (zeroStart.state === "ok") assert.equal(zeroStart.growth_pct, null, "no growth % on a zero baseline");
  const incomparable = counterMovement("views", cur, title({ metrics: { views: obs(100, "2026-09-07T04:00:00Z", "viewCount"), saves: null, rating: null } }), true);
  assert.equal(incomparable.state, "incomparable");
});

test("rank movement is within a named list; entry and exit are categorical", () => {
  const prev = title({ placements: [{ list: "top", name: "TOP", rank: 12, chart: true }] });
  const cur = title({ placements: [{ list: "top", name: "TOP", rank: 4, chart: true }] });
  assert.deepEqual(rankMovement("top", cur, prev, true), { state: "ok", list: "top", prior_rank: 12, rank: 4, movement: 8 });
  assert.equal(rankMovement("top", cur, null, true).state, "entered");
  assert.equal(rankMovement("top", null, prev, true).state, "exited");
  assert.equal(rankMovement("trending", cur, prev, true).state, "absent");
});

test("first seen comes from history, never invented", () => {
  const s1 = { observed_at: "2026-09-07", titles: [title({ key: "reelshort-1" })] } as unknown as MarketSnapshot;
  const s2 = { observed_at: "2026-09-10", titles: [title({ key: "reelshort-1" }), title({ key: "reelshort-2" })] } as unknown as MarketSnapshot;
  assert.equal(firstSeen("reelshort-1", [s1, s2]), "2026-09-07");
  assert.equal(firstSeen("reelshort-2", [s1, s2]), "2026-09-10");
  assert.equal(firstSeen("reelshort-9", [s1, s2]), null);
});

// ---- registry states ---------------------------------------------------------------

function viewOf(over: Partial<MarketView>): MarketView {
  return { latest: null, previous: null, days: [], publication: { state: "none", published_at: null, last_failure: null, errors: [] }, ...over };
}

test("registry statuses reflect the published data: unavailable, available, stale, failed, collecting history", () => {
  const ctx = (view: MarketView) => ({ view, hasReports: false, hasProfile: false, now: new Date("2026-09-08T00:00:00Z") });
  assert.equal(statusFor("catalog", ctx(viewOf({}))), "unavailable");
  const ok = { schema_version: 2, run_id: RUN1, observed_at: "2026-09-07", taxonomy_version: TAXONOMY_VERSION, titles: [], platforms: [{ id: "reelshort", status: "ok", fetched_at: "2026-09-07T04:00:00Z", source_urls: [], title_count: 0, with_views: 0, collection: { surface: "public_web", locale: "en", audience_geography: "unknown" }, detail_coverage: null, stale_from_run: null, error: null }] } as unknown as MarketSnapshot;
  const published = viewOf({ latest: ok, days: [["2026-09-07", RUN1]], publication: { state: "published", published_at: "2026-09-07T05:00:00Z", last_failure: null, errors: [] } });
  assert.equal(statusFor("catalog", ctx(published)), "available");
  assert.equal(statusFor("history", ctx(published)), "collecting_history");
  const old = { ...ctx(published), now: new Date(`2026-09-${8 + STALE_AFTER_DAYS + 1}T00:00:00Z`) };
  assert.equal(statusFor("catalog", old), "stale");
  assert.equal(snapshotAgeDays(published, new Date("2026-09-09T05:00:00Z")), 2);
  const failed = viewOf({ latest: { ...ok, platforms: [{ ...ok.platforms[0], status: "failed" }] } as MarketSnapshot, publication: { state: "published", published_at: "x", last_failure: null, errors: [] } });
  assert.equal(statusFor("catalog", ctx(failed)), "failed");
  assert.equal(statusFor("connection", ctx(published)), "requires_connection");
  assert.equal(statusFor("producer", ctx(published)), "requires_connection");
  assert.equal(statusFor("producer", { ...ctx(published), hasProfile: true }), "available");
});
