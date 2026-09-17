import { portalSession, producerLocale } from "@/components/producer/server";
import { titleName } from "@/components/producer/TitleShell";
import { DemoChip, fmtUsd } from "@/components/producer/analytics/bits";
import { t } from "@/lib/i18n";
import type { PromoCampaignSummary } from "@/lib/types";
import { loadWorkspace } from "@/lib/research/workspace";

export const dynamic = "force-dynamic";

export default async function EarlierCampaigns({ searchParams }: { searchParams: { q?: string } }) {
  const session = await portalSession("/producer/promote");
  const locale = producerLocale();
  const workspace = await loadWorkspace(session);
  const query = searchParams.q?.trim().toLowerCase() ?? "";

  const byTitle = new Map<string, PromoCampaignSummary[]>();
  for (const campaign of workspace.campaigns) {
    const current = byTitle.get(campaign.title_id) ?? [];
    current.push(campaign);
    byTitle.set(campaign.title_id, current);
  }
  const roundOf = new Map<string, number>();
  for (const list of byTitle.values()) [...list].sort((a, b) => a.created_at.localeCompare(b.created_at)).forEach((campaign, index) => roundOf.set(campaign.id, index + 1));

  const shown = workspace.campaigns.map((campaign) => {
    const own = workspace.results.filter((result) => result.campaign_id === campaign.id);
    return {
      campaign, own, round: roundOf.get(campaign.id) ?? 1,
      spend: own.reduce((sum, row) => sum + (row.spend_usd ?? 0), 0),
      title: titleName(locale, campaign.title_name_zh, campaign.title_name_en),
    };
  }).filter((row) => !query || row.title.primary.toLowerCase().includes(query) || (row.title.secondary ?? "").toLowerCase().includes(query) || row.campaign.name.toLowerCase().includes(query))
    .sort((a, b) => b.campaign.updated_at.localeCompare(a.campaign.updated_at));
  const anyDemo = shown.some((row) => row.own.some((result) => result.source === "demo"));

  return <>
    <div className="page-head"><div>
      <h1>{t(locale, "lv2.legacyCampaigns")}</h1>
      <p className="page-sub">{t(locale, "legacy.listNote")}</p>
    </div><a className="btn btn-primary" href="/producer/launch">{t(locale, "lv2.launch.title")}&nbsp;→</a></div>

    <div className="pf-filters"><form action="/producer/promote" method="get" role="search" aria-label={t(locale, "lv2.legacyCampaigns")}>
      <input className="input" type="search" name="q" defaultValue={query} placeholder={t(locale, "workflow.search")} aria-label={t(locale, "workflow.search")} />
      <button className="btn btn-outline btn-sm" type="submit">{t(locale, "research.search.go")}</button>
    </form></div>

    {workspace.campaigns.length === 0 ? <section className="pf-table-wrap pf-empty ps-catalog-empty">
      <h2>{t(locale, "ws.assess.noExperiments")}</h2><p>{t(locale, "legacy.listNote")}</p>
    </section> : shown.length === 0 ? <section className="pf-table-wrap pf-empty ps-catalog-empty">
      <h2>{t(locale, "workflow.noMatches")}</h2><a className="btn btn-primary" href="/producer/promote">{t(locale, "pf.reset")}</a>
    </section> : <section className="ps-catalog cc-catalog cc-campaigns">
      {anyDemo && <div className="rs-meta" style={{ padding: "12px 14px 0" }}><DemoChip locale={locale} /></div>}
      <table className="ps-catalog-table" role="table">
        <caption className="sr-only">{t(locale, "lv2.legacyCampaigns")}</caption>
        <thead role="rowgroup"><tr role="row">
          <th scope="col">{t(locale, "ws.exp.col.experiment")}</th>
          <th scope="col">{t(locale, "legacy.status")}</th>
          <th scope="col" className="gt-num">{t(locale, "ws.exp.col.budget")} <small className="an-basis">USD</small></th>
          <th scope="col" className="gt-num">{t(locale, "rd.col.spend")} <small className="an-basis">USD</small></th>
          <th scope="col">{t(locale, "legacy.results")}</th>
          <th scope="col">{t(locale, "an.catalog.col.action")}</th>
        </tr></thead>
        <tbody role="rowgroup">{shown.map(({ campaign, own, spend, round, title }) => <tr key={campaign.id} role="row">
          <th className="ps-catalog-identity" scope="row" role="rowheader"><a className="ps-catalog-name" href={`/producer/promote/${campaign.id}`} lang={title.lang}>{title.primary}</a>
            <span className="ps-catalog-secondary">{campaign.name}</span><span className="ps-catalog-titlemeta">{t(locale, "tw.ads.roundN", { n: round })} · {campaign.created_at.slice(0, 10)}</span>
          </th>
          <td role="cell" data-label={t(locale, "legacy.status")}><span className="pill pill-neutral">{t(locale, `promote.status.${campaign.status}`)}</span></td>
          <td className="gt-num" role="cell" data-label={t(locale, "ws.exp.col.budget")}>{campaign.experiment?.approved_at ? <b>{fmtUsd(campaign.experiment.budget_usd, 0)}</b> : "—"}</td>
          <td className="gt-num" role="cell" data-label={t(locale, "rd.col.spend")}>{own.length ? <b>{fmtUsd(spend, 2)}</b> : "—"}</td>
          <td role="cell" data-label={t(locale, "legacy.results")}>{own.length ? t(locale, "legacy.resultCount", { n: own.length }) : t(locale, "legacy.noResults")}</td>
          <td className="cc-next" role="cell" data-label={t(locale, "an.catalog.col.action")}><a className="btn btn-outline btn-sm" href={`/producer/promote/${campaign.id}`}>{t(locale, "legacy.openRecord")}&nbsp;→</a></td>
        </tr>)}</tbody>
      </table>
      <div className="rs-panel-foot">{t(locale, "workflow.count", { n: shown.length })}</div>
    </section>}
  </>;
}
