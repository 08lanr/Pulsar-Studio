import AnalyticsFrame from "@/components/producer/analytics/AnalyticsFrame";
import { DefName, EvidenceOf, MetricValue, RateBasis } from "@/components/producer/analytics/bits";
import { loadAnalyticsPage } from "@/components/producer/analytics/load";
import { fmtPct, fmtUtc } from "@/components/producer/research/ui";
import { t } from "@/lib/i18n";

// /producer/titles/[id]/analytics/acquisition — the title's campaigns built
// from the existing promote.results rows (spend, impressions, clicks, CTR,
// CPC, CPM, hook hold vs the shared benchmark) with attributed users,
// payers and revenue where the source reports them, cost per acquired user
// and cohort ROAS only where both sides exist. The attribution window,
// reporting source and refresh time are visible; unattributed traffic is
// unattributed, never "organic"; ROAS is not profit. This view renders even
// when the title has no analytics data, because the campaign rows exist.

export const dynamic = "force-dynamic";

export default async function AnalyticsAcquisition({ params, searchParams }: { params: { id: string }; searchParams: { range?: string; campaign?: string } }) {
  const data = await loadAnalyticsPage(params.id, "acquisition", searchParams);
  const { locale, record: a, query } = data;
  const acq = a.acquisition;
  const focus = searchParams.campaign ?? null;
  const backHere = encodeURIComponent(`/producer/titles/${a.title.id}/analytics/acquisition${query}`);
  return (
    <AnalyticsFrame data={data} view="acquisition">
      {acq.campaigns.length === 0 ? (
        <section className="rs-panel rs-empty" role="status">
          <h2>{t(locale, "an.acq.none")}</h2>
          <p>{t(locale, "an.acq.noneBody")}</p>
          <a className="btn btn-primary" href={`/producer/promote/new?title=${a.title.id}`}>{t(locale, "ws.actions.test")}</a>
        </section>
      ) : (
        <>
          <p className="rs-meta an-acq-meta">
            <span>{t(locale, "an.acq.titleRevenue")}: <MetricValue m={acq.title_revenue_usd} unit="usd" locale={locale} compact /></span>
            <span>{t(locale, acq.unattributed_note_key)}</span>
            <span>{t(locale, "an.acq.benchmark", { hold: Math.round(acq.campaigns[0].benchmark.hook_hold_rate * 100), ctr: (acq.campaigns[0].benchmark.ctr * 100).toFixed(1) })}</span>
          </p>
          <div className="an-campaigns">
            {acq.campaigns.map((c) => {
              const id = c.campaign_id ?? c.name;
              const focused = focus != null && focus === c.campaign_id;
              const src = c.reporting_source === "demo" ? t(locale, "an.acq.sourceDemo") : c.reporting_source === "grow" ? t(locale, "an.acq.sourceGrow") : t(locale, "an.acq.sourceNone");
              return (
                <section key={id} id={c.campaign_id ? `campaign-${c.campaign_id}` : undefined} className={`rs-panel an-campaign${focused ? " is-focused" : ""}`} aria-current={focused ? "true" : undefined}>
                  <div className="rs-panel-head">
                    <div>
                      <h2>{c.name}</h2>
                      <p>
                        {c.status === "prior_round_demo" ? <span className="state state-unavailable">{t(locale, "an.acq.priorRound")}</span> : <span className="state state-collecting_history">{t(locale, `promote.status.${c.status}`)}</span>}
                        {" · "}{t(locale, "an.acq.source")}: {src}
                        {" · "}{t(locale, "an.acq.window")}: {c.attribution_window}
                        {c.window && <> · {c.window.from} → {c.window.to}</>}
                        {c.refreshed_at && <> · {t(locale, "an.acq.refreshed", { at: fmtUtc(c.refreshed_at) })}</>}
                      </p>
                    </div>
                    {c.href ? <a className="btn btn-outline btn-sm" href={c.href}>{t(locale, "an.acq.openCampaign")} →</a> : <span className="rs-panel-aside">{t(locale, "an.acq.noRecord")}</span>}
                  </div>
                  <div className="an-two">
                    <dl className="an-kv">
                      <div><dt><DefName metricKey="spend" locale={locale} /> <EvidenceOf m={c.spend_usd} locale={locale} /></dt><dd><MetricValue m={c.spend_usd} unit="usd" locale={locale} /></dd></div>
                      <div><dt><DefName metricKey="impressions" locale={locale} /></dt><dd><MetricValue m={c.impressions} unit="count" locale={locale} /></dd></div>
                      <div><dt><DefName metricKey="clicks" locale={locale} /></dt><dd><MetricValue m={c.clicks} unit="count" locale={locale} /></dd></div>
                      <div><dt><DefName metricKey="ctr" locale={locale} /></dt><dd><MetricValue m={c.ctr} unit="rate" locale={locale} /><RateBasis m={c.ctr} locale={locale} />{c.ctr.value != null && <small className="an-basis">{t(locale, c.ctr.value >= c.benchmark.ctr ? "an.acq.aboveBench" : "an.acq.belowBench", { v: fmtPct(c.benchmark.ctr, 1) })}</small>}</dd></div>
                      <div><dt><DefName metricKey="cpc" locale={locale} /></dt><dd><MetricValue m={c.cpc} unit="usd" locale={locale} /></dd></div>
                      <div><dt><DefName metricKey="cpm" locale={locale} /></dt><dd><MetricValue m={c.cpm} unit="usd" locale={locale} /></dd></div>
                      <div><dt><DefName metricKey="hook_hold_rate" locale={locale} /></dt><dd><MetricValue m={c.hook_hold_rate} unit="rate" locale={locale} />{c.hook_hold_rate.value != null && <small className="an-basis">{t(locale, c.hook_hold_rate.value >= c.benchmark.hook_hold_rate ? "an.acq.aboveBench" : "an.acq.belowBench", { v: fmtPct(c.benchmark.hook_hold_rate) })}</small>}</dd></div>
                    </dl>
                    <dl className="an-kv">
                      <div><dt><DefName metricKey="attributed_users" locale={locale} /> <EvidenceOf m={c.attributed_users} locale={locale} /></dt><dd><MetricValue m={c.attributed_users} unit="count" locale={locale} /></dd></div>
                      <div><dt><DefName metricKey="attributed_payers" locale={locale} /></dt><dd><MetricValue m={c.attributed_payers} unit="count" locale={locale} /></dd></div>
                      <div><dt><DefName metricKey="attributed_revenue" locale={locale} /></dt><dd><MetricValue m={c.attributed_revenue_usd} unit="usd" locale={locale} /></dd></div>
                      <div><dt><DefName metricKey="cost_per_acquired_user" locale={locale} /></dt><dd><MetricValue m={c.cost_per_acquired_user} unit="usd" locale={locale} /></dd></div>
                      <div><dt><DefName metricKey="cohort_roas" locale={locale} /></dt><dd><MetricValue m={c.cohort_roas} unit="ratio" locale={locale} />{c.cohort_roas.value != null && <small className="an-basis">{t(locale, "an.acq.roasNote")}</small>}</dd></div>
                    </dl>
                  </div>
                  {c.result_ids.length > 0 && <div className="rs-panel-foot">{t(locale, "an.acq.rows", { n: c.result_ids.length })} · <a href={`/producer/promote/${c.campaign_id}?returnTo=${backHere}`}>{t(locale, "an.acq.openResults")} ›</a></div>}
                </section>
              );
            })}
          </div>
          <p className="rs-meta"><a className="btn btn-outline btn-sm" href={`/producer/promote/new?title=${a.title.id}`}>{t(locale, "ws.exp.new")}</a></p>
        </>
      )}
    </AnalyticsFrame>
  );
}
