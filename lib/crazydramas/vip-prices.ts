// crazydramas.com's VIP prices, as Studio knows them (decision 2026-09-29 "VIP prices cut"): the fallback for a
// report that does not say what each subscription pays. A report since that day carries `vip[].cents` and
// `vip[].interval`, and those win (lib/crazydramas/stats-money.ts vipNow). Change these when crazydramas changes
// packages/shared/src/coins.ts VIP_PLANS / FIRST_WEEK_VIP, and nothing else in Studio: every label reads them.

/** Cents per period, by crazydramas' plan id. */
export const VIP_PRICE_CENTS = { all_access_weekly: 399, vip_monthly: 799, vip_yearly: 3999 } as const;
/** The first week a new viewer is offered, in cents. */
export const FIRST_WEEK_CENTS = 99;

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
/** "$0.99": the first-week price as the labels print it. */
export const firstWeekPrice = () => usd(FIRST_WEEK_CENTS);
/** "$3.99": the weekly price as the labels print it. */
export const weeklyPrice = () => usd(VIP_PRICE_CENTS.all_access_weekly);
