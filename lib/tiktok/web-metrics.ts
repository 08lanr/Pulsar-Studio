// TikTok-attributed website conversions for the monitor (decision 2026-09-23,
// "TikTok launch: crazydramas link contract + pixel + one account"). Pure and
// client-safe: the driver reads the report, this turns its rows into numbers.
//
// The metric names are /report/integrated/get/'s website metrics ("Basic
// report supported metrics", https://business-api.tiktok.com/portal/docs?id=1751443967255553):
//   complete_payment             Purchases (website)
//   cost_per_complete_payment    Cost per purchase (website)
//   total_complete_payment_rate  Purchase value (website): despite the name, the VALUE
//   complete_payment_roas        Purchase ROAS (website)
//   initiate_checkout            Checkouts initiated (website)
//   cost_per_initiate_checkout   Cost per checkout initiated (website)
// Not `purchase` / `total_purchase_value`: those are in-app metrics.
//
// These are TikTok's own attribution (the ad group's click/view windows), not
// crazydramas' click_id funnel; the screens label them "TikTok-attributed" and
// the two will not match. A missing field stays null, never zero.

export const WEB_METRICS = ["spend", "complete_payment", "cost_per_complete_payment", "total_complete_payment_rate", "complete_payment_roas", "initiate_checkout", "cost_per_initiate_checkout"] as const;

export type WebConversions = {
  purchases: number | null;
  purchase_value_cents: number | null;
  cost_per_purchase_cents: number | null;
  /** Purchase value ÷ spend, as TikTok reports it (2 = $2 back per $1). */
  roas: number | null;
  checkouts: number | null;
  cost_per_checkout_cents: number | null;
};

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Report rows (one per campaign, or per day) → one set of numbers. A single
 * row keeps TikTok's own ratios; several rows are summed and the ratios
 * recomputed from the sums, because averaging ratios is wrong. A metric any
 * row lacks is unknown for the whole set.
 */
export function webConversionsFromReport(rows: readonly Row[]): WebConversions {
  const metrics = rows.map((r) => (r.metrics ?? {}) as Row);
  const sum = (key: string): number | null => (metrics.length && metrics.every((m) => num(m[key]) !== null) ? metrics.reduce((n, m) => n + Number(m[key]), 0) : metrics.length ? null : 0);
  const cents = (v: number | null) => (v === null ? null : Math.round(v * 100));
  const spend = sum("spend");
  const purchases = sum("complete_payment");
  const value = sum("total_complete_payment_rate");
  const checkouts = sum("initiate_checkout");
  if (metrics.length === 1) {
    const m = metrics[0];
    return {
      purchases, purchase_value_cents: cents(value),
      cost_per_purchase_cents: purchases ? cents(num(m.cost_per_complete_payment)) : null,
      roas: num(m.complete_payment_roas),
      checkouts,
      cost_per_checkout_cents: checkouts ? cents(num(m.cost_per_initiate_checkout)) : null,
    };
  }
  return {
    purchases, purchase_value_cents: cents(value),
    cost_per_purchase_cents: spend !== null && purchases ? Math.round((spend * 100) / purchases) : null,
    roas: spend !== null && value !== null && spend > 0 ? Math.round((value / spend) * 100) / 100 : null,
    checkouts,
    cost_per_checkout_cents: spend !== null && checkouts ? Math.round((spend * 100) / checkouts) : null,
  };
}
