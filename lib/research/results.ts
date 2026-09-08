// Reading a campaign's results against the benchmarks (decision 2026-09-09,
// "results explain the next decision"). One pure function shared by the
// campaign page, the overview queue and title analytics, so every surface
// names the same winner for the same reason.
//
// Rules (unchanged from the 2026-09-08 workspace decision):
// - An ad "meets the benchmarks" when hook hold ≥ BENCHMARK.hook_hold_rate
//   AND CTR ≥ BENCHMARK.ctr; the winner is the qualifying ad with the
//   highest hook hold. No ad above both means no winner: test new ads
//   before spending more.
// - Derived rates are null, never 0, when their denominator is 0.
// - Provenance travels with the reading: the sources present (demo rows
//   are simulated and count at half in the assessment), the window and the
//   read time. Nothing here spends money or knows about a provider.

import type { CreativeResult, PromoCreative } from "@/lib/types";

export type Benchmark = { hook_hold_rate: number; ctr: number };

export type Verdict = "met_both" | "missed_hold" | "missed_ctr" | "missed_both" | "no_impressions";

export type AdReading = {
  result: CreativeResult;
  creative: PromoCreative | null;
  /** Position in the campaign's active creatives (1-based) for "Ad n"; null when the creative is gone. */
  ad_number: number | null;
  view_rate: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cost_per_action: number | null;
  hold_met: boolean;
  ctr_met: boolean;
  verdict: Verdict;
};

export type ResultsReading = {
  rows: AdReading[];
  winner: AdReading | null;
  totals: { spend_usd: number; impressions: number; video_views: number; clicks: number; landing_actions: number | null };
  window: { start: string; end: string } | null;
  observed_at: string | null;
  sources: CreativeResult["source"][];
  /** True when every row is simulated. */
  demo_only: boolean;
};

const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

export function readResults(results: CreativeResult[], creatives: PromoCreative[], benchmark: Benchmark): ResultsReading {
  const active = creatives.filter((c) => c.status !== "superseded");
  const rows: AdReading[] = results.map((r) => {
    const creative = creatives.find((c) => c.id === r.creative_id) ?? null;
    const ctr = ratio(r.clicks, r.impressions);
    const hold_met = r.hook_hold_rate >= benchmark.hook_hold_rate;
    const ctr_met = ctr != null && ctr >= benchmark.ctr;
    const verdict: Verdict = r.impressions === 0 ? "no_impressions" : hold_met && ctr_met ? "met_both" : hold_met ? "missed_ctr" : ctr_met ? "missed_hold" : "missed_both";
    return {
      result: r,
      creative,
      ad_number: creative ? active.findIndex((c) => c.id === creative.id) + 1 || null : null,
      view_rate: ratio(r.video_views, r.impressions),
      ctr,
      cpc: ratio(r.spend_usd, r.clicks),
      cpm: r.impressions > 0 ? (r.spend_usd / r.impressions) * 1000 : null,
      cost_per_action: r.landing_actions != null ? ratio(r.spend_usd, r.landing_actions) : null,
      hold_met,
      ctr_met,
      verdict,
    };
  });
  const winner = rows.filter((x) => x.verdict === "met_both").sort((a, b) => b.result.hook_hold_rate - a.result.hook_hold_rate || (b.ctr ?? 0) - (a.ctr ?? 0))[0] ?? null;
  const landing = results.some((r) => r.landing_actions != null) ? results.reduce((a, r) => a + (r.landing_actions ?? 0), 0) : null;
  const sorted = [...results].sort((a, b) => a.window_start.localeCompare(b.window_start));
  return {
    rows,
    winner,
    totals: {
      spend_usd: Math.round(results.reduce((a, r) => a + r.spend_usd, 0) * 100) / 100,
      impressions: results.reduce((a, r) => a + r.impressions, 0),
      video_views: results.reduce((a, r) => a + r.video_views, 0),
      clicks: results.reduce((a, r) => a + r.clicks, 0),
      landing_actions: landing,
    },
    window: sorted.length ? { start: sorted[0].window_start, end: sorted.reduce((m, r) => (r.window_end > m ? r.window_end : m), sorted[0].window_end) } : null,
    observed_at: results.reduce<string | null>((m, r) => (m == null || r.observed_at > m ? r.observed_at : m), null),
    sources: Array.from(new Set(results.map((r) => r.source))),
    demo_only: results.length > 0 && results.every((r) => r.source === "demo"),
  };
}

/** "Name, round 3" from any earlier round name: strips a trailing round marker (either language) and appends the next. */
export function nextRoundName(name: string, round: number, locale: "en" | "zh" = "en"): string {
  const base = name.replace(/\s*[,，—–-]?\s*(round|第)\s*\d+\s*(轮)?\s*$/i, "").trim();
  return locale === "zh" ? `${base}，第 ${round} 轮` : `${base}, round ${round}`;
}
