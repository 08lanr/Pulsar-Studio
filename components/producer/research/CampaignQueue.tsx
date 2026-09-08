import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import type { CreativeResult, PromoCampaignSummary } from "@/lib/types";
import { campaignWorkflow } from "@/lib/research/workflow";
import { WorkflowBadge } from "./workspace-ui";

export default function CampaignQueue({ campaigns, results, locale }: { campaigns: PromoCampaignSummary[]; results: CreativeResult[]; locale: Locale }) {
  const rows = campaigns.map(c => ({ c, flow: campaignWorkflow(c, results) }));
  rows.sort((a,b) => Number(a.flow.waiting) - Number(b.flow.waiting) || b.flow.number - a.flow.number || b.c.updated_at.localeCompare(a.c.updated_at));
  return <ul className="wf-queue">{rows.map(({ c, flow }) => {
    const ownResults = results.filter(r => r.campaign_id === c.id);
    const demo = ownResults.length > 0 && ownResults.every(r => r.source === "demo");
    return <li key={c.id} className="wf-queue-row">
      <div className="wf-queue-title"><a href={flow.href}>{locale === "zh" ? c.title_name_zh : c.title_name_en || c.title_name_zh}</a><span>{c.name}</span></div>
      <div className="wf-queue-step"><WorkflowBadge step={flow.step} locale={locale}/><p>{t(locale,flow.hint)}</p>{demo && <span className="wf-provenance">{t(locale,"ws.state.demo")}</span>}</div>
      <div className="wf-queue-budget"><span>{t(locale,"ws.exp.col.budget")}</span><strong>{c.experiment ? new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(c.experiment.budget_usd) : "—"}</strong><small>{c.experiment?.approved_at ? t(locale,"workflow.budgetApproved") : t(locale,"workflow.budgetUnapproved")}</small></div>
      <a className={`btn ${flow.waiting ? "btn-outline" : "btn-primary"}`} href={flow.href}>{t(locale,flow.action)}</a>
    </li>;
  })}</ul>;
}
