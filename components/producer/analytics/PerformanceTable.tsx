import { fmtUtc } from "@/components/producer/research/ui";
import { t, type Locale } from "@/lib/i18n";
import type { AnalyticsRange, TitlePerformanceRow } from "@/lib/analytics/types";
import { DemoChip, MetricValue, RangeControl, RateBasis, StateChip, fmtUsd } from "./bits";

// The catalog's Performance view: one compact comparison row per title with
// revenue (one basis, one window, one currency for the whole column, named
// in the header and the caption), viewers, payer conversion, observed D30
// cohort value (blank with its reason while immature), freshness, the
// analytics state chip and the Analytics link. Filters and search are the
// catalog's; this only orders and renders the rows it is given.

export const PERF_SORTS = ["revenue", "viewers", "conversion", "name"] as const;
export type PerfSort = (typeof PERF_SORTS)[number];

function sortRows(rows: TitlePerformanceRow[], sort: PerfSort): TitlePerformanceRow[] {
  const v = (m: { value: number | null }) => (m.value == null ? -Infinity : m.value);
  return [...rows].sort((a, b) => {
    if (sort === "name") return a.name_zh.localeCompare(b.name_zh, "zh");
    if (sort === "viewers") return v(b.viewers) - v(a.viewers) || v(b.revenue) - v(a.revenue);
    if (sort === "conversion") return v(b.payer_conversion) - v(a.payer_conversion) || v(b.revenue) - v(a.revenue);
    return v(b.revenue) - v(a.revenue) || v(b.viewers) - v(a.viewers);
  });
}

export default function PerformanceTable({ rows, perf, range, sort, locale, hrefFor }: { rows: string[]; perf: TitlePerformanceRow[]; range: AnalyticsRange; sort: PerfSort; locale: Locale; hrefFor: (r: AnalyticsRange) => string }) {
  const keep = new Set(rows);
  const shown = sortRows(perf.filter((r) => keep.has(r.title_id)), sort);
  // One basis for the whole column: publisher earnings when every row with a value reports it, otherwise IAP gross.
  const withValue = shown.filter((r) => r.revenue.value != null);
  const basis = withValue.length && withValue.every((r) => r.revenue.basis === "publisher_earnings") ? "publisher_earnings" : "iap_gross";
  const revenueOf = (r: TitlePerformanceRow) => (r.revenue.basis === basis ? r.revenue : { ...r.revenue, value: null, reason: "an.reason.basisMismatch" });
  const anyDemo = shown.some((r) => r.source === "demo");
  return (
    <section className="ps-catalog cc-catalog cc-performance">
      <div className="rs-meta" style={{ margin: "0", padding: "12px 14px 0" }}>
        <RangeControl range={range} hrefFor={hrefFor} locale={locale} />
        {anyDemo && <DemoChip locale={locale} />}
      </div>
      <table className="ps-catalog-table" role="table">
        <caption className="sr-only">{t(locale, "an.catalog.caption", { basis: t(locale, `an.basis.${basis}`), range: t(locale, `an.range.${range}`) })}</caption>
        <thead role="rowgroup"><tr role="row">
          <th scope="col">{t(locale, "ws.catalog.col.title")}</th>
          <th scope="col" className="gt-num">{t(locale, `an.basis.${basis}`)} <small className="an-basis">USD · {t(locale, `an.range.${range}`)}</small></th>
          <th scope="col" className="gt-num">{t(locale, "an.catalog.col.viewers")} <small className="an-basis">{t(locale, "an.catalog.periodUnique")}</small></th>
          <th scope="col" className="gt-num">{t(locale, "an.catalog.col.conversion")}</th>
          <th scope="col" className="gt-num">{t(locale, "an.catalog.col.d30")} <small className="an-basis">{t(locale, "an.catalog.d30Basis")}</small></th>
          <th scope="col">{t(locale, "an.catalog.col.state")}</th>
          <th scope="col">{t(locale, "an.catalog.col.action")}</th>
        </tr></thead>
        <tbody role="rowgroup">
          {shown.map((r) => {
            const primary = locale === "en" ? r.name_en || r.name_zh : r.name_zh;
            const secondary = locale === "en" ? (r.name_en ? r.name_zh : null) : r.name_en;
            const href = `/producer/titles/${r.title_id}/analytics?range=${range}`;
            const rev = revenueOf(r);
            return (
              <tr key={r.title_id} role="row">
                <th className="ps-catalog-identity" scope="row" role="rowheader">
                  <a className="ps-catalog-name" href={href} lang={locale === "en" && r.name_en ? "en" : "zh-CN"}>{primary}</a>
                  {secondary && <span className="ps-catalog-secondary" lang={locale === "en" ? "zh-CN" : "en"}>{secondary}</span>}
                  {r.period && <span className="ps-catalog-titlemeta">{r.period.from} → {r.period.to}{r.period.covered_days < r.period.days ? ` · ${t(locale, "an.coverage", { covered: r.period.covered_days, days: r.period.days })}` : ""}</span>}
                </th>
                <td className="gt-num" role="cell" data-label={t(locale, `an.basis.${basis}`)}>{rev.value == null ? <MetricValue m={rev} unit="usd" locale={locale} compact /> : fmtUsd(rev.value, 0)}</td>
                <td className="gt-num" role="cell" data-label={t(locale, "an.catalog.col.viewers")}><MetricValue m={r.viewers} unit="count" locale={locale} compact /></td>
                <td className="gt-num" role="cell" data-label={t(locale, "an.catalog.col.conversion")}><MetricValue m={r.payer_conversion} unit="rate" locale={locale} compact /><RateBasis m={r.payer_conversion} locale={locale} /></td>
                <td className="gt-num" role="cell" data-label={t(locale, "an.catalog.col.d30")}><MetricValue m={r.cohort_d30} unit="usd_per_user" locale={locale} /></td>
                <td role="cell" data-label={t(locale, "an.catalog.col.state")}>
                  <StateChip state={r.analytics_state} locale={locale} />
                  <span className="cc-perf-fresh">{r.freshness.data_through ? t(locale, "an.dataThrough", { date: r.freshness.data_through, lag: r.freshness.lag_days ?? 0 }) : r.freshness.last_sync_at ? t(locale, "an.lastSync", { at: fmtUtc(r.freshness.last_sync_at) }) : t(locale, "an.catalog.noSync")}</span>
                </td>
                <td className="cc-next" role="cell" data-label={t(locale, "an.catalog.col.action")}>
                  <a className="btn btn-outline btn-sm" href={href} aria-label={`${t(locale, "an.linkFrom.title")}: ${primary}`}>{t(locale, "an.linkFrom.title")} →</a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="rs-panel-foot">{t(locale, "an.catalog.caption", { basis: t(locale, `an.basis.${basis}`), range: t(locale, `an.range.${range}`) })} {t(locale, "an.catalog.footNote")}</div>
    </section>
  );
}
