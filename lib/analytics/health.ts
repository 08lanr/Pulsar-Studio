// "How this title is doing" (founder decision 2026-09-10): a rules-based reading of
// the record against the previous period and the producer's own catalog, plus
// blended ROAS (all title revenue in the period ÷ ad spend whose reporting window
// overlaps it). Descriptive, never a prediction; blended is never called attributed.

import type { Metric, RateMetric, TitleAnalytics, TitlePerformanceRow } from "./types";

export type HealthTone = "good" | "bad" | "flat" | "na";
export type HealthRow = {
  key: "revenue" | "audience" | "conversion" | "rpv" | "roas";
  value: number | null;
  unit: "usd" | "count" | "rate" | "usd_per_user" | "ratio";
  verdict_key: string;
  tone: HealthTone;
  note_key: string;
  note_vars?: Record<string, string | number>;
};
export type TitleHealth = { overall: "good" | "mixed" | "weak" | "na"; rows: HealthRow[]; revenue_basis: "publisher_earnings" | "iap_gross" };

const r2 = (v: number) => Math.round(v * 100) / 100;
const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (v: number) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

function trendRow(key: HealthRow["key"], unit: HealthRow["unit"], m: Metric | undefined, comparison: { kind: string; value: number } | null | undefined): HealthRow {
  const value = m?.value ?? null;
  if (value == null || !comparison || comparison.kind !== "pct_change") return { key, value, unit, verdict_key: "an.health.verdict.na", tone: "na", note_key: "an.health.note.noPrev" };
  const c = comparison.value;
  const tone: HealthTone = c > 0.02 ? "good" : c < -0.02 ? "bad" : "flat";
  return { key, value, unit, verdict_key: tone === "good" ? "an.health.verdict.up" : tone === "bad" ? "an.health.verdict.down" : "an.health.verdict.flat", tone, note_key: "an.health.note.vsPrev", note_vars: { pct: pct(c) } };
}

function catalogRow(key: HealthRow["key"], unit: HealthRow["unit"], own: number | null, others: number[], fmt: (v: number) => string): HealthRow {
  const med = median(others);
  if (own == null) return { key, value: null, unit, verdict_key: "an.health.verdict.na", tone: "na", note_key: "an.health.note.noValue" };
  if (med == null || med === 0) return { key, value: own, unit, verdict_key: "an.health.verdict.na", tone: "na", note_key: "an.health.note.noCatalog" };
  const rel = (own - med) / med;
  const tone: HealthTone = rel > 0.1 ? "good" : rel < -0.1 ? "bad" : "flat";
  return { key, value: own, unit, verdict_key: tone === "good" ? "an.health.verdict.above" : tone === "bad" ? "an.health.verdict.below" : "an.health.verdict.inline", tone, note_key: "an.health.note.vsCatalog", note_vars: { median: fmt(med), n: others.length } };
}

/** Ad spend whose reporting window overlaps the record's period, across every campaign row (prior demo rounds included). */
export function spendInPeriod(a: TitleAnalytics): number | null {
  const p = a.period;
  if (!p) return null;
  let sum = 0, any = false;
  for (const c of a.acquisition.campaigns) {
    if (c.spend_usd.value == null || !c.window) continue;
    if (c.window.to < p.from || c.window.from > p.to) continue;
    sum += c.spend_usd.value; any = true;
  }
  return any ? r2(sum) : null;
}

export function titleHealth(a: TitleAnalytics, catalog: TitlePerformanceRow[]): TitleHealth | null {
  if (!a.overview) return null;
  const h = (k: string) => a.overview!.headlines.find((x) => x.key === k);
  const earnings = a.revenue?.waterfall.find((w) => w.key === "publisher_earnings")?.metric ?? null;
  const gross = h("iap_gross")?.metric ?? null;
  const basis: TitleHealth["revenue_basis"] = earnings?.value != null ? "publisher_earnings" : "iap_gross";
  const revenueValue = basis === "publisher_earnings" ? earnings!.value : gross?.value ?? null;

  const rows: HealthRow[] = [];
  rows.push({ ...trendRow("revenue", "usd", basis === "publisher_earnings" ? earnings! : gross ?? undefined, h("iap_gross")?.comparison as { kind: string; value: number } | null), value: revenueValue });
  rows.push(trendRow("audience", "count", h("viewers")?.metric, h("viewers")?.comparison as { kind: string; value: number } | null));

  const others = catalog.filter((r) => r.title_id !== a.title.id);
  const conv = h("payer_conversion")?.metric as RateMetric | undefined;
  rows.push(catalogRow("conversion", "rate", conv?.value ?? null, others.map((r) => r.payer_conversion.value).filter((v): v is number => v != null), (v) => `${(v * 100).toFixed(2)}%`));
  const mine = catalog.find((r) => r.title_id === a.title.id);
  const rpv = (r: TitlePerformanceRow) => (r.revenue.value != null && r.viewers.value ? r.revenue.value / r.viewers.value : null);
  rows.push(catalogRow("rpv", "usd_per_user", mine ? rpv(mine) : null, others.map(rpv).filter((v): v is number => v != null), (v) => `$${v.toFixed(2)}/u`));

  const spend = spendInPeriod(a);
  if (spend == null || spend === 0 || revenueValue == null) rows.push({ key: "roas", value: null, unit: "ratio", verdict_key: "an.health.verdict.na", tone: "na", note_key: "an.health.note.noSpend" });
  else {
    const roas = r2(revenueValue / spend);
    rows.push({ key: "roas", value: roas, unit: "ratio", verdict_key: roas >= 1 ? "an.health.verdict.roasAbove" : "an.health.verdict.roasBelow", tone: roas >= 1 ? "good" : "bad", note_key: "an.health.note.roas", note_vars: { roas: roas.toFixed(2), spend: spend.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), revenue: revenueValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) } });
  }

  const known = rows.filter((r) => r.tone !== "na");
  const good = known.filter((r) => r.tone === "good").length;
  const bad = known.filter((r) => r.tone === "bad").length;
  // Good: nothing negative and at least two positives. Needs attention: the negatives outnumber the positives. Otherwise mixed.
  const overall: TitleHealth["overall"] = known.length < 2 ? "na" : bad === 0 && good >= 2 ? "good" : bad > good ? "weak" : "mixed";
  return { overall, rows, revenue_basis: basis };
}
