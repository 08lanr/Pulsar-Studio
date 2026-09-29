// Ad video stats (decision 2026-09-28): TikTok's delivery and video numbers per ad, read lifetime or per day
// per ad account with that account's own token, and summed per ad creative across every launch, the way
// drama-remix/scripts/ad-review/collect_launches.py sums them. Nothing here leaves the process.

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { adCreatives, type CreativeClip } from "@/lib/crazydramas/stats-ads";
import {
  adSpans,
  benchmark,
  creativeKey,
  creativeRows,
  dailyTotals,
  EARLY_IMPRESSIONS,
  fmtPct,
  median,
  numbersIn,
  ratesOf,
  sumVideo,
  totalsOf,
  UNKNOWN,
  versusMedian,
} from "@/lib/crazydramas/stats-creatives";
import { FAKE_ARCHIVE_ADS, FAKE_STATS_ADS, fakeAdVideo, fakeStatsArchive, fakeVideoDays } from "@/lib/crazydramas/fake-stats";
import type { LaunchRun } from "@/lib/launch/types";
import { adStatsByAd, adVideoFromRows, adVideoNumbers, VIDEO_METRICS } from "@/lib/tiktok/ad-stats";
import { clearAdVideoCache, daySpans, readTikTokAdVideo, tiktokAdsByAdvertiser } from "@/lib/tiktok/ad-video";
import { fakeTransport } from "@/lib/tiktok/fake";
import type { TikTokResponse, TikTokTransport } from "@/lib/tiktok/transport";

beforeEach(() => clearAdVideoCache());

type M = Record<string, number | string>;
const row = (ad: string, m: M, day?: string) => ({ dimensions: day ? { ad_id: ad, stat_time_day: `${day} 00:00:00` } : { ad_id: ad }, metrics: m });
const full = (spend: number, impressions: number, clicks: number, conversion: number, plays: number, w2: number, w6: number, p25: number, p100: number, avg: number): M => ({
  spend, impressions, clicks, conversion, video_play_actions: plays, video_watched_2s: w2, video_watched_6s: w6,
  video_views_p25: p25, video_views_p50: Math.round((p25 + p100) / 2), video_views_p75: Math.round((p25 + p100) / 3), video_views_p100: p100, average_video_play: avg,
});

/** A minimal TikTok launch run: one campaign per [advertiser, campaign id, { code: ad id }]. */
function run(id: string, campaigns: [string, string, Record<string, string>][], opts: { mode?: LaunchRun["mode"]; provider?: "tiktok" | "meta"; content?: { kind: string; value: string; clip_id?: string; text?: string }[] } = {}): LaunchRun {
  const content = opts.content ?? campaigns.flatMap(([, , ads]) => Object.keys(ads).map((code) => ({ kind: code.startsWith("#") ? "spark" : "video", value: code, clip_id: code.startsWith("#") ? undefined : code })));
  return {
    id, external_id: `lr_${id}`, producer_id: "p", mode: opts.mode ?? "production", created_at: "2026-09-20T00:00:00.000Z",
    draft: { provider: opts.provider ?? "tiktok", name: `Launch ${id}`, content },
    campaigns: campaigns.map(([advertiser, campaign, ads], i) => ({
      id: `${id}-c${i}`, run_id: id, index: i, advertiser_id: advertiser, name: `c${i}`, content,
      state: { campaign_id: campaign, groups: [{ ads }] }, snapshot: null,
    })),
  } as unknown as LaunchRun;
}

// ---- the report rows ------------------------------------------------------------------------------------------------

test("an ad's video counts: summed across rows, average play weighted by plays, a missing count unknown, no rows observed zero", () => {
  const v = adVideoFromRows([row("a", full(1, 100, 5, 0, 60, 30, 12, 10, 2, 4)), row("a", full(1, 100, 5, 0, 20, 5, 2, 1, 0, 10))]);
  assert.deepEqual([v.plays, v.watched_2s, v.watched_6s, v.views_p25, v.views_p100], [80, 35, 14, 11, 2]);
  assert.equal(v.play_seconds, 60 * 4 + 20 * 10, "average × plays, so 80 plays average (240+200)/80 = 5.5 s, not (4+10)/2");
  assert.equal(adVideoFromRows([row("a", { spend: 1, video_play_actions: 5 })]).watched_2s, null, "a missing count is unknown, never zero");
  assert.equal(adVideoFromRows([row("a", { video_play_actions: 5 })]).play_seconds, null, "no average: seconds unknown");
  assert.deepEqual(Object.values(adVideoFromRows([])), [0, 0, 0, 0, 0, 0, 0, 0], "an ad a report does not list delivered nothing");
  const n = adVideoNumbers([row("a", full(1.5, 1956, 14, 0, 1000, 230, 80, 60, 10, 2.4))]);
  assert.deepEqual([n.spend_cents, n.impressions, n.clicks, n.conversions, n.plays], [150, 1956, 14, 0, 1000]);
});

test("the Monitor's per-ad numbers carry the video counts only when they were asked for", () => {
  const rows = [row("ad-1", full(10, 1000, 20, 1, 500, 200, 90, 70, 10, 5))];
  assert.equal(adStatsByAd(["ad-1"], rows).get("ad-1")?.video, undefined);
  const withVideo = adStatsByAd(["ad-1", "ad-2"], rows, null, true);
  assert.deepEqual(withVideo.get("ad-1")?.video, { plays: 500, watched_2s: 200, watched_6s: 90, views_p25: 70, views_p50: 40, views_p75: 27, views_p100: 10, play_seconds: 2500 });
  assert.equal(withVideo.get("ad-2")?.video?.plays, 0, "not listed: observed zero");
});

// ---- the reader ---------------------------------------------------------------------------------------------------

type Call = { path: string; token: string; params: Record<string, string | number> };
function stub(answer: (c: Call) => TikTokResponse, mode: TikTokTransport["mode"] = "production"): TikTokTransport & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    mode, calls,
    async get(path, token, params = {}) { const c = { path, token, params }; calls.push(c); return answer(c); },
    async post() { throw new Error("no writes"); },
    async upload() { throw new Error("no writes"); },
  };
}
const idsOf = (c: Call) => JSON.parse(JSON.parse(String(c.params.filtering))[0].filter_value) as string[];

test("the lifetime read: per ad account with its own token, our ad ids in 50s, query_lifetime, paged; a failing account is named, never zeros", async () => {
  const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`clip-${i}`, `9${String(i).padStart(3, "0")}`]));
  const runs = [
    run("r1", [["adv-A", "camp-1", many]]),
    run("r2", [["adv-B", "camp-2", { "#spark": "8001" }], ["adv-C", "camp-3", { "clip-x": "7001" }]]),
    run("meta", [["act_1", "m-1", { "clip-m": "6001" }]], { provider: "meta" }),
    run("fake", [["adv-A", "camp-f", { "clip-f": "5001" }]], { mode: "fake" }),
  ];
  const tt = stub((c) => {
    if (c.params.advertiser_id === "adv-C") return { code: 40001, message: "No permission for this ad account" };
    const ids = idsOf(c);
    return { code: 0, message: "OK", data: { list: ids.filter((id) => id !== "9059").map((id) => row(id, full(1, 100, 2, 1, 50, 20, 10, 8, 1, 3))), page_info: { total_page: 1 } } };
  });
  const tokens: Record<string, string> = { "adv-A": "token-A", "adv-B": "token-B", "adv-C": "token-C" };
  const read = await readTikTokAdVideo(runs, "lifetime", { transport: tt, tokenFor: (a) => tokens[a] ?? null });
  assert.equal(tt.calls.length, 4, "adv-A in two batches (50 + 10), adv-B once, adv-C once (refused)");
  assert.ok(tt.calls.every((c) => c.path === "/report/integrated/get/" && c.params.data_level === "AUCTION_AD" && c.params.query_lifetime === "true" && c.params.dimensions === JSON.stringify(["ad_id"])));
  assert.ok(tt.calls.every((c) => VIDEO_METRICS.every((m) => String(c.params.metrics).includes(m))));
  assert.deepEqual(tt.calls.map((c) => [c.params.advertiser_id, c.token, idsOf(c).length]), [["adv-A", "token-A", 50], ["adv-A", "token-A", 10], ["adv-B", "token-B", 1], ["adv-C", "token-C", 1]]);
  assert.ok(!tt.calls.some((c) => idsOf(c).includes("6001") || idsOf(c).includes("5001")), "no Meta ad, no ad of another environment");
  assert.deepEqual(read.failed, [{ advertiser_id: "adv-C", error: "No permission for this ad account" }]);
  assert.ok(!read.covered.includes("7001") && read.ads["7001"] === undefined, "the refused account's ad is unknown, not zero");
  assert.equal(read.ads["8001"].impressions, 100);
  assert.equal(read.ads["9059"].impressions, 0, "covered but not listed: delivered nothing");
  // A read with a failed account is not kept; a complete one is, for ten minutes.
  await readTikTokAdVideo(runs, "lifetime", { transport: tt, tokenFor: (a) => tokens[a] ?? null });
  assert.equal(tt.calls.length, 8, "asked again");
  const ok = stub((c) => ({ code: 0, message: "OK", data: { list: idsOf(c).map((id) => row(id, full(1, 10, 1, 0, 5, 2, 1, 1, 0, 2))) } }));
  let t = 1_000;
  await readTikTokAdVideo(runs.slice(0, 1), "lifetime", { transport: ok, tokenFor: () => "tok", now: () => t });
  await readTikTokAdVideo(runs.slice(0, 1), "lifetime", { transport: ok, tokenFor: () => "tok", now: () => t });
  assert.equal(ok.calls.length, 2, "kept");
  t += 10 * 60_000 + 1;
  await readTikTokAdVideo(runs.slice(0, 1), "lifetime", { transport: ok, tokenFor: () => "tok", now: () => t });
  assert.equal(ok.calls.length, 4, "read again after ten minutes");
  const noToken = await readTikTokAdVideo(runs.slice(1, 2), "lifetime", { transport: ok, tokenFor: () => null, fresh: true });
  assert.match(noToken.failed[0].error, /No TikTok connection covers ad account adv-B/);
});

test("the daily read: at most 30 days a request, by stat_time_day, each ad's days oldest first", async () => {
  assert.deepEqual(daySpans("2026-08-01", "2026-09-14"), [{ from: "2026-08-01", to: "2026-08-30" }, { from: "2026-08-31", to: "2026-09-14" }]);
  const tt = stub((c) => ({
    code: 0, message: "OK",
    data: { list: c.params.start_date === "2026-08-01" ? [row("9001", full(2, 200, 4, 1, 100, 40, 20, 15, 3, 4), "2026-08-10")] : [row("9001", full(1, 100, 2, 0, 50, 10, 5, 4, 1, 6), "2026-09-02"), row("9001", full(1, 100, 2, 0, 50, 10, 5, 4, 1, 6), "2026-08-31")] },
  }));
  const read = await readTikTokAdVideo([run("r", [["adv", "c", { clip: "9001" }]])], { from: "2026-08-01", to: "2026-09-14" }, { transport: tt, tokenFor: () => "t" });
  assert.equal(tt.calls.length, 2);
  assert.ok(tt.calls.every((c) => c.params.dimensions === JSON.stringify(["ad_id", "stat_time_day"]) && c.params.query_lifetime === undefined));
  assert.deepEqual(read.days!["9001"].map((d) => [d.day, d.impressions]), [["2026-08-10", 200], ["2026-08-31", 100], ["2026-09-02", 100]]);
  assert.equal(read.ads["9001"].impressions, 400);
  assert.equal(read.ads["9001"].play_seconds, 400 + 300 + 300);
  const span = numbersIn(read.days!, read.covered, { from: "2026-08-31", to: "2026-09-14" });
  assert.equal(span["9001"].impressions, 200);
  assert.equal(numbersIn(read.days!, read.covered, { from: "2026-09-10", to: "2026-09-14" })["9001"].impressions, 0, "covered, no day in the span: nothing");
});

test("the reader through the fake transport (fakeTransport.get stubbed): the report rows it answers become each ad's numbers", async () => {
  const original = fakeTransport.get;
  try {
    fakeTransport.get = async (p, _t, params) =>
      p === "/report/integrated/get/" ? { code: 0, message: "OK", data: { list: idsOf({ path: p, token: "", params: params ?? {} }).map((id) => row(id, full(1.5, 1956, 14, 0, 1076, 247, 86, 65, 11, 2.4))) } } : { code: 1, message: "not modelled" };
    const read = await readTikTokAdVideo([run("r", [["adv", "c", { "228d5a2c": "8888" }]], { mode: "fake" })], "lifetime", { transport: fakeTransport, tokenFor: () => "fake-token" });
    const rates = ratesOf(read.ads["8888"]);
    assert.equal(fmtPct(rates.ctr), "0.7%");
    assert.equal(fmtPct(rates.hold_2s), "23.0%");
    assert.equal(fmtPct(rates.hold_6s), "8.0%");
  } finally {
    fakeTransport.get = original;
  }
});

// ---- per creative -----------------------------------------------------------------------------------------------------

const clips = new Map<string, CreativeClip>([
  ["clip-hook", { id: "clip-hook", title_id: "t1", ad_format: "hook_ad", hook_en: "The hook", render_path: "t1/e1/upload-0123456789abcdef-hook-v2.mp4" }],
  ["clip-trailer", { id: "clip-trailer", title_id: "t2", ad_format: "narration_trailer", hook_en: "The trailer", render_path: "t2/e1/trailer.mp4" }],
]);
const numbers = (impressions: number, clicks: number, conversions: number, plays: number, w2: number, w6: number, p25: number, p100: number, seconds: number, spend = 100) =>
  ({ spend_cents: spend, impressions, clicks, conversions, plays, watched_2s: w2, watched_6s: w6, views_p25: p25, views_p50: 0, views_p75: 0, views_p100: p100, play_seconds: seconds });

test("per creative: every ad of a clip across launches and ad accounts summed, rates from the sums, Spark codes by code, Meta left out", () => {
  const runs = [
    run("r1", [["adv-A", "c1", { "clip-hook": "a1", "clip-trailer": "a2" }]]),
    run("r2", [["adv-B", "c2", { "clip-hook": "b1", "#sparkcode": "b2" }]], { content: [{ kind: "video", value: "clip-hook", clip_id: "clip-hook" }, { kind: "spark", value: "#sparkcode", text: "A Spark post" }] }),
    run("m", [["act", "m1", { "clip-trailer": "m1" }]], { provider: "meta" }),
  ];
  const creatives = adCreatives(runs, clips);
  assert.equal(creativeKey(creatives.get("b2")!), "#sparkcode");
  const rows = creativeRows(creatives, {
    a1: numbers(1000, 10, 1, 500, 250, 100, 80, 10, 2000),
    b1: numbers(3000, 90, 2, 1500, 300, 150, 120, 30, 3000),
    a2: numbers(400, 20, 0, 0, 0, 0, 0, 0, 0),
    b2: numbers(900, 45, 3, 450, 90, 45, 30, 9, 1800),
  });
  assert.deepEqual(rows.map((r) => r.key), ["clip-hook", "#sparkcode", "clip-trailer"], "most impressions first; no Meta row");
  const hook = rows[0];
  assert.deepEqual(hook.ad_ids.sort(), ["a1", "b1"]);
  assert.equal(hook.launches, 2);
  assert.equal(hook.sums.impressions, 4000);
  assert.equal(hook.rates.ctr, 100 / 4000, "clicks over impressions of the sums, not the mean of 1% and 3%");
  assert.equal(hook.rates.hold_2s, 550 / 2000);
  assert.equal(hook.rates.hold_6s, 250 / 2000);
  assert.equal(hook.rates.p25, 200 / 2000);
  assert.equal(hook.rates.p100, 40 / 2000);
  assert.equal(hook.rates.avg_play_s, 5000 / 2000, "weighted by plays");
  assert.equal(hook.rates.checkouts_per_1k, 3 / 4000 * 1000);
  assert.equal(hook.rates.cost_per_checkout_cents, Math.round(200 / 3));
  assert.deepEqual([hook.ad_format, hook.title_id, hook.file_name, hook.early], ["hook_ad", "t1", "hook-v2.mp4", false]);
  assert.equal(rows[1].text, "A Spark post");
  const trailer = rows[2];
  assert.equal(trailer.early, true, `under ${EARLY_IMPRESSIONS} impressions`);
  assert.deepEqual([trailer.rates.hold_2s, trailer.rates.avg_play_s, trailer.rates.cost_per_checkout_cents], [null, null, null], "no plays, no checkouts: no rate, never 0");
});

test("an ad TikTok did not answer for leaves its creative unknown; the totals add the known ones and count the rest", () => {
  const runs = [run("r1", [["adv-A", "c1", { "clip-hook": "a1" }], ["adv-C", "c9", { "clip-hook": "c1", "clip-trailer": "c2" }]])];
  const rows = creativeRows(adCreatives(runs, clips), { a1: numbers(1000, 10, 1, 500, 250, 100, 80, 10, 2000) });
  const hook = rows.find((r) => r.key === "clip-hook")!;
  assert.equal(hook.unknown_ads, 1);
  assert.deepEqual(hook.sums, UNKNOWN);
  assert.equal(hook.rates.ctr, null);
  assert.equal(hook.early, true);
  const t = totalsOf(rows);
  assert.equal(t.unknown, 2);
  assert.equal(t.sums.impressions, 0);
  assert.equal(sumVideo([numbers(1, 1, 1, 1, 1, 1, 1, 1, 1), { ...numbers(1, 1, 1, 1, 1, 1, 1, 1, 1), plays: null }]).plays, null);
});

test("the benchmark is the median of creatives with 500+ impressions; only clear gaps are marked, never on an early row", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([null, null]), null);
  const runs = [run("r", [["adv", "c", { h1: "1", h2: "2", h3: "3", h4: "4" }]])];
  const rows = creativeRows(adCreatives(runs, new Map()), {
    "1": numbers(10000, 100, 10, 5000, 1000, 500, 400, 50, 20000),
    "2": numbers(8000, 400, 20, 4000, 1600, 1000, 800, 200, 24000),
    "3": numbers(600, 12, 0, 300, 90, 30, 20, 3, 900),
    "4": numbers(100, 50, 5, 50, 45, 40, 30, 20, 500),
  });
  const b = benchmark(rows);
  assert.equal(b.n, 3, "the 100-impression creative is left out");
  assert.equal(b.rates.hold_2s, 0.3, "median of 0.2, 0.4, 0.3");
  assert.equal(versusMedian(0.4, 0.3, "hold_2s"), "above");
  assert.equal(versusMedian(0.32, 0.3, "hold_2s"), null, "within 20%: not marked");
  assert.equal(versusMedian(0.2, 0.3, "hold_2s"), "below");
  assert.equal(versusMedian(0.9, 0.3, "hold_2s", true), null, "early: never marked");
  assert.equal(versusMedian(500, 1000, "cost_per_checkout_cents"), "above", "a cheaper checkout is better");
});

// ---- periods ----------------------------------------------------------------------------------------------------

test("the Ads tab's days: the period, the one before, the small line's days, and one span to read", () => {
  assert.deepEqual(adSpans("7d", "2026-09-28"), { span: { from: "2026-09-22", to: "2026-09-28" }, prev: { from: "2026-09-15", to: "2026-09-21" }, chart: { from: "2026-09-22", to: "2026-09-28" }, read: { from: "2026-09-15", to: "2026-09-28" } });
  assert.deepEqual(adSpans("today", "2026-09-28"), { span: { from: "2026-09-28", to: "2026-09-28" }, prev: { from: "2026-09-27", to: "2026-09-27" }, chart: { from: "2026-09-15", to: "2026-09-28" }, read: { from: "2026-09-15", to: "2026-09-28" } });
  assert.equal(adSpans("30d", "2026-09-28").read.from, "2026-07-31", "60 days: two requests");
  assert.deepEqual(adSpans("all", "2026-09-28"), { span: null, prev: null, chart: { from: "2026-08-30", to: "2026-09-28" }, read: { from: "2026-08-30", to: "2026-09-28" } });
  const days = { a: [{ day: "2026-09-27", ...numbers(100, 1, 0, 50, 20, 10, 5, 1, 100) }], b: [{ day: "2026-09-27", ...numbers(300, 9, 1, 150, 30, 20, 10, 2, 600) }] };
  const line = dailyTotals(days, ["a", "b"], { from: "2026-09-26", to: "2026-09-28" });
  assert.deepEqual(line.map((d) => d.sums.impressions), [0, 400, 0]);
  assert.equal(line[1].rates.hold_2s, 50 / 200);
  assert.equal(line[0].rates.ctr, null);
});

// ---- fixture mode -------------------------------------------------------------------------------------------------

test("fixture mode's invented numbers add up: days to the life, the archive's spend to its launch record", () => {
  const now = new Date("2026-09-28T19:00:00Z");
  const life = fakeAdVideo("lifetime", now);
  const days = fakeVideoDays(now);
  for (const id of [...FAKE_STATS_ADS, ...FAKE_ARCHIVE_ADS]) {
    for (const k of ["impressions", "plays", "watched_6s", "conversions"] as const) assert.equal(days[id].reduce((x, d) => x + d[k], 0), life.ads[id][k], `${id} ${k}`);
  }
  const archive = fakeStatsArchive(now);
  const snap = archive.runs[0].campaigns[0].snapshot!;
  assert.equal(snap.spend_cents, FAKE_ARCHIVE_ADS.reduce((x, id) => x + life.ads[id].spend_cents, 0));
  const week = fakeAdVideo({ from: "2026-09-22", to: "2026-09-28" }, now);
  assert.equal(week.ads[FAKE_ARCHIVE_ADS[1]].impressions, 0, "the archive ran before this week");
  assert.equal(week.ads[FAKE_STATS_ADS[0]].impressions, life.ads[FAKE_STATS_ADS[0]].impressions);
  const rows = creativeRows(adCreatives(archive.runs, new Map(archive.clips.map((c) => [c.id, { ...c }]))), life.ads);
  assert.equal(rows.find((r) => r.key === "fake-clip-bus-clip")?.early, true);
  assert.deepEqual([...tiktokAdsByAdvertiser(archive.runs, "fake").values()][0], FAKE_ARCHIVE_ADS);
});
