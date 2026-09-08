import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { fixtureSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { demoCampaignId, demoTitleId } from "@/data/fixture/demo-catalog";
import { addDays, buildDemoAnalytics, DEMO_SCENARIO_TITLES, DEMO_TODAY } from "@/data/fixture/demo-analytics";
import { computeTitleAnalytics, grossBetween, totals } from "@/lib/analytics/compute";
import { DEFINITIONS } from "@/lib/analytics/definitions";
import { isDataError } from "@/lib/data";
import type { RateMetric } from "@/lib/analytics/types";

// Title analytics: tenant isolation, mapping permissions and conflicts, the
// scenario states, date filtering and the previous-period rule, aggregate
// consistency (daily sums, no summed uniques), cohort maturity, missing vs
// zero, revenue accounting, attribution boundaries and the continuation
// definition. Everything runs on the demo seed with the demo clock.

afterEach(() => resetFixtureStore());

const producer = () => fixtureSession("producer");
const staff = () => fixtureSession("staff");
const reviewer = () => ({ ...fixtureSession("producer"), producerRole: "reviewer" as const });
const viewer = () => ({ ...fixtureSession("producer"), producerRole: "viewer" as const });
const other = () => ({ ...fixtureSession("producer"), producerId: "00000000-0000-4000-8000-00000000ffff" });
const S = DEMO_SCENARIO_TITLES;

async function code(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return isDataError(e) ? e.code : `other:${(e as Error).message}`;
  }
}

// ---- isolation and states ------------------------------------------------------------------

test("performance rows are company-scoped and carry the scenario states", async () => {
  resetFixtureStore("demo");
  const rows = await fixtureData.listTitlePerformance(producer(), { range: "30d" });
  assert.equal(rows.length, 14);
  const state = (n: number) => rows.find((r) => r.title_id === demoTitleId(n))!.analytics_state;
  assert.equal(state(S.strong_viewing_weak_monetization), "available");
  assert.equal(state(S.strong_monetization_low_traffic), "available");
  assert.equal(state(S.paywall_drop), "available");
  assert.equal(state(S.expensive_acquisition), "available");
  assert.equal(state(S.no_campaign), "available");
  assert.equal(state(S.unmapped), "needs_listing_link");
  assert.equal(state(S.awaiting_data), "linked_awaiting_data");
  assert.equal(state(S.immature_cohort), "partial");
  assert.equal(state(S.stale), "stale");
  assert.equal(state(S.sync_failed), "sync_failed");
  for (const n of [5, 9, 11, 13]) assert.equal(state(n), "needs_listing_link");
  assert.ok(rows.every((r) => r.source === "demo" || r.source === null), "fixture rows are demo-labelled or empty");
  assert.deepEqual(await fixtureData.listTitlePerformance(other(), { range: "30d" }), []);
  assert.deepEqual(await fixtureData.listTitlePerformance(staff(), { range: "30d" }), [], "staff preview has no company");
});

test("a foreign title is not_found, never forbidden, and viewers may read", async () => {
  resetFixtureStore("demo");
  assert.equal(await code(() => fixtureData.getTitleAnalytics(other(), demoTitleId(1), { range: "30d" })), "not_found");
  const asViewer = await fixtureData.getTitleAnalytics(viewer(), demoTitleId(1), { range: "30d" });
  assert.equal(asViewer.analytics_state, "available");
  assert.ok(asViewer.overview, "viewer-role producers read the record (read-only rendering is the page's job)");
  assert.deepEqual(await fixtureData.listAnalyticsListings(other()), []);
});

test("scenario shapes: strong viewing / weak monetization vs strong monetization / low traffic", async () => {
  resetFixtureStore("demo");
  const a8 = await fixtureData.getTitleAnalytics(producer(), demoTitleId(S.strong_viewing_weak_monetization), { range: "30d" });
  const a6 = await fixtureData.getTitleAnalytics(producer(), demoTitleId(S.strong_monetization_low_traffic), { range: "30d" });
  const h = (a: typeof a8, k: string) => a.overview!.headlines.find((x) => x.key === k)!.metric.value!;
  assert.ok(h(a8, "viewers") > 5 * h(a6, "viewers"));
  assert.ok(h(a6, "payer_conversion") > 5 * h(a8, "payer_conversion"));
  assert.ok(a6.revenue!.users.arppu.value! > a8.revenue!.users.arppu.value!);
});

// ---- mapping permissions and conflicts ----------------------------------------------------

test("linking: editors only, staff preview refused, conflicts named, unlink restores needs_listing_link", async () => {
  resetFixtureStore("demo");
  const t3 = demoTitleId(S.unmapped);
  assert.equal(await code(() => fixtureData.linkAnalyticsListing(viewer(), t3, "lst_demo_flash_marriage_a")), "forbidden");
  assert.equal(await code(() => fixtureData.linkAnalyticsListing(staff(), t3, "lst_demo_flash_marriage_a")), "forbidden");
  assert.equal(await code(() => fixtureData.linkAnalyticsListing(other(), t3, "lst_demo_flash_marriage_a")), "not_found");
  assert.equal(await code(() => fixtureData.linkAnalyticsListing(producer(), t3, "lst_demo_does_not_exist")), "not_found");
  // Already linked to title 1: conflict, with the other title named.
  try {
    await fixtureData.linkAnalyticsListing(reviewer(), t3, "lst_demo_reborn_ceo");
    assert.fail("expected conflict");
  } catch (e) {
    assert.ok(isDataError(e) && e.code === "conflict");
    assert.match((e as Error).message, /Reborn as the CEO/);
  }
  const link = await fixtureData.linkAnalyticsListing(reviewer(), t3, "lst_demo_flash_marriage_a");
  assert.equal(link.listing_id, "lst_demo_flash_marriage_a");
  const linked = await fixtureData.getTitleAnalytics(producer(), t3, { range: "30d" });
  assert.equal(linked.analytics_state, "available");
  const listings = await fixtureData.listAnalyticsListings(producer());
  assert.equal(listings.find((l) => l.id === "lst_demo_flash_marriage_a")!.linked_title_id, t3);
  // Re-linking the same pair is idempotent; switching listings replaces the row.
  assert.equal((await fixtureData.linkAnalyticsListing(producer(), t3, "lst_demo_flash_marriage_a")).id, link.id);
  await fixtureData.linkAnalyticsListing(producer(), t3, "lst_demo_flash_marriage_b");
  assert.equal(listings.length, 12);
  assert.equal(await code(() => fixtureData.unlinkAnalyticsListing(viewer(), t3)), "forbidden");
  await fixtureData.unlinkAnalyticsListing(producer(), t3);
  assert.equal((await fixtureData.getTitleAnalytics(producer(), t3, { range: "30d" })).analytics_state, "needs_listing_link");
});

// ---- periods, comparison, aggregates ------------------------------------------------------

test("date filtering: periods end at the last data day; previous-period comparison needs two full periods", async () => {
  resetFixtureStore("demo");
  const a = await fixtureData.getTitleAnalytics(producer(), demoTitleId(S.paywall_drop), { range: "7d" });
  assert.equal(a.period!.to, addDays(DEMO_TODAY, -1));
  assert.equal(a.period!.from, addDays(DEMO_TODAY, -7));
  assert.equal(a.period!.covered_days, 7);
  assert.ok(a.overview!.previous_period, "two full 7-day periods exist");
  assert.equal(a.overview!.previous_period!.to, addDays(a.period!.from, -1));
  assert.equal(a.overview!.series.length, 7);
  for (const h of a.overview!.headlines) {
    assert.ok(h.comparison, `${h.key} compares`);
    assert.equal(h.comparison!.kind, h.unit === "rate" ? "pp_change" : "pct_change", "rates change in pp, counts in %");
  }
  // Title 14 has five days: 7d is partial and has no comparison; cohorts are immature.
  const a14 = await fixtureData.getTitleAnalytics(producer(), demoTitleId(S.immature_cohort), { range: "7d" });
  assert.equal(a14.analytics_state, "partial");
  assert.equal(a14.period!.covered_days, 5);
  assert.equal(a14.overview!.previous_period, null);
  assert.ok(a14.overview!.headlines.every((h) => h.comparison === null));
  for (const c of a14.revenue!.cohorts) {
    assert.equal(c.mature, false);
    assert.equal(c.metric.value, null, "immature is null, not 0");
    assert.equal(c.metric.reason, "an.reason.immature");
  }
  // Stale: the last data day is 9 days old; the range still ends there.
  const a10 = await fixtureData.getTitleAnalytics(producer(), demoTitleId(S.stale), { range: "30d" });
  assert.equal(a10.analytics_state, "stale");
  assert.equal(a10.freshness.lag_days, 9);
  assert.equal(a10.revenue!.mix.ads.value, null, "ad revenue component unavailable");
  assert.equal(a10.revenue!.mix.ads.availability, "unavailable");
});

test("aggregate consistency: daily sums equal period totals; unique users are not summed", async () => {
  const demo = buildDemoAnalytics(DEMO_TODAY);
  const ds = demo.datasets.get("lst_demo_reborn_ceo")!;
  resetFixtureStore("demo");
  const a = await fixtureData.getTitleAnalytics(producer(), demoTitleId(S.paywall_drop), { range: "30d" });
  const rows = ds.daily.filter((d) => d.date >= a.period!.from && d.date <= a.period!.to);
  const t = totals(rows, ds.dedupe);
  const sumGross = Math.round(rows.reduce((x, d) => x + d.recharge_gmv_usd, 0) * 100) / 100;
  assert.equal(a.overview!.headlines.find((h) => h.key === "iap_gross")!.metric.value, sumGross);
  assert.equal(a.overview!.series.reduce((x, p) => x + (p.starts ?? 0), 0), t.starts);
  const dailySum = rows.reduce((x, d) => x + d.new_viewers + d.returning_viewers, 0);
  const viewers = a.overview!.headlines.find((h) => h.key === "viewers")!.metric.value!;
  assert.ok(viewers < dailySum, "period-unique viewers are fewer than the sum of daily viewers");
  assert.ok(viewers >= t.new_viewers, "and at least every new viewer");
  const rate = a.overview!.headlines.find((h) => h.key === "payer_conversion")!.metric as RateMetric;
  assert.equal(rate.denominator, viewers);
  assert.equal(rate.value, Math.round((rate.numerator! / rate.denominator!) * 10000) / 10000, "rate = numerator / denominator shown");
  const comp = a.overview!.headlines.find((h) => h.key === "completion_rate")!.metric as RateMetric;
  assert.equal(comp.numerator, t.completions);
  assert.equal(comp.denominator, t.starts);
});

test("cohort maturity and D7/D30 math use elapsed cohorts only", async () => {
  const demo = buildDemoAnalytics(DEMO_TODAY);
  const ds = demo.datasets.get("lst_demo_reborn_ceo")!;
  resetFixtureStore("demo");
  const a = await fixtureData.getTitleAnalytics(producer(), demoTitleId(S.paywall_drop), { range: "30d" });
  const d7 = a.revenue!.cohorts.find((c) => c.horizon === 7)!;
  const d30 = a.revenue!.cohorts.find((c) => c.horizon === 30)!;
  for (const c of [d7, d30]) {
    assert.ok(c.mature);
    assert.equal(c.entry_to, addDays(ds.data_through, -c.horizon), "entry window ends where the horizon has elapsed");
    assert.equal(c.eligible_cohorts, 30);
    assert.equal(c.elapsed_days_min, c.horizon);
    const rows = ds.daily.filter((d) => d.date >= c.entry_from! && d.date <= c.entry_to!);
    const users = rows.reduce((x, d) => x + d.cohort_size, 0);
    const rev = rows.reduce((x, d) => x + (c.horizon === 7 ? d.cohort_rev_d7_usd! : d.cohort_rev_d30_usd!), 0);
    assert.equal(c.initial_users, users);
    assert.equal(c.metric.value, Math.round((Math.round(rev * 100) / 100 / users) * 10000) / 10000, "eligible cumulative cohort revenue / initial eligible cohort users");
    assert.equal(c.basis, "gross");
  }
  assert.ok(d30.metric.value! >= d7.metric.value!, "D30 never below D7");
  // Unelapsed cohorts carry null, never 0.
  const recent = ds.daily[ds.daily.length - 1];
  assert.equal(recent.cohort_rev_d7_usd, null);
  assert.equal(recent.cohort_rev_d30_usd, null);
});

test("missing values are unavailable with a reason, never zero; free episodes are not applicable", async () => {
  resetFixtureStore("demo");
  const a2 = await fixtureData.getTitleAnalytics(producer(), demoTitleId(S.sync_failed), { range: "30d" });
  assert.equal(a2.episodes!.attribution, "unavailable");
  assert.deepEqual(a2.episodes!.rows, []);
  assert.ok(a2.freshness.notes.includes("an.note.noEpisodeAttribution"));
  const a12 = await fixtureData.getTitleAnalytics(producer(), demoTitleId(S.awaiting_data), { range: "30d" });
  assert.equal(a12.overview, null);
  assert.equal(a12.period, null);
  const perf = (await fixtureData.listTitlePerformance(producer(), { range: "30d" })).find((r) => r.title_id === demoTitleId(S.awaiting_data))!;
  assert.equal(perf.viewers.value, null);
  assert.equal(perf.viewers.reason, "an.reason.awaitingData");
  assert.equal(perf.revenue.basis, "none");
  const a1 = await fixtureData.getTitleAnalytics(producer(), demoTitleId(S.paywall_drop), { range: "30d" });
  const free = a1.episodes!.rows.find((r) => r.number === 1)!;
  assert.equal(free.unlock_conversion.availability, "not_applicable");
  assert.equal(free.revenue_usd.value, null);
  const paidOut = a1.revenue!.waterfall.find((w) => w.key === "paid_out")!;
  assert.equal(paidOut.metric.availability, "unavailable");
  assert.equal(paidOut.metric.value, null);
});

// ---- revenue accounting ---------------------------------------------------------------------

test("revenue accounting: recharge and redemption are separate; earnings <= gross - refunds - fees; settled <= earnings", async () => {
  resetFixtureStore("demo");
  const a = await fixtureData.getTitleAnalytics(producer(), demoTitleId(S.strong_monetization_low_traffic), { range: "90d" });
  const r = a.revenue!;
  const v = (k: string) => r.waterfall.find((w) => w.key === k)!.metric.value;
  assert.ok(v("iap_gross")! > 0);
  assert.equal(r.orders.recharge_gmv.value, v("iap_gross"), "gross sales are the recharge value, nothing else");
  assert.ok(r.orders.redeem_orders.value! > 0 && r.orders.redeem_coins.value! > 0, "redemption is reported separately");
  assert.ok(r.mix.iap.value === v("iap_gross"), "redeemed coins never enter revenue");
  const expected = Math.round((v("iap_gross")! - v("refunds")! - v("fees_share")!) * 100) / 100;
  assert.equal(v("publisher_earnings"), expected);
  assert.ok(v("publisher_earnings")! <= v("iap_gross")! - v("refunds")! - v("fees_share")! + 0.01);
  assert.ok(v("settled")! <= v("publisher_earnings")! + 0.01, "settled never exceeds earnings");
  assert.ok(r.users.repeat_payers.value! <= r.users.paying_users.value!);
  assert.equal(r.users.arppu.value, Math.round((r.mix.iap.value! / r.users.paying_users.value!) * 10000) / 10000);
  assert.ok(r.platform_ltv.value != null && r.platform_ltv.definition_text_key, "platform LTV is shown with its definition, apart from cohorts");
  // Episode revenue never exceeds the title total.
  const ep = a.episodes!;
  assert.ok(ep.mapped_revenue_usd! <= ep.title_revenue_usd! + 0.01);
  assert.equal(Math.round(ep.rows.reduce((x, row) => x + (row.revenue_usd.value ?? 0), 0) * 100) / 100, ep.mapped_revenue_usd);
});

// ---- attribution -----------------------------------------------------------------------------

test("acquisition reuses promo_results rows exactly and keeps attribution inside title revenue", async () => {
  resetFixtureStore("demo");
  const a = await fixtureData.getTitleAnalytics(producer(), demoTitleId(S.paywall_drop), { range: "30d" });
  const results = await fixtureData.listCreativeResults(producer(), { titleId: demoTitleId(1) });
  const c = a.acquisition.campaigns.find((x) => x.campaign_id === demoCampaignId(1))!;
  assert.deepEqual([...c.result_ids].sort(), results.map((r) => r.id).sort());
  assert.equal(c.spend_usd.value, Math.round(results.reduce((x, r) => x + r.spend_usd, 0) * 100) / 100);
  assert.equal(c.impressions.value, results.reduce((x, r) => x + r.impressions, 0));
  assert.equal(c.clicks.value, results.reduce((x, r) => x + r.clicks, 0));
  assert.equal(c.ctr.value, Math.round((c.clicks.value! / c.impressions.value!) * 10000) / 10000);
  assert.equal(c.reporting_source, "demo");
  assert.equal(c.benchmark.hook_hold_rate, 0.3);
  assert.equal(c.benchmark.ctr, 0.012);
  const ds = buildDemoAnalytics(DEMO_TODAY).datasets.get("lst_demo_reborn_ceo")!;
  const titleGross = grossBetween(ds, c.window!.from, c.window!.to);
  assert.ok(c.attributed_revenue_usd.value! <= titleGross, "attributed revenue is bounded by title revenue in the same window");
  assert.equal(c.cohort_roas.value, Math.round((c.attributed_revenue_usd.value! / c.spend_usd.value!) * 10000) / 10000);
  assert.equal(c.cost_per_acquired_user.value, Math.round((c.spend_usd.value! / c.attributed_users.value!) * 100) / 100);
  // Ad impressions are never added to title viewers.
  const viewers = a.overview!.headlines.find((h) => h.key === "viewers")!.metric.value!;
  assert.ok(viewers < c.impressions.value! + 1_000_000 && !(viewers === c.impressions.value), "viewers stay a title figure");
  // No campaign: an empty list, and the takeaway says so.
  const a7 = await fixtureData.getTitleAnalytics(producer(), demoTitleId(S.no_campaign), { range: "30d" });
  assert.deepEqual(a7.acquisition.campaigns, []);
  assert.ok(a7.overview!.takeaways.some((k) => k.key === "an.take.noCampaign"));
  // Expensive acquisition: the prior round has few users and a high CPA; ROAS exists only with attributed revenue.
  const a4 = await fixtureData.getTitleAnalytics(producer(), demoTitleId(S.expensive_acquisition), { range: "30d" });
  const prior = a4.acquisition.campaigns.find((x) => x.status === "prior_round_demo")!;
  assert.ok(prior.cost_per_acquired_user.value! > 10);
  assert.ok(prior.hook_hold_rate.value! >= 0.3);
  const draft = a4.acquisition.campaigns.find((x) => x.campaign_id === demoCampaignId(3))!;
  assert.equal(draft.spend_usd.value, null);
  assert.equal(draft.cohort_roas.value, null);
  assert.equal(draft.cohort_roas.reason, "an.reason.noAttributedRevenue");
});

// ---- episodes ---------------------------------------------------------------------------------

test("continuation is eligible starters of N who started N+1 within the window; the paywall drop is flagged", async () => {
  const ds = buildDemoAnalytics(DEMO_TODAY).datasets.get("lst_demo_reborn_ceo")!;
  resetFixtureStore("demo");
  const a = await fixtureData.getTitleAnalytics(producer(), demoTitleId(S.paywall_drop), { range: "30d" });
  const ep = a.episodes!;
  assert.equal(ep.paywall_episode, 4);
  const row3 = ep.rows.find((r) => r.number === 3)!;
  const eligible = ds.episode_daily.filter((r) => r.number === 3 && r.date >= a.period!.from && r.date <= a.period!.to && r.continued_to_next != null);
  assert.equal(row3.continuation.denominator, eligible.reduce((x, r) => x + r.unique_starters, 0));
  assert.equal(row3.continuation.numerator, eligible.reduce((x, r) => x + (r.continued_to_next ?? 0), 0));
  assert.ok(row3.continuation.value! < 0.5 && row3.flags.includes("continuation_loss"));
  assert.ok(ep.rows.find((r) => r.number === 2)!.continuation.value! > 0.7, "healthy early retention");
  assert.equal(ep.rows[ep.rows.length - 1].continuation.availability, "not_applicable", "the last episode has no next");
  assert.ok(a.overview!.takeaways.some((k) => k.key === "an.take.continuation" && k.vars?.n === 3 && k.vars?.next === 4));
  // Every recent day is inside the window: 7d has eligible days only for the first four.
  const a7 = await fixtureData.getTitleAnalytics(producer(), demoTitleId(S.paywall_drop), { range: "7d" });
  assert.ok(a7.episodes!.rows[0].continuation.denominator! < a7.episodes!.rows[0].unique_starters.value!);
  for (const r of ep.rows) assert.equal(r.completion_rate.denominator, r.starts.value);
});

test("the compute layer never sees a provider: an unlinked record has no data, and a supabase-shaped call returns unavailable metrics", () => {
  const record = computeTitleAnalytics({ title: { id: "t", producer_id: "p", name_zh: "x", name_en: null, episode_count: 0 }, episodes: [], listing: null, link: { id: "l", producer_id: "p", title_id: "t", listing_id: "lst_x", linked_by: "u", linked_at: DEMO_TODAY }, dataset: null, campaigns: [], results: [], range: "30d", today: DEMO_TODAY });
  assert.equal(record.analytics_state, "needs_listing_link", "a link without a dataset yields nothing (supabase mode overrides the state to linked_awaiting_data)");
  assert.equal(record.overview, null);
  assert.deepEqual(record.acquisition.campaigns, []);
});

test("every definition key the record uses exists in the dictionary source", async () => {
  resetFixtureStore("demo");
  const keys = new Set(DEFINITIONS.map((d) => d.key));
  const a = await fixtureData.getTitleAnalytics(producer(), demoTitleId(S.paywall_drop), { range: "30d" });
  const seen = new Set<string>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    if ("definition_key" in (v as Record<string, unknown>)) seen.add((v as { definition_key: string }).definition_key);
    for (const x of Object.values(v as Record<string, unknown>)) walk(x);
  };
  walk(a);
  for (const k of seen) assert.ok(keys.has(k), `definition ${k}`);
  assert.ok(seen.size > 30);
});
