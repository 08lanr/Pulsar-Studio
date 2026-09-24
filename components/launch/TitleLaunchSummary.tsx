import { int, usd } from "@/components/tiktok/api";
import { t, type Locale } from "@/lib/i18n";
import type { TitleResults } from "@/lib/launch/title-stats";

// A title's ad results in one strip, for the title pages (server-rendered):
// what the launches that promote it spent and brought, read from the same
// stored launch readings the Monitor and the title's results page show
// (lib/launch/title-stats.ts), with the way to the full breakdown. Before
// any launch it says what to do next instead.

const money = (cents: number | null) => usd(cents === null ? null : cents / 100);

export default function TitleLaunchSummary({ locale, results, resultsHref, launchHref }: { locale: Locale; results: TitleResults; resultsHref: string; launchHref?: string | null }) {
  const x = results.totals;
  if (!results.campaigns.length) return <section className="rs-panel tls" data-testid="title-launch-summary">
    <div className="rs-panel-head"><div><h2>{t(locale, "mad.fromLaunches")}</h2><p>{t(locale, "mad.titleEmpty")}</p></div>
      {launchHref && <a className="btn btn-primary btn-sm" href={launchHref}>{t(locale, "launchFeedback.createLaunch")}</a>}</div>
  </section>;
  return <section className="rs-panel tls" data-testid="title-launch-summary">
    <div className="rs-panel-head"><div><h2>{t(locale, "mad.fromLaunches")}</h2><p>{t(locale, "mad.fromLaunchesSub", { launches: results.launches, campaigns: results.campaigns.length, ads: results.ads })}</p></div>
      <a className="btn btn-outline btn-sm" href={resultsHref}>{t(locale, "mad.openResults")}&nbsp;→</a></div>
    <div className="tw-strip">
      <div><span>{t(locale, "lv2.spent")}</span><strong>{money(x.spend_cents)}</strong></div>
      <div><span>{t(locale, "lv2.clicks")}</span><strong>{int(x.clicks)}</strong></div>
      <div><span>CTR</span><strong>{x.ctr === null ? "—" : `${(x.ctr * 100).toFixed(2)}%`}</strong></div>
      <div><span>{t(locale, "lv2.cpc")}</span><strong>{money(x.cpc_cents)}</strong></div>
      <div><span>{t(locale, "lpx.purchases")}</span><strong>{int(x.purchases)}</strong></div>
      <div><span>{t(locale, "lpx.roas")}</span><strong>{x.roas ?? "—"}</strong></div>
    </div>
    {results.unattributed > 0 && <p className="hint">{t(locale, "mad.unattributedLong", { n: results.unattributed })}</p>}
  </section>;
}
