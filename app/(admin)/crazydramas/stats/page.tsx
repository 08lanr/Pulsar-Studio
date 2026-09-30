import "@/app/crazydramas-stats.css";
import { adminLocale, staffSession } from "@/components/admin/server";
import { AdDetail, AdTypeTable, type AdRun } from "@/components/admin/cd-stats/AdDetail";
import AdsTab from "@/components/admin/cd-stats/AdsTab";
import { CoinValueNotice, RangeTabs, ReadFailure } from "@/components/admin/cd-stats/Bits";
import { BuyersTable, PersonPanel, type Names } from "@/components/admin/cd-stats/Buyers";
import CampaignsView, { type CampaignsViewRow } from "@/components/admin/cd-stats/Campaigns";
import { FunnelChart } from "@/components/admin/cd-stats/Dash";
import FilterBar, { type FilterOptions } from "@/components/admin/cd-stats/FilterBar";
import Info from "@/components/admin/cd-stats/Info";
import { SpendRevenueChart, StackedDaysChart, type StackSeries } from "@/components/admin/cd-stats/Money";
import { KpiCard } from "@/components/admin/cd-stats/Overview";
import { PlaybackSection } from "@/components/admin/cd-stats/Sections";
import { EpisodeCurveChart, SeriesFunnelList } from "@/components/admin/cd-stats/SeriesCurve";
import { SurveyView } from "@/components/admin/cd-stats/Tables";
import TeamEditor from "@/components/admin/cd-stats/TeamEditor";
import { fakeStatsArchive, fakeStatsLaunches, FAKE_STATS_CLIPS } from "@/lib/crazydramas/fake-stats";
import { readCrazydramasStats, readLaunchClips } from "@/lib/crazydramas/stats";
import { adCreatives, byAdType, campaignFacts, changeAbove, compareCampaigns, dailySpend, fmtRatio, returnOnSpend, spendIn, type AdCreative, type CreativeClip } from "@/lib/crazydramas/stats-ads";
import { adBuyers, browsersOf, buyerCounts, buyersByAd, fmtDuration, hasBuyerDetails, personOf, purchasesIn, untaggedBuyers } from "@/lib/crazydramas/stats-buyers";
import {
  coinsByDay,
  coinsBySeries,
  coinsIn,
  firstOffersTaken,
  hasMoneyDetails,
  medianToFirstPay,
  moneyByDay,
  moneyDayCash,
  moneyTotals,
  paymentsHaveOrigin,
  paymentsIn,
  paywallIn,
  perPayer,
  placementRows,
  productMix,
  repeatCoinBuyers,
  vipEnded,
  vipNow,
  vipPeriod,
  vipWeeks,
} from "@/lib/crazydramas/stats-money";
import { firstWeekPrice } from "@/lib/crazydramas/vip-prices";
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
  checkoutOutcome,
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
import type { CdStatsPayment, CdStatsPurchase, PaymentKind } from "@/lib/crazydramas/stats-types";
import { getData } from "@/lib/data";
import { mediaUrl } from "@/lib/data/storage";
import { t } from "@/lib/i18n";
import type { LaunchRun } from "@/lib/launch/types";
import { readTikTokAdDays, type AdDaysRead } from "@/lib/tiktok/ad-days";

// /crazydramas/stats — viewing and money on crazydramas.com, staff only. Decisions 2026-09-24 "CrazyDramas
// stats", 2026-09-25 "the stats dashboard, second cut" and 2026-09-26 "Stats: campaigns, buyers and the full
// episode curve" (Ruobin: "I dont know if the 6 buyers are different for the same people ... perhaps i can
// click on buyers? see where they came from? Our current series metric also stops at episode 2"). Tabs:
// Overview (spend, revenue, return, cost per buyer, buyers; spend against revenue per day), Campaigns (each
// campaign and ad: what TikTok says it sold against what we saw, why they differ, which clip each ad played),
// Money (decision 2026-09-28 "Stats for coins and VIP": cash by product, refunds, payers, what sold, every payment
// and each person's way through the site), Paywall (the unlock sheet and the pop-ups), VIP, Coins, Series (the
// whole episode curve), Playback. One
// filter row (period, series, phone, source, country) scopes every tab; words that explain a number live in
// its ⓘ. The numbers are crazydramas' /api/studio/stats report (lib/crazydramas/stats.ts), summed in the pure
// lib/crazydramas/stats-*.ts modules.

export const dynamic = "force-dynamic";

const n0 = (v: number) => v.toLocaleString("en-US");

type Search = { range?: string; fresh?: string; series?: string; device?: string; source?: string; country?: string; tab?: string; eps?: string; ad?: string; person?: string; curve?: string; ad_title?: string; ad_type?: string };

/** TikTok's days of spend, with the fixture's invented launches' days laid over them. */
function withDays(read: AdDaysRead, extra: AdDaysRead | null): AdDaysRead {
  if (!extra || !extra.ok) return read;
  if (!read.ok) return extra;
  return { ...read, campaigns: [...read.campaigns, ...extra.campaigns], days: { ...read.days, ...extra.days } };
}

/** Today on crazydramas' clock (the Pacific day), for the Ads tab when crazydramas does not answer. */
const pacificToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

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
    const next: Partial<Search> = { range, tab, eps, series: searchParams.series, device: searchParams.device, source: searchParams.source, country: searchParams.country, ad_title: searchParams.ad_title, ad_type: searchParams.ad_type, ...patch };
    for (const [k, v] of Object.entries(next)) {
      // The Ads tab's own filters stay on the Ads tab.
      if ((k === "ad_title" || k === "ad_type") && next.tab !== "ads") continue;
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
  const tabs = (
    <nav className="tabs cdx-tabs" aria-label={tt("cds.title")}>
      {DASH_TABS.map((x) => (
        <a key={x} className={`tab${x === tab ? " on" : ""}`} aria-current={x === tab ? "page" : undefined} href={hrefWith({ tab: x })}>
          {tt(`cdx.tab.${x}`)}
        </a>
      ))}
    </nav>
  );
  // The Ads tab is TikTok's numbers only: it still shows when crazydramas does not answer.
  const adsTab = async (today: string, invented: LaunchRun[] | null, extraClips: CreativeClip[]) => {
    const [clipMap, titles] = await Promise.all([readLaunchClips(session, launched), getData().listTitles(session).catch(() => [])]);
    for (const c of extraClips) clipMap.set(c.id, { ...c });
    const titleNames = new Map(titles.map((x) => [x.id, x.name_en || x.name_zh]));
    if (invented) titleNames.set("fake-title", tt("cda.fakeTitle"));
    return (
      <AdsTab
        session={session}
        locale={locale}
        range={range}
        today={today}
        fresh={fresh}
        launched={launched}
        invented={invented}
        clips={clipMap}
        titleNames={titleNames}
        filter={{ title: searchParams.ad_title || null, type: searchParams.ad_type || null }}
        vs={range === "all" ? null : tt(`cdx.vs.${range}`)}
      />
    );
  };
  if (!read.ok) {
    return (
      <>
        {head}
        {tab === "ads" ? (
          <>
            {tabs}
            {await adsTab(pacificToday(), null, [])}
          </>
        ) : (
          <ReadFailure read={read} locale={locale} />
        )}
      </>
    );
  }

  const report = read.report;
  // Fixture mode: the fake report's ads get invented launch records (never stored), so Campaigns has spend to show.
  // Fixture mode also gets an earlier invented launch (four more clips) so the Ads tab has a spread.
  const fake = read.mode === "fake" ? fakeStatsLaunches() : null;
  const archive = read.mode === "fake" ? fakeStatsArchive() : null;
  const invented = fake && archive ? [...fake.runs, ...archive.runs] : null;
  const inventedClips: CreativeClip[] = fake && archive ? [...FAKE_STATS_CLIPS, ...archive.clips].map((c) => ({ ...c })) : [];
  const runs = invented ? [...launched, ...invented] : launched;
  const [realDays, clips] = await Promise.all([readTikTokAdDays(launched, { to: report.to, fresh }), readLaunchClips(session, launched)]);
  for (const c of inventedClips) clips.set(c.id, { ...c });
  const adDays = withDays(withDays(realDays, fake?.days ?? null), archive?.days ?? null);

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
  // Coins and VIP (crazydramas since 2026-09-28): every payment, cash the day it was paid.
  const money = hasMoneyDetails(report);
  const price = firstWeekPrice();
  const pays = money ? paymentsIn(report, span, filter) : null;
  const paysBefore = money && prev ? paymentsIn(report, prev, filter) : null;
  // The Paywall, VIP and Coins tabs are the whole site: crazydramas does not split those numbers by series or source.
  const allPays = money ? paymentsIn(report, span, NO_FILTER) : null;
  const allPaysBefore = money && prev ? paymentsIn(report, prev, NO_FILTER) : null;
  const filtered = !!(filter.series || filter.source || filter.device || filter.country);
  const wholeSiteNote = filtered ? <p className="note">{tt("cdm.wholeSite")}</p> : null;
  const daysOf = (r: { from: string; to: string }) => {
    const out: string[] = [];
    for (let d = r.from; d <= r.to; d = nextDay(d)) out.push(d);
    return out;
  };
  const newWatchers = (r: { from: string; to: string }) => report.days.filter((d) => d.day >= r.from && d.day <= r.to).reduce((a, d) => a + d.new_watchers, 0);

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

  return (
    <>
      {head}
      <div className="cdx-bar">
        {tab !== "ads" && <FilterBar
          range={range}
          keep={Object.fromEntries(Object.entries({ tab: tab === "overview" ? "" : tab, eps: eps === "1" ? "" : eps, ...here }).filter((e): e is [string, string] => !!e[1]))}
          value={{ series: seriesSlug, device: filter.device, source: filter.source, country: filter.country ?? null }}
          options={options}
        />}
        <span className="cdx-updated">
          {read.mode === "fake" ? tt("cdx.testData") : tt("cdx.updated", { time })} · <a href={`${hrefWith(here)}&fresh=1`}>{tt("cdx.refresh")}</a>
        </span>
      </div>
      {tabs}
      <CoinValueNotice report={report} locale={locale} />

      {tab === "overview" && <OverviewTab />}
      {tab === "money" && <MoneyTab />}
      {tab === "paywall" && <PaywallTab />}
      {tab === "vip" && <VipTab />}
      {tab === "coins" && <CoinsTab />}
      {tab === "campaigns" && <CampaignsTab />}
      {tab === "ads" && (await adsTab(report.to, invented, inventedClips))}
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
    // Cash from the payments for the whole site; with a filter, the source rows' money, which crazydramas credits
    // where it belongs (coins where spent, split by source, phone and country), as the Series and Campaigns tabs.
    const cash = money && !filtered;
    const chartPays = cash ? paymentsIn(report, chart, filter) : null;
    const revenueDays = chartPays
      ? spendDays.map((d) => chartPays.filter((p) => p.day === d.day && !p.refunded).reduce((a, p) => a + p.cents, 0))
      : paidDays && !money
        ? spendDays.map((d) => onDay(paidDays, d.day).reduce((a, p) => a + p.amount_cents, 0))
        : dailyTotals(report, chart, filter).map((d) => d.totals.revenue_cents);
    const buyerDays = paidDays ? spendDays.map((d) => new Set(onDay(paidDays, d.day).map((p) => p.person)).size) : dailyTotals(report, chart, filter).map((d) => d.totals.buyers);
    const known = (list: { cents: number | null }[]) => (list.every((d) => d.cents !== null) ? list.reduce((a, d) => a + (d.cents ?? 0), 0) : null);
    const spendKnown = !spendDays.every((d) => d.cents === null);

    const spend = adSpends.length ? spendIn(adSpends, adPeriod) : { cents: null, partial: false };
    const spendBefore = prev && adSpends.length ? known(dailySpend(adSpends, adDays, prev)) : null;
    const net = (list: CdStatsPayment[]) => moneyTotals(list).net_cents;
    const revenue = cash && pays ? net(pays) : paid && !money ? paid.reduce((a, p) => a + p.amount_cents, 0) : totals.revenue_cents;
    const revenueBefore = prev ? (cash && paysBefore ? net(paysBefore) : paidBefore && !money ? paidBefore.reduce((a, p) => a + p.amount_cents, 0) : (before?.revenue_cents ?? null)) : null;
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
    // With coins and VIP: new payers (a person's first payment of all), and what each one from ads cost.
    const firstsOf = (list: CdStatsPayment[]) => moneyTotals(list).first_payers;
    const firstFromAds = (list: CdStatsPayment[]) => {
      const ads = new Set(paymentsIn({ payments: list }, { from: "0000-00-00", to: "9999-99-99" }, { source: "ads" }));
      return new Set(list.filter((p) => p.first && !p.refunded && ads.has(p)).map((p) => p.person)).size;
    };
    const newPayers = pays ? firstsOf(pays) : null;
    const newPayersBefore = paysBefore ? firstsOf(paysBefore) : null;
    const perFirst = pays && spend.cents !== null && firstFromAds(pays) > 0 ? Math.round(spend.cents / firstFromAds(pays)) : null;
    const perFirstBefore = paysBefore && spendBefore !== null && firstFromAds(paysBefore) > 0 ? Math.round(spendBefore / firstFromAds(paysBefore)) : null;
    const firstDays = chartPays ? spendDays.map((d) => new Set(chartPays.filter((p) => p.day === d.day && p.first && !p.refunded).map((p) => p.person)).size) : null;

    const steps = dashPath(totals).filter((s) => ["seen", "played", "finished", "ep2", "paywall", "checkout", "paid"].includes(s.key));
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
          <KpiCard label={tt("cdx.kpi.revenue")} info={tt(cash ? "cdo.cashInfo" : money ? "cdo.creditInfo" : details ? "cdo.revenueInfo" : "cdx.info.revenue")} value={fmtUsdCents(revenue)} change={changeAbove(revenue, revenueBefore, 1000)} vs={vs} spark={revenueDays} href={money ? hrefWith({ tab: "money" }) : undefined} />
          <KpiCard
            label={tt("cdo.roas")}
            info={tt("cdo.roasInfo")}
            value={fmtRatio(roas)}
            sub={roas !== null ? tt("cdo.roasSub", { back: fmtUsdCents(Math.round(roas * 100)) }) : null}
            change={roas !== null && roasBefore ? (roas - roasBefore) / roasBefore : null}
            vs={vs}
            spark={spendKnown ? spendDays.map((d, i) => (d.cents ? revenueDays[i] / d.cents : 0)) : undefined}
          />
          {pays ? (
            <KpiCard
              label={tt("cdo.perFirst")}
              info={tt("cdo.perFirstInfo")}
              value={perFirst === null ? "–" : fmtUsdCents(perFirst)}
              change={perFirstBefore !== null ? changeAbove(perFirst, perFirstBefore, 1) : null}
              vs={vs}
              upIsGood={false}
            />
          ) : (
            <KpiCard
              label={tt("cdo.perBuyer")}
              info={tt("cdo.perBuyerInfo")}
              value={perBuyer === null ? "–" : fmtUsdCents(perBuyer)}
              sub={tt(adBuyersNow === 1 ? "cdo.adBuyers1" : "cdo.adBuyers", { n: n0(adBuyersNow) })}
              change={adBuyersBefore && adBuyersBefore >= 3 ? changeAbove(perBuyer, perBuyerBefore, 1) : null}
              vs={vs}
              upIsGood={false}
            />
          )}
          {pays && newPayers !== null ? (
            <KpiCard
              label={tt("cdo.firstPayers")}
              info={tt("cdo.firstPayersInfo")}
              value={tt(newPayers === 1 ? "cdc.people1" : "cdc.people", { n: n0(newPayers) })}
              change={change(newPayers, newPayersBefore)}
              vs={vs}
              spark={firstDays ?? undefined}
              href={hrefWith({ tab: "money" })}
            />
          ) : (
            <KpiCard
              label={tt("cdx.kpi.buyers")}
              info={tt(details ? "cdo.buyersInfo" : "cdx.info.buyers")}
              value={tt(people === 1 ? "cdc.people1" : "cdc.people", { n: n0(people) })}
              sub={counts ? tt(counts.purchases === 1 ? "cdc.purchases1" : "cdc.purchases", { n: n0(counts.purchases) }) : null}
              change={change(people, peopleBefore)}
              vs={vs}
              spark={buyerDays}
              href={hrefWith({ tab: "money" })}
            />
          )}
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
          <CheckoutLine totals={totals} />
        </section>
        <WhyTheyStop totals={totals} />

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
          <CampaignsView rows={viewRows} caption={tt("cdx.ads.campaigns")} launchedLabel={launchedLabel} returns={money} />
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

  function MoneyTab() {
    const person = searchParams.person ? personOf(report, searchParams.person) : null;
    const buyersList = paid ? (
      <>
        {searchParams.person && !person && <p className="note">{tt("cdb.person.notFound", { code: searchParams.person })}</p>}
        {person && <PersonPanel person={person} names={names} closeHref={hrefWith({})} locale={locale} />}
        <section className="rs-panel cdx-card">
          <div className="cdx-card-head">
            <h2>{tt("cdb.list")}</h2>
            <span className="cdx-muted">{tt("cdb.listSub", { people: n0(buyerCounts(paid).people), purchases: n0(buyerCounts(paid).purchases) })}</span>
          </div>
          <BuyersTable list={paid} browsers={browsersOf(report.purchases ?? [])} names={names} personHref={personHref} current={person?.person ?? null} locale={locale} />
        </section>
      </>
    ) : null;
    if (!pays) return buyersList ?? <p className="rs-empty">{tt("cdb.none")}</p>;
    const t = moneyTotals(pays);
    const tb = paysBefore ? moneyTotals(paysBefore) : null;
    const chart = chartSpan(report, range);
    const chartDays = daysOf(chart);
    const stack = moneyByDay(paymentsIn(report, chart, filter), chartDays);
    const spark = (f: (d: (typeof stack)[number]) => number) => stack.map(f);
    const kinds: PaymentKind[] = ["coins", "vip_intro", "vip", "vip_renewal", "series"];
    const colour: Record<PaymentKind, StackSeries["colour"]> = { coins: 1, vip_intro: 5, vip: 3, vip_renewal: 4, series: 2 };
    const series: StackSeries[] = [...kinds.map((k) => ({ key: k, label: tt(`cdm.kind.${k}`, { price }), colour: colour[k] })), { key: "refunds", label: tt("cdm.kind.refunds"), colour: "neg" as const, below: true }];
    // Over the same people as the payers: everyone new on the site, or with a filter the rows' people who opened.
    const newViewers = filtered ? totals.opened : newWatchers(span);
    const newViewersBefore = prev ? (filtered ? (before?.opened ?? 0) : newWatchers(prev)) : 0;
    const seriesCoins = filter.series ? (coinsBySeries(report, span).get(filter.series)?.cents ?? 0) : 0;
    const rate = newViewers ? t.first_payers / newViewers : null;
    const rateBefore = tb && newViewersBefore ? tb.first_payers / newViewersBefore : null;
    const productName = (product: string, kind: PaymentKind) => {
      const pack = /^coins:c(\d+)(first)?$/.exec(product);
      if (pack) return pack[2] ? tt("cdm.product.first", { coins: n0(Number(pack[1])), bonus: "75" }) : tt("cdm.product.coins", { coins: n0(Number(pack[1])) });
      if (kind === "vip_intro") return tt("cdm.product.firstWeek", { price });
      if (["all_access_weekly", "vip_monthly", "vip_yearly"].includes(product)) return tt(`cdm.product.${product}`);
      return kind === "series" ? tt("cdm.product.series") : product;
    };
    const mix = productMix(pays).map((m) => ({ ...m, product: m.kind === "vip_intro" ? "vip_intro" : m.product }));
    return (
      <>
        {(filter.device || filter.country) && !paymentsHaveOrigin(report) && <p className="note">{tt("cdm.scopeNote")}</p>}
        {filter.series && <p className="note">{tt("cdm.seriesNote", { cash: fmtUsdCents(seriesCoins) })}</p>}
        <div className="cdx-kpis cdx-kpis-5">
          <KpiCard label={tt("cdm.cash")} info={tt("cdm.cashInfo")} value={fmtUsdCents(t.cash_cents)} change={tb ? changeAbove(t.cash_cents, tb.cash_cents, 1000) : null} vs={vs} spark={spark(moneyDayCash)} />
          <KpiCard label={tt("cdm.refunds")} info={tt("cdm.refundsInfo")} value={fmtUsdCents(t.refund_cents)} sub={tt("cdm.refundsSub", { n: n0(t.refunds) })} change={tb ? changeAbove(t.refund_cents, tb.refund_cents, 1000) : null} vs={vs} upIsGood={false} />
          <KpiCard label={tt("cdm.payers")} info={tt("cdm.payersInfo")} value={n0(t.payers)} sub={tt("cdm.firstPayersSub", { n: n0(t.first_payers) })} change={change(t.payers, tb?.payers ?? null)} vs={vs} />
          <KpiCard label={tt("cdm.payerRate")} info={tt("cdm.payerRateInfo")} value={fmtShare(rate)} change={rate !== null && rateBefore ? (rate - rateBefore) / rateBefore : null} vs={vs} />
          <KpiCard label={tt("cdm.perPayer")} info={tt("cdm.perPayerInfo")} value={perPayer(t) === null ? "–" : fmtUsdCents(perPayer(t)!)} sub={tt("cdm.toPay") + ": " + fmtDuration(medianToFirstPay(pays))} change={tb ? changeAbove(perPayer(t), perPayer(tb), 1) : null} vs={vs} />
        </div>
        <section className="rs-panel cdx-card">
          <StackedDaysChart id="cdm-money-kinds" title={tt("cdm.chart")} days={stack.map(({ day, ...values }) => ({ day, values }))} series={series} fmt={(v) => fmtUsdCents(v).replace(/\.00$/, "")} tableLabel={tt("cdx.numbers")} />
        </section>
        <section className="rs-panel cdx-card">
          <div className="cdx-card-head">
            <h2>{tt("cdm.mix")}</h2>
          </div>
          <div className="an-scroll" tabIndex={0} role="region" aria-label={tt("cdm.mix")}>
            <table className="an-table cds-table cdx-table">
              <thead>
                <tr>
                  <th scope="col">{tt("cdm.col.product")}</th>
                  <th scope="col" className="gt-num">{tt("cdm.col.payments")}</th>
                  <th scope="col" className="gt-num">{tt("cdm.col.cash")}</th>
                </tr>
              </thead>
              <tbody>
                {mix.map((m) => (
                  <tr key={m.product}>
                    <th scope="row" className="cds-title">{productName(m.product, m.kind)}</th>
                    <td className="gt-num">{n0(m.payments)}</td>
                    <td className="gt-num">{fmtUsdCents(m.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        {buyersList}
      </>
    );
  }

  function PaywallTab() {
    if (!pays) return <p className="rs-empty">{tt("cdm.none")}</p>;
    const pw = paywallIn(report, span);
    const pwBefore = prev ? paywallIn(report, prev) : null;
    const rows = placementRows(pw, allPays ?? []);
    const rowsBefore = pwBefore && allPaysBefore ? placementRows(pwBefore, allPaysBefore) : null;
    const sheetRate = pw.views ? rows[0].paid / pw.views : null;
    const sheetRateBefore = rowsBefore && pwBefore?.views ? rowsBefore[0].paid / pwBefore.views : null;
    const taken = firstOffersTaken(allPays ?? []);
    const takenBefore = allPaysBefore ? firstOffersTaken(allPaysBefore) : null;
    const top = Math.max(1, ...rows.map((r) => r.paid));
    return (
      <>
        {wholeSiteNote}
        <div className="cdx-kpis cdx-kpis-5">
          <KpiCard label={tt("cdw.views")} info={tt("cdw.viewsInfo")} value={n0(pw.views)} change={change(pw.views, pwBefore?.views ?? null)} vs={vs} />
          <KpiCard label={tt("cdw.conv")} info={tt("cdw.convInfo")} value={fmtShare(sheetRate)} sub={tt("cdvip.ofSub", { a: n0(rows[0].paid), b: n0(pw.views) })} change={sheetRate !== null && sheetRateBefore ? (sheetRate - sheetRateBefore) / sheetRateBefore : null} vs={vs} />
          <KpiCard label={tt("cdw.unlocks")} info={tt("cdw.unlocksInfo")} value={n0(pw.unlocks)} change={change(pw.unlocks, pwBefore?.unlocks ?? null)} vs={vs} />
          <KpiCard label={tt("cdw.firstWeek", { price })} info={tt("cdw.firstWeekInfo", { price })} value={n0(taken.first_week)} sub={`${tt("cdw.firstPack")}: ${n0(taken.first_pack)}`} change={change(taken.first_week, takenBefore?.first_week ?? null)} vs={vs} />
          <KpiCard label={tt("cdw.notCompleted")} info={tt("cdw.notCompletedInfo")} value={n0(pw.not_completed)} change={change(pw.not_completed, pwBefore?.not_completed ?? null)} vs={vs} upIsGood={false} />
        </div>
        <section className="rs-panel cdx-card">
          <div className="cdx-card-head">
            <h2>
              {tt("cdw.table")} <Info text={tt("cdw.tableInfo")} label={tt("cdx.about", { what: tt("cdw.table") })} />
            </h2>
          </div>
          <div className="an-scroll" tabIndex={0} role="region" aria-label={tt("cdw.table")}>
            <table className="an-table cds-table cdx-table">
              <thead>
                <tr>
                  <th scope="col" />
                  <th scope="col" className="gt-num">{tt("cdw.col.shown")}</th>
                  <th scope="col" className="gt-num">{tt("cdw.col.checkouts")}</th>
                  <th scope="col" className="gt-num">{tt("cdw.col.paid")}</th>
                  <th scope="col" className="gt-num">{tt("cdw.col.rate")}</th>
                  <th scope="col" className="gt-num">{tt("cdm.col.cash")}</th>
                  <th scope="col" className="cdm-bar-cell" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.placement}>
                    <th scope="row" className="cds-title">{tt(`cdw.pl.${r.placement}`)}</th>
                    <td className="gt-num">{r.shown === null ? "–" : n0(r.shown)}</td>
                    <td className="gt-num">{n0(r.checkouts)}</td>
                    <td className="gt-num">{n0(r.paid)}</td>
                    <td className="gt-num">{r.shown ? fmtShare(share(r.paid, r.shown)) : "–"}</td>
                    <td className="gt-num">{fmtUsdCents(r.cents)}</td>
                    <td className="cdm-bar-cell">
                      <span className="cdm-bar" style={{ width: `${Math.round((r.paid / top) * 100)}%` }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <WhyTheyStop totals={totals} />
      </>
    );
  }

  function VipTab() {
    if (!pays) return <p className="rs-empty">{tt("cdm.none")}</p>;
    const now = vipNow(report);
    const per = vipPeriod(report, span);
    const perBefore = prev ? vipPeriod(report, prev) : null;
    const ended = vipEnded(report, span);
    const endedBefore = prev ? vipEnded(report, prev) : null;
    const introRate = per.intros_due ? per.intros_renewed / per.intros_due : null;
    const introRateBefore = perBefore?.intros_due ? perBefore.intros_renewed / perBefore.intros_due : null;
    const weeks = vipWeeks(report, chartSpan(report, range === "today" || range === "7d" ? "30d" : range));
    const series: StackSeries[] = [
      { key: "new_intro", label: tt("cdvip.s.intro", { price }), colour: 5 },
      { key: "new_full", label: tt("cdvip.s.full"), colour: 3 },
      { key: "renewals", label: tt("cdvip.s.renewals"), colour: 4 },
      { key: "ended", label: tt("cdvip.s.ended"), colour: "neg", below: true },
    ];
    return (
      <>
        {wholeSiteNote}
        <div className="cdx-kpis cdx-kpis-5">
          <KpiCard label={tt("cdvip.active")} info={tt("cdvip.activeInfo")} value={n0(now.active)} sub={tt("cdvip.activeSub", { w: n0(now.by_plan.weekly), m: n0(now.by_plan.monthly), y: n0(now.by_plan.yearly) })} />
          <KpiCard label={tt("cdvip.mrr")} info={tt("cdvip.mrrInfo", { price })} value={fmtUsdCents(now.mrr_cents)} sub={`${tt("cdvip.intros", { price })}: ${n0(now.intros)}`} />
          <KpiCard label={tt("cdvip.new")} info={tt("cdvip.newInfo", { price })} value={n0(per.new_intro + per.new_full)} sub={tt("cdvip.newSub", { price, i: n0(per.new_intro), f: n0(per.new_full) })} change={perBefore ? change(per.new_intro + per.new_full, perBefore.new_intro + perBefore.new_full) : null} vs={vs} />
          <KpiCard label={tt("cdvip.introRate")} info={tt("cdvip.introRateInfo", { price })} value={fmtShare(introRate)} sub={tt("cdvip.ofSub", { a: n0(per.intros_renewed), b: n0(per.intros_due) })} change={introRate !== null && introRateBefore ? (introRate - introRateBefore) / introRateBefore : null} vs={vs} />
          <KpiCard
            label={tt("cdvip.ended")}
            info={tt("cdvip.endedInfo")}
            value={n0(ended)}
            sub={now.cancelling === null ? null : tt("cdvip.cancellingSub", { n: n0(now.cancelling) })}
            change={change(ended, endedBefore)}
            vs={vs}
            upIsGood={false}
          />
        </div>
        <section className="rs-panel cdx-card">
          <StackedDaysChart id="cdm-vip-weeks" title={tt("cdvip.chart")} days={weeks.map((w) => ({ day: w.week, values: { new_intro: w.new_intro, new_full: w.new_full, renewals: w.renewals, ended: w.ended } }))} series={series} fmt={(v) => n0(v)} tableLabel={tt("cdx.numbers")} firstCol={tt("cdvip.weekOf")} />
          <p className="cdm-note">{tt("cdvip.renewalLine", { n: n0(per.renewals), cash: fmtUsdCents(per.renewal_cents) })}</p>
        </section>
      </>
    );
  }

  function CoinsTab() {
    if (!pays) return <p className="rs-empty">{tt("cdm.none")}</p>;
    const c = coinsIn(report, span);
    const cb = prev ? coinsIn(report, prev) : null;
    const repeat = repeatCoinBuyers(report, allPays ?? []);
    const repeatRate = repeat.buyers ? repeat.repeat / repeat.buyers : null;
    const chartDays = daysOf(chartSpan(report, range));
    const stack = coinsByDay(report, chartDays);
    const series: StackSeries[] = [
      { key: "bought", label: tt("cdcoin.s.bought"), colour: 1 },
      { key: "bonus", label: tt("cdcoin.s.bonus"), colour: 4 },
      { key: "reward", label: tt("cdcoin.s.reward"), colour: 3 },
      { key: "spent_paid", label: tt("cdcoin.s.spent_paid"), colour: "neg", below: true },
      { key: "spent_bonus", label: tt("cdcoin.s.spent_bonus"), colour: 5, below: true },
      { key: "expired", label: tt("cdcoin.s.expired"), colour: 2, below: true },
    ];
    const unspent = report.coins;
    return (
      <>
        {wholeSiteNote}
        <div className="cdx-kpis cdx-kpis-5">
          <KpiCard label={tt("cdcoin.bought")} info={tt("cdcoin.boughtInfo")} value={n0(c.bought)} sub={tt("cdcoin.bonusSub", { n: n0(c.bonus) })} change={change(c.bought, cb?.bought ?? null)} vs={vs} spark={stack.map((d) => d.bought)} />
          <KpiCard label={tt("cdcoin.spent")} info={tt("cdcoin.spentInfo")} value={n0(c.spent_paid + c.spent_bonus)} sub={tt("cdcoin.spentSub", { paid: n0(c.spent_paid), bonus: n0(c.spent_bonus) })} change={cb ? change(c.spent_paid + c.spent_bonus, cb.spent_paid + cb.spent_bonus) : null} vs={vs} spark={stack.map((d) => d.spent_paid + d.spent_bonus)} />
          <KpiCard label={tt("cdcoin.reward")} info={tt("cdcoin.rewardInfo")} value={n0(c.reward)} change={change(c.reward, cb?.reward ?? null)} vs={vs} />
          <KpiCard label={tt("cdcoin.unspent")} info={tt("cdcoin.unspentInfo")} value={fmtUsdCents(unspent?.unspent_paid_cents ?? 0)} sub={tt("cdcoin.coinsSub", { n: n0(unspent?.unspent_paid ?? 0) })} />
          <KpiCard label={tt("cdcoin.repeat")} info={tt("cdcoin.repeatInfo")} value={fmtShare(repeatRate)} sub={`${tt("cdvip.ofSub", { a: n0(repeat.repeat), b: n0(repeat.buyers) })} · ${tt("cdcoin.expired")}: ${n0(c.expired)}`} />
        </div>
        <section className="rs-panel cdx-card">
          <StackedDaysChart id="cdm-coins-flow" title={tt("cdcoin.chart")} days={stack.map(({ day, ...values }) => ({ day, values }))} series={series} fmt={(v) => n0(v)} tableLabel={tt("cdx.numbers")} />
        </section>
      </>
    );
  }

  // The player's two one-tap questions (pausing episode 1; closing the unlock screen), scoped like
  // every other number by the filter row: the answer to "why did they leave" beside where they left.
  /** What happened after tapping pay: paid, came back unpaid, never came back. Nothing when nobody tapped. */
  function CheckoutLine({ totals: x }: { totals: typeof totals }) {
    const o = checkoutOutcome(x);
    if (!o.tapped) return null;
    return (
      <p className="cdx-note">
        {tt("cdx.checkout.outcome", { n: n0(o.tapped), paid: n0(o.paid), back: n0(o.came_back), gone: n0(o.gone) })}{" "}
        <Info text={tt("cdx.checkout.outcomeInfo")} label={tt("cdx.about", { what: tt("cdx.checkout.outcomeName") })} />
      </p>
    );
  }

  function WhyTheyStop({ totals: x, title }: { totals: typeof totals; title?: string }) {
    return (
      <section className="rs-panel cdx-card">
        <div className="cdx-card-head">
          <h2>
            {title ?? tt("cdx.why")} <Info text={tt("cds.survey.sub")} label={tt("cdx.about", { what: tt("cdx.why") })} />
          </h2>
        </div>
        <div className="cds-surveys">
          <SurveyView kind="ep1_stop" shown={x.survey_ep1_shown} answers={x.survey_ep1} locale={locale} />
          <SurveyView kind="paywall_close" shown={x.survey_paywall_shown} answers={x.survey_paywall} locale={locale} />
        </div>
      </section>
    );
  }

  function SeriesTab() {
    const groups = dashBy(dashRows(report, span, filter, "series"), (x) => x.drama_id);
    const bySlug = (slug?: string) => (slug ? report.series.find((s) => s.slug === slug) : undefined);
    const top = [...groups].sort((a, b) => b.totals.started_ep1 - a.totals.started_ep1)[0];
    const shown = bySlug(searchParams.curve) ?? (filter.series ? titleOf.get(filter.series) : undefined) ?? (top ? titleOf.get(top.key) : undefined);
    const curve = shown ? episodeCurve(shown, span, report.journeys) : null;
    const fun = shown ? seriesFunnel(sumRows(dashRows(report, span, { ...filter, series: shown.drama_id }))) : null;
    const coinSpend = report.coins ? coinsBySeries(report, span) : null;
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
              <CheckoutLine totals={sumRows(dashRows(report, span, { ...filter, series: shown.drama_id }))} />
            </section>
          </div>
        ) : null}
        {shown && curve && fun ? (
          <WhyTheyStop totals={sumRows(dashRows(report, span, { ...filter, series: shown.drama_id }))} title={`${tt("cdx.why")} · ${shown.title}`} />
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
                  <th scope="col" className="gt-num">{tt("cdx.col.checkout")}</th>
                  <th scope="col" className="gt-num">{tt("cdx.kpi.buyers")}</th>
                  <th scope="col" className="gt-num">{tt("cdx.kpi.revenue")}</th>
                  {coinSpend && (
                    <th scope="col" className="gt-num">
                      {tt("cdx.col.coins")} <Info text={tt("cdx.col.coinsInfo")} label={tt("cdx.about", { what: tt("cdx.col.coins") })} />
                    </th>
                  )}
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
                      <td className="gt-num" title={tt("cdx.checkout.outcome", { n: n0(x.checkouts), paid: n0(x.buyers), back: n0(x.checkout_cancelled), gone: n0(checkoutOutcome(x).gone) })}>
                        {n0(x.checkouts)}
                      </td>
                      <td className="gt-num">{n0(x.buyers)}</td>
                      <td className="gt-num">{fmtUsdCents(x.revenue_cents)}</td>
                      {coinSpend && <td className="gt-num">{fmtUsdCents(coinSpend.get(g.key)?.cents ?? 0)}</td>}
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
