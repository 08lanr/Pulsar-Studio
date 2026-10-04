// The summary's daily answers (decision 2026-10-04): the pure sums behind the paywall test, what was bought and the
// campaigns' spend against their sales on the stats page's first tab, and the fake report that shows them in
// fixture mode. No request leaves the process.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStatsReport } from "@/lib/crazydramas/fake-stats";
import { boughtGroup, boughtMix, campaignBrief, paywallTest } from "@/lib/crazydramas/stats-brief";
import type { CampaignRow } from "@/lib/crazydramas/stats-summary";
import { CdStatsPaymentSchema, CdStatsPaywallDaySchema, CdStatsReportSchema, type CdStatsPayment } from "@/lib/crazydramas/stats-types";

const pay = (over: Partial<CdStatsPayment> & Pick<CdStatsPayment, "person" | "kind" | "cents">): CdStatsPayment => ({
  day: "2026-10-04",
  product: null,
  first: true,
  refunded: false,
  offer: null,
  placement: "sheet",
  drama_id: "d1",
  platform: "tiktok",
  campaign: "c1",
  stored_copy: false,
  paid_after_s: null,
  arm: null,
  ...over,
});

const day = (d: string, arms?: Record<string, { views: number; viewers: number; checkouts: number; starters: number }>) =>
  CdStatsPaywallDaySchema.parse({ day: d, views: 0, viewers: 0, unlocks: 0, unlockers: 0, checkouts: {}, gift_shown: 0, retention_shown: 0, not_completed: 0, ...(arms ? { arms } : {}) });

test("a payment is a new VIP, a series, coins or a renewal", () => {
  assert.deepEqual(["vip_intro", "vip", "vip_renewal", "series", "coins"].map((kind) => boughtGroup({ kind: kind as CdStatsPayment["kind"] })), ["vip", "vip", "renewal", "series", "coins"]);
  const mix = boughtMix([
    pay({ person: "a", kind: "vip_intro", cents: 99 }),
    pay({ person: "b", kind: "vip", cents: 799 }),
    pay({ person: "c", kind: "series", cents: 99 }),
    pay({ person: "d", kind: "series", cents: 99, refunded: true }),
    pay({ person: "a", kind: "vip_renewal", cents: 399 }),
  ]);
  assert.deepEqual(mix, { vip: { payments: 2, cents: 898 }, series: { payments: 1, cents: 99 }, coins: { payments: 0, cents: 0 }, renewal: { payments: 1, cents: 399 } });
});

test("the paywall test: a row per sheet over the period's days, its viewers' payments by what they bought", () => {
  const report = {
    paywall_days: [
      day("2026-10-02"), // before crazydramas sent arms
      day("2026-10-03", { vip: { views: 60, viewers: 50, checkouts: 6, starters: 5 }, series: { views: 55, viewers: 48, checkouts: 9, starters: 8 } }),
      day("2026-10-04", { vip: { views: 90, viewers: 75, checkouts: 7, starters: 6 }, series: { views: 30, viewers: 25, checkouts: 5, starters: 4 } }),
    ],
  };
  const list = [
    pay({ person: "a", kind: "vip_intro", cents: 99, arm: "vip" }),
    pay({ person: "a", kind: "series", cents: 99, arm: "vip" }),
    pay({ person: "b", kind: "series", cents: 99, arm: "series" }),
    pay({ person: "c", kind: "series", cents: 99, arm: "series", refunded: true }),
    pay({ person: "d", kind: "vip_renewal", cents: 399, arm: "vip" }),
    pay({ person: "e", kind: "coins", cents: 499 }), // no sheet on record: in neither row
  ];
  const rows = paywallTest(report, { from: "2026-10-03", to: "2026-10-04" }, list)!;
  assert.deepEqual(rows.map((r) => r.arm), ["vip", "series"]);
  assert.deepEqual(rows[0], { arm: "vip", views: 150, viewer_days: 125, checkouts: 13, starter_days: 11, payments: 2, payers: 1, cents: 198, vip: 1, series: 1, coins: 0 });
  assert.deepEqual(rows[1], { arm: "series", views: 85, viewer_days: 73, checkouts: 14, starter_days: 12, payments: 1, payers: 1, cents: 99, vip: 0, series: 1, coins: 0 });
  // Days without arms: nothing to show, not zeros.
  assert.equal(paywallTest(report, { from: "2026-10-01", to: "2026-10-02" }, list), null);
  assert.equal(paywallTest({}, { from: "2026-10-03", to: "2026-10-04" }, list), null);
});

test("an older report's payments and days read without arms; an unknown arm reads as none", () => {
  const { arm: _arm, ...old } = pay({ person: "a", kind: "series", cents: 99 });
  assert.equal(CdStatsPaymentSchema.parse(old).arm, undefined);
  assert.equal(CdStatsPaymentSchema.parse({ ...old, arm: "gold" }).arm, null);
  assert.equal(day("2026-10-01").arms, undefined);
});

test("campaigns: the period's payments laid over the campaign rows, cost per payment from the spend", () => {
  const row = (over: Partial<CampaignRow> & Pick<CampaignRow, "key" | "kind">): CampaignRow => ({ campaign_id: null, launch_name: null, campaign_name: null, launched_at: null, titles: [], ads: [], spend_cents: null, opened: 0, checkouts: 0, ...over }) as CampaignRow;
  const rows = [
    row({ key: "campaign:c1", kind: "campaign", campaign_id: "c1", launch_name: "Sep 29", spend_cents: 6233, opened: 500, checkouts: 20 }),
    row({ key: "campaign:c2", kind: "campaign", campaign_id: "c2", campaign_name: "copy", spend_cents: 1018, opened: 90, checkouts: 3 }),
    row({ key: "no_ad", kind: "no_ad", opened: 40 }),
  ];
  const out = campaignBrief(rows, [
    pay({ person: "a", kind: "series", cents: 99 }),
    pay({ person: "b", kind: "vip_intro", cents: 99 }),
    pay({ person: "c", kind: "series", cents: 99, refunded: true }),
    pay({ person: "d", kind: "vip_renewal", cents: 399 }),
    pay({ person: "e", kind: "series", cents: 99, campaign: null, platform: "organic" }),
    pay({ person: "f", kind: "series", cents: 99, campaign: "c9" }), // landed before the period: no row yet
    pay({ person: "g", kind: "coins", cents: 499, campaign: null, stored_copy: true }),
  ]);
  const by = Object.fromEntries(out.map((b) => [b.key, b]));
  assert.deepEqual(out.map((b) => b.key), ["campaign:c1", "campaign:c2", "campaign:c9", "stored_copy", "no_ad"]);
  assert.deepEqual([by["campaign:c1"].payments, by["campaign:c1"].vip, by["campaign:c1"].series, by["campaign:c1"].cents, by["campaign:c1"].cost_per_payment_cents], [2, 1, 1, 198, 3117]);
  assert.equal(by["campaign:c1"].name, "Sep 29");
  assert.deepEqual([by["campaign:c2"].payments, by["campaign:c2"].cost_per_payment_cents, by["campaign:c2"].name], [0, null, "copy"]);
  assert.deepEqual([by["campaign:c9"].payments, by["campaign:c9"].spend_cents, by["campaign:c9"].campaign_id], [1, null, "c9"]);
  assert.deepEqual([by.no_ad.payments, by.no_ad.opened, by.stored_copy.coins], [1, 40, 1]);
});

test("the fake report carries the paywall test, so fixture mode shows the summary's panels", () => {
  const series = [{ id: "d1", slug: "one", title: "My Cold Boss", status: "published", free_episode_count: 10 }];
  const report = CdStatsReportSchema.parse(fakeStatsReport(series, [], new Date("2026-10-04T20:00:00Z")));
  const span = { from: report.to, to: report.to };
  const rows = paywallTest(report, span, (report.payments ?? []).filter((p) => p.day === report.to));
  assert.ok(rows && rows[0].viewer_days > rows[1].viewer_days && rows[1].viewer_days > 0, "three quarters see VIP");
  assert.ok((report.payments ?? []).some((p) => p.arm === "series") && (report.payments ?? []).filter((p) => p.kind === "vip_renewal").every((p) => p.arm == null));
});
