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

/**
 * The plain words for a TikTok pixel ID set by hand (TIKTOK_PIXEL_ID while
 * TikTok refuses the pixel read for want of the permission; decision
 * 2026-09-24), shared by the preview, the confirm dialog and /tiktok so they
 * say it the same way. `owners` are the Business Centers that list the pixel.
 */
export function pixelHandSetNote(tt: Translate, pixelId: string, owners: readonly (string | null | undefined)[] = []): string {
  const named = [...new Set(owners.filter((o): o is string => !!o))];
  return named.length ? tt("lpx.pixelUnverifiedOwned", { id: pixelId, bc: named.join(" · ") }) : tt("lpx.pixelUnverified", { id: pixelId });
}

/** A plan's hand-set pixel note, or undefined when TikTok confirmed the pixel on every chosen account. */
export function planPixelNote(tt: Translate, pixel?: { accounts: { pixel_id: string; unverified?: true; owner?: string | null }[] }): string | undefined {
  const handSet = pixel?.accounts.filter((a) => a.unverified) ?? [];
  return handSet.length ? pixelHandSetNote(tt, handSet[0].pixel_id, handSet.map((a) => a.owner)) : undefined;
}
