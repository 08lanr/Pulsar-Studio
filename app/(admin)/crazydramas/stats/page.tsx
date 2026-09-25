import "@/app/crazydramas-stats.css";
import { adminLocale, staffSession } from "@/components/admin/server";
import { RangeTabs, ReadFailure } from "@/components/admin/cd-stats/Bits";
import CampaignTable from "@/components/admin/cd-stats/CampaignTable";
import { CompareTable, FunnelChart, type CompareRow } from "@/components/admin/cd-stats/Dash";
import FilterBar, { type FilterOptions } from "@/components/admin/cd-stats/FilterBar";
import { KpiCard, TrendChart } from "@/components/admin/cd-stats/Overview";
import { HeadlineNumbers, PlaybackSection } from "@/components/admin/cd-stats/Sections";
import { SurveyView } from "@/components/admin/cd-stats/Tables";
import TeamEditor from "@/components/admin/cd-stats/TeamEditor";
import TopPanel, { type TopTab } from "@/components/admin/cd-stats/TopPanel";
import { readAdPeriod, readCrazydramasStats } from "@/lib/crazydramas/stats";
import { readTeamList } from "@/lib/crazydramas/stats-team";
import {
  adSpendsFromRuns,
  audience,
  biggestDrop,
  byDevice,
  byPlace,
  campaignTable,
  change,
  chartSpan,
  countryName,
  DASH_TABS,
  dailyTotals,
  dashBy,
  dashPath,
  dashRows,
  DEVICE_ORDER,
  dropsFor,
  fmtShare,
  fmtUsdCents,
  histSummary,
  KPI_METRICS,
  kpiValue,
  NO_FILTER,
  NO_PLACE,
  notCounted,
  parseDashFilter,
  parseDashTab,
  parseKpiMetric,
  parsePlayEps,
  parseStatsRange,
  prevSpan,
  rangeDays,
  regionName,
  share,
  sourceKey,
  sourceOptions,
  sumRows,
  type DashFilter,
  type DashTotals,
  type KpiMetric,
} from "@/lib/crazydramas/stats-summary";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";

// /crazydramas/stats — viewing and money on crazydramas.com, staff only. Decisions 2026-09-24 "CrazyDramas
// stats" and 2026-09-25 "the stats dashboard, second cut" (Ruobin: "information overload ... no tabs ... 50% less
// text"): laid out the way analytics dashboards are (Plausible, YouTube Studio), a tab per question. Overview:
// six headline numbers against the period before, one chart of the picked number per day, where people drop,
// the top series / phones / sources / countries. Funnel: every step, and groups compared. Playback: does the
// video start. Series, Ads, Audience. One filter row (period, series, phone, source, country) scopes every tab;
// words that explain a number live in its ⓘ. The numbers are crazydramas' /api/studio/stats source rows
// (lib/crazydramas/stats.ts), summed in lib/crazydramas/stats-summary.ts.

export const dynamic = "force-dynamic";

const n0 = (v: number) => v.toLocaleString("en-US");

type Search = { range?: string; fresh?: string; series?: string; device?: string; source?: string; country?: string; tab?: string; metric?: string; by?: string; eps?: string };
const COMPARE_BY = ["device", "source", "series", "country"] as const;

export default async function CrazydramasStatsPage({ searchParams }: { searchParams: Search }) {
  const session = await staffSession();
  const locale = adminLocale();
  const range = parseStatsRange(searchParams.range);
  const tab = parseDashTab(searchParams.tab);
  const metric = parseKpiMetric(searchParams.metric);
  const by = (COMPARE_BY as readonly string[]).includes(searchParams.by ?? "") ? (searchParams.by as (typeof COMPARE_BY)[number]) : "device";
  const eps = parsePlayEps(searchParams.eps);
  const [read, team, runs] = await Promise.all([
    readCrazydramasStats({ fresh: searchParams.fresh === "1" }),
    readTeamList(),
    getData().listLaunchRuns(session).catch(() => []),
  ]);
  // Every link keeps the rest of the address; `patch` changes some of it.
  const hrefWith = (patch: Partial<Search>) => {
    const q = new URLSearchParams();
    const next = { range, tab, metric, by, eps, series: searchParams.series, device: searchParams.device, source: searchParams.source, country: searchParams.country, ...patch };
    for (const [k, v] of Object.entries(next)) {
      // Defaults stay out of the address.
      if (v && !(k === "tab" && v === "overview") && !(k === "metric" && v === "visitors") && !(k === "by" && v === "device") && !(k === "eps" && v === "1")) q.set(k, v);
    }
    return `/crazydramas/stats?${q.toString()}`;
  };

  const head = (
    <div className="page-head cdx-head">
      <h1>{t(locale, "cds.title")}</h1>
      <RangeTabs range={range} hrefFor={(r) => hrefWith({ range: r })} locale={locale} />
    </div>
  );
  if (!read.ok) {
    return (
      <>
        {head}
        <ReadFailure read={read} locale={locale} />
      </>
    );
  }

  const report = read.report;
  const span = rangeDays(report, range);
  const prev = prevSpan(report, range);
  const edges = report.timing_edges_s;
  const filter: DashFilter = parseDashFilter(searchParams, report);
  const spends = adSpendsFromRuns(runs);
  const titleOf = new Map(report.series.map((s) => [s.drama_id, s]));
  const totals = sumRows(dashRows(report, span, filter));
  const before = prev ? sumRows(dashRows(report, prev, filter)) : null;

  // The filter row's choices.
  const campaignLabel = (key: string, name: string | null) => name ?? t(locale, "cdd.filter.campaign", { id: key.slice(9) });
  const sources = sourceOptions(report, span, spends);
  const allRows = dashRows(report, span, NO_FILTER);
  const devicesSeen = new Set(allRows.map((x) => x.device));
  const countriesSeen = new Set(allRows.map((x) => x.country ?? NO_PLACE));
  if (filter.country) countriesSeen.add(filter.country);
  const sourceLabel = (key: string) =>
    key === "stored_copy" ? t(locale, "cds.ads.storedCopy") : key === "no_ad" ? t(locale, "cds.ads.noAd") : campaignLabel(key, sources.find((s) => s.key === key)?.name ?? null);
  const placeLabel = (key: string) => (key === NO_PLACE ? t(locale, "cdd.place.none") : countryName(key, locale));
  const options: FilterOptions = {
    series: report.series.filter((s) => s.cohorts.some((c) => c.day >= span.from && c.day <= span.to && c.opened + c.unseen > 0) || s.drama_id === filter.series).map((s) => ({ slug: s.slug, title: s.title })),
    devices: DEVICE_ORDER.filter((d) => devicesSeen.has(d) || d === filter.device),
    countries: [...countriesSeen].map((c) => ({ key: c, label: placeLabel(c) })).sort((a, b) => Number(a.key === NO_PLACE) - Number(b.key === NO_PLACE) || a.label.localeCompare(b.label)),
    sources: [{ key: "ads", label: t(locale, "cdd.filter.ads") }, ...sources.map((s) => ({ key: s.key, label: campaignLabel(s.key, s.name) })), { key: "stored_copy", label: t(locale, "cds.ads.storedCopy") }, { key: "no_ad", label: t(locale, "cds.ads.noAd") }],
  };
  const seriesSlug = filter.series ? (titleOf.get(filter.series)?.slug ?? null) : null;
  const time = new Date(read.read_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });

  // Groups of the filtered people, each ignoring its own filter: the rows of Top, Compare and the tables.
  const inCountry = !!filter.country && filter.country !== NO_PLACE;
  const groups = {
    series: dashBy(dashRows(report, span, filter, "series"), (x) => x.drama_id).map((g) => ({
      key: g.key,
      name: titleOf.get(g.key)?.title ?? g.key,
      href: titleOf.get(g.key) ? hrefWith({ series: titleOf.get(g.key)!.slug }) : null,
      totals: g.totals,
    })),
    device: byDevice(dashRows(report, span, filter, "device")).map((g) => ({ key: g.key, name: t(locale, `cds.dev.${g.key}`), href: hrefWith({ device: g.key }), totals: g.totals })),
    source: dashBy(dashRows(report, span, filter, "source"), sourceKey).map((g) => ({ key: g.key, name: sourceLabel(g.key), href: hrefWith({ source: g.key }), totals: g.totals })),
    country: byPlace(dashRows(report, span, filter, inCountry ? undefined : "country"), filter.country).map((g) => ({
      key: g.key,
      name: g.key === NO_PLACE ? t(locale, "cdd.place.none") : inCountry ? regionName(filter.country!, g.key) : countryName(g.key, locale),
      href: inCountry ? null : hrefWith({ country: g.key }),
      totals: g.totals,
    })),
  } satisfies Record<(typeof COMPARE_BY)[number], CompareRow[]>;

  const tabs = (
    <nav className="tabs cdx-tabs" aria-label={t(locale, "cds.title")}>
      {DASH_TABS.map((x) => (
        <a key={x} className={`tab${x === tab ? " on" : ""}`} aria-current={x === tab ? "page" : undefined} href={hrefWith({ tab: x })}>
          {t(locale, `cdx.tab.${x}`)}
        </a>
      ))}
    </nav>
  );

  return (
    <>
      {head}
      <div className="cdx-bar">
        <FilterBar
          range={range}
          keep={Object.fromEntries(Object.entries({ tab: tab === "overview" ? "" : tab, metric: metric === "visitors" ? "" : metric, by: by === "device" ? "" : by, eps: eps === "1" ? "" : eps }).filter(([, v]) => v))}
          value={{ series: seriesSlug, device: filter.device, source: filter.source, country: filter.country ?? null }}
          options={options}
        />
        <span className="cdx-updated">
          {read.mode === "fake" ? t(locale, "cdx.testData") : t(locale, "cdx.updated", { time })} · <a href={`${hrefWith({})}&fresh=1`}>{t(locale, "cdx.refresh")}</a>
        </span>
      </div>
      {tabs}

      {tab === "overview" && <OverviewTab />}
      {tab === "funnel" && <FunnelTab />}
      {tab === "playback" && <PlaybackTab />}
      {tab === "series" && <SeriesTab />}
      {tab === "ads" && (await AdsTab())}
      {tab === "audience" && <AudienceTab />}
    </>
  );

  // ---- the tabs ----------------------------------------------------------------------------------------------

  function OverviewTab() {
    const days = dailyTotals(report, chartSpan(report, range), filter);
    const vs = prev ? t(locale, `cdx.vs.${range}`) : null;
    const steps = dashPath(totals).filter((s) => ["seen", "played", "finished", "ep2", "paid"].includes(s.key));
    const drop = biggestDrop(steps);
    const out = notCounted(report, span);
    const top = (rows: CompareRow[]) => rows.map((r) => ({ key: r.key, name: r.name, href: r.href ?? null, visitors: r.totals.opened, started: share(r.totals.started_ep1, r.totals.opened), finished: share(r.totals.finished_ep1, r.totals.opened) }));
    const topTabs: TopTab[] = [
      { key: "series", label: t(locale, "cdx.top.series"), rows: top(groups.series), allHref: hrefWith({ tab: "series" }) },
      { key: "phones", label: t(locale, "cdx.top.phones"), rows: top(groups.device), allHref: hrefWith({ tab: "funnel", by: "device" }) },
      { key: "sources", label: t(locale, "cdx.top.sources"), rows: top(groups.source), allHref: hrefWith({ tab: "funnel", by: "source" }) },
      { key: "countries", label: t(locale, "cdx.top.countries"), rows: top(groups.country), allHref: hrefWith({ tab: "funnel", by: "country" }) },
    ];
    return (
      <>
        <HeadlineNumbers totals={totals} before={before} days={days} metric={metric} hrefFor={(m) => hrefWith({ metric: m })} vs={vs} locale={locale} />
        <div className="cdx-grid2">
          <section className="rs-panel cdx-card">
            <div className="cdx-card-head">
              <h2>{t(locale, "cdx.drop.title")}</h2>
              <a href={hrefWith({ tab: "funnel" })}>{t(locale, "cdx.drop.full")} →</a>
            </div>
            <FunnelChart steps={steps} drop={drop} locale={locale} />
          </section>
          <section className="rs-panel cdx-card">
            <div className="cdx-card-head">
              <h2>{t(locale, "cdx.top.title")}</h2>
            </div>
            <TopPanel tabs={topTabs} labels={{ visitors: t(locale, "cdx.kpi.visitors"), started: t(locale, "cdx.col.started"), finished: t(locale, "cdx.col.finished"), all: t(locale, "cdx.top.all") }} />
          </section>
        </div>
        <div className="cdx-foot">
          <span title={t(locale, "cdx.leftOutInfo")}>
            {t(locale, "cdx.leftOut", { robots: n0(out.robots), unseen: n0(out.unseen), browsed: n0(out.browsed) })} <span className="cdx-i" aria-hidden>ⓘ</span>
          </span>
          <details className="cdx-team">
            <summary>{t(locale, "cdx.team", { n: team.emails.length })}</summary>
            <TeamEditor emails={team.emails} canEdit={session.staffRole === "admin"} updatedAt={team.updated_at} updatedBy={team.updated_by} />
          </details>
        </div>
      </>
    );
  }

  function FunnelTab() {
    const steps = dashPath(totals);
    const drop = biggestDrop(steps);
    return (
      <>
        <section className="rs-panel cdx-card">
          <div className="cdx-card-head">
            <h2>{t(locale, "cdx.funnel.title")}</h2>
          </div>
          <FunnelChart steps={steps} drop={drop} locale={locale} />
        </section>
        <section className="rs-panel cdx-card">
          <div className="cdx-card-head">
            <h2>{t(locale, "cdx.compare.title")}</h2>
            <nav className="seg" aria-label={t(locale, "cdx.compare.title")}>
              {COMPARE_BY.map((b) => (
                <a key={b} className={`seg-btn${b === by ? " on" : ""}`} aria-current={b === by ? "true" : undefined} href={hrefWith({ by: b })}>
                  {t(locale, `cdx.compare.${b}`)}
                </a>
              ))}
            </nav>
          </div>
          <CompareTable rows={groups[by]} caption={t(locale, "cdx.compare.title")} locale={locale} />
        </section>
        <section className="rs-panel cdx-card">
          <div className="cdx-card-head">
            <h2>{t(locale, "cdx.why")}</h2>
          </div>
          <div className="cds-surveys">
            <SurveyView kind="ep1_stop" shown={totals.survey_ep1_shown} answers={totals.survey_ep1} locale={locale} />
            <SurveyView kind="paywall_close" shown={totals.survey_paywall_shown} answers={totals.survey_paywall} locale={locale} />
          </div>
        </section>
      </>
    );
  }

  function PlaybackTab() {
    return (
      <PlaybackSection
        totals={totals}
        before={before}
        vs={prev ? t(locale, `cdx.vs.${range}`) : null}
        phones={groups.device}
        edges={edges}
        eps={eps}
        epsHref={(e) => hrefWith({ eps: e })}
        drops={dropsFor(report, span, filter, eps)}
        titleOf={(id) => titleOf.get(id)?.title ?? id}
        locale={locale}
      />
    );
  }

  function SeriesTab() {
    return (
      <section className="rs-panel cdx-card">
        <div className="an-scroll" tabIndex={0} role="region" aria-label={t(locale, "cdx.tab.series")}>
          <table className="an-table cds-table cdx-table">
            <thead>
              <tr>
                <th scope="col" />
                <th scope="col" className="gt-num">{t(locale, "cdx.kpi.visitors")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdx.kpi.started")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdx.kpi.finished")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdx.kpi.ep2")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdx.col.paywall")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdx.kpi.buyers")}</th>
                <th scope="col" className="gt-num">{t(locale, "cdx.kpi.revenue")}</th>
              </tr>
            </thead>
            <tbody>
              {groups.series.map((g) => {
                const x = g.totals;
                const s = titleOf.get(g.key);
                const rate = (n: number) => (
                  <td className="gt-num" title={n0(n)}>
                    {fmtShare(share(n, x.opened))}
                  </td>
                );
                return (
                  <tr key={g.key}>
                    <th scope="row" className="cds-title">
                      {s ? <a href={`/crazydramas/stats/${encodeURIComponent(s.slug)}?range=${range}`}>{g.name}</a> : g.name}
                      {g.href && filter.series !== g.key && (
                        <a className="cdd-only" href={g.href}>
                          {t(locale, "cdx.filter")}
                        </a>
                      )}
                    </th>
                    <td className="gt-num">{n0(x.opened)}</td>
                    {rate(x.started_ep1)}
                    {rate(x.finished_ep1)}
                    {rate(x.watched_ep2)}
                    {rate(x.paywall)}
                    <td className="gt-num">{n0(x.buyers)}</td>
                    <td className="gt-num">{fmtUsdCents(x.revenue_cents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  async function AdsTab() {
    // Its people are the filtered rows over the report (the period is the ad table's own); spend is per ad, not
    // per phone or country, so with one of those picked the costs would divide an ad's whole spend: none then.
    const adReport = { ...report, sources: dashRows(report, { from: report.from, to: report.to }, filter) };
    const adPeriod = await readAdPeriod(report, range, runs, searchParams.fresh === "1");
    const adSpends =
      filter.device || filter.country
        ? []
        : !filter.source || filter.source === "ads"
          ? spends
          : filter.source.startsWith("campaign:")
            ? spends.filter((sp) => sp.campaign_id === filter.source!.slice(9))
            : [];
    const campaigns = campaignTable(adReport, adSpends, filter.series ?? undefined, adPeriod);
    const ads = campaigns.filter((c) => c.kind === "campaign");
    const spend = ads.reduce((a, c) => a + (c.spend_cents ?? 0), 0);
    const known = ads.some((c) => c.spend_cents != null);
    const people = ads.reduce((a, c) => a + c.opened, 0);
    const finishers = ads.reduce((a, c) => a + c.finished_ep1, 0);
    const per = (n: number) => (known && n > 0 ? fmtUsdCents(Math.round(spend / n)) : "–");
    return (
      <>
        <div className="cdx-kpis">
          <KpiCard label={t(locale, "cdx.ads.spend")} info={t(locale, "cdx.ads.spendInfo")} value={known ? fmtUsdCents(spend) : "–"} />
          <KpiCard label={t(locale, "cdx.ads.visitors")} info={t(locale, "cdx.info.visitors")} value={n0(people)} />
          <KpiCard label={t(locale, "cdx.ads.perVisitor")} info={t(locale, "cdx.ads.perInfo")} value={per(people)} />
          <KpiCard label={t(locale, "cdx.ads.perFinisher")} info={t(locale, "cdx.ads.perInfo")} value={per(finishers)} />
          <KpiCard label={t(locale, "cdx.kpi.buyers")} info={t(locale, "cdx.info.buyers")} value={n0(ads.reduce((a, c) => a + c.buyers, 0))} />
          <KpiCard label={t(locale, "cdx.kpi.revenue")} info={t(locale, "cdx.info.revenue")} value={fmtUsdCents(ads.reduce((a, c) => a + c.revenue_cents, 0))} />
        </div>
        <section className="rs-panel cdx-card">
          <div className="cdx-card-head">
            <h2>{t(locale, "cdx.ads.campaigns")}</h2>
          </div>
          {adPeriod?.days && !adPeriod.days.ok && <p className="note note-warn">{t(locale, "cds.ads.daysFailed", { error: adPeriod.days.error })}</p>}
          {(filter.device || filter.country) && <p className="note">{t(locale, "cdd.ads.byPhoneNote")}</p>}
          <CampaignTable rows={campaigns} caption={t(locale, "cdx.ads.campaigns")} />
        </section>
      </>
    );
  }

  function AudienceTab() {
    const aud = audience(report, range);
    return (
      <>
        <div className="cdx-kpis cdx-kpis-4">
          <KpiCard label={t(locale, "cds.aud.today")} info={t(locale, "cds.aud.sub")} value={n0(aud.today?.watchers ?? 0)} sub={t(locale, "cds.aud.opened", { n: n0(aud.today?.visitors ?? 0) })} />
          <KpiCard label={t(locale, "cds.aud.yesterday")} info={t(locale, "cds.aud.sub")} value={n0(aud.yesterday?.watchers ?? 0)} />
          <KpiCard label={t(locale, "cds.aud.wau")} info={t(locale, "cds.aud.sub")} value={n0(aud.wau)} />
          <KpiCard label={t(locale, "cds.aud.mau")} info={t(locale, "cds.aud.sub")} value={n0(aud.mau)} />
        </div>
        {aud.days.length > 1 && (
          <section className="rs-panel cdx-card">
            <TrendChart title={t(locale, "cds.aud.chart")} points={aud.days.map((d) => ({ day: d.day, value: d.watchers }))} tableLabel={t(locale, "cdx.numbers")} />
          </section>
        )}
        <div className="cdx-kpis cdx-kpis-4">
          <KpiCard label={t(locale, "cds.money.revenue")} info={t(locale, "cds.money.sub")} value={fmtUsdCents(aud.money.revenue_cents)} />
          <KpiCard label={t(locale, "cds.money.payments")} info={t(locale, "cds.money.sub")} value={n0(aud.money.payments)} />
          <KpiCard label={t(locale, "cds.money.first")} info={t(locale, "cds.money.sub")} value={n0(aud.money.first_purchases)} />
          <KpiCard label={t(locale, "cds.money.renewals")} info={t(locale, "cds.money.sub")} value={n0(aud.money.renewals)} />
        </div>
        <section className="rs-panel cdx-card">
          <div className="cdx-card-head">
            <h2>{inCountry ? t(locale, "cdd.place.inTitle", { country: countryName(filter.country!, locale) }) : t(locale, "cdx.aud.where")}</h2>
          </div>
          <CompareTable rows={groups.country} caption={t(locale, "cdx.aud.where")} locale={locale} />
        </section>
      </>
    );
  }
}
