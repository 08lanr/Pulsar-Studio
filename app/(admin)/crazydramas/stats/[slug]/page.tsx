import "@/app/crazydramas-stats.css";
import { adminLocale, staffSession } from "@/components/admin/server";
import { Definitions, RangeTabs, ReadFailure, ReadLine } from "@/components/admin/cd-stats/Bits";
import { EpisodeChart, Ep1Chart } from "@/components/admin/cd-stats/Charts";
import CampaignTable from "@/components/admin/cd-stats/CampaignTable";
import { DeviceTableView, SurveyView } from "@/components/admin/cd-stats/Tables";
import { crazydramasPublicUrl } from "@/lib/crazydramas";
import { readCrazydramasStats } from "@/lib/crazydramas/stats";
import { adSpendsFromRuns, campaignTable, deviceTable, ep1Curve, episodeBars, fmtClock, fmtShare, fmtUsdCents, parseStatsRange, rangeDays, seriesTotals, share } from "@/lib/crazydramas/stats-summary";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";

// /crazydramas/stats/[slug] — one series on crazydramas.com, staff only
// (decision 2026-09-24, "CrazyDramas stats"): the path from opening to
// paying, how long people stay in episode 1, every episode's audience with
// the paywall marked, how people reached the paywall, what happened before
// the video started (and on which phones), what the one-tap questions heard,
// and which ads sent the viewers. Real people who first opened the series in
// the period; robots and the team left out.

export const dynamic = "force-dynamic";

const n0 = (v: number) => v.toLocaleString("en-US");

export default async function CrazydramasSeriesStatsPage({ params, searchParams }: { params: { slug: string }; searchParams: { range?: string; fresh?: string } }) {
  const session = await staffSession();
  const locale = adminLocale();
  const slug = decodeURIComponent(params.slug);
  const range = parseStatsRange(searchParams.range);
  const [read, runs] = await Promise.all([readCrazydramasStats({ fresh: searchParams.fresh === "1" }), getData().listLaunchRuns(session).catch(() => [])]);
  const base = `/crazydramas/stats/${encodeURIComponent(slug)}`;
  const hrefFor = (r: string) => `${base}?range=${r}`;
  const back = <a className="cds-back" href={`/crazydramas/stats?range=${range}`}>←&nbsp;{t(locale, "cds.back")}</a>;

  if (!read.ok) {
    return (
      <>
        {back}
        <ReadFailure read={read} locale={locale} />
      </>
    );
  }
  const series = read.report.series.find((s) => s.slug === slug);
  if (!series) {
    return (
      <>
        {back}
        <p className="note note-warn" role="alert">{t(locale, "cds.d.notFound", { slug })}</p>
      </>
    );
  }

  const span = rangeDays(read.report, range);
  const tot = seriesTotals(series, span);
  const curve = ep1Curve(tot, read.report.ep1_step_s);
  const { bars, hidden_after } = episodeBars(tot);
  const len = tot.ep1_duration_s ? fmtClock(tot.ep1_duration_s) : null;
  const w2 = tot.episodes_watched[1] ?? 0;
  const w3 = tot.episodes_watched[2] ?? 0;
  const path = [
    { key: "opened", label: t(locale, "cds.path.opened"), n: tot.opened },
    { key: "played", label: t(locale, "cds.path.played"), n: tot.started_ep1 },
    { key: "finished", label: t(locale, "cds.path.finished"), n: tot.finished_ep1 },
    { key: "w2", label: t(locale, "cds.path.watched", { n: 2 }), n: w2 },
    { key: "w3", label: t(locale, "cds.path.watched", { n: 3 }), n: w3 },
    { key: "paywall", label: t(locale, "cds.path.paywall"), n: tot.paywall },
    { key: "checkout", label: t(locale, "cds.path.checkout"), n: tot.checkouts },
    { key: "paid", label: t(locale, "cds.path.paid"), n: tot.buyers },
  ];

  return (
    <>
      {back}
      <div className="page-head">
        <div>
          <h1>{series.title}</h1>
          <p className="page-sub">
            {len ? t(locale, "cds.d.meta", { free: tot.free_episodes, count: tot.episode_count, len }) : t(locale, "cds.d.metaNoLen", { free: tot.free_episodes, count: tot.episode_count })}
            {" · "}
            <a href={crazydramasPublicUrl(slug)} target="_blank" rel="noreferrer">{t(locale, "cds.d.openSite")}&nbsp;↗</a>
          </p>
        </div>
        <div className="cds-head-tools">
          <RangeTabs range={range} hrefFor={hrefFor} locale={locale} />
        </div>
      </div>
      <ReadLine read={read} span={span} refreshHref={`${hrefFor(range)}&fresh=1`} locale={locale} />

      {tot.opened === 0 ? (
        <p className="rs-empty">{t(locale, "cds.d.nobody")}</p>
      ) : (
        <>
          <section className="rs-panel cds-section" aria-labelledby="cds-path-h">
            <div className="rs-panel-head">
              <div>
                <h2 id="cds-path-h">{t(locale, "cds.path.title")}</h2>
                <p>{t(locale, "cds.path.sub")}</p>
              </div>
            </div>
            <div className="rs-panel-body">
              <ol className="cds-path">
                {path.map((s) => {
                  const sh = share(s.n, tot.opened) ?? 0;
                  return (
                    <li key={s.key}>
                      <span className="cds-path-label">{s.label}</span>
                      <span className="cds-path-track" aria-hidden>
                        <span className={`cds-path-fill${s.n === 0 ? " is-zero" : ""}`} style={{ width: `${Math.min(100, sh * 100)}%`, display: "block" }} />
                      </span>
                      <span className="cds-path-count">{n0(s.n)}</span>
                      <span className="cds-path-share">{fmtShare(share(s.n, tot.opened))}</span>
                    </li>
                  );
                })}
              </ol>
              <div className="cds-says">
                {tot.finished_ep1 > 0 && <p>{t(locale, "cds.path.ep2", { finished: n0(tot.finished_ep1), n: n0(w2), share: fmtShare(share(w2, tot.finished_ep1)) })}</p>}
                <p>{t(locale, "cds.path.returned", { n: n0(tot.returned), share: fmtShare(share(tot.returned, tot.opened)) })}</p>
                {tot.errors > 0 && <p>{t(locale, "cds.path.errors", { n: n0(tot.errors) })}</p>}
              </div>
            </div>
          </section>

          <section className="rs-panel cds-section" aria-labelledby="cds-before-h">
            <div className="rs-panel-head">
              <div>
                <h2 id="cds-before-h">{t(locale, "cds.before.title")}</h2>
                <p>{t(locale, "cds.before.sub")}</p>
              </div>
            </div>
            <div className="rs-panel-body">
              <div className="cds-says cds-says-top">
                <p>
                  <strong>{t(locale, "cds.before.neverStarted", { n: n0(tot.never_started), share: fmtShare(share(tot.never_started, tot.opened)) })}</strong>
                  {tot.left_waiting > 0 && <> {t(locale, "cds.before.waited", { n: n0(tot.left_waiting), avg: Math.round(tot.left_waiting_seconds / tot.left_waiting) })}</>}
                </p>
                {tot.no_events > 0 && <p>{t(locale, "cds.before.noEvents", { n: n0(tot.no_events), share: fmtShare(share(tot.no_events, tot.opened)) })}</p>}
              </div>
              <DeviceTableView rows={deviceTable(read.report, span, series.drama_id)} locale={locale} />
            </div>
          </section>

          <section className="rs-panel cds-section" aria-labelledby="cds-ep1-h">
            <div className="rs-panel-head">
              <div>
                <h2 id="cds-ep1-h">{t(locale, "cds.ep1.title")}</h2>
                <p>{t(locale, "cds.ep1.sub")}</p>
              </div>
            </div>
            <div className="rs-panel-body">
              {curve.started === 0 ? (
                <p className="rs-empty">{t(locale, "cds.ep1.none")}</p>
              ) : (
                <>
                  <div className="cds-says">
                    {curve.gone_first_step !== null && <p>{t(locale, "cds.ep1.goneFirst", { share: fmtShare(curve.gone_first_step), s: curve.step_s })}</p>}
                    <p>{curve.half_gone_at !== null ? t(locale, "cds.ep1.halfAt", { at: fmtClock(curve.half_gone_at) }) : t(locale, "cds.ep1.halfStay")}</p>
                    {curve.avg_seconds !== null && <p>{len ? t(locale, "cds.ep1.avg", { avg: fmtClock(curve.avg_seconds), len }) : t(locale, "cds.ep1.avgNoLen", { avg: fmtClock(curve.avg_seconds) })}</p>}
                    <p>{tot.ep1_sound_known > 0 ? t(locale, "cds.ep1.sound", { on: n0(tot.ep1_sound_on), known: n0(tot.ep1_sound_known), share: fmtShare(share(tot.ep1_sound_on, tot.ep1_sound_known)) }) : t(locale, "cds.ep1.soundUnknown")}</p>
                  </div>
                  <Ep1Chart curve={curve} locale={locale} />
                </>
              )}
            </div>
          </section>

          <section className="rs-panel cds-section" aria-labelledby="cds-eps-h">
            <div className="rs-panel-head">
              <div>
                <h2 id="cds-eps-h">{t(locale, "cds.eps.title")}</h2>
                <p>{t(locale, "cds.eps.sub")}</p>
              </div>
            </div>
            <div className="rs-panel-body">
              <EpisodeChart bars={bars} freeEpisodes={tot.free_episodes} locale={locale} />
              {hidden_after !== null && <p className="cds-foot">{t(locale, "cds.eps.hidden", { n: hidden_after })}</p>}
            </div>
          </section>

          <section className="rs-panel cds-section" aria-labelledby="cds-pay-h">
            <div className="rs-panel-head">
              <div>
                <h2 id="cds-pay-h">{t(locale, "cds.pay.title")}</h2>
              </div>
            </div>
            <div className="rs-panel-body">
              {tot.paywall === 0 && tot.buyers === 0 ? (
                <p className="rs-empty">{t(locale, "cds.pay.none")}</p>
              ) : (
                <div className="cds-says">
                  <p><strong>{t(locale, "cds.pay.summary", { n: n0(tot.paywall) })}</strong></p>
                  <p>{t(locale, "cds.pay.watched", { n: n0(tot.paywall_watched) })}</p>
                  <p>{t(locale, "cds.pay.skipped", { n: n0(tot.paywall_skipped) })}</p>
                  <p>{t(locale, "cds.pay.after", { checkouts: n0(tot.checkouts), buyers: n0(tot.buyers), revenue: fmtUsdCents(tot.revenue_cents) })}</p>
                </div>
              )}
            </div>
          </section>
        </>
      )}

      {tot.opened > 0 && (
        <>
          <section className="rs-panel cds-section" aria-labelledby="cds-why-h">
            <div className="rs-panel-head">
              <div>
                <h2 id="cds-why-h">{t(locale, "cds.survey.title")}</h2>
                <p>{t(locale, "cds.survey.sub")}</p>
              </div>
            </div>
            <div className="rs-panel-body cds-surveys">
              <SurveyView kind="ep1_stop" shown={tot.survey_ep1_shown} answers={tot.survey_ep1} locale={locale} />
              <SurveyView kind="paywall_close" shown={tot.survey_paywall_shown} answers={tot.survey_paywall} locale={locale} />
            </div>
          </section>

          <section className="rs-panel cds-section" aria-labelledby="cds-src-h">
            <div className="rs-panel-head">
              <div>
                <h2 id="cds-src-h">{t(locale, "cds.src.title")}</h2>
                <p>{t(locale, "cds.src.sub")}</p>
              </div>
            </div>
            <div className="rs-panel-body">
              <CampaignTable rows={campaignTable(read.report, adSpendsFromRuns(runs), series.drama_id)} showTitle={false} caption={t(locale, "cds.src.title")} />
            </div>
          </section>
        </>
      )}

      <p className="cds-foot">{t(locale, "cds.d.robots", { n: n0(tot.robots) })}</p>
      <Definitions robots={read.report.robots.people} locale={locale} />
    </>
  );
}
