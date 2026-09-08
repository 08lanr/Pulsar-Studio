// Server-safe pieces the analytics views share: a metric value that shows
// its unit and, when missing, its reason; a change label that never confuses
// percent with percentage points; the state chip; the demo chip; the range
// control; the freshness line. Colors are never the only signal: every chip
// carries text.

import { EvidenceTag, fmtCount, fmtPct, fmtUtc } from "@/components/producer/research/ui";
import { definition } from "@/lib/analytics/definitions";
import { RANGES, type AnalyticsRange, type AnalyticsState, type Comparison, type Freshness, type Metric, type RateMetric, type ReportingPeriod } from "@/lib/analytics/types";
import { t, type Locale } from "@/lib/i18n";

export type Unit = "count" | "usd" | "rate" | "usd_per_user" | "seconds" | "ratio";

export function fmtUsd(v: number | null | undefined, digits = 2): string {
  if (v == null) return "–";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function fmtValue(v: number | null | undefined, unit: Unit): string {
  if (v == null) return "–";
  if (unit === "usd") return fmtUsd(v);
  if (unit === "usd_per_user") return `${fmtUsd(v)}/u`;
  if (unit === "rate") return fmtPct(v, v < 0.1 ? 2 : 1);
  if (unit === "seconds") return `${Math.round(v)} s`;
  if (unit === "ratio") return `${v.toFixed(2)}×`;
  return v.toLocaleString("en-US");
}

export function defName(key: string, locale: Locale): string {
  const d = definition(key);
  return d ? (locale === "zh" ? d.name_zh : d.name_en) : key;
}

/** A metric name that carries its formula as a tooltip and links to the dictionary. */
export function DefName({ metricKey, locale }: { metricKey: string; locale: Locale }) {
  const d = definition(metricKey);
  return (
    <abbr className="an-def" title={d ? `${d.formula}${d.denominator ? ` · ${t(locale, "an.denominator")}: ${d.denominator}` : ""}` : undefined}>
      {defName(metricKey, locale)}
    </abbr>
  );
}

/** The value, or the honest missing state with its reason. */
export function MetricValue({ m, unit, locale, compact }: { m: Metric | RateMetric; unit: Unit; locale: Locale; compact?: boolean }) {
  if (m.value == null) {
    const reason = m.reason ? t(locale, m.reason) : t(locale, "an.reason.notReported");
    return (
      <span className={`an-missing an-missing-${m.availability}`} title={reason}>
        {m.availability === "not_applicable" ? t(locale, "an.na") : t(locale, "an.unavailable")}
        {!compact && <small>{reason}</small>}
      </span>
    );
  }
  const shown = unit === "count" && compact ? fmtCount(m.value) : fmtValue(m.value, unit);
  const rate = "denominator" in m && m.denominator != null && m.numerator != null ? `${m.numerator.toLocaleString("en-US")} / ${m.denominator.toLocaleString("en-US")} · ${t(locale, m.denominator_key)}` : null;
  return (
    <span className="an-value" title={rate ?? undefined}>
      {shown}
      {m.availability === "partial" && <small className="an-partial">{t(locale, "an.partial")}</small>}
    </span>
  );
}

/** The numbers behind a rate, shown under it so the denominator is never hidden. */
export function RateBasis({ m, locale }: { m: RateMetric; locale: Locale }) {
  if (m.numerator == null || m.denominator == null) return null;
  return <small className="an-basis">{m.numerator.toLocaleString("en-US")} / {m.denominator.toLocaleString("en-US")} {t(locale, m.denominator_key)}</small>;
}

export function Delta({ c, locale }: { c: Comparison | null; locale: Locale }) {
  if (!c) return <small className="an-delta an-delta-none">{t(locale, "an.noComparison")}</small>;
  if (c.kind === "not_comparable") return <small className="an-delta an-delta-none">{t(locale, c.reason)}</small>;
  const up = c.value > 0;
  const flat = Math.abs(c.value) < 0.0005;
  const text = c.kind === "pct_change" ? `${up ? "+" : ""}${(c.value * 100).toFixed(1)}%` : `${up ? "+" : ""}${(c.value * 100).toFixed(2)} ${t(locale, "an.pp")}`;
  return (
    <small className={`an-delta ${flat ? "an-delta-flat" : up ? "delta-up" : "delta-down"}`}>
      <span aria-hidden>{flat ? "→" : up ? "↑" : "↓"}</span> {text} <span className="an-delta-note">{t(locale, c.kind === "pct_change" ? "an.vsPrevPct" : "an.vsPrevPp")}</span>
    </small>
  );
}

const STATE_CLASS: Record<AnalyticsState, string> = {
  available: "state-available",
  needs_listing_link: "state-requires_connection",
  linked_awaiting_data: "state-collecting_history",
  partial: "state-collecting_history",
  stale: "state-stale",
  sync_failed: "state-failed",
};

export function StateChip({ state, locale }: { state: AnalyticsState; locale: Locale }) {
  return <span className={`state ${STATE_CLASS[state]}`}>{t(locale, `an.state.${state}`)}</span>;
}

export function DemoChip({ locale }: { locale: Locale }) {
  return <span className="state state-unavailable an-demo-chip" title={t(locale, "an.demo.note")}>{t(locale, "an.demo.chip")}</span>;
}

export function RangeControl({ range, hrefFor, locale }: { range: AnalyticsRange; hrefFor: (r: AnalyticsRange) => string; locale: Locale }) {
  return (
    <nav className="filter-row an-range" aria-label={t(locale, "an.range.label")}>
      <span className="rs-toolbar-label">{t(locale, "an.range.label")}</span>
      {RANGES.map((r) => (
        <a key={r} className={`filter-chip${r === range ? " on" : ""}`} aria-current={r === range ? "true" : undefined} href={hrefFor(r)}>
          {t(locale, `an.range.${r}`)}
        </a>
      ))}
    </nav>
  );
}

export function PeriodText({ p, locale }: { p: ReportingPeriod | null; locale: Locale }) {
  if (!p) return null;
  return (
    <span>
      {p.from} → {p.to} · {p.timezone} · {p.currency}
      {p.covered_days < p.days && <> · {t(locale, "an.coverage", { covered: p.covered_days, days: p.days })}</>}
    </span>
  );
}

export function FreshnessLine({ f, period, locale, source }: { f: Freshness; period: ReportingPeriod | null; locale: Locale; source: string | null }) {
  return (
    <p className="an-fresh rs-meta">
      <PeriodText p={period} locale={locale} />
      {f.data_through && <span>{t(locale, "an.dataThrough", { date: f.data_through, lag: f.lag_days ?? 0 })}</span>}
      {f.last_sync_at && <span>{t(locale, "an.lastSync", { at: fmtUtc(f.last_sync_at) })}</span>}
      {f.source_label && <span>{t(locale, "an.source")}: {f.source_label}</span>}
      {source === "demo" && <EvidenceTag evidence="estimated" locale={locale} />}
      {f.notes.map((n) => <span key={n} className="ev ev-inferred">{t(locale, n)}</span>)}
    </p>
  );
}

export function EvidenceOf({ m, locale }: { m: Metric; locale: Locale }) {
  return <EvidenceTag evidence={m.provenance.evidence} locale={locale} />;
}
