import "@/app/crazydramas-stats.css";
import { adminLocale, staffSession } from "@/components/admin/server";
import { RangeTabs, ReadFailure } from "@/components/admin/cd-stats/Bits";
import { EpisodeChart, Ep1Chart } from "@/components/admin/cd-stats/Charts";
import CampaignTable from "@/components/admin/cd-stats/CampaignTable";
import { FunnelChart } from "@/components/admin/cd-stats/Dash";
import { KpiCard } from "@/components/admin/cd-stats/Overview";
import { HeadlineNumbers, PlaybackSection } from "@/components/admin/cd-stats/Sections";
import { SurveyView } from "@/components/admin/cd-stats/Tables";
import { crazydramasPublicUrl } from "@/lib/crazydramas";
import { readAdPeriod, readCrazydramasStats } from "@/lib/crazydramas/stats";
import {
  adSpendsFromRuns,
  biggestDrop,
  byDevice,
  campaignTable,
  chartSpan,
  dailyTotals,
  dashPath,
  dashRows,
  ep1Curve,
  episodeBars,
  fmtClock,
  fmtShare,
  fmtUsdCents,
  parseKpiMetric,
  parseStatsRange,
  prevSpan,
  rangeDays,
  seriesTotals,
  share,
  sumRows,
  type DashFilter,
  dropsFor,
  parsePlayEps,
} from "@/lib/crazydramas/stats-summary";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";

// /crazydramas/stats/[slug] — one series on crazydramas.com, staff only (decisions 2026-09-24 "CrazyDramas
// stats", 2026-09-25 "the stats dashboard, second cut"): the dashboard's layout for one series. Overview: the
// headline numbers, the path, the unlock screen, why they stop. Episode 1: how long people stay. Episodes:
// each episode's audience, the paywall marked. Playback and Ads as on the dashboard. Real people who first
// opened the series in the period; robots and the team left out.

export const dynamic = "force-dynamic";

const n0 = (v: number) => v.toLocaleString("en-US");
const TABS = ["overview", "ep1", "episodes", "playback", "ads"] as const;
type Tab = (typeof TABS)[number];
type Search = { range?: string; fresh?: string; tab?: string; metric?: string; eps?: string };

export default async function CrazydramasSeriesStatsPage({ params, searchParams }: { params: { slug: string }; searchParams: Search }) {
  const session = await staffSession();
  const locale = adminLocale();
  const slug = decodeURIComponent(params.slug);
  const range = parseStatsRange(searchParams.range);
  const tab: Tab = (TABS as readonly string[]).includes(searchParams.tab ?? "") ? (searchParams.tab as Tab) : "overview";
  const metric = parseKpiMetric(searchParams.metric);
  const [read, runs] = await Promise.all([readCrazydramasStats({ fresh: searchParams.fresh === "1" }), getData().listLaunchRuns(session).catch(() => [])]);
  const base = `/crazydramas/stats/${encodeURIComponent(slug)}`;
  const hrefWith = (patch: Partial<Search>) => {
    const q = new URLSearchParams();
    const next = { range, tab, metric, ...patch };
    for (const [k, v] of Object.entries(next)) if (v && !(k === "tab" && v === "overview") && !(k === "metric" && v === "visitors")) q.set(k, v);
    return `${base}?${q.toString()}`;
  };
  const back = (
    <a className="cds-back" href={`/crazydramas/stats?range=${range}&tab=series`}>
      ←&nbsp;{t(locale, "cds.back")}
    </a>
  );

  if (!read.ok) {
    return (
      <>
        {back}
        <ReadFailure read={read} locale={locale} />
      </>
    );
  }
  const report = read.report;
  const series = report.series.find((s) => s.slug === slug);
  if (!series) {
    return (
      <>
        {back}
        <p className="note note-warn" role="alert">{t(locale, "cds.d.notFound", { slug })}</p>
      </>
    );
  }

  const span = rangeDays(report, range);
  const prev = prevSpan(report, range);
  const vs = prev ? t(locale, `cdx.vs.${range}`) : null;
  const filter: DashFilter = { series: series.drama_id, device: null, source: null, country: null };
  const totals = sumRows(dashRows(report, span, filter));
  const before = prev ? sumRows(dashRows(report, prev, filter)) : null;
  // The cohorts carry what the source rows do not: episode 1 minute by minute, and every episode.
  const tot = seriesTotals(series, span);
  const len = tot.ep1_duration_s ? fmtClock(tot.ep1_duration_s) : null;
  const time = new Date(read.read_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });

  const head = (
    <>
      {back}
      <div className="page-head cdx-head">
        <div>
          <h1>{series.title}</h1>
          <p className="page-sub">
            {len ? t(locale, "cds.d.meta", { free: tot.free_episodes, count: tot.episode_count, len }) : t(locale, "cds.d.metaNoLen", { free: tot.free_episodes, count: tot.episode_count })}
            {" · "}
            <a href={crazydramasPublicUrl(slug)} target="_blank" rel="noreferrer">
              {t(locale, "cds.d.openSite")}&nbsp;↗
            </a>
          </p>
        </div>
        <RangeTabs range={range} hrefFor={(r) => hrefWith({ range: r })} locale={locale} />
      </div>
      <div className="cdx-bar">
        <span className="cdx-updated">
          {read.mode === "fake" ? t(locale, "cdx.testData") : t(locale, "cdx.updated", { time })} · <a href={`${hrefWith({})}&fresh=1`}>{t(locale, "cdx.refresh")}</a>
        </span>
      </div>
      <nav className="tabs cdx-tabs" aria-label={series.title}>
        {TABS.map((x) => (
          <a key={x} className={`tab${x === tab ? " on" : ""}`} aria-current={x === tab ? "page" : undefined} href={hrefWith({ tab: x })}>
            {t(locale, `cdx.stab.${x}`)}
          </a>
        ))}
      </nav>
    </>
  );

  if (totals.opened === 0 && tot.opened === 0) {
    return (
      <>
        {head}
        <p className="rs-empty">{t(locale, "cds.d.nobody")}</p>
      </>
    );
  }

  return (
    <>
      {head}
      {tab === "overview" && <Overview />}
      {tab === "ep1" && <EpisodeOne />}
      {tab === "episodes" && <Episodes />}
      {tab === "playback" && (
        <PlaybackSection
          totals={totals}
          before={before}
          vs={vs}
          phones={byDevice(dashRows(report, span, filter)).map((g) => ({ key: g.key, name: t(locale, `cds.dev.${g.key}`), href: `/crazydramas/stats?range=${range}&series=${encodeURIComponent(slug)}&device=${g.key}`, totals: g.totals }))}
          edges={report.timing_edges_s}
          eps={parsePlayEps(searchParams.eps)}
          epsHref={(e) => hrefWith({ eps: e === "1" ? undefined : e })}
          drops={dropsFor(report, span, filter, parsePlayEps(searchParams.eps))}
          titleOf={() => series.title}
          locale={locale}
        />
      )}
      {tab === "ads" && (await Ads())}
      <p className="cdx-foot">{t(locale, "cdx.robots", { n: n0(tot.robots) })}</p>
    </>
  );

  function Overview() {
    const steps = dashPath(totals);
    const rows = [
      { key: "saw", n: totals.paywall },
      { key: "watched", n: totals.paywall_watched },
      { key: "skipped", n: totals.paywall_skipped },
      { key: "tapped", n: totals.checkouts },
      { key: "paid", n: totals.buyers },
    ];
    return (
      <>
        <HeadlineNumbers totals={totals} before={before} days={dailyTotals(report, chartSpan(report, range), filter)} metric={metric} hrefFor={(m) => hrefWith({ metric: m })} vs={vs} locale={locale} />
        <div className="cdx-grid2">
          <section className="rs-panel cdx-card">
            <div className="cdx-card-head">
              <h2>{t(locale, "cdx.funnel.title")}</h2>
            </div>
            <FunnelChart steps={steps} drop={biggestDrop(steps)} locale={locale} />
          </section>
          <div>
            <section className="rs-panel cdx-card">
              <div className="cdx-card-head">
                <h2>{t(locale, "cdx.pay.title")}</h2>
                <span className="cdx-card-note">{fmtUsdCents(totals.revenue_cents)}</span>
              </div>
              <ul className="cdx-list">
                {rows.map((r) => (
                  <li key={r.key} className={r.key === "watched" || r.key === "skipped" ? "cdx-list-sub" : undefined}>
                    <span>{t(locale, `cdx.pay.${r.key}`)}</span>
                    <strong>{n0(r.n)}</strong>
                  </li>
                ))}
              </ul>
            </section>
            <section className="rs-panel cdx-card">
              <div className="cdx-card-head">
                <h2>{t(locale, "cdx.why")}</h2>
              </div>
              <div className="cdx-stack">
                <SurveyView kind="ep1_stop" shown={totals.survey_ep1_shown} answers={totals.survey_ep1} locale={locale} />
                <SurveyView kind="paywall_close" shown={totals.survey_paywall_shown} answers={totals.survey_paywall} locale={locale} />
              </div>
            </section>
          </div>
        </div>
      </>
    );
  }

  function EpisodeOne() {
    const curve = ep1Curve(tot, report.ep1_step_s);
    if (curve.started === 0) return <p className="rs-empty">{t(locale, "cds.ep1.none")}</p>;
    return (
      <>
        <div className="cdx-kpis cdx-kpis-4">
          <KpiCard label={t(locale, "cdx.kpi.started")} info={t(locale, "cdx.info.started")} value={n0(curve.started)} />
          <KpiCard
            label={t(locale, "cdx.ep1.gone", { s: curve.step_s })}
            info={t(locale, "cdx.ep1.goneInfo", { s: curve.step_s })}
            value={curve.gone_first_step === null ? "–" : fmtShare(curve.gone_first_step)}
          />
          <KpiCard label={t(locale, "cdx.ep1.half")} info={t(locale, "cdx.ep1.halfInfo")} value={curve.half_gone_at === null ? t(locale, "cdx.ep1.never") : fmtClock(curve.half_gone_at)} />
          <KpiCard
            label={t(locale, "cdx.ep1.avg")}
            info={t(locale, "cdx.ep1.avgInfo")}
            value={curve.avg_seconds === null ? "–" : fmtClock(curve.avg_seconds)}
            sub={len ? t(locale, "cdx.ep1.of", { len }) : null}
          />
        </div>
        <section className="rs-panel cdx-card">
          <Ep1Chart curve={curve} locale={locale} />
          <p className="cdx-note">{tot.ep1_sound_known > 0 ? t(locale, "cdx.ep1.sound", { share: fmtShare(share(tot.ep1_sound_on, tot.ep1_sound_known)) }) : ""}</p>
        </section>
      </>
    );
  }

  function Episodes() {
    const { bars, hidden_after } = episodeBars(tot);
    return (
      <section className="rs-panel cdx-card">
        <EpisodeChart bars={bars} freeEpisodes={tot.free_episodes} locale={locale} />
        {hidden_after !== null && <p className="cdx-note">{t(locale, "cds.eps.hidden", { n: hidden_after })}</p>}
      </section>
    );
  }

  async function Ads() {
    const adPeriod = await readAdPeriod(report, range, runs, searchParams.fresh === "1");
    return (
      <section className="rs-panel cdx-card">
        {adPeriod?.days && !adPeriod.days.ok && <p className="note note-warn">{t(locale, "cds.ads.daysFailed", { error: adPeriod.days.error })}</p>}
        <CampaignTable rows={campaignTable(report, adSpendsFromRuns(runs), series!.drama_id, adPeriod)} showTitle={false} caption={t(locale, "cdx.ads.campaigns")} />
      </section>
    );
  }
}
