import { portalSession, producerLocale } from "@/components/producer/server";
import CampaignQueue from "@/components/producer/research/CampaignQueue";
import { t } from "@/lib/i18n";
import { loadWorkspace } from "@/lib/research/workspace";
import { campaignWorkflow } from "@/lib/research/workflow";
import NextMini from "@/components/producer/research/NextMini";
export const dynamic = "force-dynamic";

export default async function Overview({ searchParams }: { searchParams: { view?: string } }) {
  const opportunities = searchParams.view === "opportunities";
  const session = await portalSession();
  const locale = producerLocale();
  const ws = await loadWorkspace(session);
  // Existing campaigns appear once in the task queue. Suggestions contain only
  // titles without a campaign, so these two sections never compete for a task.
  const suggested = ws.titles.filter(x => !x.campaigns.length && ["test_first", "prepare"].includes(x.assessment.band)).slice(0,3);
  const actionCount = ws.campaigns.filter(c => !campaignWorkflow(c,ws.results).waiting).length;
  const setup = [
    { key:"profile", done:!!ws.profile, href:"/producer/company?tab=profile&edit=1" },
    { key:"accounts", done:ws.accounts.some(a => a.kind === "ad_account" && a.state === "connected"), href:"/producer/company?tab=accounts" },
    { key:"reports", done:ws.reports.length > 0, href:"/producer/company?tab=reports" },
  ];
  return <div className="wf-overview">
    <div className="page-head"><div><h1>{t(locale,"desk.title")}</h1><p className="page-sub">{t(locale,"desk.sub")}</p></div><a className="btn btn-outline" href="/producer/titles">{t(locale,"ws.nav.catalog")}</a></div>
    {!opportunities && <div className="wf-company-context"><span><strong>{t(locale,"ws.overview.goal")}</strong>{ws.profile?.goal || t(locale,"workflow.noGoal")}</span><span><strong>{t(locale,"ws.overview.budget")}</strong>{ws.profile?.monthly_test_budget_usd != null ? `$${ws.profile.monthly_test_budget_usd}` : "—"}</span></div>}
    <nav className="desk-tabs" aria-label={t(locale,"desk.views")}>
      <a href="/producer" aria-current={!opportunities ? "page" : undefined}>{t(locale,"workflow.tasks")}<span>{actionCount}</span></a>
      <a href="/producer?view=opportunities" aria-current={opportunities ? "page" : undefined}>{t(locale,"next.nav.next")}</a>
    </nav>
    {opportunities ? <>
      <NextMini market={ws.market} locale={locale} catalog={ws.titles} />
    </> : <>
    <section className="wf-section" aria-labelledby="campaign-tasks">
      <header className="wf-section-head"><div><h2 id="campaign-tasks">{t(locale,"workflow.tasks")}</h2><p>{t(locale,"workflow.tasksSub",{n:actionCount})}</p></div><a href="/producer/promote">{t(locale,"workflow.allCampaigns")}</a></header>
      {ws.campaigns.length ? <CampaignQueue campaigns={ws.campaigns} results={ws.results} locale={locale}/> : <div className="rs-empty"><p>{t(locale,"workflow.noCampaigns")}</p><a className="btn btn-primary" href="/producer/titles">{t(locale,"workflow.chooseTitle")}</a></div>}
    </section>

    </>}
    <div className="desk-support">
      {opportunities && <section className="wf-section" aria-labelledby="next-titles"><header className="wf-section-head"><div><h2 id="next-titles">{t(locale,"workflow.nextTitles")}</h2><p>{t(locale,"workflow.nextTitlesSub")}</p></div></header>
        {suggested.length ? <ul className="wf-suggestions">{suggested.map(x => <li key={x.summary.id}><div><strong>{locale === "zh" ? x.summary.name_zh : x.summary.name_en || x.summary.name_zh}</strong><p>{t(locale,x.facts.episodes_with_video ? "workflow.readyTitle" : "workflow.needsVideo")}</p></div><a href={`/producer/titles/${x.summary.id}`}>{t(locale,"pf.col.open")} →</a></li>)}</ul> : <div className="rs-empty"><p>{t(locale,"workflow.noSuggestions")}</p><a href="/producer/titles/new">{t(locale,"research.nav.addTitle")}</a></div>}
      </section>}
      {!opportunities && setup.some(s => !s.done) && <section className="wf-section" aria-labelledby="company-setup"><header className="wf-section-head"><div><h2 id="company-setup">{t(locale,"workflow.setup")}</h2><p>{t(locale,"workflow.setupSub")}</p></div></header><ul className="wf-setup">{setup.filter(s => !s.done).map(s => <li key={s.key}><div><strong>{t(locale,`workflow.setup.${s.key}`)}</strong><p>{t(locale,`workflow.setup.${s.key}Hint`)}</p></div><a className={s.done ? "wf-setup-done" : "wf-setup-action"} href={s.href}>{t(locale,s.done ? "workflow.recorded" : `workflow.setup.${s.key}Action`)}</a></li>)}</ul></section>}
    </div>
  </div>;
}
