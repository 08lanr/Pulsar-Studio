// One sentence describing a launch plan, shared by the Launch preview and the
// confirm dialog so the two can never word the same plan differently.
//
// English needs the singular ("1 campaign", not "1 campaigns"); Chinese uses one
// form for both. The daily clause only appears when the plan actually carries a
// daily budget, instead of printing a dash where a number belongs.

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function planScale(tt: Translate, campaigns: number, accounts: number): { campaigns: string; accounts: string } {
  return {
    campaigns: campaigns === 1 ? tt("lv2.campaignsOne") : tt("lv2.campaignsMany", { n: campaigns }),
    accounts: accounts === 1 ? tt("lv2.accountsOne") : tt("lv2.accountsMany", { n: accounts }),
  };
}

export function planSummary(
  tt: Translate,
  plan: { campaign_count: number; account_count: number; total_budget_cents: number; daily_total_cents?: number | null },
  money: (cents: number) => string,
): string {
  const scale = planScale(tt, plan.campaign_count, plan.account_count);
  const line = tt("lv2.planSummaryLine", { ...scale, total: money(plan.total_budget_cents) });
  const daily = plan.daily_total_cents;
  return daily == null ? line : `${line} · ${tt("lv2.planSummaryDaily", { daily: money(daily) })}`;
}

export function launchButtonLabel(tt: Translate, count: number, state: string): string {
  return count === 1 ? tt("lv2.launchButtonOne", { state }) : tt("lv2.launchButton", { count, state });
}
