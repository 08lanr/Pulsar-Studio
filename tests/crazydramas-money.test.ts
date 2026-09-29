// Stats for coins and VIP (decision 2026-09-28): the pure sums behind the Money, Paywall, VIP and Coins tabs, the
// campaigns' day-0 / day-7 return, and the fake report that shows them in fixture mode. No request leaves the process.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStatsReport } from "@/lib/crazydramas/fake-stats";
import {
  coinsByDay,
  coinsBySeries,
  coinsIn,
  firstOffersTaken,
  hasMoneyDetails,
  medianToFirstPay,
  moneyByDay,
  moneyTotals,
  paymentsIn,
  paywallIn,
  perPayer,
  placementRows,
  productMix,
  repeatCoinBuyers,
  vipEnded,
  vipNow,
  vipPeriod,
  vipWeeks,
  weekOf,
} from "@/lib/crazydramas/stats-money";
import { NO_FILTER, campaignTable, parseDashTab } from "@/lib/crazydramas/stats-summary";
import { CdStatsReportSchema, type CdStatsPayment, type CdStatsReport } from "@/lib/crazydramas/stats-types";

const NOW = new Date("2026-09-28T20:00:00Z");
const SERIES = [
  { id: "d1", slug: "one", title: "My Cold Boss", status: "published", free_episode_count: 10 },
  { id: "d2", slug: "two", title: "Flirt", status: "published", free_episode_count: 10 },
];

const pay = (over: Partial<CdStatsPayment> & Pick<CdStatsPayment, "person" | "kind" | "cents">): CdStatsPayment => ({
  day: "2026-09-28",
  product: null,
  first: false,
  refunded: false,
  offer: null,
  placement: null,
  drama_id: "d1",
  platform: "tiktok",
  campaign: "c1",
  paid_after_s: null,
  ...over,
});

function report(over: Partial<CdStatsReport>): CdStatsReport {
  return CdStatsReportSchema.parse({
    version: 1,
    generated_at: NOW.toISOString(),
    timezone: "America/Los_Angeles",
    from: "2026-06-01",
    to: "2026-09-28",
    ep1_step_s: 15,
    robots: { people: 0, crawler_ua: 0, burst: 0, end_jump: 0 },
    days: [],
    series: [],
    ...over,
  });
}

test("an older report has no money details; a new one reads payments, coins, VIP and paywall days", () => {
  assert.equal(hasMoneyDetails(report({})), false);
  const r = report({
    payments: [pay({ person: "a", kind: "coins", cents: 499, product: "coins:c500first", first: true })],
    coins: { days: [{ day: "2026-09-28", bought: 500, bonus: 75, reward: 0, spent_paid: 0, spent_bonus: 60, expired: 0, clawed_back: 0, unlocks: 1 }], unspent_paid: 500, unspent_paid_cents: 499, unspent_bonus: 15, series_days: [] },
    vip: [{ plan: "all_access_weekly", intro: true, active: true, expires_day: "2026-10-05" }],
    paywall_days: [{ day: "2026-09-28", views: 3, viewers: 2, unlocks: 1, unlockers: 1, checkouts: { sheet: 1 }, gift_shown: 0, retention_shown: 1, not_completed: 0 }],
  });
  assert.equal(hasMoneyDetails(r), true);
  // An unknown kind from a newer crazydramas reads as a series payment rather than failing the whole report.
  const odd = report({ payments: [pay({ person: "a", kind: "series", cents: 99 }), { ...pay({ person: "b", kind: "series", cents: 1 }), kind: "gift_card" as unknown as "series" }] });
  assert.equal(odd.payments?.[1].kind, "series");
});

test("money: cash with refunds apart, payers and first payers, per kind, per payer, time to first pay, what sold", () => {
  const list = [
    pay({ person: "a", kind: "coins", cents: 499, product: "coins:c500first", first: true, paid_after_s: 600 }),
    pay({ person: "a", kind: "coins", cents: 999, product: "coins:c1000" }),
    pay({ person: "b", kind: "vip_intro", cents: 199, product: "all_access_weekly", offer: "first_week", first: true, paid_after_s: 1800 }),
    pay({ person: "c", kind: "vip_renewal", cents: 699, product: "all_access_weekly" }),
    pay({ person: "d", kind: "coins", cents: 499, product: "coins:c500", first: true, refunded: true }),
  ];
  const t = moneyTotals(list);
  assert.deepEqual([t.cash_cents, t.refund_cents, t.net_cents, t.payments, t.refunds], [499 + 999 + 199 + 699 + 499, 499, 499 + 999 + 199 + 699, 5, 1]);
  assert.deepEqual([t.payers, t.first_payers], [3, 2], "d's only payment was refunded; c's renewal is not a first payment");
  assert.deepEqual([t.by_kind.coins, t.by_kind.vip_intro, t.by_kind.vip_renewal, t.by_kind.series], [1498, 199, 699, 0]);
  assert.equal(perPayer(t), Math.round((499 + 999 + 199 + 699) / 3));
  assert.equal(medianToFirstPay(list), 600);
  assert.deepEqual(productMix(list).map((m) => [m.product, m.payments, m.cents]), [["coins:c1000", 1, 999], ["all_access_weekly", 2, 898], ["coins:c500first", 1, 499]]);
  const days = moneyByDay(list, ["2026-09-27", "2026-09-28"]);
  assert.deepEqual(days[0], { day: "2026-09-27", refunds: 0, series: 0, coins: 0, vip_intro: 0, vip: 0, vip_renewal: 0 });
  assert.deepEqual([days[1].coins, days[1].refunds, days[1].vip_intro], [1498, 499, 199]);
});

test("money: the period, the series a payment is credited to, and where the payer came from", () => {
  const r = report({
    payments: [
      pay({ person: "a", kind: "coins", cents: 499, day: "2026-09-20" }),
      pay({ person: "b", kind: "coins", cents: 999, drama_id: null, placement: "store" }),
      pay({ person: "c", kind: "vip", cents: 1399, drama_id: "d2", platform: "organic", campaign: null }),
    ],
  });
  const week = { from: "2026-09-22", to: "2026-09-28" };
  assert.equal(paymentsIn(r, week, NO_FILTER).length, 2);
  assert.deepEqual(paymentsIn(r, week, { series: "d2", source: null }).map((p) => p.person), ["c"], "a store pack names no series");
  assert.deepEqual(paymentsIn(r, week, { series: null, source: "ads" }).map((p) => p.person), ["b"]);
  assert.deepEqual(paymentsIn(r, week, { series: null, source: "no_ad" }).map((p) => p.person), ["c"]);
  assert.deepEqual(paymentsIn(r, { from: "2026-09-01", to: "2026-09-28" }, { series: null, source: "campaign:c1" }).map((p) => p.person), ["a", "b"]);
});

test("money: a picked series leaves coin packs out, even one bought on its sheet; the payer's whole origin filters like the rows", () => {
  const r = report({
    payments: [
      pay({ person: "a", kind: "coins", cents: 499, drama_id: "d1", placement: "sheet" }),
      pay({ person: "b", kind: "series", cents: 99, drama_id: "d1" }),
      // Landed with TikTok's click id only: no ad, the same as its source row.
      pay({ person: "c", kind: "vip", cents: 1399, drama_id: "d2", platform: "tiktok", campaign: null, ad: null, stored_copy: false, device: "tiktok_ios", country: "US" }),
      pay({ person: "d", kind: "vip", cents: 1399, drama_id: "d2", platform: "tiktok", campaign: null, ad: null, stored_copy: true, device: "tiktok_android", country: "PH" }),
      pay({ person: "e", kind: "vip", cents: 1399, drama_id: "d2", platform: "tiktok", campaign: null, ad: "ad9", stored_copy: false, device: "tiktok_ios", country: null }),
    ],
  });
  const day = { from: "2026-09-28", to: "2026-09-28" };
  assert.deepEqual(paymentsIn(r, day, { series: "d1" }).map((p) => p.person), ["b"], "the pack's coins are credited where spent, not here");
  assert.deepEqual(paymentsIn(r, day, { source: "no_ad" }).map((p) => p.person), ["c"]);
  assert.deepEqual(paymentsIn(r, day, { source: "stored_copy" }).map((p) => p.person), ["d"]);
  assert.deepEqual(paymentsIn(r, day, { source: "campaign:unknown" }).map((p) => p.person), ["e"], "an ad without its campaign, as sourceKey names it");
  assert.deepEqual(paymentsIn(r, day, { source: "ads" }).map((p) => p.person), ["a", "b", "e"], "a and b: older payments with their campaign");
  assert.deepEqual(paymentsIn(r, day, { device: "tiktok_ios" }).map((p) => p.person), ["a", "b", "c", "e"], "an older payment without the origin is kept");
  assert.deepEqual(paymentsIn(r, day, { country: "none" }).map((p) => p.person), ["a", "b", "e"]);
});

test("paywall: sheet views, unlocks and checkouts by screen; paid and cash per screen; the first-time offers taken", () => {
  const r = report({
    paywall_days: [
      { day: "2026-09-27", views: 10, viewers: 8, unlocks: 4, unlockers: 3, checkouts: { sheet: 3, gift: 1 }, gift_shown: 5, retention_shown: 2, not_completed: 1 },
      { day: "2026-09-28", views: 6, viewers: 5, unlocks: 2, unlockers: 2, checkouts: { retention: 1, other: 2, store: 1 }, gift_shown: 1, retention_shown: 3, not_completed: 0 },
    ],
  });
  const pw = paywallIn(r, { from: "2026-09-27", to: "2026-09-28" });
  assert.deepEqual([pw.views, pw.viewer_days, pw.unlocks, pw.gift_shown, pw.retention_shown, pw.not_completed], [16, 13, 6, 6, 5, 1]);
  assert.deepEqual(pw.checkouts, { sheet: 3, gift: 1, retention: 1, store: 1, other: 2 });
  const list = [
    pay({ person: "a", kind: "coins", cents: 499, placement: "sheet", product: "coins:c500first" }),
    pay({ person: "b", kind: "coins", cents: 499, placement: null }),
    pay({ person: "c", kind: "vip_intro", cents: 199, placement: "retention", offer: "first_week" }),
    pay({ person: "d", kind: "coins", cents: 499, placement: "gift", refunded: true }),
    pay({ person: "e", kind: "vip_renewal", cents: 699, placement: null }),
  ];
  const rows = placementRows(pw, list);
  assert.deepEqual(rows.map((x) => [x.placement, x.shown, x.checkouts, x.paid, x.cents]), [
    ["sheet", 16, 5, 2, 998],
    ["gift", 6, 1, 0, 0],
    ["retention", 5, 1, 1, 199],
    ["store", null, 1, 0, 0],
  ]);
  assert.deepEqual(firstOffersTaken(list), { first_week: 1, first_pack: 1 });
  // A renewal carries the subscription's `offer: first_week`: it is not another $1.99 week taken.
  assert.deepEqual(firstOffersTaken([...list, pay({ person: "c", kind: "vip_renewal", cents: 699, offer: "first_week" })]), { first_week: 1, first_pack: 1 });
});

test("VIP: active by plan, monthly value without the $1.99 weeks, ended; new, renewals and first week → renewal", () => {
  const r = report({
    to: "2026-09-28",
    vip: [
      { plan: "all_access_weekly", intro: false, active: true, expires_day: "2026-10-02" },
      { plan: "all_access_weekly", intro: true, active: true, expires_day: "2026-10-01" },
      { plan: "vip_monthly", intro: false, active: true, expires_day: "2026-10-20" },
      { plan: "vip_yearly", intro: false, active: true, expires_day: "2027-09-01" },
      { plan: "all_access_weekly", intro: false, active: false, expires_day: "2026-09-25" },
      { plan: "vip_monthly", intro: false, active: true, expires_day: "2026-09-20" },
    ],
    payments: [
      pay({ person: "a", kind: "vip_intro", cents: 199, day: "2026-09-10" }),
      pay({ person: "a", kind: "vip_renewal", cents: 699, day: "2026-09-17" }),
      pay({ person: "b", kind: "vip_intro", cents: 199, day: "2026-09-12" }),
      pay({ person: "c", kind: "vip_intro", cents: 199, day: "2026-09-26" }),
      pay({ person: "d", kind: "vip", cents: 1399, day: "2026-09-26" }),
    ],
  });
  const now = vipNow(r);
  assert.deepEqual([now.active, now.by_plan.weekly, now.by_plan.monthly, now.by_plan.yearly, now.intros], [4, 2, 1, 1, 1], "an expired one is not active, whatever its flag");
  assert.equal(now.mrr_cents, Math.round((699 * 52) / 12 + 1399 + 6999 / 12));
  assert.equal(vipEnded(r, { from: "2026-09-22", to: "2026-09-28" }), 1);
  const per = vipPeriod(r, { from: "2026-09-01", to: "2026-09-28" });
  assert.deepEqual([per.new_intro, per.new_full, per.renewals, per.renewal_cents], [3, 1, 1, 699]);
  assert.deepEqual([per.intros_due, per.intros_renewed], [2, 1], "c's week is not over yet");
  const dueToday = report({ to: "2026-09-28", payments: [pay({ person: "t", kind: "vip_intro", cents: 199, day: "2026-09-21" })] });
  assert.equal(vipPeriod(dueToday, { from: "2026-09-22", to: "2026-09-28" }).intros_due, 0, "due today: it may still renew later today");
  const lastWeek = vipPeriod(r, { from: "2026-09-18", to: "2026-09-28" });
  assert.deepEqual([lastWeek.intros_due, lastWeek.intros_renewed], [1, 0], "a first week counts in the period it runs out in, whenever it began");
  const weeks = vipWeeks(r, { from: "2026-09-08", to: "2026-09-28" });
  assert.deepEqual(weeks.map((w) => w.week), ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]);
  assert.deepEqual(weeks.map((w) => [w.new_intro, w.new_full, w.renewals, w.ended]), [[2, 0, 0, 0], [0, 0, 1, 1], [1, 1, 0, 1], [0, 0, 0, 0]], "the monthly still flagged active ran out Sep 20: ended");
  assert.equal(vipEnded(r, { from: "2026-09-14", to: "2026-09-20" }), 1, "a VIP left to run out ended, whatever its flag");
  assert.equal(weekOf("2026-09-28"), "2026-09-28", "a Monday is its own week");
});

test("coins: in and out per day and period, repeat buyers over all their packs, coins spent per series", () => {
  const r = report({
    coins: {
      days: [
        { day: "2026-09-27", bought: 500, bonus: 75, reward: 20, spent_paid: 0, spent_bonus: 60, expired: 5, clawed_back: 0, unlocks: 1 },
        { day: "2026-09-28", bought: 1000, bonus: 100, reward: 10, spent_paid: 120, spent_bonus: 60, expired: 0, clawed_back: 0, unlocks: 3 },
      ],
      unspent_paid: 1380,
      unspent_paid_cents: 1377,
      unspent_bonus: 65,
      series_days: [
        { day: "2026-09-28", drama_id: "d1", spent_paid: 120, spent_bonus: 0, cents: 120, unlocks: 2 },
        { day: "2026-09-27", drama_id: "d1", spent_paid: 0, spent_bonus: 60, cents: 0, unlocks: 1 },
      ],
    },
    payments: [
      pay({ person: "a", kind: "coins", cents: 499, day: "2026-09-01" }),
      pay({ person: "a", kind: "coins", cents: 999 }),
      pay({ person: "b", kind: "coins", cents: 499 }),
    ],
  });
  const c = coinsIn(r, { from: "2026-09-27", to: "2026-09-28" });
  assert.deepEqual([c.bought, c.bonus, c.reward, c.spent_paid, c.spent_bonus, c.expired, c.unlocks], [1500, 175, 30, 120, 120, 5, 4]);
  assert.deepEqual(coinsByDay(r, ["2026-09-26", "2026-09-28"]).map((d) => d.bought), [0, 1000]);
  const inWeek = paymentsIn(r, { from: "2026-09-22", to: "2026-09-28" }, NO_FILTER);
  assert.deepEqual(repeatCoinBuyers(r, inWeek), { buyers: 2, repeat: 1 }, "a bought before the week too");
  assert.deepEqual(coinsBySeries(r, { from: "2026-09-27", to: "2026-09-28" }).get("d1"), { spent_paid: 120, spent_bonus: 60, cents: 120, unlocks: 3 });
});

test("the Buyers tab became Money; the campaigns add up day-0 and day-7 revenue", () => {
  assert.equal(parseDashTab("buyers"), "money");
  assert.equal(parseDashTab("coins"), "coins");
  const r = fakeStatsReport(SERIES, [], NOW);
  const rows = campaignTable(r, []);
  const all = rows.reduce((a, x) => ({ d0: a.d0 + x.revenue_d0_cents, d7: a.d7 + x.revenue_d7_cents, rev: a.rev + x.revenue_cents }), { d0: 0, d7: 0, rev: 0 });
  assert.ok(all.d0 > 0 && all.d0 <= all.d7 && all.d7 <= all.rev, JSON.stringify(all));
});

test("the fake report carries coins and VIP that add up (fixture mode's tabs)", () => {
  const r = CdStatsReportSchema.parse(fakeStatsReport(SERIES, [], NOW));
  assert.ok(hasMoneyDetails(r));
  const span = { from: "2026-08-30", to: r.to };
  const t = moneyTotals(paymentsIn(r, span, NO_FILTER));
  assert.ok(t.payers > 0 && t.first_payers > 0 && t.first_payers <= t.payers);
  assert.ok(t.by_kind.coins > 0 && t.by_kind.vip_intro > 0);
  assert.ok(vipNow(r).active > 0);
  assert.ok(coinsIn(r, span).bought > 0);
  assert.ok(paywallIn(r, span).views > 0);
  for (const p of r.payments ?? []) if (!p.first) assert.ok((r.payments ?? []).some((q) => q.person === p.person && q.first), `${p.person} has a first payment`);
});
