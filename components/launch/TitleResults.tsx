"use client";

// One title's ad results (Ruobin, 2026-09-24: "stats by title"): every
// launch, campaign and ad that promotes it, what they cost and what they
// brought, from the same stored launch readings the Monitor shows
// (lib/launch/title-stats.ts), plus the way to crazydramas' own dashboard,
// the second source. Staff and producer alike; Refresh reads TikTok and Meta
// again exactly as the Monitor's Refresh does.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useT } from "@/components/locale";
import { call, int, usd } from "@/components/tiktok/api";
import { adLandingUrl } from "@/lib/launch/plan";
import { providerCampaignId } from "@/lib/launch/provider-errors";
import { CRAZYDRAMAS_DASHBOARD_URL, titleResults, type Totals } from "@/lib/launch/title-stats";
import type { LaunchRun } from "@/lib/launch/types";
import "@/app/launch-monitor.css";

const money = (cents: number | null | undefined) => usd(cents == null ? null : cents / 100);
const pct = (ratio: number | null) => (ratio === null ? "—" : `${(ratio * 100).toFixed(2)}%`);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

/** The page one ad opens, TikTok's click macros filled in from our own launch record where they are known. */
function filledLink(template: string, ids: { campaign?: string | null; adgroup?: string | null; ad?: string | null }): string | null {
  if (!/^https:\/\//i.test(template)) return null;
  let url = template;
  if (ids.campaign) url = url.split("__CAMPAIGN_ID__").join(ids.campaign);
  if (ids.adgroup) url = url.split("__AID__").join(ids.adgroup);
  if (ids.ad) url = url.split("__CID__").join(ids.ad);
  return url;
}

function Numbers({ totals }: { totals: Totals | null }) {
  if (!totals) return <><td className="lm-number" colSpan={9}>—</td></>;
  return <>
    <td className="lm-number">{money(totals.spend_cents)}</td>
    <td className="lm-number">{int(totals.clicks)}</td>
    <td className="lm-number">{pct(totals.ctr)}</td>
    <td className="lm-number">{money(totals.cpc_cents)}</td>
    <td className="lm-number">{int(totals.purchases)}</td>
    <td className="lm-number">{money(totals.value_cents)}</td>
    <td className="lm-number">{totals.roas ?? "—"}</td>
    <td className="lm-number">{money(totals.cost_per_purchase_cents)}</td>
    <td className="lm-number">{int(totals.checkouts)}</td>
  </>;
}

export default function TitleResults({ staff = false, titleId, titleName, crazydramasSlug }: { staff?: boolean; titleId: string; titleName: string; crazydramasSlug?: string | null }) {
  const { tt } = useT();
  const [runs, setRuns] = useState<LaunchRun[] | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const url = staff ? "/api/promote/launches" : "/api/producer/monitor";
  const monitor = staff ? "/promote/monitor" : "/producer/monitor";
  const launchPage = staff ? "/promote/launches" : "/producer/launch";
  const load = useCallback(async (force = false) => {
    const r = await call<{ runs: LaunchRun[] }>(`${url}${force ? "?force=1" : ""}`);
    setRuns(r.runs); setError("");
  }, [url]);
  useEffect(() => { void load().catch((e) => setError(message(e))); }, [load]);
  const refresh = async () => {
    setRefreshing(true);
    try { await load(true); } catch (e) { setError(message(e)); } finally { setRefreshing(false); }
  };
  const results = useMemo(() => (runs ? titleResults(runs, titleId) : null), [runs, titleId]);
  const t = results?.totals;

  return <div className="launch-flow lm tr" data-testid="title-results">
    <nav className="studio-crumbs" aria-label={tt("v3.breadcrumbs")}><Link href={monitor}>{tt("lv2.monitor.title")}</Link><span aria-hidden>›</span><Link href={`${monitor}?view=titles`}>{tt("mad.byTitle")}</Link><span aria-hidden>›</span><span>{titleName}</span></nav>
    <div className="page-head"><div><h1>{titleName}</h1><p className="page-sub">{tt("mad.titleSub")}</p></div>
      {/* Nothing launched yet: the empty state below carries the one Create a launch, and there is nothing to refresh (UI sweep 2026-09-24). */}
      {!(results && results.campaigns.length === 0) && <div className="rs-tool-row"><button type="button" className="btn btn-outline" disabled={refreshing || !runs} onClick={() => void refresh()}>{tt(refreshing ? "common.loading" : "lv2.refresh")}</button><Link className="btn btn-outline" href={launchPage}>{tt("launchFeedback.createLaunch")}</Link></div>}</div>
    {error && <p className="note note-warn" role="alert">{error}</p>}
    {!results ? <p role="status">{tt("common.loading")}</p> : <>
      <div className="lm-summary tr-summary" aria-label={tt("mad.totals")} data-testid="title-totals">
        <div><small>{tt("lv2.spent")}</small><strong>{money(t!.spend_cents)}</strong></div>
        <div><small>{tt("mad.impressions")}</small><strong>{int(t!.impressions)}</strong></div>
        <div><small>{tt("lv2.clicks")}</small><strong>{int(t!.clicks)}</strong></div>
        <div><small>CTR</small><strong>{pct(t!.ctr)}</strong></div>
        <div><small>{tt("lv2.cpc")}</small><strong>{money(t!.cpc_cents)}</strong></div>
        <div><small>{tt("mad.counts")}</small><strong>{results.launches}<span className="lm-stat-denominator"> · {results.campaigns.length} · {results.ads}</span></strong><span className="lm-stat-hint">{tt("mad.countsHint")}</span></div>
      </div>
      <div className="lm-web-summary tr-summary" aria-label={tt("lpx.attributed")}>
        <div><small>{tt("lpx.purchases")} · {tt("lpx.attributed")}</small><strong>{int(t!.purchases)}</strong></div>
        <div><small>{tt("lpx.value")}</small><strong>{money(t!.value_cents)}</strong></div>
        <div><small>{tt("lpx.roas")}</small><strong>{t!.roas ?? "—"}</strong></div>
        <div><small>{tt("lpx.costPerPurchase")}</small><strong>{money(t!.cost_per_purchase_cents)}</strong></div>
        <div><small>{tt("lpx.checkouts")}</small><strong>{int(t!.checkouts)}</strong></div>
        <div><small>{tt("lv2.lastChecked")}</small><span className="lm-stat-hint">{date(results.checked_at)}</span></div>
      </div>
      {results.unattributed > 0 && <p className="note" role="status">{tt("mad.unattributedLong", { n: results.unattributed })}</p>}
      {results.unattributed_meta > 0 && <p className="note" role="status">{tt("mad.unattributedMetaLong", { n: results.unattributed_meta })}</p>}
      <section className="rs-panel tr-second" aria-labelledby="tr-second-h">
        <h2 id="tr-second-h">{tt("mad.secondSource")}</h2>
        <p className="hint">{tt("mad.secondSourceHint", { slug: crazydramasSlug ?? "—" })}</p>
        <a className="btn btn-outline btn-sm" href={CRAZYDRAMAS_DASHBOARD_URL} target="_blank" rel="noreferrer" data-testid="crazydramas-dashboard-link">{tt("mad.openDashboard")}</a>
      </section>
      {results.campaigns.length === 0 ? <div className="empty"><p>{tt("mad.titleEmpty")}</p><Link className="btn btn-primary btn-sm" href={launchPage}>{tt("launchFeedback.createLaunch")}</Link></div> : <>
        <h2 className="tr-head">{tt("mad.campaignsHead")}</h2>
        <div className="lm-table-scroll"><table className="lm-table tr-table" data-testid="title-campaigns">
          <colgroup><col className="lm-col-title" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /></colgroup>
          <thead><tr><th scope="col">{tt("lv2.campaign")}</th><th scope="col">{tt("lv2.spent")}</th><th scope="col">{tt("lv2.clicks")}</th><th scope="col">CTR</th><th scope="col">{tt("lv2.cpc")}</th><th scope="col">{tt("lpx.purchases")}</th><th scope="col">{tt("lpx.value")}</th><th scope="col">{tt("lpx.roas")}</th><th scope="col">{tt("lpx.costPerPurchase")}</th><th scope="col">{tt("lpx.checkouts")}</th></tr></thead>
          <tbody>{results.campaigns.map(({ run, campaign, whole, totals }) => <tr key={campaign.id}>
            <td><Link className="lm-title-link" href={`${monitor}?run=${encodeURIComponent(run.id)}`}>{run.draft.name} · {campaign.index}</Link>
              <small className="lm-title-note">{run.draft.provider === "meta" ? "Meta" : "TikTok"}{campaign.campid ? ` · ${campaign.campid}` : ""}{providerCampaignId(campaign) ? ` · ${tt("mad.campaignId")} ${providerCampaignId(campaign)}` : ""}</small>
              {!whole && <small className="lm-title-note">{tt(totals ? "mad.partCampaign" : "mad.partCampaignUnread")}</small>}</td>
            <Numbers totals={totals} />
          </tr>)}</tbody>
        </table></div>
        <h2 className="tr-head">{tt("mad.ads")}</h2>
        <div className="lm-table-scroll"><table className="lm-table tr-table" data-testid="title-ads">
          <colgroup><col className="lm-col-title" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /></colgroup>
          <thead><tr><th scope="col">{tt("mad.ad")}</th><th scope="col">{tt("lv2.spent")}</th><th scope="col">{tt("lv2.clicks")}</th><th scope="col">CTR</th><th scope="col">{tt("lv2.cpc")}</th><th scope="col">{tt("lpx.purchases")}</th><th scope="col">{tt("lpx.value")}</th><th scope="col">{tt("lpx.roas")}</th><th scope="col">{tt("lpx.costPerPurchase")}</th><th scope="col">{tt("lpx.checkouts")}</th></tr></thead>
          <tbody>{results.campaigns.flatMap(({ ads }) => ads).map(({ run, campaign, item, position, ads, totals }) => {
            const ad = ads[0];
            const groups = campaign.snapshot?.groups ?? [];
            const providerCampaign = providerCampaignId(campaign);
            const link = run.draft.provider === "tiktok" ? filledLink(adLandingUrl(item, run.draft.destination_url), { campaign: providerCampaign, adgroup: groups.length === 1 ? groups[0].id : null, ad: ad?.id ?? null }) : null;
            return <tr key={`${campaign.id}:${item.kind}:${item.value}`} data-testid="title-ad-row">
              <td><strong>{item.label || tt("lr3.adNumber", { n: position })}</strong>
                <small className="lm-title-note">{run.draft.name} · {campaign.index}{ad ? ` · ${tt("mad.adId")} ${ad.id}` : ""}{ad ? ` · ${ad.status.replaceAll("_", " ").toLowerCase()}` : ""}</small>
                {link && <a className="lm-row-button lm-ad-link" href={link} target="_blank" rel="noreferrer" title={link}>{tt("mr4.landing")}</a>}</td>
              <Numbers totals={totals} />
            </tr>;
          })}</tbody>
        </table></div>
        <p className="hint">{tt("mad.adsHint")}</p>
      </>}
    </>}
  </div>;
}
