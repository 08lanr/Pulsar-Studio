import { portalSession, producerLocale } from "@/components/producer/server";
import CampaignQueue from "@/components/producer/research/CampaignQueue";
import { t } from "@/lib/i18n";
import { loadWorkspace } from "@/lib/research/workspace";
import { WORKFLOW_STEPS } from "@/lib/research/workflow";
export const dynamic = "force-dynamic";
export default async function Campaigns() {
  const session = await portalSession("/producer/promote");
  const locale = producerLocale();
  const ws = await loadWorkspace(session);
  return <div className="wf-campaign-list">
    <div className="page-head"><div><h1>{t(locale,"ws.exp.title")}</h1><p className="page-sub">{t(locale,"workflow.campaignsSub")}</p></div><a className="btn btn-primary" href="/producer/promote/new">{t(locale,"ws.exp.new")}</a></div>
    <details className="wf-guide"><summary>{t(locale,"workflow.howItWorks")}</summary><ol>{WORKFLOW_STEPS.map(step => <li key={step}><strong>{t(locale,`workflow.step.${step}`)}</strong><p>{t(locale,`workflow.hint.${step}`)}</p></li>)}</ol></details>
    <p className="wf-demo-note">{t(locale,"workflow.demoMode")}</p>
    <section className="wf-section"><header className="wf-section-head"><div><h2>{t(locale,"workflow.allCampaigns")}</h2><p>{t(locale,"workflow.queueSub")}</p></div></header>{ws.campaigns.length ? <CampaignQueue campaigns={ws.campaigns} results={ws.results} locale={locale}/> : <div className="rs-empty"><p>{t(locale,"workflow.noCampaigns")}</p><a className="btn btn-outline" href="/producer/titles">{t(locale,"workflow.chooseTitle")}</a></div>}</section>
  </div>;
}
