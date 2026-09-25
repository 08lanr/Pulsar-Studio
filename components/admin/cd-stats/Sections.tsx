import { HistView, type CompareRow } from "@/components/admin/cd-stats/Dash";
import { KpiCard, TrendChart } from "@/components/admin/cd-stats/Overview";
import { change, fmtShare, fmtUsdCents, histSummary, KPI_METRICS, kpiValue, share, type DashTotals, type KpiMetric } from "@/lib/crazydramas/stats-summary";
import { t, type Locale } from "@/lib/i18n";

// Sections both CrazyDramas stats pages show (the dashboard, and one series): the six headline numbers with
// the chart of the picked one, and the Playback tab. Server components.

const n0 = (v: number) => v.toLocaleString("en-US");

/** The six headline numbers (visitors, started / finished episode 1, episode 2, buyers, revenue) against the period before, and one chart of the picked number per day. */
export function HeadlineNumbers({
  totals,
  before,
  days,
  metric,
  hrefFor,
  vs,
  locale,
}: {
  totals: DashTotals;
  before: DashTotals | null;
  days: { day: string; totals: DashTotals }[];
  metric: KpiMetric;
  hrefFor: (m: KpiMetric) => string;
  vs: string | null;
  locale: Locale;
}) {
  const fmt = (m: KpiMetric, v: number) => (m === "revenue" ? fmtUsdCents(v) : n0(v));
  return (
    <>
      <div className="cdx-kpis">
        {KPI_METRICS.map((m) => (
          <KpiCard
            key={m}
            label={t(locale, `cdx.kpi.${m}`)}
            info={t(locale, `cdx.info.${m}`)}
            value={fmt(m, kpiValue(totals, m))}
            sub={m === "visitors" || m === "revenue" ? null : fmtShare(share(kpiValue(totals, m), totals.opened))}
            change={before ? change(kpiValue(totals, m), kpiValue(before, m)) : null}
            vs={vs}
            spark={days.map((d) => kpiValue(d.totals, m))}
            href={hrefFor(m)}
            on={m === metric}
          />
        ))}
      </div>
      <section className="rs-panel cdx-card">
        <TrendChart
          title={t(locale, "cdx.chart", { metric: t(locale, `cdx.kpi.${metric}`) })}
          points={days.map((d) => ({ day: d.day, value: kpiValue(d.totals, metric) }))}
          cents={metric === "revenue"}
          tableLabel={t(locale, "cdx.numbers")}
        />
      </section>
    </>
  );
}

/** Does the video start: pages never on screen, no video, waits, the first frame, restarts, errors; the three timings; by phone. */
export function PlaybackSection({ totals, before, vs, phones, edges, locale }: { totals: DashTotals; before: DashTotals | null; vs: string | null; phones: CompareRow[]; edges: number[]; locale: Locale }) {
  const landed = totals.opened + totals.unseen;
  const frame = histSummary(totals.start_hist, edges);
  const ch = (a: (x: DashTotals) => number) => (before ? change(a(totals), a(before)) : null);
  const median = (hist: number[]) => histSummary(hist, edges).median ?? "–";
  return (
    <>
      <div className="cdx-kpis">
        <KpiCard label={t(locale, "cdx.play.unseen")} info={t(locale, "cdx.play.unseenInfo")} value={n0(totals.unseen)} sub={t(locale, "cdx.play.ofLanded", { share: fmtShare(share(totals.unseen, landed)) })} change={ch((x) => x.unseen)} vs={vs} upIsGood={false} />
        <KpiCard label={t(locale, "cdx.play.noVideo")} info={t(locale, "cdx.play.noVideoInfo")} value={n0(totals.never_started)} sub={t(locale, "cdx.ofVisitors", { share: fmtShare(share(totals.never_started, totals.opened)) })} change={ch((x) => x.never_started)} vs={vs} upIsGood={false} />
        <KpiCard label={t(locale, "cdx.play.left")} info={t(locale, "cdx.play.leftInfo")} value={n0(totals.left_waiting)} sub={totals.left_waiting ? t(locale, "cdx.play.avgWait", { s: Math.round(totals.left_waiting_seconds / totals.left_waiting) }) : null} />
        <KpiCard label={t(locale, "cdx.play.frame")} info={t(locale, "cdx.play.frameInfo")} value={frame.median ?? "–"} sub={frame.n ? t(locale, "cdx.play.measured", { n: n0(frame.n) }) : null} />
        <KpiCard label={t(locale, "cdx.play.restarts")} info={t(locale, "cdx.play.restartsInfo")} value={n0(totals.restarted)} sub={totals.restarted ? t(locale, "cdx.play.muted", { n: n0(totals.restarted_muted) }) : null} />
        <KpiCard label={t(locale, "cdx.play.errors")} info={t(locale, "cdx.play.errorsInfo")} value={n0(totals.errors)} sub={t(locale, "cdx.ofVisitors", { share: fmtShare(share(totals.errors, totals.opened)) })} />
      </div>
      <div className="cdx-grid3">
        <section className="rs-panel cdx-card">
          <HistView title={t(locale, "cdx.hist.load")} hist={totals.load_hist} edges={edges} locale={locale} />
        </section>
        <section className="rs-panel cdx-card">
          <HistView title={t(locale, "cdx.hist.frame")} hist={totals.start_hist} edges={edges} locale={locale} />
        </section>
        <section className="rs-panel cdx-card">
          <HistView title={t(locale, "cdx.hist.wait")} hist={totals.wait_hist} edges={edges} locale={locale} />
        </section>
      </div>
      <section className="rs-panel cdx-card">
        <div className="cdx-card-head">
          <h2>{t(locale, "cdx.phones")}</h2>
        </div>
        <div className="an-scroll" tabIndex={0} role="region" aria-label={t(locale, "cdx.phones")}>
          <table className="an-table cds-table cdx-table">
            <thead>
              <tr>
                <th scope="col" />
                <th scope="col" className="gt-num">{t(locale, "cdx.col.landed")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdx.col.unseen")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdx.kpi.visitors")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdx.kpi.started")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdx.col.frame")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdx.col.sound")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdx.col.restarts")}</th>
              </tr>
            </thead>
            <tbody>
              {phones.map((g) => {
                const x = g.totals;
                const l = x.opened + x.unseen;
                return (
                  <tr key={g.key}>
                    <th scope="row" className="cds-title">{g.href ? <a href={g.href}>{g.name}</a> : g.name}</th>
                    <td className="gt-num">{n0(l)}</td>
                    <td className="gt-num">{fmtShare(share(x.unseen, l))}</td>
                    <td className="gt-num">{n0(x.opened)}</td>
                    <td className="gt-num">{fmtShare(share(x.started_ep1, x.opened))}</td>
                    <td className="gt-num">{median(x.start_hist)}</td>
                    <td className="gt-num">{x.ep1_sound_known ? fmtShare(share(x.ep1_sound_on, x.ep1_sound_known)) : "–"}</td>
                    <td className="gt-num">{n0(x.restarted)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
