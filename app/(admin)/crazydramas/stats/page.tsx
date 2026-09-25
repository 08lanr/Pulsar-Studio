import "@/app/crazydramas-stats.css";
import { adminLocale, staffSession } from "@/components/admin/server";
import { Definitions, RangeTabs, ReadFailure, ReadLine, Tile } from "@/components/admin/cd-stats/Bits";
import { DailyChart } from "@/components/admin/cd-stats/Charts";
import CampaignTable from "@/components/admin/cd-stats/CampaignTable";
import { BeforeStart, BreakdownTable, HistView, PathView, type BreakdownRow } from "@/components/admin/cd-stats/Dash";
import FilterBar, { type FilterOptions } from "@/components/admin/cd-stats/FilterBar";
import { SurveyView } from "@/components/admin/cd-stats/Tables";
import TeamEditor from "@/components/admin/cd-stats/TeamEditor";
import { readAdPeriod, readCrazydramasStats } from "@/lib/crazydramas/stats";
import { readTeamList } from "@/lib/crazydramas/stats-team";
import {
  adSpendsFromRuns,
  audience,
  byDevice,
  campaignTable,
  dashBy,
  dashRows,
  DEVICE_ORDER,
  fmtShare,
  fmtUsdCents,
  notCounted,
  parseDashFilter,
  parseStatsRange,
  rangeDays,
  share,
  sourceOptions,
  sumRows,
  type DashFilter,
} from "@/lib/crazydramas/stats-summary";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";

// /crazydramas/stats — viewing and money on crazydramas.com, staff only
// (decisions 2026-09-24, "CrazyDramas stats"; 2026-09-25, "the stats
// dashboard"). One page with every number, narrowed by period, series, kind
// of phone and source: the headline, the path from landing to paying step by
// step, what happened before the video started (pages never on screen, waits,
// the player's restarts, sound, errors, and how long the page and the first
// frame took), then the same people by phone, by series and by ad, why they
// stopped, and, for the whole site, the audience, the money and what is not
// counted. Real people only; the numbers come from crazydramas'
// /api/studio/stats (lib/crazydramas/stats.ts), summed from its source rows
// (lib/crazydramas/stats-summary.ts, "the dashboard").

export const dynamic = "force-dynamic";

const n0 = (v: number) => v.toLocaleString("en-US");

type Search = { range?: string; fresh?: string; series?: string; device?: string; source?: string };

export default async function CrazydramasStatsPage({ searchParams }: { searchParams: Search }) {
  const session = await staffSession();
  const locale = adminLocale();
  const range = parseStatsRange(searchParams.range);
  const [read, team, runs] = await Promise.all([
    readCrazydramasStats({ fresh: searchParams.fresh === "1" }),
    readTeamList(),
    getData().listLaunchRuns(session).catch(() => []),
  ]);
  // Links keep the filters; `patch` changes some of them.
  const hrefWith = (patch: Partial<Search>) => {
    const q = new URLSearchParams();
    const next = { range, series: searchParams.series, device: searchParams.device, source: searchParams.source, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    return `/crazydramas/stats?${q.toString()}`;
  };
  const hrefFor = (r: string) => hrefWith({ range: r });

  const head = (
    <div className="page-head">
      <div>
        <h1>{t(locale, "cds.title")}</h1>
        <p className="page-sub">{t(locale, "cds.sub")}</p>
      </div>
      <div className="cds-head-tools">
        <RangeTabs range={range} hrefFor={hrefFor} locale={locale} />
      </div>
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
  const edges = report.timing_edges_s;
  const filter: DashFilter = parseDashFilter(searchParams, report);
  const spends = adSpendsFromRuns(runs);
  const titleOf = new Map(report.series.map((s) => [s.drama_id, s]));

  // Every number of the filtered people, and the breakdowns (each ignores its own filter).
  const totals = sumRows(dashRows(report, span, filter));
  const phones: BreakdownRow[] = byDevice(dashRows(report, span, filter, "device")).map((g) => ({
    key: g.key,
    name: t(locale, `cds.dev.${g.key}`),
    only: filter.device === g.key ? null : hrefWith({ device: g.key }),
    totals: g.totals,
  }));
  const seriesRows: BreakdownRow[] = dashBy(dashRows(report, span, filter, "series"), (x) => x.drama_id).map((g) => {
    const s = titleOf.get(g.key);
    return {
      key: g.key,
      name: s?.title ?? g.key,
      href: s ? `/crazydramas/stats/${encodeURIComponent(s.slug)}?range=${range}` : null,
      only: s && filter.series !== g.key ? hrefWith({ series: s.slug }) : null,
      totals: g.totals,
    };
  });

  // The filters' choices: series anybody opened in the period, phones seen, the period's ad campaigns.
  const campaignLabel = (key: string, name: string | null) => name ?? t(locale, "cdd.filter.campaign", { id: key.slice(9) });
  const sources = sourceOptions(report, span, spends);
  const devicesSeen = new Set(dashRows(report, span, { series: null, device: null, source: null }).map((x) => x.device));
  const options: FilterOptions = {
    series: report.series.filter((s) => s.cohorts.some((c) => c.day >= span.from && c.day <= span.to && c.opened + c.unseen > 0) || s.drama_id === filter.series).map((s) => ({ slug: s.slug, title: s.title })),
    devices: DEVICE_ORDER.filter((d) => devicesSeen.has(d) || d === filter.device),
    sources: [
      { key: "ads", label: t(locale, "cdd.filter.ads") },
      ...sources.map((s) => ({ key: s.key, label: campaignLabel(s.key, s.name) })),
      { key: "stored_copy", label: t(locale, "cds.ads.storedCopy") },
      { key: "no_ad", label: t(locale, "cds.ads.noAd") },
    ],
  };
  const seriesSlug = filter.series ? (titleOf.get(filter.series)?.slug ?? null) : null;
  const showing = [
    filter.series ? titleOf.get(filter.series)?.title : null,
    filter.device ? t(locale, `cds.dev.${filter.device}`) : null,
    filter.source ? (options.sources.find((s) => s.key === filter.source)?.label ?? filter.source) : null,
  ].filter(Boolean);

  // By ad follows the filters: its people are the filtered rows. Spend is per ad, not per phone, so with a
  // phone picked the costs would divide one ad's whole spend by one phone's people: hidden then.
  const adReport = { ...report, sources: dashRows(report, { from: report.from, to: report.to }, filter) };
  const adPeriod = await readAdPeriod(report, range, runs, searchParams.fresh === "1");
  // Only the picked source's ads carry spend (an ad that brought nobody still shows what it spent).
  const adSpends = filter.device
    ? []
    : !filter.source || filter.source === "ads"
      ? spends
      : filter.source.startsWith("campaign:")
        ? spends.filter((sp) => sp.campaign_id === filter.source!.slice(9))
        : [];
  const campaigns = campaignTable(adReport, adSpends, filter.series ?? undefined, adPeriod);

  const aud = audience(report, range);
  const out = notCounted(report, span);
  const today = aud.today;

  return (
    <>
      {head}
      <FilterBar range={range} value={{ series: seriesSlug, device: filter.device, source: filter.source }} options={options} />
      <ReadLine read={read} span={span} refreshHref={`${hrefFor(range)}&fresh=1`} locale={locale} />
      {showing.length > 0 && <p className="cdd-showing">{t(locale, "cdd.filter.showing", { what: showing.join(" · ") })}</p>}

      <section className="rs-panel cds-section" aria-labelledby="cdd-glance-h">
        <div className="rs-panel-head">
          <div>
            <h2 id="cdd-glance-h">{t(locale, "cdd.glance.title")}</h2>
            <p>{t(locale, "cdd.glance.sub")}</p>
          </div>
        </div>
        <div className="rs-panel-body">
          <div className="cds-tiles">
            <Tile label={t(locale, "cdd.glance.landed")} value={n0(totals.opened + totals.unseen)} note={t(locale, "cdd.glance.landedNote", { n: n0(totals.unseen) })} />
            <Tile hero label={t(locale, "cdd.glance.seen")} value={n0(totals.opened)} />
            <Tile label={t(locale, "cdd.glance.played")} value={n0(totals.started_ep1)} note={t(locale, "cdd.glance.of", { share: fmtShare(share(totals.started_ep1, totals.opened)) })} />
            <Tile label={t(locale, "cdd.glance.finished")} value={n0(totals.finished_ep1)} note={t(locale, "cdd.glance.of", { share: fmtShare(share(totals.finished_ep1, totals.opened)) })} />
            <Tile label={t(locale, "cdd.glance.ep2")} value={n0(totals.watched_ep2)} note={t(locale, "cdd.glance.of", { share: fmtShare(share(totals.watched_ep2, totals.opened)) })} />
            <Tile label={t(locale, "cdd.glance.paid")} value={n0(totals.buyers)} note={t(locale, "cdd.glance.paidNote", { revenue: fmtUsdCents(totals.revenue_cents) })} />
          </div>
        </div>
      </section>

      <section className="rs-panel cds-section" aria-labelledby="cdd-path-h" id="path">
        <div className="rs-panel-head">
          <div>
            <h2 id="cdd-path-h">{t(locale, "cdd.path.title")}</h2>
            <p>{t(locale, "cdd.path.sub")}</p>
          </div>
        </div>
        <div className="rs-panel-body">
          <PathView totals={totals} locale={locale} />
        </div>
      </section>

      <section className="rs-panel cds-section" aria-labelledby="cdd-before-h" id="before">
        <div className="rs-panel-head">
          <div>
            <h2 id="cdd-before-h">{t(locale, "cdd.before.title")}</h2>
            <p>{t(locale, "cdd.before.sub")}</p>
          </div>
        </div>
        <div className="rs-panel-body">
          <BeforeStart totals={totals} locale={locale} />
          <div className="cdd-hists">
            <HistView title={t(locale, "cdd.hist.load")} hist={totals.load_hist} edges={edges} locale={locale} />
            <HistView title={t(locale, "cdd.hist.start")} hist={totals.start_hist} edges={edges} locale={locale} />
            <HistView title={t(locale, "cdd.hist.wait")} hist={totals.wait_hist} edges={edges} locale={locale} />
          </div>
        </div>
      </section>

      <section className="rs-panel cds-section" aria-labelledby="cdd-phone-h" id="phones">
        <div className="rs-panel-head">
          <div>
            <h2 id="cdd-phone-h">{t(locale, "cdd.phone.title")}</h2>
            <p>{t(locale, "cdd.phone.sub")}</p>
          </div>
        </div>
        <div className="rs-panel-body">
          <BreakdownTable rows={phones} caption={t(locale, "cdd.phone.title")} edges={edges} locale={locale} />
        </div>
      </section>

      <section className="rs-panel cds-section" aria-labelledby="cds-series-h" id="series">
        <div className="rs-panel-head">
          <div>
            <h2 id="cds-series-h">{t(locale, "cdd.series.title")}</h2>
            <p>{t(locale, "cdd.series.sub")}</p>
          </div>
        </div>
        <div className="rs-panel-body">
          <BreakdownTable rows={seriesRows} caption={t(locale, "cdd.series.title")} edges={edges} revenue locale={locale} />
        </div>
      </section>

      <section className="rs-panel cds-section" aria-labelledby="cds-ads-h" id="ads">
        <div className="rs-panel-head">
          <div>
            <h2 id="cds-ads-h">{t(locale, "cds.ads.title")}</h2>
            <p>{t(locale, adPeriod ? "cds.ads.subPeriod" : "cds.ads.sub")}</p>
          </div>
        </div>
        <div className="rs-panel-body">
          {adPeriod?.days && !adPeriod.days.ok && <p className="note note-warn">{t(locale, "cds.ads.daysFailed", { error: adPeriod.days.error })}</p>}
          {filter.device && <p className="note">{t(locale, "cdd.ads.byPhoneNote")}</p>}
          <CampaignTable rows={campaigns} caption={t(locale, "cds.ads.title")} />
          <p className="cds-foot">{t(locale, "cds.ads.foot")}</p>
        </div>
      </section>

      <section className="rs-panel cds-section" aria-labelledby="cds-why-all-h" id="why">
        <div className="rs-panel-head">
          <div>
            <h2 id="cds-why-all-h">{t(locale, "cdd.why.title")}</h2>
            <p>{t(locale, "cdd.why.sub")}</p>
          </div>
        </div>
        <div className="rs-panel-body cds-surveys">
          <SurveyView kind="ep1_stop" shown={totals.survey_ep1_shown} answers={totals.survey_ep1} locale={locale} />
          <SurveyView kind="paywall_close" shown={totals.survey_paywall_shown} answers={totals.survey_paywall} locale={locale} />
        </div>
      </section>

      <section className="rs-panel cds-section" aria-labelledby="cds-aud-h">
        <div className="rs-panel-head">
          <div>
            <h2 id="cds-aud-h">{t(locale, "cdd.site.audience")}</h2>
            <p>{t(locale, "cds.aud.sub")}</p>
          </div>
        </div>
        <div className="rs-panel-body">
          <div className="cds-tiles">
            <Tile hero label={t(locale, "cds.aud.today")} value={n0(today?.watchers ?? 0)} note={t(locale, "cds.aud.opened", { n: n0(today?.visitors ?? 0) })} />
            <Tile label={t(locale, "cds.aud.yesterday")} value={n0(aud.yesterday?.watchers ?? 0)} note={t(locale, "cds.aud.opened", { n: n0(aud.yesterday?.visitors ?? 0) })} />
            <Tile label={t(locale, "cds.aud.wau")} value={n0(aud.wau)} note={t(locale, "cds.aud.distinct")} />
            <Tile label={t(locale, "cds.aud.mau")} value={n0(aud.mau)} note={t(locale, "cds.aud.distinct")} />
          </div>
          {aud.days.length > 1 && <DailyChart days={aud.days} locale={locale} />}
        </div>
      </section>

      <section className="rs-panel cds-section" aria-labelledby="cds-money-h">
        <div className="rs-panel-head">
          <div>
            <h2 id="cds-money-h">{t(locale, "cdd.site.money")}</h2>
            <p>{t(locale, "cds.money.sub")}</p>
          </div>
        </div>
        <div className="rs-panel-body">
          <div className="cds-tiles">
            <Tile label={t(locale, "cds.money.revenue")} value={fmtUsdCents(aud.money.revenue_cents)} />
            <Tile label={t(locale, "cds.money.payments")} value={n0(aud.money.payments)} />
            <Tile label={t(locale, "cds.money.first")} value={n0(aud.money.first_purchases)} />
            <Tile label={t(locale, "cds.money.renewals")} value={n0(aud.money.renewals)} />
          </div>
        </div>
      </section>

      <section className="rs-panel cds-section" aria-labelledby="cdd-out-h" id="not-counted">
        <div className="rs-panel-head">
          <div>
            <h2 id="cdd-out-h">{t(locale, "cdd.out.title")}</h2>
            <p>{t(locale, "cdd.out.sub")}</p>
          </div>
        </div>
        <div className="rs-panel-body">
          <div className="cds-tiles">
            <Tile
              label={t(locale, "cdd.out.robots")}
              value={n0(out.robots)}
              note={t(locale, "cdd.out.robotsNote", { crawler: n0(report.robots.crawler_ua), burst: n0(report.robots.burst), end: n0(report.robots.end_jump), link: n0(report.robots.link_check) })}
            />
            <Tile label={t(locale, "cdd.out.unseen")} value={n0(out.unseen)} note={t(locale, "cdd.out.unseenNote")} />
            <Tile label={t(locale, "cdd.out.browsed")} value={n0(out.browsed)} note={t(locale, "cdd.out.browsedNote")} />
          </div>
        </div>
      </section>

      <details className="rs-panel cds-section cds-team-panel" id="team">
        <summary className="rs-panel-head">
          <div>
            <h2>{t(locale, "cds.team.title", { n: team.emails.length })}</h2>
            <p>{t(locale, "cds.team.sub", { people: n0(report.team.people), payments: n0(report.team.payments), revenue: fmtUsdCents(report.team.revenue_cents) })}</p>
          </div>
        </summary>
        <div className="rs-panel-body">
          <TeamEditor emails={team.emails} canEdit={session.staffRole === "admin"} updatedAt={team.updated_at} updatedBy={team.updated_by} />
        </div>
      </details>

      <Definitions robots={report.robots.people} locale={locale} />
    </>
  );
}
