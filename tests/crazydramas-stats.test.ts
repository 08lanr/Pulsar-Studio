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
import { audience, ep1Curve, episodeBars, fmtClock, fmtShare, parseStatsRange, rangeDays, seriesTable, seriesTotals } from "@/lib/crazydramas/stats-summary";
import type { CdStatsReport, CdStatsSeries } from "@/lib/crazydramas/stats-types";
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
  const day = (d: string, watchers: number, extra: Partial<CdStatsReport["days"][number]> = {}) => ({
    day: d, visitors: watchers * 2, watchers, new_watchers: watchers, wau: 0, mau: 0, robots: 1, payments: 0, first_purchases: 0, renewals: 0, revenue_cents: 0, ...extra,
  });
  const cohort = (d: string, opened: number, over: Partial<CdStatsSeries["cohorts"][number]> = {}) => ({
    day: d, opened, started_ep1: Math.round(opened / 2), finished_ep1: Math.round(opened / 4), ep1_seconds: opened * 30,
    ep1_reached: [Math.round(opened / 2), Math.round(opened / 3), Math.round(opened / 4)], episodes: [Math.round(opened / 2), 3, 1, 0, 0, 0],
    episodes_watched: [Math.round(opened / 3), 2, 1, 0, 0, 0], paywall: 2, paywall_watched: 1, paywall_skipped: 1, checkouts: 1, buyers: 1, revenue_cents: 199, robots: 3, ...over,
  });
  return {
    version: 1, generated_at: "2026-09-24T20:00:00.000Z", timezone: "America/Los_Angeles", from: "2026-05-28", to: "2026-09-24", ep1_step_s: 15,
    robots: { people: 9, crawler_ua: 1, burst: 6, end_jump: 2 },
    days: [day("2026-09-20", 5), day("2026-09-23", 10, { wau: 14, mau: 20 }), day("2026-09-24", 20, { wau: 30, mau: 40, payments: 3, first_purchases: 2, renewals: 1, revenue_cents: 1097 })],
    series: [
      { drama_id: "a", slug: "alpha", title: "Alpha", status: "published", free_episodes: 3, episode_count: 6, ep1_duration_s: 40, cohorts: [cohort("2026-09-10", 40), cohort("2026-09-24", 100)] },
      { drama_id: "b", slug: "beta", title: "Beta", status: "published", free_episodes: 5, episode_count: 60, ep1_duration_s: null, cohorts: [] },
    ],
  };
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
