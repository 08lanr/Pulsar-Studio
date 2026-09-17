import ReportActions from "@/components/producer/ReportActions";
import { titleName } from "@/components/producer/TitleShell";
import { portalSession, producerLocale } from "@/components/producer/server";
import { StateChip, fmtUsd } from "@/components/producer/analytics/bits";
import { BandPill, ScoreDial } from "@/components/producer/research/workspace-ui";
import { MetricLabel, Prominence, TropeChip, fmtCount, fmtPct, platformName } from "@/components/producer/research/ui";
import { adTextOf } from "@/lib/clips/creatives";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { ASSESSMENT_VERSION, BENCHMARK } from "@/lib/research/assessment";
import { readResults } from "@/lib/research/results";
import { loadTitleWorkspace } from "@/lib/research/title-workspace";

// /producer/titles/[id]/report — the one-page outbound report (decision
// 2026-09-15): what the workspace already says about a title, on one sheet a
// producer saves as a PDF and forwards inside their company. Read-only,
// assembled from the same reads as the sections it summarizes, rendered on
// request and never stored (the exports rule). Every number keeps its
// provenance: demo labels, data-through dates and the evidence-label footer.

export const dynamic = "force-dynamic";

export default async function TitleReport({ params }: { params: { id: string } }) {
  const session = await portalSession(`/producer/titles/${params.id}/report`);
  const locale = producerLocale();
  const data = getData();
  const w = await loadTitleWorkspace(session, params.id);
  const company = await data.getCompanyIdentity(session);
  // The measured round: the newest campaign that has reported results. A
  // newer draft round must not erase the measured table, and a campaign
  // that has not reported yet is "no results yet", never "no campaign".
  const measured = new Set(w.title.results.map((r) => r.campaign_id));
  const resultCampaign = [...w.title.campaigns].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).find((c) => measured.has(c.id)) ?? null;
  const detail = resultCampaign ? await data.getPromoCampaign(session, resultCampaign.id) : null;
  const reading = detail && detail.results.length ? readResults(detail.results, detail.creatives, BENCHMARK) : null;
  const a = w.title.assessment;
  const episodes = w.detail.episodes;
  const withVideo = episodes.filter((e) => e.has_video).length;
  const finalized = episodes.filter((e) => e.status === "approved").length;
  const { primary, secondary, lang } = titleName(locale, w.detail.title.name_zh, w.detail.title.name_en);
  const today = new Date().toISOString().slice(0, 10);
  const companyName = company ? (locale === "en" ? company.name_en || company.name_zh : company.name_zh) : null;
  const winnerText = reading?.winner?.creative ? adTextOf(reading.winner.creative) : null;

  return (
    <div className="tw-page report-page">
      <nav className="studio-crumbs report-no-print" aria-label={t(locale, "v3.breadcrumbs")}>
        <a href="/producer/titles">{t(locale, "ws.nav.catalog")}</a>
        <span aria-hidden>›</span>
        <a href={`/producer/titles/${params.id}`} lang={lang}>{primary}</a>
        <span aria-hidden>›</span>
        <span>{t(locale, "rp.crumb")}</span>
      </nav>
      <ReportActions />

      <article className="report-sheet">
        <header className="report-head">
          <div>
            <span className="report-kicker">Pulsar Studio · {t(locale, "rp.kicker")}</span>
            <h1 lang={lang}>{primary}</h1>
            {secondary && <p className="report-secondary" lang={lang === "en" ? "zh-CN" : "en"}>{secondary}</p>}
            <p className="report-meta">
              {companyName && <span lang={locale === "en" && company?.name_en ? "en" : "zh-CN"}>{companyName} · </span>}
              {t(locale, "rp.generated", { date: today })}
            </p>
          </div>
          <div className="report-score">
            <ScoreDial score={a.score} band={a.band} locale={locale} />
            <BandPill band={a.band} locale={locale} />
          </div>
        </header>

        <section className="report-section">
          <h2>{t(locale, "tw.nav.preparation")}</h2>
          <table className="report-table report-components">
            <tbody>
              {a.components.map((c) => (
                <tr key={c.key}>
                  <th scope="row">{t(locale, `ws.component.${c.key}`)}</th>
                  <td className="report-track">
                    <div className="report-track-bar"><span style={{ width: `${c.max ? Math.round((c.points / c.max) * 100) : 0}%` }} /></div>
                  </td>
                  <td className="report-pts">{t(locale, "ws.assess.pointsOf", { points: c.points, max: c.max })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="report-note">
            {t(locale, "ws.score.note", { version: ASSESSMENT_VERSION })}
            {a.observed_at && <> · {t(locale, "ws.assess.observed", { date: a.observed_at })}</>}
          </p>
        </section>

        <section className="report-section">
          <h2>{t(locale, "rp.results")}</h2>
          {detail && reading ? (
            <>
              <p className="report-line">
                <b>{detail.campaign.name}</b>
                {detail.campaign.experiment && <> · {t(locale, "rp.budget")} ${detail.campaign.experiment.budget_usd}</>}
                {reading.window && <> · {reading.window.start} → {reading.window.end}</>}
              </p>
              <table className="report-table report-results">
                <thead>
                  <tr>
                    <th>{t(locale, "rd.col.ad")}</th>
                    <th>{t(locale, "rd.col.hold")} <small>≥ {Math.round(BENCHMARK.hook_hold_rate * 100)}%</small></th>
                    <th>{t(locale, "rd.col.ctr")} <small>≥ {(BENCHMARK.ctr * 100).toFixed(1)}%</small></th>
                    <th className="report-num">{t(locale, "rd.col.spend")}</th>
                  </tr>
                </thead>
                <tbody>
                  {reading.rows.map((r, i) => (
                    <tr key={i} className={reading.winner === r ? "is-winner" : undefined}>
                      <td>
                        {r.ad_number != null ? t(locale, "rp.adN", { n: r.ad_number }) : "—"}
                        {r.creative && <span className="report-ad-text" lang="en">{adTextOf(r.creative)}</span>}
                      </td>
                      <td>{r.verdict === "no_impressions" ? "—" : <><b className={r.hold_met ? "delta-up" : "delta-down"}>{fmtPct(r.result.hook_hold_rate, 0)}</b> <small>{r.hold_met ? "✓" : "✗"}</small></>}</td>
                      <td>{r.ctr == null ? "—" : <><b className={r.ctr_met ? "delta-up" : "delta-down"}>{fmtPct(r.ctr, 2)}</b> <small>{r.ctr_met ? "✓" : "✗"}</small></>}</td>
                      <td className="report-num">{fmtUsd(r.result.spend_usd, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {reading.winner ? (
                <p className="report-winner">
                  ✓ {t(locale, "rp.winner", { n: reading.winner.ad_number ?? "—" })}
                  {winnerText && <> · <q lang="en">{winnerText}</q></>}
                </p>
              ) : (
                <p className="report-winner">✗ {t(locale, "rd.noWinner")}</p>
              )}
              {reading.demo_only && <p className="tw-demo">{t(locale, "rd.sourceDemo")}</p>}
            </>
          ) : w.ads.campaign ? (
            <p className="report-line">
              <b>{w.ads.campaign.name}</b>
              {w.ads.flow && <> · {t(locale, `workflow.step.${w.ads.flow.step}`)}</>} · {t(locale, "rp.pending")}
            </p>
          ) : (
            <p className="report-empty">{t(locale, "tw.ads.noneYet")}</p>
          )}
        </section>

        <div className="report-pair">
        <section className="report-section">
          <h2>{t(locale, "tw.nav.tiktok")}</h2>
          {w.tiktok && w.tiktok.revenue.value != null ? (
            <>
              <dl className="tw-facts report-facts">
                <div><dt>{t(locale, `an.basis.${w.tiktok.revenue.basis}`)} · {t(locale, "an.range.30d")}</dt><dd className="tw-big">{fmtUsd(w.tiktok.revenue.value, 0)}</dd></div>
                <div><dt>{t(locale, "an.catalog.col.viewers")}</dt><dd>{w.tiktok.viewers.value != null ? fmtCount(w.tiktok.viewers.value) : "—"}</dd></div>
                <div><dt>{t(locale, "an.catalog.col.conversion")}</dt><dd>{w.tiktok.payer_conversion.value != null ? fmtPct(w.tiktok.payer_conversion.value, 2) : "—"}</dd></div>
              </dl>
              <p className="report-note">
                {w.tiktok.freshness.data_through && t(locale, "an.dataThrough", { date: w.tiktok.freshness.data_through, lag: w.tiktok.freshness.lag_days ?? 0 })}
                {w.tiktok.source === "demo" && <> · {t(locale, "an.demo.chip")}</>}
              </p>
            </>
          ) : (
            <p className="report-empty">
              <StateChip state={w.tiktok?.analytics_state ?? "needs_listing_link"} locale={locale} />
              {t(locale, w.platform === "not_linked" ? "tw.tiktok.notLinked" : w.platform === "awaiting_data" ? "tw.tiktok.awaiting" : "tw.tiktok.noValue")}
            </p>
          )}
        </section>

        <section className="report-section">
          <h2>{t(locale, "tw.nav.materials")}</h2>
          <dl className="tw-facts report-facts">
            <div><dt>{t(locale, "v3.title.episodes")}</dt><dd className="tw-big">{episodes.length}<small> / {w.detail.title.episode_count}</small></dd></div>
            <div><dt>{t(locale, "ws.catalog.col.video")}</dt><dd>{withVideo > 0 ? t(locale, "ws.catalog.video.n", { n: withVideo }) : t(locale, "ws.catalog.video.none")}</dd></div>
            <div><dt>{t(locale, "ws.catalog.col.subs")}</dt><dd>{finalized > 0 ? t(locale, "ws.catalog.subs.approved", { n: finalized }) : w.title.summary.percent_adapted > 0 ? t(locale, "redesign.catalog.partialSubs", { pct: w.title.summary.percent_adapted }) : t(locale, "ws.catalog.subs.none")}</dd></div>
          </dl>
        </section>
        </div>

        <section className="report-section">
          <h2>{t(locale, "ws.assess.comparables")}</h2>
          {a.comparables.length === 0 ? (
            <p className="report-empty">{t(locale, "research.mine.untagged")}</p>
          ) : (
            <ul className="report-list">
              {a.comparables.slice(0, 4).map((c) => (
                <li key={c.key}>
                  <span className="report-comp-name" lang="en">{c.title}</span>
                  <span className="report-comp-platform">{platformName(c.platform)}</span>
                  <span className="rs-tropes">{c.overlap.slice(0, 3).map((id) => <TropeChip key={id} id={id} locale={locale} />)}</span>
                  <span className="spacer" />
                  <MetricLabel metric="prominence" locale={locale}><Prominence value={c.prominence} locale={locale} /></MetricLabel>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="report-section">
          <h2>{t(locale, "tw.prep.nextSteps")}</h2>
          <ol className="report-next">{a.next.slice(0, 3).map((k) => <li key={k}>{t(locale, k)}</li>)}</ol>
        </section>

        <footer className="report-foot">
          <p>{t(locale, "rp.footer")}</p>
        </footer>
      </article>
    </div>
  );
}
