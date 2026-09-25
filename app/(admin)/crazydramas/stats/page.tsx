import "@/app/crazydramas-stats.css";
import { adminLocale, staffSession } from "@/components/admin/server";
import { Definitions, RangeTabs, ReadFailure, ReadLine, Tile } from "@/components/admin/cd-stats/Bits";
import { DailyChart } from "@/components/admin/cd-stats/Charts";
import { readCrazydramasStats } from "@/lib/crazydramas/stats";
import { audience, fmtShare, fmtUsdCents, parseStatsRange, rangeDays, seriesTable, share, type SeriesTotals } from "@/lib/crazydramas/stats-summary";
import { t } from "@/lib/i18n";

// /crazydramas/stats — viewing and money on crazydramas.com, staff only
// (decision 2026-09-24, "CrazyDramas stats"): the audience per day (DAU,
// WAU, MAU), the money, and one row per series following the people who
// first opened it in the period, in plain words. Real people only; the
// numbers come from crazydramas' GET /api/studio/stats (lib/crazydramas/stats.ts).

export const dynamic = "force-dynamic";

const n0 = (v: number) => v.toLocaleString("en-US");

function Cell({ n, of }: { n: number; of: number }) {
  return (
    <td className="gt-num">
      {n0(n)}
      {n > 0 && <span className="cds-sub">{fmtShare(share(n, of))}</span>}
    </td>
  );
}

export default async function CrazydramasStatsPage({ searchParams }: { searchParams: { range?: string; fresh?: string } }) {
  await staffSession();
  const locale = adminLocale();
  const range = parseStatsRange(searchParams.range);
  const read = await readCrazydramasStats({ fresh: searchParams.fresh === "1" });
  const hrefFor = (r: string) => `/crazydramas/stats?range=${r}`;

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
  const aud = audience(report, range);
  const rows = seriesTable(report, range);
  const seen = rows.filter((r) => r.opened > 0 || r.revenue_cents > 0);
  const unseen = rows.filter((r) => !(r.opened > 0 || r.revenue_cents > 0));
  const robotVisits = rows.reduce((a, r) => a + r.robots, 0);
  const today = aud.today;

  return (
    <>
      {head}
      <ReadLine read={read} span={span} refreshHref={`${hrefFor(range)}&fresh=1`} locale={locale} />

      <section className="rs-panel cds-section" aria-labelledby="cds-aud-h">
        <div className="rs-panel-head">
          <div>
            <h2 id="cds-aud-h">{t(locale, "cds.aud.title")}</h2>
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
            <h2 id="cds-money-h">{t(locale, "cds.money.title")}</h2>
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

      <section className="rs-panel cds-section" aria-labelledby="cds-series-h">
        <div className="rs-panel-head">
          <div>
            <h2 id="cds-series-h">{t(locale, "cds.series.title")}</h2>
            <p>{t(locale, "cds.series.sub")}</p>
          </div>
        </div>
        <div className="rs-panel-body">
          <div className="an-scroll" tabIndex={0} role="region" aria-labelledby="cds-series-h">
            <table className="an-table cds-table">
              <thead>
                <tr>
                  <th scope="col">{t(locale, "cds.col.series")}</th>
                  <th scope="col" className="gt-num">{t(locale, "cds.col.opened")}</th>
                  <th scope="col" className="gt-num">{t(locale, "cds.col.playedEp1")}</th>
                  <th scope="col" className="gt-num">{t(locale, "cds.col.finishedEp1")}</th>
                  <th scope="col" className="gt-num">{t(locale, "cds.col.watchedEp", { n: 2 })}</th>
                  <th scope="col" className="gt-num">{t(locale, "cds.col.watchedEp", { n: 3 })}</th>
                  <th scope="col" className="gt-num">{t(locale, "cds.col.paywall")}</th>
                  <th scope="col" className="gt-num">{t(locale, "cds.col.checkouts")}</th>
                  <th scope="col" className="gt-num">{t(locale, "cds.col.buyers")}</th>
                  <th scope="col" className="gt-num">{t(locale, "cds.col.revenue")}</th>
                </tr>
              </thead>
              <tbody>
                {seen.map((r: SeriesTotals) => (
                  <tr key={r.drama_id}>
                    <th scope="row" className="cds-title">
                      <a href={`/crazydramas/stats/${encodeURIComponent(r.slug)}?range=${range}`}>{r.title}</a>
                    </th>
                    <td className="gt-num">{n0(r.opened)}</td>
                    <Cell n={r.started_ep1} of={r.opened} />
                    <Cell n={r.finished_ep1} of={r.opened} />
                    <Cell n={r.episodes_watched[1] ?? 0} of={r.opened} />
                    <Cell n={r.episodes_watched[2] ?? 0} of={r.opened} />
                    <Cell n={r.paywall} of={r.opened} />
                    <Cell n={r.checkouts} of={r.opened} />
                    <Cell n={r.buyers} of={r.opened} />
                    <td className="gt-num">{fmtUsdCents(r.revenue_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {unseen.length > 0 && <p className="cds-foot">{t(locale, "cds.series.none", { titles: unseen.map((r) => r.title).join(" · ") })}</p>}
          <p className="cds-foot">{t(locale, "cds.series.robots", { n: n0(robotVisits) })}</p>
        </div>
      </section>

      <Definitions robots={report.robots.people} locale={locale} />
    </>
  );
}
