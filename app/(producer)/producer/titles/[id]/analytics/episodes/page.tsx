import AnalyticsFrame from "@/components/producer/analytics/AnalyticsFrame";
import { DefName, MetricValue, fmtUsd } from "@/components/producer/analytics/bits";
import RetentionChart from "@/components/producer/analytics/RetentionChart";
import { loadAnalyticsPage } from "@/components/producer/analytics/load";
import { t } from "@/lib/i18n";

// /producer/titles/[id]/analytics/episodes — the episode comparison table
// with denominators and sample sizes, the continuation chart, text flags,
// and links to the episode workspace with a return link. There is no
// "best episode" score: each column answers one question and the
// definitions (mid-title entry, replays, out-of-sequence viewing) are on
// the page.

export const dynamic = "force-dynamic";

export default async function AnalyticsEpisodes({ params, searchParams }: { params: { id: string }; searchParams: { range?: string } }) {
  const data = await loadAnalyticsPage(params.id, "episodes", searchParams);
  const { locale, record: a, base, query } = data;
  const ep = a.episodes;
  const returnTo = encodeURIComponent(`${base}/episodes${query}`);
  return (
    <AnalyticsFrame data={data} view="episodes">
      {ep && ep.attribution === "unavailable" && (
        <section className="rs-panel rs-empty" role="status">
          <h2>{t(locale, "an.ep.noAttribution")}</h2>
          <p>{t(locale, "an.ep.noAttributionBody")}</p>
        </section>
      )}
      {ep && ep.attribution === "available" && (
        <>
          <section className="rs-panel an-panel">
            <div className="rs-panel-head"><div><h2>{t(locale, "an.ep.continuation")}</h2><p>{t(locale, "an.ep.continuationSub", { days: ep.continuation_window_days })}</p></div></div>
            <div className="rs-panel-body"><RetentionChart ep={ep} locale={locale} /></div>
          </section>

          <section className="rs-panel an-panel">
            <div className="rs-panel-head"><div><h2>{t(locale, "an.ep.table")}</h2><p>{t(locale, "an.ep.tableSub", { min: ep.min_sample })}</p></div></div>
            <div className="an-scroll" tabIndex={0} aria-label={t(locale, "an.ep.table")}>
              <table className="an-table an-ep-table">
                <caption className="sr-only">{t(locale, "an.ep.table")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t(locale, "an.ep.episode")}</th>
                    <th scope="col" className="gt-num"><DefName metricKey="starts" locale={locale} /></th>
                    <th scope="col" className="gt-num"><DefName metricKey="unique_starters" locale={locale} /></th>
                    <th scope="col" className="gt-num"><DefName metricKey="completions" locale={locale} /></th>
                    <th scope="col" className="gt-num"><DefName metricKey="completion_rate" locale={locale} /></th>
                    <th scope="col" className="gt-num"><DefName metricKey="continuation" locale={locale} /></th>
                    <th scope="col" className="gt-num"><DefName metricKey="watch_seconds_avg" locale={locale} /></th>
                    <th scope="col" className="gt-num"><DefName metricKey="paywall_reached_ep" locale={locale} /></th>
                    <th scope="col" className="gt-num"><DefName metricKey="paid_unlocks" locale={locale} /></th>
                    <th scope="col" className="gt-num"><DefName metricKey="ad_unlocks" locale={locale} /></th>
                    <th scope="col" className="gt-num"><DefName metricKey="unlock_conversion" locale={locale} /></th>
                    <th scope="col" className="gt-num"><DefName metricKey="episode_revenue" locale={locale} /></th>
                    <th scope="col">{t(locale, "an.ep.flags")}</th>
                    <th scope="col">{t(locale, "an.ep.open")}</th>
                  </tr>
                </thead>
                <tbody>
                  {ep.rows.map((r) => (
                    <tr key={r.number} className={r.is_paywall ? "is-paywall" : ""}>
                      <th scope="row">{t(locale, "an.ep.n", { n: r.number })}{r.is_paywall && <span className="ev ev-inferred">{t(locale, "an.ep.paywall")}</span>}</th>
                      <td className="gt-num"><MetricValue m={r.starts} unit="count" locale={locale} compact /></td>
                      <td className="gt-num"><MetricValue m={r.unique_starters} unit="count" locale={locale} compact /></td>
                      <td className="gt-num"><MetricValue m={r.completions} unit="count" locale={locale} compact /></td>
                      <td className="gt-num"><MetricValue m={r.completion_rate} unit="rate" locale={locale} compact /><small className="an-basis">n={r.completion_rate.denominator?.toLocaleString("en-US") ?? "–"}</small></td>
                      <td className="gt-num"><MetricValue m={r.continuation} unit="rate" locale={locale} compact /><small className="an-basis">{r.continuation.denominator == null ? (r.continuation.reason ? t(locale, r.continuation.reason) : "") : `n=${r.continuation.denominator.toLocaleString("en-US")}`}</small></td>
                      <td className="gt-num"><MetricValue m={r.watch_seconds_avg} unit="seconds" locale={locale} compact /></td>
                      <td className="gt-num"><MetricValue m={r.paywall_reached} unit="count" locale={locale} compact /></td>
                      <td className="gt-num"><MetricValue m={r.paid_unlocks} unit="count" locale={locale} compact /></td>
                      <td className="gt-num"><MetricValue m={r.ad_unlocks} unit="count" locale={locale} compact /></td>
                      <td className="gt-num"><MetricValue m={r.unlock_conversion} unit="rate" locale={locale} compact />{r.unlock_conversion.denominator != null && <small className="an-basis">n={r.unlock_conversion.denominator.toLocaleString("en-US")}</small>}</td>
                      <td className="gt-num"><MetricValue m={r.revenue_usd} unit="usd" locale={locale} compact /></td>
                      <td className="an-flags">{r.flags.length ? r.flags.map((f) => <span key={f} className={`an-flag an-flag-${f}`}>{t(locale, `an.flag.${f}`)}</span>) : <span className="gt-muted">–</span>}</td>
                      <td>{r.episode_id ? <a className="btn btn-ghost btn-sm" href={`/producer/titles/${a.title.id}/episodes/${r.number}?returnTo=${returnTo}`}>{t(locale, "an.ep.workspace")}&nbsp;→</a> : <span className="gt-muted" title={t(locale, "an.ep.notInStudio")}>{t(locale, "an.ep.notInStudio")}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="rs-panel-foot">
              {t(locale, "an.ep.revenueBasis", { mapped: fmtUsd(ep.mapped_revenue_usd), total: fmtUsd(ep.title_revenue_usd) })}
            </div>
          </section>

          <section className="rs-panel an-panel">
            <div className="rs-panel-head"><div><h2>{t(locale, "an.ep.definitions")}</h2></div></div>
            <ul className="an-defs">
              <li>{t(locale, "an.ep.def.entry")}</li>
              <li>{t(locale, "an.ep.def.replays")}</li>
              <li>{t(locale, "an.ep.def.sequence", { days: ep.continuation_window_days })}</li>
              <li>{t(locale, "an.ep.def.uniques")}</li>
              <li>{t(locale, "an.ep.def.sample", { min: ep.min_sample })}</li>
            </ul>
          </section>
        </>
      )}
    </AnalyticsFrame>
  );
}
