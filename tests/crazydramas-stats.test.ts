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
import { adOutcomes, adSpendsFromRuns, adTable, audience, CAMPAIGN_SORTS, campaignTable, dayIn, deliveryIn, deviceTable, sortCampaigns, ep1Curve, episodeBars, fmtClock, fmtShare, parseStatsRange, rangeDays, seriesTable, seriesTotals, type AdPeriod } from "@/lib/crazydramas/stats-summary";
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
  const rows = seriesTable(report(), "7d");
  assert.deepEqual(rows.map((r) => r.slug), ["alpha", "beta"]);
  const alpha = rows[0];
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
  const rows = deviceTable(report(), rangeDays(report(), "today"), "a");
  assert.deepEqual(rows.map((r) => [r.device, r.opened, r.no_events]), [["tiktok_android", 72, 0], ["tiktok_iphone", 20, 12]]);
});
