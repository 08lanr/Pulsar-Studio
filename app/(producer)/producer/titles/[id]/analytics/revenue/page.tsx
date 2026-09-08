import AnalyticsFrame from "@/components/producer/analytics/AnalyticsFrame";
import { DefName, EvidenceOf, MetricValue, RateBasis, fmtUsd } from "@/components/producer/analytics/bits";
import { loadAnalyticsPage } from "@/components/producer/analytics/load";
import { EvidenceTag } from "@/components/producer/research/ui";
import { t } from "@/lib/i18n";

// /producer/titles/[id]/analytics/revenue — Revenue & LTV: the IAP / ad mix,
// paying users and conversion, recharge vs redemption side by side, the
// gross → refunds → fees → publisher earnings → settled → paid-out
// waterfall with unavailable steps shown as unavailable, the platform's
// own LTV kept apart from Pulsar's observed D7/D30 cohort revenue per user
// (formula, entry definition, size, elapsed days, basis, region split).
// No lifetime forecast.

export const dynamic = "force-dynamic";

export default async function AnalyticsRevenue({ params, searchParams }: { params: { id: string }; searchParams: { range?: string } }) {
  const data = await loadAnalyticsPage(params.id, "revenue", searchParams);
  const { locale, record: a } = data;
  const r = a.revenue;
  return (
    <AnalyticsFrame data={data} view="revenue">
      {r && (
        <>
          <div className="rs-grid an-grid">
            <section className="rs-panel">
              <div className="rs-panel-head"><div><h2>{t(locale, "an.rev.mix")}</h2><p>{t(locale, "an.rev.mixSub")}</p></div></div>
              <dl className="an-kv">
                <div><dt><DefName metricKey="iap_gross" locale={locale} /> <EvidenceOf m={r.mix.iap} locale={locale} /></dt><dd><MetricValue m={r.mix.iap} unit="usd" locale={locale} /></dd></div>
                <div><dt><DefName metricKey="ad_revenue" locale={locale} /> <EvidenceOf m={r.mix.ads} locale={locale} /></dt><dd><MetricValue m={r.mix.ads} unit="usd" locale={locale} /></dd></div>
                <div><dt><DefName metricKey="iap_share" locale={locale} /></dt><dd><MetricValue m={r.mix.iap_share} unit="rate" locale={locale} /><RateBasis m={r.mix.iap_share} locale={locale} /></dd></div>
              </dl>
              <div className="rs-panel-foot">{t(locale, "an.rev.mixNote")}</div>
            </section>
            <section className="rs-panel">
              <div className="rs-panel-head"><div><h2>{t(locale, "an.rev.users")}</h2><p>{t(locale, "an.rev.usersSub")}</p></div></div>
              <dl className="an-kv">
                <div><dt><DefName metricKey="paying_users" locale={locale} /> <EvidenceOf m={r.users.paying_users} locale={locale} /></dt><dd><MetricValue m={r.users.paying_users} unit="count" locale={locale} /></dd></div>
                <div><dt><DefName metricKey="payer_conversion" locale={locale} /></dt><dd><MetricValue m={r.users.payer_conversion} unit="rate" locale={locale} /><RateBasis m={r.users.payer_conversion} locale={locale} /></dd></div>
                <div><dt><DefName metricKey="repeat_payers" locale={locale} /> <EvidenceOf m={r.users.repeat_payers} locale={locale} /></dt><dd><MetricValue m={r.users.repeat_payers} unit="count" locale={locale} /></dd></div>
                <div><dt><DefName metricKey="repeat_share" locale={locale} /></dt><dd><MetricValue m={r.users.repeat_share} unit="rate" locale={locale} /><RateBasis m={r.users.repeat_share} locale={locale} /></dd></div>
                <div><dt><DefName metricKey="arppu" locale={locale} /></dt><dd><MetricValue m={r.users.arppu} unit="usd_per_user" locale={locale} /><RateBasis m={r.users.arppu} locale={locale} /></dd></div>
              </dl>
            </section>
          </div>

          <section className="rs-panel an-panel">
            <div className="rs-panel-head"><div><h2>{t(locale, "an.rev.orders")}</h2><p>{t(locale, "an.rev.ordersSub")}</p></div></div>
            <div className="an-two">
              <div className="an-side">
                <h3>{t(locale, "an.rev.recharge")}</h3>
                <p className="gt-muted">{t(locale, "an.rev.rechargeNote")}</p>
                <dl className="an-kv">
                  <div><dt><DefName metricKey="recharge_orders" locale={locale} /></dt><dd><MetricValue m={r.orders.recharge_orders} unit="count" locale={locale} /></dd></div>
                  <div><dt><DefName metricKey="iap_gross" locale={locale} /></dt><dd><MetricValue m={r.orders.recharge_gmv} unit="usd" locale={locale} /></dd></div>
                  <div><dt><DefName metricKey="avg_gmv_per_order" locale={locale} /></dt><dd><MetricValue m={r.orders.avg_gmv_per_order} unit="usd" locale={locale} /><RateBasis m={r.orders.avg_gmv_per_order} locale={locale} /></dd></div>
                </dl>
              </div>
              <div className="an-side">
                <h3>{t(locale, "an.rev.redeem")}</h3>
                <p className="gt-muted">{t(locale, "an.rev.redeemNote")}</p>
                <dl className="an-kv">
                  <div><dt><DefName metricKey="redeem_orders" locale={locale} /></dt><dd><MetricValue m={r.orders.redeem_orders} unit="count" locale={locale} /></dd></div>
                  <div><dt><DefName metricKey="redeem_coins" locale={locale} /></dt><dd><MetricValue m={r.orders.redeem_coins} unit="count" locale={locale} /> <span className="gt-muted">{t(locale, "an.unit.coins")}</span></dd></div>
                </dl>
              </div>
            </div>
          </section>

          <section className="rs-panel an-panel">
            <div className="rs-panel-head"><div><h2>{t(locale, "an.rev.waterfall")}</h2><p>{t(locale, "an.rev.waterfallSub")}</p></div></div>
            <ol className="an-waterfall">
              {r.waterfall.map((w) => (
                <li key={w.key} className={`an-wf an-wf-${w.sign}`}>
                  <span className="an-wf-sign" aria-hidden>{w.sign === "plus" ? "" : w.sign === "minus" ? "−" : w.sign === "equals" ? "=" : "→"}</span>
                  <span className="an-wf-label"><DefName metricKey={w.key} locale={locale} /> <span className="sr-only">{t(locale, `an.sign.${w.sign}`)}</span> <EvidenceOf m={w.metric} locale={locale} /></span>
                  <span className="an-wf-value gt-num"><MetricValue m={w.metric} unit="usd" locale={locale} /></span>
                </li>
              ))}
            </ol>
            <div className="rs-panel-foot">{t(locale, "an.rev.waterfallNote")}</div>
          </section>

          <div className="rs-grid an-grid">
            <section className="rs-panel">
              <div className="rs-panel-head"><div><h2>{t(locale, "an.rev.platformLtv")}</h2><p>{t(locale, r.platform_ltv.definition_text_key)}</p></div></div>
              <dl className="an-kv">
                <div><dt><DefName metricKey="platform_ltv" locale={locale} /> <EvidenceOf m={r.platform_ltv} locale={locale} /></dt><dd><MetricValue m={r.platform_ltv} unit="usd_per_user" locale={locale} /></dd></div>
                {r.platform_ltv.period_key && <div><dt>{t(locale, "an.rev.ltvPeriod")}</dt><dd>{r.platform_ltv.period_key}</dd></div>}
              </dl>
              <div className="rs-panel-foot">{t(locale, "an.rev.platformLtvNote")}</div>
            </section>
            <section className="rs-panel">
              <div className="rs-panel-head"><div><h2>{t(locale, "an.rev.cohorts")}</h2><p>{t(locale, "an.rev.cohortsSub")}</p></div></div>
              <div className="an-cohorts">
                {r.cohorts.map((c) => (
                  <div key={c.horizon} className="an-cohort">
                    <h3>D{c.horizon} <EvidenceTag evidence="inferred" locale={locale} />{!c.mature && <span className="state state-collecting_history">{t(locale, "an.cohort.immature")}</span>}</h3>
                    <strong className="an-cohort-value"><MetricValue m={c.metric} unit="usd_per_user" locale={locale} /></strong>
                    <dl className="an-kv an-kv-tight">
                      <div><dt>{t(locale, "an.cohort.formula")}</dt><dd><code>{c.formula}</code></dd></div>
                      <div><dt>{t(locale, "an.cohort.entry")}</dt><dd>{t(locale, c.entry_definition_key)}</dd></div>
                      <div><dt>{t(locale, "an.cohort.window")}</dt><dd>{c.entry_from ? `${c.entry_from} → ${c.entry_to}` : "–"}</dd></div>
                      <div><dt>{t(locale, "an.cohort.size")}</dt><dd>{c.initial_users == null ? "–" : c.initial_users.toLocaleString("en-US")} · {t(locale, "an.cohort.days", { n: c.eligible_cohorts })}</dd></div>
                      <div><dt>{t(locale, "an.cohort.elapsed")}</dt><dd>{c.elapsed_days_min == null ? t(locale, "an.cohort.notReached", { n: c.horizon }) : t(locale, "an.cohort.elapsedDays", { n: c.elapsed_days_min })}</dd></div>
                      <div><dt>{t(locale, "an.cohort.basis")}</dt><dd>{t(locale, `an.cohort.basis.${c.basis}`)}</dd></div>
                    </dl>
                    {c.breakdown.length > 0 && (
                      <table className="an-table an-table-sm">
                        <caption className="sr-only">{t(locale, "an.cohort.byRegion")}</caption>
                        <thead><tr><th scope="col">{t(locale, "an.cohort.region")}</th><th scope="col" className="gt-num">{t(locale, "an.cohort.users")}</th><th scope="col" className="gt-num">D{c.horizon}</th></tr></thead>
                        <tbody>{c.breakdown.map((b) => <tr key={b.key}><th scope="row">{b.label}</th><td className="gt-num">{b.users.toLocaleString("en-US")}</td><td className="gt-num">{b.value == null ? "–" : `${fmtUsd(b.value)}/u`}</td></tr>)}</tbody>
                      </table>
                    )}
                  </div>
                ))}
              </div>
              <div className="rs-panel-foot">{t(locale, "an.rev.cohortsNote")}</div>
            </section>
          </div>
        </>
      )}
    </AnalyticsFrame>
  );
}
