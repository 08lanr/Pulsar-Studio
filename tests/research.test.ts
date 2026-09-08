import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { fixtureSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import {
  catalogMatches,
  cohortOf,
  companyStats,
  filterTitles,
  firstSentence,
  formatStats,
  insights,
  premiseExamples,
  profileOpportunities,
  rankTitles,
  scoreSnapshot,
  similarTitles,
  tagCatalogTitle,
  tropePairs,
  tropeStats,
} from "@/lib/research/engine";
import { marketView, resetMarketCache, snapshotHistory } from "@/lib/research/snapshot";
import { TAXONOMY_VERSION, TROPES, assignTropes, audienceFromTags } from "@/lib/research/taxonomy";
import { marketSnapshotSchema, type MarketTitle, type Observation } from "@/lib/research/types";

afterEach(() => {
  resetFixtureStore();
  resetMarketCache();
});

const producer = () => fixtureSession("producer");
const staff = () => fixtureSession("staff");

// ---- taxonomy ------------------------------------------------------------------------

test("platform tags map to tropes as observed; keywords fall back as inferred", () => {
  const tags = assignTropes({ platform_tags: ["Revenge", "Billionaire"], title: "Reborn Heiress Strikes Back", blurb: "" });
  const byId = new Map(tags.map((x) => [x.id, x]));
  assert.equal(byId.get("revenge")?.evidence, "observed");
  assert.equal(byId.get("ceo_billionaire")?.evidence, "observed");
  assert.equal(byId.get("rebirth")?.evidence, "inferred");
  assert.equal(byId.get("rebirth")?.via, "reborn");
});

test("Chinese synopses are tagged with the same taxonomy", () => {
  const ids = tagCatalogTitle({ name_zh: "重生后我成了霸总的白月光", name_en: null, genre: "都市 · 爱情", synopsis_zh: "林晚重生回到离婚前夜，这一次她要向前夫复仇。", synopsis_en: null });
  assert.ok(ids.includes("rebirth"));
  assert.ok(ids.includes("ceo_billionaire"));
  assert.ok(ids.includes("revenge"));
});

test("every platform tag maps to exactly one trope; audience tags are positioning, not tropes", () => {
  const seen = new Map<string, string>();
  for (const trope of TROPES)
    for (const tag of trope.platform_tags) {
      const key = tag.toLowerCase();
      assert.ok(!seen.has(key) || seen.get(key) === trope.id, `${tag} is claimed by ${seen.get(key)} and ${trope.id}`);
      seen.set(key, trope.id);
    }
  assert.equal(audienceFromTags(["Female", "Romance"]), "female");
  assert.equal(audienceFromTags(["M-Drama"]), "male");
  assert.equal(audienceFromTags(["Romance"]), null);
  assert.ok(!seen.has("female") && !seen.has("f-drama"), "audience positioning is not a trope");
});

// ---- engine over a hand-built snapshot -----------------------------------------------

const AT = "2026-09-07T04:00:00.000Z";
const o = (value: number, source_field: string, unit: Observation["unit"], observed_at = AT): Observation => ({ value, source_field, unit, observed_at, evidence: "observed" });

function mt(over: Partial<MarketTitle> & { key: string; platform: MarketTitle["platform"] }): MarketTitle {
  return {
    platform_id: over.key.split("-")[1] ?? over.key,
    title: over.key,
    blurb: "",
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
const T = (ids: MarketTitle["tropes"][number]["id"][]) => ids.map((id) => ({ id, evidence: "observed" as const, via: id }));

const sample: MarketTitle[] = [
  mt({ key: "reelshort-a", platform: "reelshort", tropes: T(["revenge", "ceo_billionaire"]), metrics: { views: o(100, "read_count", "views"), saves: o(1, "collect_count", "collects"), rating: null }, placements: [{ list: "top", name: "TOP", rank: 1, chart: true }], audience: "female", paywall_episode: 10 }),
  mt({ key: "reelshort-b", platform: "reelshort", tropes: T(["werewolf"]), metrics: { views: o(50, "read_count", "views"), saves: null, rating: null }, audience: "female", paywall_episode: 9 }),
  mt({ key: "reelshort-c", platform: "reelshort", tropes: T(["revenge"]), metrics: { views: o(10, "read_count", "views"), saves: null, rating: null }, audience: "male", paywall_episode: 12 }),
  mt({ key: "reelshort-d", platform: "reelshort", tropes: T(["sweet_romance"]), placements: [{ list: "shelf-1", name: "Love at First Sight", rank: 2, chart: false }] }), // no counter, no chart: unscored
  mt({ key: "dramabox-x", platform: "dramabox", tropes: T(["revenge", "war_god"]), metrics: { views: o(5_000_000, "viewCount", "views"), saves: o(1, "followCount", "follows"), rating: o(9, "ratings", "rating") }, placements: [{ list: "trending", name: "Trending", rank: 2, chart: true }], companies: [{ name: "Webfic", role: "publisher", evidence: "observed", via: "author field" }], audience: "male", platform_new: true }),
  mt({ key: "dramabox-y", platform: "dramabox", tropes: T(["sweet_romance"]), metrics: { views: o(1_000, "viewCount", "views"), saves: o(1, "followCount", "follows"), rating: o(8, "ratings", "rating") }, companies: [{ name: "Webfic", role: "publisher", evidence: "observed", via: "author field" }], audience: "female" }),
  mt({ key: "dramabox-z", platform: "dramabox", tropes: T(["revenge"]), placements: [{ list: "trending", name: "Trending", rank: 5, chart: true }] }), // chart, no counter
];
const snap = { titles: sample };

test("missing observations are unscored (null), not zero; chart-only listings score by visibility", () => {
  const scores = scoreSnapshot(snap);
  assert.equal(scores.get("reelshort-d")?.prominence, null, "no counter and no chart → null");
  assert.equal(scores.get("reelshort-d")?.view_percentile, null);
  assert.equal(scores.get("dramabox-z")?.view_percentile, null, "no counter → null percentile");
  assert.ok((scores.get("dramabox-z")?.chart_visibility ?? 0) > 0, "chart-only still has visibility");
  assert.equal(scores.get("reelshort-a")?.prominence, 100);
});

test("ranking: unscored last; equal prominence → the charted listing wins over an uncharted one", () => {
  const scores = scoreSnapshot(snap);
  const ranked = rankTitles(sample, scores);
  assert.equal(ranked[ranked.length - 1].key, "reelshort-d", "unscored listing is last");
  // reelshort-a (rank 1 + top views) and dramabox-x (rank 2 + top views) both 100; rank 1 wins.
  assert.equal(ranked[0].key, "reelshort-a");
  assert.equal(ranked[1].key, "dramabox-x");
  // Tie between a charted and an uncharted listing with equal prominence:
  const tie = [
    mt({ key: "reelshort-p", platform: "reelshort", metrics: { views: o(100, "read_count", "views"), saves: null, rating: null } }),
    mt({ key: "reelshort-q", platform: "reelshort", metrics: { views: o(100, "read_count", "views"), saves: null, rating: null }, placements: [{ list: "top", name: "TOP", rank: 90, chart: true }] }),
    mt({ key: "reelshort-r", platform: "reelshort", metrics: { views: o(1, "read_count", "views"), saves: null, rating: null } }),
  ];
  const s2 = scoreSnapshot({ titles: tie });
  assert.equal(s2.get("reelshort-p")?.prominence, s2.get("reelshort-q")?.prominence, "same view percentile");
  assert.equal(rankTitles(tie, s2)[0].key, "reelshort-q", "the ranked listing beats the unranked one");
});

test("an unchanged snapshot shows zero movement under every filter (same reference population)", () => {
  const scores = scoreSnapshot(snap);
  const filters = [{}, { platform: "reelshort" as const }, { platform: "dramabox" as const }, { audience: "female" as const }, { audience: "male" as const }, { trope: "revenge" as const }];
  for (const f of filters) {
    const cur = filterTitles(sample, f);
    const prev = { titles: filterTitles(sample, f), scores, taxonomy_version: TAXONOMY_VERSION };
    const stats = tropeStats(cur, scores, TAXONOMY_VERSION, prev);
    for (const s of stats) assert.equal(s.delta_pts, 0, `${JSON.stringify(f)} ${s.id} moved ${s.delta_pts}`);
  }
});

test("a taxonomy version change is a method change: no delta is computed", () => {
  const scores = scoreSnapshot(snap);
  const stats = tropeStats(sample, scores, TAXONOMY_VERSION, { titles: sample, scores, taxonomy_version: "other" });
  for (const s of stats) assert.equal(s.delta_pts, null);
});

test("trope shares carry denominators, platform split and lift; multi-label sums exceed 100%", () => {
  const scores = scoreSnapshot(snap);
  const stats = tropeStats(sample, scores, TAXONOMY_VERSION);
  const cohort = cohortOf(sample, scores);
  assert.equal(cohort.length, 6, "unscored listing is not in the cohort");
  const sum = stats.reduce((a, s) => a + s.cohort_share, 0);
  assert.ok(sum > 1, "multi-label shares sum above 100%");
  const revenge = stats.find((s) => s.id === "revenge")!;
  assert.equal(revenge.cohort, 6);
  assert.equal(revenge.sample, 7);
  assert.deepEqual(revenge.cohort_by_platform, { reelshort: 3, dramabox: 3 });
  assert.equal(revenge.lift, null, "lift needs a cohort of at least 10");
});

test("filters, companies, pairs, similarity", () => {
  assert.equal(filterTitles(sample, { platform: "dramabox" }).length, 3);
  assert.equal(filterTitles(sample, { audience: "male" }).length, 2);
  assert.equal(filterTitles(sample, { trope: "war_god" }).length, 1);
  assert.equal(filterTitles(sample, { q: "reelshort-a" }).length, 1);
  const scores = scoreSnapshot(snap);
  const companies = companyStats(sample, scores);
  assert.equal(companies[0].name, "Webfic");
  assert.equal(companies[0].role, "publisher", "a publisher label is a publisher, not a studio");
  assert.equal(companies[0].titles, 2);
  const pairs = tropePairs([...sample, ...sample, ...sample], scores);
  assert.ok(pairs.some((p) => p.a === "ceo_billionaire" && p.b === "revenge"));
  const sim = similarTitles(sample[0], sample, scores);
  // dramabox-z and reelshort-c both share {revenge} only (Jaccard 1/2); z is charted, c is not.
  assert.equal(sim[0].title.key, "dramabox-z", "Jaccard 1/2 beats 1/3; the charted listing breaks the tie");
  assert.equal(sim[1].title.key, "reelshort-c");
  assert.equal(sim[2].title.key, "dramabox-x", "Jaccard 1/3");
  assert.ok(!sim.some((x) => x.title.key === "reelshort-b"));
});

test("formats keep the runtime basis and sample sizes", () => {
  const rows = [
    mt({ key: "reelshort-1", platform: "reelshort", episode_seconds: 120, episode_seconds_basis: "episode_1", episode_count: 60 }),
    mt({ key: "dramabox-1", platform: "dramabox", episode_seconds: 80, episode_seconds_basis: "listed_average", episode_count: 90 }),
  ];
  const f = formatStats(rows);
  assert.equal(f.find((x) => x.platform === "reelshort")?.episode_seconds_basis, "episode_1");
  assert.equal(f.find((x) => x.platform === "dramabox")?.episode_seconds_basis, "listed_average");
  assert.equal(f[0].n_episodes, 1);
});

test("catalog matches explain themselves; untagged titles have no score, not zero", () => {
  const scores = scoreSnapshot(snap);
  const stats = tropeStats(sample, scores, TAXONOMY_VERSION);
  const matches = catalogMatches([{ id: "t1", tropes: ["revenge"] }, { id: "t2", tropes: [] }], stats, sample, scores);
  assert.equal(matches[0].title_id, "t1");
  assert.equal(matches[1].market_score, null);
  assert.equal(matches[0].explanation[0].trope, "revenge");
  assert.ok(matches[0].comparable_keys.includes("reelshort-a"));
  const opp = profileOpportunities(["revenge", "palace_period"], stats);
  assert.ok(opp.producing_hot.some((s) => s.id === "revenge"));
});

test("premise examples are first sentences and insights cite their listings", () => {
  const rows = sample.map((t) => ({ ...t, blurb: `${t.key} was dismissed as a nobody at her own wedding. Then the real heir walked in.` }));
  const scores = scoreSnapshot({ titles: rows });
  const ex = premiseExamples(["revenge"], rows, scores, 3);
  assert.equal(ex.length, 3);
  assert.ok(ex[0].sentence.endsWith("wedding."));
  assert.equal(firstSentence("Short. Then more words here that continue. And a third."), "Short. Then more words here that continue.");
  const obs = insights(sample, scores, tropeStats(sample, scores, TAXONOMY_VERSION), formatStats(sample));
  for (const i of obs) if (i.kind === "trope_lift" || i.kind === "new_listings") assert.ok(i.refs.length > 0);
});

// ---- the published snapshot ---------------------------------------------------------

test("the published snapshot validates, has run ids, evidence on every metric, and no play tokens", () => {
  const view = marketView();
  assert.equal(view.publication.state, "published");
  const latest = view.latest!;
  assert.match(latest.run_id, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
  assert.equal(latest.schema_version, 2);
  assert.ok(marketSnapshotSchema.safeParse(latest).success);
  assert.ok(latest.titles.length > 100);
  for (const p of latest.platforms) {
    assert.equal(p.collection.audience_geography, "unknown", "an English page does not establish a US audience");
    assert.equal(p.collection.locale, "en");
  }
  for (const t of latest.titles) {
    assert.equal(t.key, `${t.platform}-${t.platform_id}`);
    for (const m of [t.metrics.views, t.metrics.saves, t.metrics.rating]) if (m) assert.ok(m.source_field && m.unit && !Number.isNaN(Date.parse(m.observed_at)));
    if (t.episode_seconds != null) assert.ok(t.episode_seconds_basis);
    for (const c of t.companies) assert.ok(["publisher", "platform_original", "producer", "rights_holder"].includes(c.role));
  }
  const raw = fs.readFileSync(path.join(process.cwd(), "data", "research", "snapshots", `${latest.run_id}.json`), "utf8");
  assert.ok(!raw.includes("play_info"));
  assert.ok(latest.titles.filter((t) => t.tropes.length > 0).length / latest.titles.length > 0.95);
  assert.ok(snapshotHistory().length >= 1);
  // Coverage is recounted from data, never hard-coded.
  for (const p of latest.platforms) assert.equal(p.title_count, latest.titles.filter((t) => t.platform === p.id).length);
});

// ---- data layer guards ---------------------------------------------------------------

test("market is readable by producers and staff; the profile and catalog are the producer's own", async () => {
  resetFixtureStore();
  assert.ok((await fixtureData.getMarket(producer())).latest);
  assert.ok((await fixtureData.getMarket(staff())).latest);
  assert.equal(await fixtureData.getResearchProfile(producer()), null);
  assert.equal(await fixtureData.getResearchProfile(staff()), null);
  const saved = await fixtureData.saveResearchProfile(producer(), { tropes: ["revenge", "ceo_billionaire"], audience: "female", titles_per_year: 12, distribution: ["licensed"], target_markets: ["US"] });
  assert.ok(saved.updated_at);
  assert.deepEqual((await fixtureData.getResearchProfile(producer()))?.tropes, ["revenge", "ceo_billionaire"]);
  const catalog = await fixtureData.listCatalogForMatching(producer());
  assert.equal(catalog.truncated, false);
  assert.equal(catalog.total, catalog.rows.length);
  const staffCatalog = await fixtureData.listCatalogForMatching(staff());
  assert.equal(staffCatalog.total, 0, "staff previewing have no company catalog");
});

test("tenant crossing: another company's session sees none of this producer's catalog", async () => {
  resetFixtureStore();
  await fixtureData.createTitle(producer(), { name_zh: "向园", name_en: "Xiang Yuan", producer_id: "ignored", synopsis_zh: "复仇" });
  const other = { ...producer(), producerId: "00000000-0000-4000-8000-00000000ffff" };
  const theirs = await fixtureData.listCatalogForMatching(other);
  assert.equal(theirs.total, 0);
  const mine = await fixtureData.listCatalogForMatching(producer());
  assert.equal(mine.total, 1);
});

test("staff and viewer-role producers cannot describe the company", async () => {
  resetFixtureStore();
  const input = { tropes: ["revenge" as const], audience: null, titles_per_year: null, distribution: [], target_markets: [] };
  await assert.rejects(fixtureData.saveResearchProfile(staff(), input), (e: Error & { code?: string }) => e.code === "forbidden");
  await assert.rejects(fixtureData.saveResearchProfile({ ...producer(), producerRole: "viewer" }, input), (e: Error & { code?: string }) => e.code === "forbidden");
});
