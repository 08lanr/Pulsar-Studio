import { HistView, type CompareRow } from "@/components/admin/cd-stats/Dash";
import { KpiCard, TrendChart } from "@/components/admin/cd-stats/Overview";
import { DropsList, EndsCard, StartSplit } from "@/components/admin/cd-stats/Playback";
import { change, earlyExits, fmtShare, fmtUsdCents, histSummary, KPI_METRICS, kpiValue, PLAY_EPS, playOf, share, topKey, type DashTotals, type KpiMetric, type PlayEps } from "@/lib/crazydramas/stats-summary";
import type { CdStatsDrop, CdStatsPlayback } from "@/lib/crazydramas/stats-types";
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

/**
 * The Playback tab (2026-09-25, the playback report): why views ended early, six numbers on how playing went,
 * where the start's time goes, the first frame and the wait before leaving, the phones side by side, and the
 * latest early endings one by one. Episode 1 or the later episodes, by a switch.
 */
export function PlaybackSection({
  totals,
  before,
  vs,
  phones,
  edges,
  eps,
  epsHref,
  drops,
  titleOf,
  locale,
}: {
  totals: DashTotals;
  before: DashTotals | null;
  vs: string | null;
  phones: CompareRow[];
  edges: number[];
  eps: PlayEps;
  epsHref: (e: PlayEps) => string;
  drops: CdStatsDrop[];
  titleOf: (id: string) => string;
  locale: Locale;
}) {
  const p = playOf(totals, eps);
  const pb = before ? playOf(before, eps) : null;
  const exits = earlyExits(p);
  const landed = totals.opened + totals.unseen;
  // The first frame from the report; before it (and where it has no view yet), from the player's own start.
  const frameHist = p.started ? p.start_hist : eps === "1" ? totals.start_hist : [];
  const frame = histSummary(frameHist, edges);
  const ch = (now: number | null, then: number | null) => (now === null || then === null ? null : change(now, then));
  const rate = (x: CdStatsPlayback, n: number) => share(n, x.started || x.views);
  const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;
  const median = (hist: number[]) => histSummary(hist, edges).median ?? "–";
  return (
    <>
      <nav className="seg cdp-eps" aria-label={t(locale, "cdp.eps.label")}>
        {PLAY_EPS.map((e) => (
          <a key={e} className={`seg-btn${e === eps ? " on" : ""}`} aria-current={e === eps ? "true" : undefined} href={epsHref(e)}>
            {t(locale, `cdp.eps.${e}`)}
          </a>
        ))}
      </nav>
      <section className="rs-panel cdx-card">
        <div className="cdx-card-head">
          <h2 title={t(locale, "cdp.ends.info")}>
            {t(locale, eps === "1" ? "cdp.ends.title1" : "cdp.ends.titleLater")} <span className="cdx-i" aria-hidden>ⓘ</span>
          </h2>
          {exits.total > 0 && <span className="cdx-muted">{t(locale, "cdp.ends.of", { n: n0(exits.total), views: n0(p.views) })}</span>}
        </div>
        <EndsCard exits={exits} locale={locale} />
      </section>
      <div className="cdx-kpis">
        <KpiCard label={t(locale, "cdx.play.frame")} info={t(locale, "cdp.info.frame")} value={frame.median ?? "–"} sub={frame.n ? t(locale, "cdx.play.measured", { n: n0(frame.n) }) : null} />
        <KpiCard
          label={t(locale, "cdp.kpi.freezes")}
          info={t(locale, "cdp.info.freezes")}
          value={fmtShare(rate(p, p.stall_views))}
          sub={p.stalls ? t(locale, "cdp.kpi.freezeLen", { s: (p.stall_ms / p.stalls / 1000).toFixed(1) }) : null}
          change={pb ? ch(rate(p, p.stall_views), rate(pb, pb.stall_views)) : null}
          vs={vs}
          upIsGood={false}
        />
        <KpiCard
          label={t(locale, "cdp.kpi.phone")}
          info={t(locale, "cdp.info.phone")}
          value={fmtShare(rate(p, p.phone_pause_views))}
          sub={p.phone_pauses ? t(locale, "cdp.kpi.withSound", { n: n0(p.phone_pauses_sound), all: n0(p.phone_pauses) }) : null}
          change={pb ? ch(rate(p, p.phone_pause_views), rate(pb, pb.phone_pause_views)) : null}
          vs={vs}
          upIsGood={false}
        />
        {eps === "1" ? (
          <>
            <KpiCard label={t(locale, "cdx.play.unseen")} info={t(locale, "cdx.play.unseenInfo")} value={n0(totals.unseen)} sub={t(locale, "cdx.play.ofLanded", { share: fmtShare(share(totals.unseen, landed)) })} />
            <KpiCard label={t(locale, "cdx.play.left")} info={t(locale, "cdx.play.leftInfo")} value={n0(totals.left_waiting)} sub={totals.left_waiting ? t(locale, "cdx.play.avgWait", { s: Math.round(totals.left_waiting_seconds / totals.left_waiting) }) : null} />
          </>
        ) : (
          <>
            <KpiCard label={t(locale, "cdp.kpi.views")} info={t(locale, "cdp.info.views")} value={n0(p.views)} />
            <KpiCard label={t(locale, "cdp.kpi.watched")} info={t(locale, "cdp.info.watched")} value={hours(p.watched_ms)} />
          </>
        )}
        <KpiCard
          label={t(locale, "cdx.play.errors")}
          info={t(locale, "cdx.play.errorsInfo")}
          value={n0(p.views ? p.error_views : eps === "1" ? totals.errors : 0)}
          sub={p.views ? fmtShare(share(p.error_views, p.views)) : null}
          upIsGood={false}
        />
      </div>
      {eps === "1" && (
        <section className="rs-panel cdx-card">
          <div className="cdx-card-head">
            <h2 title={t(locale, "cdp.split.info")}>
              {t(locale, "cdp.split.title")} <span className="cdx-i" aria-hidden>ⓘ</span>
            </h2>
          </div>
          <StartSplit rows={[{ key: "all", name: t(locale, "cdp.split.all"), play: p }, ...phones.map((g) => ({ key: g.key, name: g.name, play: g.totals.play_ep1 }))]} locale={locale} />
        </section>
      )}
      <div className="cdx-grid2">
        <section className="rs-panel cdx-card">
          <HistView title={t(locale, "cdx.hist.frame")} hist={frameHist} edges={edges} locale={locale} />
        </section>
        {eps === "1" && (
          <section className="rs-panel cdx-card">
            <HistView title={t(locale, "cdx.hist.wait")} hist={totals.wait_hist} edges={edges} locale={locale} />
          </section>
        )}
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
                <th scope="col" className="gt-num">{t(locale, "cdp.kpi.views")}</th>
                <th scope="col" className="gt-num" title={t(locale, "cdp.ends.info")}>{t(locale, "cdp.col.wrong")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdx.col.frame")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdp.col.freezes")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdp.col.phonePaused")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdx.col.sound")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdp.col.quality")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdp.col.conn")}</th>
              </tr>
            </thead>
            <tbody>
              {phones.map((g) => {
                const x = playOf(g.totals, eps);
                const wrong = earlyExits(x).families.problem;
                return (
                  <tr key={g.key}>
                    <th scope="row" className="cds-title">{g.href ? <a href={g.href}>{g.name}</a> : g.name}</th>
                    <td className="gt-num">{n0(x.views)}</td>
                    <td className="gt-num">{fmtShare(share(wrong, x.views))}</td>
                    <td className="gt-num">{median(x.started ? x.start_hist : eps === "1" ? g.totals.start_hist : [])}</td>
                    <td className="gt-num">{fmtShare(rate(x, x.stall_views))}</td>
                    <td className="gt-num">{fmtShare(rate(x, x.phone_pause_views))}</td>
                    <td className="gt-num">{g.totals.ep1_sound_known ? fmtShare(share(g.totals.ep1_sound_on, g.totals.ep1_sound_known)) : "–"}</td>
                    <td className="gt-num">{topKey(x.quality_ms) ?? "–"}</td>
                    <td className="gt-num">{topKey(x.conn) ?? "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="rs-panel cdx-card" id="drops">
        <div className="cdx-card-head">
          <h2 title={t(locale, "cdp.drops.info")}>
            {t(locale, "cdp.drops.title")} <span className="cdx-i" aria-hidden>ⓘ</span>
          </h2>
          {drops.length > 0 && <span className="cdx-muted">{t(locale, "cdp.drops.latest", { n: n0(Math.min(drops.length, DROPS_SHOWN)) })}</span>}
        </div>
        <DropsList drops={drops.slice(0, DROPS_SHOWN)} titleOf={titleOf} locale={locale} />
      </section>
    </>
  );
}

/** Early endings listed one by one. */
const DROPS_SHOWN = 20;
