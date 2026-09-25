// CrazyDramas stats (decision 2026-09-24): the read of crazydramas'
// GET /api/studio/stats through the Studio API transport (the fake here; the
// live transport never reaches the network under node:test), its whitelist,
// its five-minute keep and its refusals, and the pure sums the staff pages
// show. No request leaves the process.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { fakeCrazydramasTransport as fake } from "@/lib/crazydramas/fake";
import { fakeStatsReport } from "@/lib/crazydramas/fake-stats";
import { STATS_CACHE_MS, clearCdStatsCache, readCrazydramasStats } from "@/lib/crazydramas/stats";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  adOutcomes, adSpendsFromRuns, adTable, audience, binLabels, byDevice, byPlace, CAMPAIGN_SORTS, countryName, regionName, campaignTable, dashBy, dashPath, dashRows, dayIn, deliveryIn,
  sortCampaigns, ep1Curve, episodeBars, fmtClock, fmtShare, histSummary, NO_FILTER, notCounted, parseDashFilter, parseStatsRange, PATH_STEPS, rangeDays,
  seriesTotals, sourceKey, sourceOptions, sumRows, type AdPeriod,
  biggestDrop, change, chartSpan, dailyTotals, kpiValue, MIN_COMPARE, parseDashTab, parseKpiMetric, prevSpan,
} from "@/lib/crazydramas/stats-summary";
import { normalizeTeamEmails, readTeamList, saveTeamList, TEAM_FILE } from "@/lib/crazydramas/stats-team";
import { CdStatsReportSchema, type CdStatsReport } from "@/lib/crazydramas/stats-types";
import type { LaunchRun } from "@/lib/launch/types";
import { AD_DAYS_CACHE_MS, clearAdDaysCache, readTikTokAdDays } from "@/lib/tiktok/ad-days";
import { adDaysFromRows } from "@/lib/tiktok/ad-stats";
import type { CrazydramasStudioTransport } from "@/lib/crazydramas/transport";

const ENV_KEYS = ["DATA_SOURCE", "CRAZYDRAMAS_LIVE_READ", "CRAZYDRAMAS_STUDIO_TOKEN"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  fake.reset();
  clearCdStatsCache();
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fake.reset();
  clearCdStatsCache();
});

/** A transport that answers one fixed body and counts its calls. */
function stub(status: number, body: unknown): CrazydramasStudioTransport & { calls: number } {
  const t = {
    mode: "live" as const,
    calls: 0,
    async request() {
      t.calls++;
      return { status, body: JSON.parse(JSON.stringify(body)) };
    },
    async putUploadChunk() {
      throw new Error("not used");
    },
    async checkImage() {
      return { ok: false, status: null, content_type: null, reason: "not used" };
    },
  };
  return t;
}

// ---- the read -----------------------------------------------------------------------------------------------

test("fixture mode reads the fake's report through the Studio API route, and it parses", async () => {
  const read = await readCrazydramasStats();
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.mode, "fake");
  assert.equal(read.report.version, 1);
  assert.equal(read.report.days.length, 120);
  assert.ok(read.report.series.length > 0, "the fake's live series have stats");
  assert.ok(!read.report.series.some((s) => s.slug.startsWith("mock-") || s.status === "archived"));
});

test("the whitelist drops what the contract does not name, and a wrong shape is bad_response", async () => {
  const report = fakeStatsReport([{ id: "d1", slug: "one", title: "One", status: "published", free_episode_count: 5 }], [], new Date("2026-09-24T20:00:00Z"));
  const extra = { ...report, secret: "x", series: report.series.map((s) => ({ ...s, anonymous_ids: ["a"] })) };
  const ok = await readCrazydramasStats({ transport: stub(200, extra) });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal("secret" in ok.report, false);
    assert.equal("anonymous_ids" in ok.report.series[0], false);
  }
  clearCdStatsCache();
  const bad = await readCrazydramasStats({ transport: stub(200, { ...report, version: 2 }) });
  assert.deepEqual(bad.ok ? null : bad.code, "bad_response");
});

test("crazydramas' refusal comes back with its own code; no answer is unreachable", async () => {
  const refused = await readCrazydramasStats({ transport: stub(503, { error: "Studio API not configured", code: "not_configured" }) });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "not_configured");
    assert.equal(refused.error, "Studio API not configured");
  }
  const gone = await readCrazydramasStats({
    transport: { ...stub(200, {}), async request() { throw new Error("socket hang up"); } },
  });
  assert.equal(gone.ok ? null : gone.code, "unreachable");
});

test("a read is kept for five minutes; fresh asks again", async () => {
  const report = fakeStatsReport([{ id: "d1", slug: "one", title: "One", status: "published", free_episode_count: 5 }], []);
  const transport = stub(200, report);
  let clock = 1_000_000;
  const now = () => clock;
  await readCrazydramasStats({ transport, now });
  await readCrazydramasStats({ transport, now });
  assert.equal(transport.calls, 1);
  clock += STATS_CACHE_MS + 1;
  await readCrazydramasStats({ transport, now });
  assert.equal(transport.calls, 2);
  await readCrazydramasStats({ transport, now, fresh: true });
  assert.equal(transport.calls, 3);
});

test("the live read is refused without the token, before any request", async () => {
  process.env.DATA_SOURCE = "fixture";
  process.env.CRAZYDRAMAS_LIVE_READ = "1";
  const read = await readCrazydramasStats();
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.code, "read_off");
    assert.match(read.error, /CRAZYDRAMAS_STUDIO_TOKEN/);
  }
});

// ---- the sums -----------------------------------------------------------------------------------------------

function report(): CdStatsReport {
  const day = (d: string, watchers: number, extra: Record<string, number> = {}) => ({
    day: d, visitors: watchers * 2, watchers, new_watchers: watchers, wau: 0, mau: 0, robots: 1, payments: 0, first_purchases: 0, renewals: 0, revenue_cents: 0, ...extra,
  });
  const cohort = (d: string, opened: number, over: Record<string, unknown> = {}) => ({
    day: d, opened, started_ep1: Math.round(opened / 2), finished_ep1: Math.round(opened / 4), ep1_seconds: opened * 30,
    ep1_reached: [Math.round(opened / 2), Math.round(opened / 3), Math.round(opened / 4)], episodes: [Math.round(opened / 2), 3, 1, 0, 0, 0],
    episodes_watched: [Math.round(opened / 3), 2, 1, 0, 0, 0], paywall: 2, paywall_watched: 1, paywall_skipped: 1, checkouts: 1, buyers: 1, revenue_cents: 199, robots: 3, ...over,
  });
  return CdStatsReportSchema.parse({
    version: 1, generated_at: "2026-09-24T20:00:00.000Z", timezone: "America/Los_Angeles", from: "2026-05-28", to: "2026-09-24", ep1_step_s: 15,
    robots: { people: 9, crawler_ua: 1, burst: 6, end_jump: 2 },
    days: [day("2026-09-20", 5), day("2026-09-23", 10, { wau: 14, mau: 20 }), day("2026-09-24", 20, { wau: 30, mau: 40, payments: 3, first_purchases: 2, renewals: 1, revenue_cents: 1097 })],
    series: [
      { drama_id: "a", slug: "alpha", title: "Alpha", status: "published", free_episodes: 3, episode_count: 6, ep1_duration_s: 40, cohorts: [cohort("2026-09-10", 40), cohort("2026-09-24", 100)] },
      { drama_id: "b", slug: "beta", title: "Beta", status: "published", free_episodes: 5, episode_count: 60, ep1_duration_s: null, cohorts: [] },
    ],
    sources: [
      src("2026-09-24", "a", "111", "tiktok_android", { opened: 60, started_ep1: 30, finished_ep1: 15, watched_ep2: 6, buyers: 1, revenue_cents: 99 }),
      src("2026-09-24", "a", "111", "tiktok_iphone", { opened: 20, no_events: 12, started_ep1: 4, finished_ep1: 1 }),
      src("2026-09-10", "a", "222", "tiktok_android", { opened: 40, started_ep1: 10, finished_ep1: 3, watched_ep2: 1 }),
      src("2026-09-24", "a", null, "tiktok_android", { opened: 12, started_ep1: 5, finished_ep1: 2 }, true),
      src("2026-09-24", "b", null, "iphone", { opened: 3, robots: 9 }),
    ],
  });
}

function src(d: string, drama: string, ad: string | null, device: string, counts: Record<string, number>, storedCopy = false) {
  const zero = { opened: 0, no_events: 0, never_started: 0, started_ep1: 0, finished_ep1: 0, watched_ep2: 0, watched_ep3: 0, paywall: 0, checkouts: 0, buyers: 0, revenue_cents: 0, robots: 0 };
  return { day: d, drama_id: drama, platform: ad || storedCopy ? "tiktok" : "organic", campaign: ad ? "c1" : null, ad, stored_copy: storedCopy, device, ...zero, ...counts };
}

test("a period ends today and never starts before the report", () => {
  const r = report();
  assert.deepEqual(rangeDays(r, "today"), { from: "2026-09-24", to: "2026-09-24" });
  assert.deepEqual(rangeDays(r, "7d"), { from: "2026-09-18", to: "2026-09-24" });
  // "All" starts on the first day anything happened (a cohort on the 10th), not on the report's empty first day.
  assert.deepEqual(rangeDays(r, "all"), { from: "2026-09-10", to: "2026-09-24" });
  assert.deepEqual(rangeDays({ from: r.from, to: r.to }, "all"), { from: "2026-05-28", to: "2026-09-24" });
  assert.equal(parseStatsRange("30d"), "30d");
  assert.equal(parseStatsRange("forever"), "7d");
});

test("the audience never adds people across days: the week and month are crazydramas' own counts", () => {
  const a = audience(report(), "7d");
  assert.equal(a.today?.watchers, 20);
  assert.equal(a.yesterday?.watchers, 10);
  assert.equal(a.wau, 30);
  assert.equal(a.mau, 40);
  assert.deepEqual(a.days.map((d) => d.day), ["2026-09-20", "2026-09-23", "2026-09-24"]);
  assert.deepEqual(a.money, { revenue_cents: 1097, payments: 3, first_purchases: 2, renewals: 1 });
});

test("a series' groups add up within the period, and only within it", () => {
  const alpha = seriesTotals(report().series[0], rangeDays(report(), "7d"));
  assert.equal(seriesTotals(report().series[1], rangeDays(report(), "7d")).opened, 0);
  assert.equal(alpha.opened, 100);
  assert.equal(alpha.started_ep1, 50);
  assert.deepEqual(alpha.episodes_watched.slice(0, 3), [33, 2, 1]);
  const all = seriesTotals(report().series[0], rangeDays(report(), "all"));
  assert.equal(all.opened, 140);
  assert.equal(all.buyers, 2);
  assert.equal(all.revenue_cents, 398);
  assert.deepEqual(all.ep1_reached, [70, 46, 35]);
});

test("episode 1's curve: the share still watching, the early drop, the halfway point and the average", () => {
  const tot = seriesTotals(report().series[0], rangeDays(report(), "today"));
  const c = ep1Curve(tot, 15);
  // 50 started; 33 at 15 s, 25 at 30 s, then the end (40 s): 25 finished.
  assert.deepEqual(c.points.map((p) => [p.t, p.people]), [[0, 50], [15, 33], [30, 25], [40, 25]]);
  assert.equal(Math.round((c.gone_first_step ?? 0) * 100), 34);
  assert.equal(c.half_gone_at, null, "exactly half is not fewer than half");
  assert.equal(c.avg_seconds, 60);
  const none = ep1Curve(seriesTotals(report().series[1], rangeDays(report(), "7d")), 15);
  assert.equal(none.avg_seconds, null);
  assert.equal(none.gone_first_step, null);
});

test("the episode bars stop a little past the last episode anybody started, and always show the paywall", () => {
  const alpha = episodeBars(seriesTotals(report().series[0], rangeDays(report(), "7d")));
  assert.equal(alpha.bars.length, 6, "a 6-episode series shows whole");
  assert.equal(alpha.hidden_after, null);
  assert.deepEqual(alpha.bars.slice(0, 3).map((b) => [b.n, b.started, b.watched, b.free]), [[1, 50, 33, true], [2, 3, 2, true], [3, 1, 1, true]]);
  const beta = episodeBars(seriesTotals(report().series[1], rangeDays(report(), "7d")));
  assert.equal(beta.bars.length, 8, "free 5 + 3");
  assert.equal(beta.hidden_after, 8);
});

test("shares and clocks read plainly", () => {
  assert.equal(fmtShare(null), "–");
  assert.equal(fmtShare(0), "0%");
  assert.equal(fmtShare(0.004), "<1%");
  assert.equal(fmtShare(0.045), "4.5%");
  assert.equal(fmtShare(0.456), "46%");
  assert.equal(fmtClock(116.6), "1:57");
  assert.equal(fmtClock(5), "0:05");
});

// ---- the team, the ads, the phones ---------------------------------------------------------------------------

test("an older report, without the newer fields, still reads (as zero / empty)", () => {
  const old = JSON.parse(JSON.stringify(report()));
  delete old.team;
  delete old.sources;
  for (const c of old.series[0].cohorts) for (const k of ["no_events", "never_started", "returned", "survey_ep1", "team"]) delete c[k];
  const parsed = CdStatsReportSchema.parse(old);
  assert.deepEqual(parsed.team, { people: 0, payments: 0, revenue_cents: 0 });
  assert.deepEqual(parsed.sources, []);
  assert.equal(parsed.series[0].cohorts[0].returned, 0);
  assert.deepEqual(parsed.series[0].cohorts[0].survey_ep1, {});
});

test("the read sends the team's emails in the POST body, and keeps one read per team list", async () => {
  const body = fakeStatsReport([{ id: "d1", slug: "one", title: "One", status: "published", free_episode_count: 5 }], []);
  const seen: unknown[] = [];
  const transport = {
    ...stub(200, body),
    async request(method: "GET" | "PUT" | "POST", p: string, b?: unknown) {
      seen.push({ method, p, b });
      return { status: 200, body: JSON.parse(JSON.stringify(body)) };
    },
  };
  await readCrazydramasStats({ transport, teamEmails: ["b@x.com", "a@x.com"] });
  await readCrazydramasStats({ transport, teamEmails: ["a@x.com", "b@x.com"] });
  await readCrazydramasStats({ transport, teamEmails: ["a@x.com"] });
  assert.deepEqual(seen[0], { method: "POST", p: "/api/studio/stats", b: { team_emails: ["a@x.com", "b@x.com"] } });
  assert.equal(seen.length, 2, "the same list in another order is the same kept read; a new list reads again");
});

test("a crazydramas from before the team list (POST answers 405) is read with GET, nobody left out", async () => {
  const body = fakeStatsReport([{ id: "d1", slug: "one", title: "One", status: "published", free_episode_count: 5 }], []);
  const methods: string[] = [];
  const transport = {
    ...stub(200, body),
    async request(method: "GET" | "PUT" | "POST") {
      methods.push(method);
      return method === "POST" ? { status: 405, body: null } : { status: 200, body: JSON.parse(JSON.stringify(body)) };
    },
  };
  const read = await readCrazydramasStats({ transport, teamEmails: ["a@x.com"] });
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.equal(read.ok, true);
  if (read.ok) assert.deepEqual(read.team_emails, []);
});

test("the fake answers the POST and counts the team apart", async () => {
  const read = await readCrazydramasStats({ teamEmails: ["a@x.com", "b@x.com"] });
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.report.team.payments, 2);
    assert.ok(read.report.sources.length > 0);
  }
});

test("the team list: normalized, refused whole when an entry is not an email, saved and read back", async () => {
  assert.deepEqual(normalizeTeamEmails([" B@X.com ", "a@x.com", "b@x.com", ""]), { ok: true, emails: ["a@x.com", "b@x.com"] });
  assert.deepEqual(normalizeTeamEmails(["a@x.com", "not an email"]), { ok: false, bad: ["not an email"] });
  const file = path.join(process.cwd(), ".uploads", TEAM_FILE);
  try {
    await rm(file, { force: true });
    assert.deepEqual((await readTeamList()).emails, []);
    await saveTeamList(["a@x.com", "b@x.com"], "Ruobin");
    const back = await readTeamList();
    assert.deepEqual(back.emails, ["a@x.com", "b@x.com"]);
    assert.equal(back.updated_by, "Ruobin");
  } finally {
    await rm(file, { force: true });
  }
});

function launchRuns(): LaunchRun[] {
  return [
    {
      external_id: "lr_1",
      created_at: "2026-09-24T06:38:00Z",
      draft: { name: "CrazyDramas · Sep 23" },
      campaigns: [
        {
          name: "0924test01",
          state: { campaign_id: "c1" },
          snapshot: {
            ads: [
              { id: "111", status: "ok", stats: { spend_cents: 800, impressions: 5000, clicks: 100, ctr: 0.02, cpc_cents: 8, conversions: 0 } },
              { id: "222", status: "ok", stats: { spend_cents: 300, impressions: 2000, clicks: 50, ctr: 0.025, cpc_cents: 6, conversions: 0 } },
              { id: "333", status: "ok", stats: { spend_cents: 120, impressions: 900, clicks: 9, ctr: 0.01, cpc_cents: 13, conversions: 0 } },
            ],
          },
        },
      ],
    },
  ] as unknown as LaunchRun[];
}

test("ads grouped by campaign: summed numbers, costs from the sums, the titles people opened", () => {
  const groups = campaignTable(report(), adSpendsFromRuns(launchRuns()));
  assert.deepEqual(groups.map((g) => g.key), ["campaign:c1", "stored_copy", "no_ad"]);
  const c = groups[0];
  assert.equal(c.launch_name, "CrazyDramas · Sep 23");
  assert.equal(c.campaign_name, "0924test01");
  assert.equal(c.launched_at, "2026-09-24T06:38:00Z");
  assert.deepEqual(c.ads.map((a) => a.ad), ["111", "222", "333"], "most spent first");
  assert.equal(c.spend_cents, 1220);
  assert.equal(c.clicks, 159);
  assert.equal(c.opened, 120);
  assert.equal(c.finished_ep1, 19);
  assert.equal(c.cost_per_finisher_cents, 64);
  assert.deepEqual(c.titles, [{ drama_id: "a", title: "Alpha", people: 120 }]);
  assert.deepEqual(c.ads[0].titles, [{ drama_id: "a", title: "Alpha", people: 80 }]);
  assert.deepEqual(groups[2].titles, [{ drama_id: "b", title: "Beta", people: 3 }]);
  assert.deepEqual(campaignTable(report(), adSpendsFromRuns(launchRuns()), "b").map((g) => g.key), ["no_ad"], "one series");
});

test("one sort for campaigns and their ads; no cost sorts last; the stored copy and no ad stay at the bottom", () => {
  const groups = campaignTable(report(), adSpendsFromRuns(launchRuns()));
  const ads = (by: Parameters<typeof sortCampaigns>[1]) => sortCampaigns(groups, by)[0].ads.map((a) => a.ad);
  assert.deepEqual(ads("per_finisher"), ["111", "222", "333"], "50¢, 100¢, then the one with no finisher");
  assert.deepEqual(ads("people"), ["111", "222", "333"]);
  assert.deepEqual(ads("per_ep2"), ["111", "222", "333"]);
  for (const by of CAMPAIGN_SORTS) assert.deepEqual(sortCampaigns(groups, by).slice(-2).map((g) => g.key), ["stored_copy", "no_ad"], by);
});

test("every ad over its life, joined to Studio's launches: costs per person, finisher and episode 2 watcher", () => {
  const runs = [
    {
      external_id: "lr_1",
      draft: { name: "CrazyDramas · Sep 23" },
      campaigns: [
        {
          name: "0924test01",
          snapshot: {
            ads: [
              { id: "111", status: "ok", stats: { spend_cents: 800, impressions: 5000, clicks: 100, ctr: 0.02, cpc_cents: 8, conversions: 0 } },
              { id: "222", status: "ok", stats: { spend_cents: 300, impressions: 2000, clicks: 50, ctr: 0.025, cpc_cents: 6, conversions: 0 } },
              { id: "333", status: "ok", stats: { spend_cents: 120, impressions: 900, clicks: 9, ctr: 0.01, cpc_cents: 13, conversions: 0 } },
            ],
          },
        },
      ],
    },
  ] as unknown as LaunchRun[];
  const spends = adSpendsFromRuns(runs);
  assert.equal(spends.length, 3);
  const rows = adTable(report(), spends);
  assert.deepEqual(rows.map((r) => r.key), ["ad:111", "ad:222", "ad:333", "stored_copy", "no_ad"]);
  const a = rows[0];
  assert.equal(a.opened, 80, "both phones, every day");
  assert.equal(a.finished_ep1, 16);
  assert.equal(a.cost_per_person_cents, 10);
  assert.equal(a.cost_per_finisher_cents, 50);
  assert.equal(a.cost_per_ep2_cents, 133);
  assert.equal(rows[2].opened, 0, "an ad that brought nobody still shows what it spent");
  assert.equal(rows[2].cost_per_person_cents, null);
  assert.equal(rows[3].spend, null);
  assert.deepEqual(adTable(report(), spends, "b").map((r) => r.key), ["no_ad"], "one series");
});

const tiktokDays = (over: Partial<{ from: string; campaigns: string[] }> = {}) => ({
  ok: true as const,
  from: "2026-08-26",
  campaigns: ["c1"],
  days: {
    "111": [{ day: "2026-09-23", spend_cents: 500, impressions: 3000, clicks: 60 }, { day: "2026-09-24", spend_cents: 300, impressions: 2000, clicks: 40 }],
    "222": [{ day: "2026-09-10", spend_cents: 300, impressions: 2000, clicks: 50 }],
  },
  ...over,
});

test("a period: the people who first opened a series in it, and what TikTok charged on those days", () => {
  const r = report();
  const at = (range: "today" | "7d" | "30d", days: AdPeriod["days"] = tiktokDays()) =>
    campaignTable(r, adSpendsFromRuns(launchRuns()), undefined, { ...rangeDays(r, range), timezone: r.timezone, days });
  const today = at("today");
  assert.deepEqual(today.map((g) => g.key), ["campaign:c1", "stored_copy", "no_ad"]);
  assert.deepEqual(today[0].ads.map((a) => [a.ad, a.opened, a.spend_cents, a.clicks]), [["111", 80, 300, 40]], "an ad that neither spent nor brought anybody today is not a row");
  assert.equal(today[0].cost_per_finisher_cents, 19, "300¢ over 16 finishers");
  assert.equal(today[1].opened, 12);
  const week = at("7d");
  assert.deepEqual(week[0].ads.map((a) => [a.ad, a.opened, a.spend_cents]), [["111", 80, 800]]);
  const month = at("30d");
  assert.deepEqual(month[0].ads.map((a) => [a.ad, a.opened, a.spend_cents]), [["111", 80, 800], ["222", 40, 300]]);
  assert.equal(month[0].spend_cents, 1100);
  // With no period the table is each ad's whole life, as before.
  assert.equal(campaignTable(r, adSpendsFromRuns(launchRuns()))[0].spend_cents, 1220);
});

test("a period without TikTok's days: the lifetime numbers only when the ad's whole life is in it, never a guess", () => {
  const r = report();
  const spends = adSpendsFromRuns(launchRuns());
  const s111 = spends.find((s) => s.ad_id === "111")!;
  const period = (range: "today" | "7d", days: AdPeriod["days"]) => ({ ...rangeDays(r, range), timezone: r.timezone, days });
  assert.equal(dayIn(s111.launched_at!, r.timezone), "2026-09-23", "launched 11:38 pm Pacific");
  const failed = { ok: false as const, error: "TikTok refused" };
  assert.deepEqual(deliveryIn(s111, period("today", failed)), { spend_cents: null, clicks: null, impressions: null }, "launched before today: unknown");
  assert.deepEqual(deliveryIn(s111, period("7d", failed)), { spend_cents: 800, clicks: 100, impressions: 5000 }, "its whole life is in the week");
  assert.equal(deliveryIn(s111, period("today", null)).spend_cents, null, "not read at all");
  assert.equal(deliveryIn(s111, period("today", tiktokDays({ campaigns: [] }))).spend_cents, null, "a campaign the read did not cover");
  assert.equal(deliveryIn(s111, period("today", tiktokDays({ from: "2026-09-25" }))).spend_cents, null, "days that do not reach back to the period's start");
  assert.equal(deliveryIn(s111, period("today", tiktokDays())).spend_cents, 300);
  const rows = adTable(r, spends, undefined, period("today", failed));
  const ad = rows.find((x) => x.ad === "111")!;
  assert.equal(ad.spend_cents, null);
  assert.equal(ad.cost_per_finisher_cents, null);
  assert.equal(ad.opened, 80, "its people still count");
});

test("TikTok's day report: each ad's days, oldest first; a metric a row lacks is unknown", () => {
  const row = (ad: string, day: string, metrics: Record<string, unknown>) => ({ dimensions: { ad_id: ad, stat_time_day: `${day} 00:00:00` }, metrics });
  const days = adDaysFromRows([
    row("1", "2026-09-25", { spend: "0.31", impressions: "19", clicks: "0" }),
    row("1", "2026-09-24", { spend: "0.06", impressions: "27", clicks: "1" }),
    row("2", "2026-09-24", { spend: "3.98", impressions: "1541" }),
  ]);
  assert.deepEqual(days["1"], [{ day: "2026-09-24", spend_cents: 6, impressions: 27, clicks: 1 }, { day: "2026-09-25", spend_cents: 31, impressions: 19, clicks: 0 }]);
  assert.deepEqual(days["2"], [{ day: "2026-09-24", spend_cents: 398, impressions: 1541, clicks: null }]);
});

test("the daily read: Studio's TikTok campaigns, 30 days to the stats' last day, paged, kept five minutes, failing soft", async () => {
  clearAdDaysCache();
  const runs = [
    { external_id: "lr_1", mode: "production", draft: { provider: "tiktok" }, campaigns: [{ advertiser_id: "adv1", state: { campaign_id: "c1" } }, { advertiser_id: "adv1", state: {} }] },
    { external_id: "lr_2", mode: "fake", draft: { provider: "tiktok" }, campaigns: [{ advertiser_id: "adv1", state: { campaign_id: "c-fake" } }] },
    { external_id: "lr_3", mode: "production", draft: { provider: "meta" }, campaigns: [{ advertiser_id: "act_1", state: { campaign_id: "m1" } }] },
  ] as unknown as LaunchRun[];
  const calls: Record<string, string | number>[] = [];
  let answer = (page: number) => ({
    code: 0,
    message: "OK",
    data: { list: [{ dimensions: { ad_id: `a${page}`, stat_time_day: "2026-09-24 00:00:00" }, metrics: { spend: "1.00", impressions: "10", clicks: "1" } }], page_info: { total_page: 2 } },
  });
  const tt = {
    mode: "production" as const,
    get: async (_path: string, _token: string, params: Record<string, string | number> = {}) => {
      calls.push(params);
      return answer(Number(params.page));
    },
    post: async () => ({ code: 0, message: "" }),
    upload: async () => ({ code: 0, message: "" }),
  };
  let clock = 1_000_000;
  const opts = { to: "2026-09-24", transport: tt, tokenFor: () => "token", now: () => clock };
  const read = await readTikTokAdDays(runs, opts);
  assert.ok(read.ok);
  assert.deepEqual(read.campaigns, ["c1"], "production TikTok campaigns only");
  assert.equal(read.from, "2026-08-26");
  assert.deepEqual(Object.keys(read.days).sort(), ["a1", "a2"], "both pages");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].advertiser_id, "adv1");
  assert.equal(calls[0].start_date, "2026-08-26");
  assert.equal(calls[0].end_date, "2026-09-24");
  assert.match(String(calls[0].dimensions), /stat_time_day/);
  assert.match(String(calls[0].filtering), /c1/);
  clock += AD_DAYS_CACHE_MS - 1;
  await readTikTokAdDays(runs, opts);
  assert.equal(calls.length, 2, "kept");
  answer = () => ({ code: 40100, message: "Too many requests", data: undefined as never });
  const failed = await readTikTokAdDays(runs, { ...opts, fresh: true });
  assert.deepEqual(failed, { ok: false, error: "Too many requests" });
  assert.deepEqual(await readTikTokAdDays(runs, { ...opts, tokenFor: () => null, fresh: true }), { ok: false, error: "No TikTok connection covers ad account adv1." });
  clearAdDaysCache();
});

test("the Monitor's line: each ad's people over its life, by TikTok's ad id", () => {
  const o = adOutcomes(report());
  assert.deepEqual(Object.keys(o).sort(), ["111", "222"]);
  assert.deepEqual(o["111"], { opened: 80, started_ep1: 34, finished_ep1: 16, watched_ep2: 6, buyers: 1, revenue_cents: 99 });
});

test("the kinds of phone in a period, TikTok on Android first", () => {
  const r = report();
  const rows = byDevice(dashRows(r, rangeDays(r, "today"), { series: "a", device: null, source: null }));
  assert.deepEqual(rows.map((g) => [g.key, g.totals.opened, g.totals.no_events]), [["tiktok_android", 72, 0], ["tiktok_iphone", 20, 12]]);
});

// ---- the dashboard (2026-09-25) --------------------------------------------------------------------------------

function dashReport(): CdStatsReport {
  const row = (day: string, drama: string, ad: string | null, device: string, extra: Record<string, unknown>, stored = false) => ({
    ...src(day, drama, ad, device, {}, stored),
    ...extra,
  });
  return CdStatsReportSchema.parse({
    ...JSON.parse(JSON.stringify(report())),
    sources: [
      row("2026-09-24", "a", "111", "tiktok_android", {
        opened: 50, unseen: 5, never_started: 10, left_waiting: 6, left_waiting_seconds: 60, started_ep1: 38, ep1_25: 20, ep1_50: 14, ep1_75: 11,
        finished_ep1: 9, watched_ep2: 4, watched_ep3: 2, paywall: 3, checkouts: 2, buyers: 1, revenue_cents: 99, restarted: 6, restarted_muted: 5,
        ep1_sound_known: 30, ep1_sound_on: 24, load_hist: [0, 10, 20, 10, 5, 2, 1, 0, 0, 0], start_hist: [0, 2, 10, 15, 6, 3, 1, 0, 0, 0],
        wait_hist: [1, 1, 0, 1, 1, 1, 1, 0, 0, 0], survey_ep1_shown: 4, survey_ep1: { too_slow: 2 },
      }),
      row("2026-09-24", "a", "111", "tiktok_iphone", { opened: 20, unseen: 40, never_started: 4, started_ep1: 16, ep1_25: 6, finished_ep1: 3, load_hist: [0, 4, 6, 4, 2, 0, 0, 0, 0, 0], survey_ep1: { too_slow: 1, not_for_me: 3 } }),
      row("2026-09-24", "b", null, "iphone", { opened: 8, started_ep1: 2 }),
      row("2026-09-24", "a", null, "tiktok_android", { opened: 12, started_ep1: 9 }, true),
      row("2026-09-10", "a", "222", "tiktok_android", { opened: 40, started_ep1: 10 }),
    ],
  });
}

test("the dashboard's filter reads the address bar: a series by its slug, a known phone, a source; anything else is all", () => {
  const r = dashReport();
  assert.deepEqual(parseDashFilter({ series: "alpha", device: "tiktok_iphone", source: "campaign:c1", country: "US" }, r), { series: "a", device: "tiktok_iphone", source: "campaign:c1", country: "US" });
  assert.deepEqual(parseDashFilter({ series: "nope", device: "fridge", source: "drop table", country: "usa" }, r), { series: null, device: null, source: null, country: null });
  assert.equal(parseDashFilter({ country: "none" }, r).country, "none");
  assert.deepEqual(parseDashFilter({ source: ["ads", "no_ad"] }, r).source, "ads");
  assert.equal(sourceKey({ stored_copy: true, ad: null, campaign: null }), "stored_copy");
  assert.equal(sourceKey({ stored_copy: false, ad: "111", campaign: "c1" }), "campaign:c1");
  assert.equal(sourceKey({ stored_copy: false, ad: null, campaign: null }), "no_ad");
});

test("the dashboard sums the filtered rows, and a breakdown ignores its own filter", () => {
  const r = dashReport();
  const today = rangeDays(r, "today");
  const all = sumRows(dashRows(r, today, NO_FILTER));
  assert.equal(all.opened, 90, "everything today; the Sep 10 row is out of the period");
  assert.equal(all.unseen, 45);
  assert.deepEqual(all.survey_ep1, { too_slow: 3, not_for_me: 3 });
  assert.deepEqual(all.load_hist, [0, 14, 26, 14, 7, 2, 1, 0, 0, 0]);
  const iphone = { series: null, device: "tiktok_iphone", source: null };
  assert.equal(sumRows(dashRows(r, today, iphone)).opened, 20);
  assert.equal(sumRows(dashRows(r, today, { ...iphone, device: null, source: "ads" })).opened, 70, "the two ad rows");
  assert.equal(sumRows(dashRows(r, today, { ...iphone, device: null, source: "stored_copy" })).opened, 12);
  assert.equal(sumRows(dashRows(r, today, { ...iphone, device: null, source: "no_ad" })).opened, 8);
  // The phone breakdown under a phone filter still lists every phone.
  assert.deepEqual(byDevice(dashRows(r, today, iphone, "device")).map((g) => g.key), ["tiktok_android", "tiktok_iphone", "iphone"]);
  assert.deepEqual(dashBy(dashRows(r, today, { series: "a", device: null, source: null }, "series"), (x) => x.drama_id).map((g) => g.key), ["a", "b"]);
});

test("where they were: countries (not recorded last), a country's states, and the country filter", () => {
  const r = dashReport();
  const place = (i: number, country: string | null, region: string | null) => ({ ...r.sources[i], country, region });
  const placed = { ...r, sources: [place(0, "US", "CA"), place(1, "US", "TX"), place(2, null, null), place(3, "PH", null), r.sources[4]] };
  const today = rangeDays(placed, "today");
  assert.deepEqual(byPlace(dashRows(placed, today, NO_FILTER, "country")).map((g) => [g.key, g.totals.opened]), [["US", 70], ["PH", 12], ["none", 8]]);
  const us = { ...NO_FILTER, country: "US" };
  assert.equal(sumRows(dashRows(placed, today, us)).opened, 70);
  assert.deepEqual(byPlace(dashRows(placed, today, us), "US").map((g) => [g.key, g.totals.opened]), [["TX", 20], ["CA", 50]], "the most landed first (TX: 40 never on screen)");
  assert.equal(sumRows(dashRows(placed, today, { ...NO_FILTER, country: "none" })).opened, 8);
  assert.equal(countryName("US", "en"), "United States");
  assert.equal(regionName("US", "CA"), "California");
  assert.equal(regionName("CA", "ON"), "ON");
});

test("an older report without places reads as not recorded", () => {
  const r = CdStatsReportSchema.parse(JSON.parse(JSON.stringify(dashReport(), (k, v) => (k === "country" || k === "region" ? undefined : v))));
  assert.ok(r.sources.every((x) => x.country === null && x.region === null));
  assert.deepEqual(byPlace(dashRows(r, rangeDays(r, "today"), NO_FILTER)).map((g) => g.key), ["none"]);
});

test("the path: landed, seen, and each step as a share of seen and of the step before", () => {
  const r = dashReport();
  const t = sumRows(dashRows(r, rangeDays(r, "today"), { series: null, device: "tiktok_android", source: "ads" }));
  const path = dashPath(t);
  assert.deepEqual(path.map((p) => p.key), [...PATH_STEPS]);
  const at = (k: string) => path.find((p) => p.key === k)!;
  assert.equal(at("landed").people, 55);
  assert.equal(at("seen").people, 50);
  assert.equal(at("played").people, 38);
  assert.equal(at("played").of_seen, 38 / 50);
  assert.equal(at("ep1_25").of_prev, 20 / 38);
  assert.equal(at("paid").people, 1);
  assert.equal(at("landed").of_prev, null);
  assert.equal(at("paywall").of_prev, null, "swipes reach it without episode 3");
});

test("a timing histogram in words: labels, median, the slowest quarter, over 5 s", () => {
  const edges = [1, 2, 3, 5, 8, 13, 20, 30, 60];
  assert.deepEqual(binLabels(edges), ["<1s", "1–2s", "2–3s", "3–5s", "5–8s", "8–13s", "13–20s", "20–30s", "30–60s", "60s+"]);
  const h = histSummary([0, 10, 20, 10, 5, 2, 1, 0, 0, 0], edges);
  assert.equal(h.n, 48);
  assert.equal(h.median, "2–3s");
  assert.equal(h.p75, "3–5s");
  assert.equal(h.over5, 8 / 48);
  assert.deepEqual(histSummary([], edges), { n: 0, bins: binLabels(edges).map((label) => ({ label, people: 0 })), median: null, p75: null, over5: null });
});

test("the source filter's campaigns carry Studio's launch names, newest launch first", () => {
  const r = dashReport();
  const opts = sourceOptions(r, rangeDays(r, "30d"), adSpendsFromRuns(launchRuns()));
  assert.deepEqual(opts.map((o) => [o.key, o.name]), [["campaign:c1", "CrazyDramas · Sep 23 · 0924test01"]]);
});

test("pages nobody saw, robots and browsing over a period, and a report from before them reads as zero", () => {
  const r = CdStatsReportSchema.parse({
    ...JSON.parse(JSON.stringify(report())),
    days: [{ day: "2026-09-24", visitors: 1, watchers: 1, new_watchers: 1, wau: 1, mau: 1, robots: 4, unseen: 7, payments: 0, first_purchases: 0, renewals: 0, revenue_cents: 0 }],
  });
  assert.deepEqual(notCounted(r, rangeDays(r, "today")), { unseen: 7, robots: 4, browsed: 0 });
  const old = report();
  assert.equal(old.robots.link_check, 0);
  assert.deepEqual(old.timing_edges_s, [1, 2, 3, 5, 8, 13, 20, 30, 60]);
  assert.deepEqual(old.sources[0].load_hist, []);
  assert.equal(old.sources[0].unseen, 0);
});

test("the fake report carries every newer number, so fixture mode shows the whole dashboard", () => {
  const f = fakeStatsReport([{ id: "d1", slug: "one", title: "One", status: "published", free_episode_count: 5 }], [], new Date("2026-09-25T20:00:00Z"));
  const t = sumRows(dashRows(f, rangeDays(f, "today"), NO_FILTER));
  assert.ok(t.unseen > 0 && t.ep1_25 > 0 && t.restarted > 0);
  assert.ok(t.load_hist.reduce((a, b) => a + b, 0) > 0 && t.start_hist.length === 10);
  assert.ok(f.robots.link_check >= 0 && f.days.some((d) => d.unseen > 0));
});

// ---- the dashboard, second cut (2026-09-25): tabs, numbers against the period before -----------------------------

test("the period before: the same length, yesterday for today, none for all or before the report", () => {
  const r = dashReport();
  assert.deepEqual(prevSpan(r, "today"), { from: "2026-09-23", to: "2026-09-23" });
  assert.deepEqual(prevSpan(r, "7d"), { from: "2026-09-11", to: "2026-09-17" });
  assert.equal(prevSpan(r, "all"), null);
  assert.deepEqual(chartSpan(r, "today"), { from: "2026-09-11", to: "2026-09-24" }, "a one-day range charts two weeks");
  assert.deepEqual(chartSpan(r, "7d"), rangeDays(r, "7d"));
});

test("a change is only shown against a period big enough to compare with", () => {
  assert.equal(change(120, 100), 0.2);
  assert.equal(change(50, 100), -0.5);
  assert.equal(change(300, MIN_COMPARE - 1), null, "3 to 300 is not 'up 9,900%'");
  assert.equal(change(5, null), null);
});

test("every day of a span, zero where nobody came, and the headline numbers of a day", () => {
  const r = dashReport();
  const days = dailyTotals(r, { from: "2026-09-22", to: "2026-09-24" }, NO_FILTER);
  assert.deepEqual(days.map((d) => d.day), ["2026-09-22", "2026-09-23", "2026-09-24"]);
  assert.deepEqual(days.map((d) => kpiValue(d.totals, "visitors")), [0, 0, 90]);
  assert.equal(kpiValue(days[2].totals, "revenue"), 99);
  assert.equal(parseKpiMetric("finished"), "finished");
  assert.equal(parseKpiMetric("nope"), "visitors");
  assert.equal(parseDashTab(["playback"]), "playback");
  assert.equal(parseDashTab("x"), "overview");
});

test("the biggest drop is the step that lost the most people, never from landing or into the unlock screen", () => {
  const r = dashReport();
  const steps = dashPath(sumRows(dashRows(r, rangeDays(r, "today"), NO_FILTER)));
  const drop = biggestDrop(steps)!;
  // 65 started, 26 reached a quarter: the largest loss of the whole path.
  assert.deepEqual([drop.from.key, drop.to.key, drop.lost], ["played", "ep1_25", 39]);
  const short = steps.filter((x) => ["seen", "played", "finished", "ep2", "paid"].includes(x.key));
  const d2 = biggestDrop(short)!;
  assert.deepEqual([d2.from.key, d2.to.key], ["played", "finished"], "the short path: 65 started, 12 finished");
  assert.equal(d2.lost, 53);
});

