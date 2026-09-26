import "@/app/crazydramas-stats.css";
import { adminLocale, staffSession } from "@/components/admin/server";
import { AdDetail, AdTypeTable, type AdRun } from "@/components/admin/cd-stats/AdDetail";
import { RangeTabs, ReadFailure } from "@/components/admin/cd-stats/Bits";
import { BuyersTable, PersonPanel, type Names } from "@/components/admin/cd-stats/Buyers";
import CampaignsView, { type CampaignsViewRow } from "@/components/admin/cd-stats/Campaigns";
import { FunnelChart } from "@/components/admin/cd-stats/Dash";
import FilterBar, { type FilterOptions } from "@/components/admin/cd-stats/FilterBar";
import Info from "@/components/admin/cd-stats/Info";
import { SpendRevenueChart } from "@/components/admin/cd-stats/Money";
import { KpiCard } from "@/components/admin/cd-stats/Overview";
import { PlaybackSection } from "@/components/admin/cd-stats/Sections";
import { EpisodeCurveChart, SeriesFunnelList } from "@/components/admin/cd-stats/SeriesCurve";
import TeamEditor from "@/components/admin/cd-stats/TeamEditor";
import { fakeStatsLaunches, FAKE_STATS_CLIPS } from "@/lib/crazydramas/fake-stats";
import { readCrazydramasStats, readLaunchClips } from "@/lib/crazydramas/stats";
import { adCreatives, byAdType, campaignFacts, changeAbove, compareCampaigns, dailySpend, fmtRatio, returnOnSpend, spendIn, type AdCreative } from "@/lib/crazydramas/stats-ads";
import { adBuyers, browsersOf, buyerCounts, buyersByAd, fmtDuration, hasBuyerDetails, personOf, purchasesIn, untaggedBuyers } from "@/lib/crazydramas/stats-buyers";
import { episodeCurve, seriesFunnel } from "@/lib/crazydramas/stats-series";
import { readTeamList } from "@/lib/crazydramas/stats-team";
import {
  adSpendsFromRuns,
  biggestDrop,
  byDevice,
  campaignTable,
  change,
  chartSpan,
  countryName,
  DASH_TABS,
  dailyTotals,
  dashBy,
  dashPath,
  dashRows,
  dayIn,
  DEVICE_ORDER,
  dropsFor,
  fmtShare,
  fmtUsdCents,
  NO_FILTER,
  NO_PLACE,
  notCounted,
  parseDashFilter,
  parseDashTab,
  parsePlayEps,
  parseStatsRange,
  prevSpan,
  rangeDays,
  share,
  sourceKey,
  sourceOptions,
  sumRows,
  type AdPeriod,
  type DashFilter,
} from "@/lib/crazydramas/stats-summary";
import type { CdStatsPurchase } from "@/lib/crazydramas/stats-types";
import { getData } from "@/lib/data";
import { mediaUrl } from "@/lib/data/storage";
import { t } from "@/lib/i18n";
import { readTikTokAdDays, type AdDaysRead } from "@/lib/tiktok/ad-days";

// /crazydramas/stats — viewing and money on crazydramas.com, staff only. Decisions 2026-09-24 "CrazyDramas
// stats", 2026-09-25 "the stats dashboard, second cut" and 2026-09-26 "Stats: campaigns, buyers and the full
// episode curve" (Ruobin: "I dont know if the 6 buyers are different for the same people ... perhaps i can
// click on buyers? see where they came from? Our current series metric also stops at episode 2"). Tabs:
// Overview (spend, revenue, return, cost per buyer, buyers; spend against revenue per day), Campaigns (each
// campaign and ad: what TikTok says it sold against what we saw, why they differ, which clip each ad played),
// Buyers (every payment, each person's way through the site), Series (the whole episode curve), Playback. One
// filter row (period, series, phone, source, country) scopes every tab; words that explain a number live in
// its ⓘ. The numbers are crazydramas' /api/studio/stats report (lib/crazydramas/stats.ts), summed in the pure
// lib/crazydramas/stats-*.ts modules.

export const dynamic = "force-dynamic";

const n0 = (v: number) => v.toLocaleString("en-US");

type Search = { range?: string; fresh?: string; series?: string; device?: string; source?: string; country?: string; tab?: string; eps?: string; ad?: string; person?: string; curve?: string };

/** TikTok's days of spend, with the fixture's invented launches' days laid over them. */
function withDays(read: AdDaysRead, extra: AdDaysRead | null): AdDaysRead {
  if (!extra || !extra.ok) return read;
  if (!read.ok) return extra;
  return { ...read, campaigns: [...read.campaigns, ...extra.campaigns], days: { ...read.days, ...extra.days } };
}

const nextDay = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export default async function CrazydramasStatsPage({ searchParams }: { searchParams: Search }) {
  const session = await staffSession();
  const locale = adminLocale();
  const tt = (k: string, v?: Record<string, string | number>) => t(locale, k, v);
  const range = parseStatsRange(searchParams.range);
  const tab = parseDashTab(searchParams.tab);
  const eps = parsePlayEps(searchParams.eps);
  const fresh = searchParams.fresh === "1";
  const [read, team, launched] = await Promise.all([readCrazydramasStats({ fresh }), readTeamList(), getData().listLaunchRuns(session).catch(() => [])]);
  // Every link keeps the filters and the period; `patch` changes some of it. The ad, person and curve belong to their tab.
  const hrefWith = (patch: Partial<Search>) => {
    const q = new URLSearchParams();
    const next: Partial<Search> = { range, tab, eps, series: searchParams.series, device: searchParams.device, source: searchParams.source, country: searchParams.country, ...patch };
    for (const [k, v] of Object.entries(next)) {
      if (v && !(k === "tab" && v === "overview") && !(k === "eps" && v === "1")) q.set(k, v);
    }
    return `/crazydramas/stats?${q.toString()}`;
  };
  const here = { ad: searchParams.ad, person: searchParams.person, curve: searchParams.curve };

  const head = (
    <div className="page-head cdx-head">
      <h1>{tt("cds.title")}</h1>
      <RangeTabs range={range} hrefFor={(r) => hrefWith({ range: r, ...here })} locale={locale} />
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
  // Fixture mode: the fake report's ads get invented launch records (never stored), so Campaigns has spend to show.
  const fake = read.mode === "fake" ? fakeStatsLaunches() : null;
  const runs = fake ? [...launched, ...fake.runs] : launched;
  const [realDays, clips] = await Promise.all([readTikTokAdDays(launched, { to: report.to, fresh }), readLaunchClips(session, launched)]);
  if (fake) for (const c of FAKE_STATS_CLIPS) clips.set(c.id, { ...c });
  const adDays = withDays(realDays, fake?.days ?? null);

  const span = rangeDays(report, range);
  const prev = prevSpan(report, range);
  const vs = prev ? tt(`cdx.vs.${range}`) : null;
  const filter: DashFilter = parseDashFilter(searchParams, report);
  const titleOf = new Map(report.series.map((s) => [s.drama_id, s]));
  const totals = sumRows(dashRows(report, span, filter));
  const before = prev ? sumRows(dashRows(report, prev, filter)) : null;
  const spends = adSpendsFromRuns(runs);
  const creatives = adCreatives(runs, clips);
  const adPeriod: AdPeriod | undefined = range === "all" ? undefined : { ...span, timezone: report.timezone, days: adDays };
  // Spend is per ad, not per phone or country: with one of those picked, no spend (costs would divide an ad's whole spend).
  const adSpends =
    filter.device || filter.country
      ? []
      : !filter.source || filter.source === "ads"
        ? spends
        : filter.source.startsWith("campaign:")
          ? spends.filter((sp) => sp.campaign_id === filter.source!.slice(9))
          : [];
  const details = hasBuyerDetails(report);
  const paid = details ? purchasesIn(report, span, filter) : null;
  const paidBefore = details && prev ? purchasesIn(report, prev, filter) : null;

  // The filter row's choices.
  const campaignLabel = (key: string, name: string | null) => name ?? tt("cdd.filter.campaign", { id: key.slice(9) });
  const sources = sourceOptions(report, span, spends);
  const allRows = dashRows(report, span, NO_FILTER);
  const devicesSeen = new Set(allRows.map((x) => x.device));
  const countriesSeen = new Set(allRows.map((x) => x.country ?? NO_PLACE));
  if (filter.country) countriesSeen.add(filter.country);
  const placeLabel = (key: string) => (key === NO_PLACE ? tt("cdd.place.none") : countryName(key, locale));
  const options: FilterOptions = {
    series: report.series.filter((s) => s.cohorts.some((c) => c.day >= span.from && c.day <= span.to && c.opened + c.unseen > 0) || s.drama_id === filter.series).map((s) => ({ slug: s.slug, title: s.title })),
    devices: DEVICE_ORDER.filter((d) => devicesSeen.has(d) || d === filter.device),
    countries: [...countriesSeen].map((c) => ({ key: c, label: placeLabel(c) })).sort((a, b) => Number(a.key === NO_PLACE) - Number(b.key === NO_PLACE) || a.label.localeCompare(b.label)),
    sources: [{ key: "ads", label: tt("cdd.filter.ads") }, ...sources.map((s) => ({ key: s.key, label: campaignLabel(s.key, s.name) })), { key: "stored_copy", label: tt("cds.ads.storedCopy") }, { key: "no_ad", label: tt("cds.ads.noAd") }],
  };
  const seriesSlug = filter.series ? (titleOf.get(filter.series)?.slug ?? null) : null;
  const time = new Date(read.read_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });

  // What names a campaign, an ad and a series (the Buyers tab, the ad panel).
  const campaignNames = new Map(spends.filter((s) => s.campaign_id).map((s) => [s.campaign_id!, s.launch_name]));
  const names: Names = {
    campaign: (id) => campaignNames.get(id) ?? tt("cdd.filter.campaign", { id }),
    ad: (id) => creatives.get(id) ?? null,
    media: (c: AdCreative | null) => (c?.file_path ? mediaUrl(c.file_path) : null),
    adHref: (id) => hrefWith({ tab: "campaigns", ad: id }),
    series: (id) => (id ? (titleOf.get(id)?.title ?? id) : tt("cdb.noSeries")),
  };
  const personHref = (p: string) => hrefWith({ tab: "buyers", person: p });

  const tabs = (
    <nav className="tabs cdx-tabs" aria-label={tt("cds.title")}>
      {DASH_TABS.map((x) => (
        <a key={x} className={`tab${x === tab ? " on" : ""}`} aria-current={x === tab ? "page" : undefined} href={hrefWith({ tab: x })}>
          {tt(`cdx.tab.${x}`)}
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
          keep={Object.fromEntries(Object.entries({ tab: tab === "overview" ? "" : tab, eps: eps === "1" ? "" : eps, ...here }).filter((e): e is [string, string] => !!e[1]))}
          value={{ series: seriesSlug, device: filter.device, source: filter.source, country: filter.country ?? null }}
          options={options}
        />
        <span className="cdx-updated">
          {read.mode === "fake" ? tt("cdx.testData") : tt("cdx.updated", { time })} · <a href={`${hrefWith(here)}&fresh=1`}>{tt("cdx.refresh")}</a>
        </span>
      </div>
      {tabs}

      {tab === "overview" && <OverviewTab />}
      {tab === "campaigns" && <CampaignsTab />}
      {tab === "buyers" && <BuyersTab />}
      {tab === "series" && <SeriesTab />}
      {tab === "playback" && <PlaybackTab />}
    </>
  );

  // ---- the tabs ----------------------------------------------------------------------------------------------

  function OverviewTab() {
    const chart = chartSpan(report, range);
    const spendDays = dailySpend(adSpends, adDays, chart);
    const paidDays = details ? purchasesIn(report, chart, filter) : null;
    const onDay = (list: CdStatsPurchase[], day: string) => list.filter((p) => dayIn(p.at, report.timezone) === day);
    const revenueDays = paidDays ? spendDays.map((d) => onDay(paidDays, d.day).reduce((a, p) => a + p.amount_cents, 0)) : dailyTotals(report, chart, filter).map((d) => d.totals.revenue_cents);
    const buyerDays = paidDays ? spendDays.map((d) => new Set(onDay(paidDays, d.day).map((p) => p.person)).size) : dailyTotals(report, chart, filter).map((d) => d.totals.buyers);
    const known = (list: { cents: number | null }[]) => (list.every((d) => d.cents !== null) ? list.reduce((a, d) => a + (d.cents ?? 0), 0) : null);
    const spendKnown = !spendDays.every((d) => d.cents === null);

    const spend = adSpends.length ? spendIn(adSpends, adPeriod) : { cents: null, partial: false };
    const spendBefore = prev && adSpends.length ? known(dailySpend(adSpends, adDays, prev)) : null;
    const revenue = paid ? paid.reduce((a, p) => a + p.amount_cents, 0) : totals.revenue_cents;
    const revenueBefore = prev ? (paidBefore ? paidBefore.reduce((a, p) => a + p.amount_cents, 0) : (before?.revenue_cents ?? null)) : null;
    const roas = returnOnSpend(revenue, spend.cents);
    const roasBefore = spendBefore && revenueBefore !== null && spendBefore >= 1000 ? revenueBefore / spendBefore : null;
    const counts = paid ? buyerCounts(paid) : null;
    const countsBefore = paidBefore ? buyerCounts(paidBefore) : null;
    // Buyers who came from ads: the payments' own landings, or (an older report) the ad rows' buyers.
    const fromAds = (list: CdStatsPurchase[] | null, rows: ReturnType<typeof dashRows>) => (list ? adBuyers(list) : rows.filter((x) => x.platform === "tiktok" || sourceKey(x) !== "no_ad").reduce((a, x) => a + x.buyers, 0));
    const adBuyersNow = fromAds(paid, dashRows(report, span, filter));
    const adBuyersBefore = prev ? fromAds(paidBefore, dashRows(report, prev, filter)) : null;
    const perBuyer = spend.cents !== null && adBuyersNow > 0 ? Math.round(spend.cents / adBuyersNow) : null;
    const perBuyerBefore = spendBefore !== null && adBuyersBefore ? Math.round(spendBefore / adBuyersBefore) : null;
    const people = counts ? counts.people : totals.buyers;
    const peopleBefore = countsBefore ? countsBefore.people : (before?.buyers ?? null);

    const steps = dashPath(totals).filter((s) => ["seen", "played", "finished", "ep2", "paywall", "paid"].includes(s.key));
    const out = notCounted(report, span);
    const noSpend = !!(filter.device || filter.country);
    return (
      <>
        <div className="cdx-kpis cdx-kpis-5">
          <KpiCard
            label={tt("cdo.spend")}
            info={tt(noSpend ? "cdo.spendSplitInfo" : "cdo.spendInfo")}
            value={spend.cents === null ? "–" : fmtUsdCents(spend.cents)}
            sub={spend.partial ? tt("cdo.partial") : null}
            change={changeAbove(spend.cents, spendBefore, 1000)}
            vs={vs}
            upIsGood={false}
            spark={spendKnown ? spendDays.map((d) => d.cents ?? 0) : undefined}
          />
          <KpiCard label={tt("cdx.kpi.revenue")} info={tt(details ? "cdo.revenueInfo" : "cdx.info.revenue")} value={fmtUsdCents(revenue)} change={changeAbove(revenue, revenueBefore, 1000)} vs={vs} spark={revenueDays} />
          <KpiCard
            label={tt("cdo.roas")}
            info={tt("cdo.roasInfo")}
            value={fmtRatio(roas)}
            sub={roas !== null ? tt("cdo.roasSub", { back: fmtUsdCents(Math.round(roas * 100)) }) : null}
            change={roas !== null && roasBefore ? (roas - roasBefore) / roasBefore : null}
            vs={vs}
            spark={spendKnown ? spendDays.map((d, i) => (d.cents ? revenueDays[i] / d.cents : 0)) : undefined}
          />
          <KpiCard
            label={tt("cdo.perBuyer")}
            info={tt("cdo.perBuyerInfo")}
            value={perBuyer === null ? "–" : fmtUsdCents(perBuyer)}
            sub={tt(adBuyersNow === 1 ? "cdo.adBuyers1" : "cdo.adBuyers", { n: n0(adBuyersNow) })}
            change={adBuyersBefore && adBuyersBefore >= 3 ? changeAbove(perBuyer, perBuyerBefore, 1) : null}
            vs={vs}
            upIsGood={false}
          />
          <KpiCard
            label={tt("cdx.kpi.buyers")}
            info={tt(details ? "cdo.buyersInfo" : "cdx.info.buyers")}
            value={tt(people === 1 ? "cdc.people1" : "cdc.people", { n: n0(people) })}
            sub={counts ? tt(counts.purchases === 1 ? "cdc.purchases1" : "cdc.purchases", { n: n0(counts.purchases) }) : null}
            change={change(people, peopleBefore)}
            vs={vs}
            spark={buyerDays}
            href={hrefWith({ tab: "buyers" })}
          />
        </div>
        <section className="rs-panel cdx-card">
          <SpendRevenueChart
            title={tt("cdo.chart")}
            days={spendDays.map((d, i) => ({ day: d.day, spend_cents: d.cents, revenue_cents: revenueDays[i] }))}
            labels={{ spend: tt("cdo.spend"), revenue: tt("cdx.kpi.revenue") }}
            tableLabel={tt("cdx.numbers")}
          />
        </section>
        <section className="rs-panel cdx-card">
          <div className="cdx-card-head">
            <h2>{tt("cdx.drop.title")}</h2>
            <a href={hrefWith({ tab: "series" })}>{tt("cdo.bySeries")} →</a>
          </div>
          <FunnelChart steps={steps} drop={biggestDrop(steps)} locale={locale} />
        </section>
        <div className="cdx-foot">
          <span>
            {tt("cdx.leftOut", { robots: n0(out.robots), unseen: n0(out.unseen), browsed: n0(out.browsed) })}{" "}
            <Info text={tt("cdx.leftOutInfo")} label={tt("cdx.about", { what: tt("cdx.leftOutName") })} />
          </span>
          <details className="cdx-team">
            <summary>{tt("cdx.team", { n: team.emails.length })}</summary>
            <TeamEditor emails={team.emails} canEdit={session.staffRole === "admin"} updatedAt={team.updated_at} updatedBy={team.updated_by} />
          </details>
        </div>
      </>
    );
  }

  function CampaignsTab() {
    // The people are the filtered rows over the report (the period is the table's own, as TikTok's days are).
    const adReport = { ...report, sources: dashRows(report, { from: report.from, to: report.to }, filter) };
    const rows = campaignTable(adReport, adSpends, filter.series ?? undefined, adPeriod);
    const untaggedN = paid ? untaggedBuyers(paid) : 0;
    const views = compareCampaigns(rows, campaignFacts(runs), creatives, paid ? buyersByAd(paid) : null, untaggedN, adPeriod);
    const launchDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
    const viewRows: CampaignsViewRow[] = views.map((v) => ({ ...v, ads: v.ads.map((a) => ({ ...a, href: hrefWith({ ad: a.ad_id }), media_url: names.media(a.creative) })) }));
    const launchedLabel = Object.fromEntries(views.filter((v) => v.launched_at).map((v) => [v.key, tt("cds.ads.launched", { day: launchDay(v.launched_at!) })]));
    const ads = views.filter((v) => v.kind === "campaign").flatMap((v) => v.ads);
    const picked = searchParams.ad ? ads.find((a) => a.ad_id === searchParams.ad) : undefined;
    let detail = null;
    if (searchParams.ad && !picked) detail = <p className="note">{tt("cdc.detail.notHere")}</p>;
    if (picked) {
      // The same clip in every campaign it ran in (a Spark code or a post: only this ad).
      const clip = picked.creative?.clip_id ?? null;
      const same = clip ? ads.filter((a) => a.creative?.clip_id === clip) : [picked];
      const runsOf: AdRun[] = same.map((a) => ({ ...a, launch_name: a.creative?.launch_name ?? "–", campaign_name: a.creative?.campaign_name ?? "–", href: hrefWith({ ad: a.ad_id }) }));
      const ids = new Set(same.map((a) => a.ad_id));
      const buyers = details ? purchasesIn(report, span, filter, "source").filter((p) => !!p.source?.ad && ids.has(p.source.ad)) : null;
      detail = <AdDetail ad={picked} media={names.media(picked.creative)} runs={runsOf} buyers={buyers} personHref={personHref} seriesTitle={names.series} closeHref={hrefWith({})} locale={locale} />;
    }
    return (
      <>
        {detail}
        <section className="rs-panel cdx-card">
          <div className="cdx-card-head">
            <h2>{tt("cdx.ads.campaigns")}</h2>
            {range !== "all" && <span className="cdx-muted">{tt("cdc.periodNote")}</span>}
          </div>
          {!adDays.ok && <p className="note note-warn">{tt("cds.ads.daysFailed", { error: adDays.error })}</p>}
          {(filter.device || filter.country) && <p className="note">{tt("cdd.ads.byPhoneNote")}</p>}
          <CampaignsView rows={viewRows} caption={tt("cdx.ads.campaigns")} launchedLabel={launchedLabel} />
          {untaggedN > 0 && <p className="cdx-note">{tt(untaggedN === 1 ? "cdc.untaggedLine1" : "cdc.untaggedLine", { n: untaggedN })}</p>}
        </section>
        <section className="rs-panel cdx-card">
          <div className="cdx-card-head">
            <h2>
              {tt("cdc.types.title")} <Info text={tt("cdc.types.info")} label={tt("cdx.about", { what: tt("cdc.types.title") })} />
            </h2>
          </div>
          <AdTypeTable rows={byAdType(ads)} locale={locale} />
        </section>
      </>
    );
  }

  function BuyersTab() {
    if (!paid) return <p className="rs-empty">{tt("cdb.none")}</p>;
    const counts = buyerCounts(paid);
    const countsBefore = paidBefore ? buyerCounts(paidBefore) : null;
    const chart = chartSpan(report, range);
    const byDay = new Map<string, CdStatsPurchase[]>();
    for (const p of purchasesIn(report, chart, filter)) {
      const d = dayIn(p.at, report.timezone);
      byDay.set(d, [...(byDay.get(d) ?? []), p]);
    }
    const days: string[] = [];
    for (let d = chart.from; d <= chart.to; d = nextDay(d)) days.push(d);
    const spark = (f: (list: CdStatsPurchase[]) => number) => days.map((d) => f(byDay.get(d) ?? []));
    const firsts = paid.filter((p) => !p.renewal && p.paid_after_s !== null).map((p) => p.paid_after_s!).sort((a, b) => a - b);
    const median = firsts.length ? firsts[Math.floor((firsts.length - 1) / 2)] : null;
    const person = searchParams.person ? personOf(report, searchParams.person) : null;
    return (
      <>
        <div className="cdx-kpis cdx-kpis-4">
          <KpiCard label={tt("cdb.kpi.people")} info={tt("cdb.kpi.peopleInfo")} value={n0(counts.people)} change={change(counts.people, countsBefore?.people ?? null)} vs={vs} spark={spark((l) => new Set(l.map((p) => p.person)).size)} />
          <KpiCard
            label={tt("cdb.kpi.purchases")}
            info={tt("cdb.kpi.purchasesInfo")}
            value={n0(counts.purchases)}
            sub={counts.renewals ? tt("cdb.kpi.renewals", { n: counts.renewals }) : null}
            change={change(counts.purchases, countsBefore?.purchases ?? null)}
            vs={vs}
            spark={spark((l) => l.length)}
          />
          <KpiCard label={tt("cdx.kpi.revenue")} info={tt("cdo.revenueInfo")} value={fmtUsdCents(counts.revenue_cents)} change={changeAbove(counts.revenue_cents, countsBefore?.revenue_cents ?? null, 1000)} vs={vs} spark={spark((l) => l.reduce((a, p) => a + p.amount_cents, 0))} />
          <KpiCard label={tt("cdb.kpi.toPay")} info={tt("cdb.kpi.toPayInfo")} value={fmtDuration(median)} />
        </div>
        {searchParams.person && !person && <p className="note">{tt("cdb.person.notFound", { code: searchParams.person })}</p>}
        {person && <PersonPanel person={person} names={names} closeHref={hrefWith({})} locale={locale} />}
        <section className="rs-panel cdx-card">
          <div className="cdx-card-head">
            <h2>{tt("cdb.list")}</h2>
            <span className="cdx-muted">{tt("cdb.listSub", { people: n0(counts.people), purchases: n0(counts.purchases) })}</span>
          </div>
          <BuyersTable list={paid} browsers={browsersOf(report.purchases ?? [])} names={names} personHref={personHref} current={person?.person ?? null} locale={locale} />
        </section>
      </>
    );
  }

  function SeriesTab() {
    const groups = dashBy(dashRows(report, span, filter, "series"), (x) => x.drama_id);
    const bySlug = (slug?: string) => (slug ? report.series.find((s) => s.slug === slug) : undefined);
    const top = [...groups].sort((a, b) => b.totals.started_ep1 - a.totals.started_ep1)[0];
    const shown = bySlug(searchParams.curve) ?? (filter.series ? titleOf.get(filter.series) : undefined) ?? (top ? titleOf.get(top.key) : undefined);
    const curve = shown ? episodeCurve(shown, span, report.journeys) : null;
    const fun = shown ? seriesFunnel(sumRows(dashRows(report, span, { ...filter, series: shown.drama_id }))) : null;
    return (
      <>
        {shown && curve && fun ? (
          <div className="cdv-grid">
            <section className="rs-panel cdx-card">
              <div className="cdx-card-head">
                <h2>
                  {shown.title} <Info text={tt("cdv.info")} label={tt("cdx.about", { what: tt("cdv.title") })} />
                </h2>
                <a href={`/crazydramas/stats/${encodeURIComponent(shown.slug)}?range=${range}`}>{tt("cdv.open")} →</a>
              </div>
              <EpisodeCurveChart title={tt("cdv.title")} curve={curve} locale={locale} />
            </section>
            <section className="rs-panel cdx-card">
              <div className="cdx-card-head">
                <h2>{tt("cdv.funnel")}</h2>
              </div>
              <SeriesFunnelList steps={fun.steps} paywallToPaid={fun.paywall_to_paid} revenuePerBuyer={fun.revenue_per_buyer_cents} locale={locale} />
            </section>
          </div>
        ) : (
          <p className="rs-empty">{tt("cdx.empty")}</p>
        )}
        <section className="rs-panel cdx-card">
          <div className="an-scroll" tabIndex={0} role="region" aria-label={tt("cdx.tab.series")}>
            <table className="an-table cds-table cdx-table">
              <thead>
                <tr>
                  <th scope="col" />
                  <th scope="col" className="gt-num">{tt("cdx.kpi.visitors")}</th>
                  <th scope="col" className="gt-num">{tt("cdx.kpi.started")}</th>
                  <th scope="col" className="gt-num">{tt("cdx.kpi.finished")}</th>
                  <th scope="col" className="gt-num">{tt("cdx.col.paywall")}</th>
                  <th scope="col" className="gt-num">{tt("cdx.kpi.buyers")}</th>
                  <th scope="col" className="gt-num">{tt("cdx.kpi.revenue")}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const x = g.totals;
                  const s = titleOf.get(g.key);
                  const rate = (n: number) => (
                    <td className="gt-num" title={n0(n)}>
                      {fmtShare(share(n, x.opened))}
                    </td>
                  );
                  return (
                    <tr key={g.key} className={s && s.drama_id === shown?.drama_id ? "cdc-this" : undefined}>
                      <th scope="row" className="cds-title">
                        {s ? <a href={hrefWith({ curve: s.slug })}>{s.title}</a> : g.key}
                      </th>
                      <td className="gt-num">{n0(x.opened)}</td>
                      {rate(x.started_ep1)}
                      {rate(x.finished_ep1)}
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
      </>
    );
  }

  function PlaybackTab() {
    return (
      <PlaybackSection
        totals={totals}
        before={before}
        vs={vs}
        phones={byDevice(dashRows(report, span, filter, "device")).map((g) => ({ key: g.key, name: tt(`cds.dev.${g.key}`), href: hrefWith({ device: g.key }), totals: g.totals }))}
        edges={report.timing_edges_s}
        eps={eps}
        epsHref={(e) => hrefWith({ eps: e })}
        drops={dropsFor(report, span, filter, eps)}
        titleOf={(id) => titleOf.get(id)?.title ?? id}
        locale={locale}
      />
    );
  }
}
