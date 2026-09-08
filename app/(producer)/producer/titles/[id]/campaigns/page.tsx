import TitleShell from "@/components/producer/TitleShell";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { WorkflowBadge } from "@/components/producer/research/workspace-ui";
import { fmtPct } from "@/components/producer/research/ui";
import { fmtUsd } from "@/components/producer/analytics/bits";
import { t } from "@/lib/i18n";
import { BENCHMARK } from "@/lib/research/assessment";
import { readResults } from "@/lib/research/results";
import { adCtr, adSpend } from "@/lib/research/title-status";
import { loadTitleWorkspace } from "@/lib/research/title-workspace";
import { campaignWorkflow } from "@/lib/research/workflow";

// /producer/titles/[id]/campaigns — the Ad campaigns section: every round
// on this title with its step, budget, reported spend and result reading,
// the way into each campaign (which stays at /producer/promote/[id]) and
// the way to the attributable outcomes in the TikTok section.

export const dynamic = "force-dynamic";

export default async function TitleCampaigns({ params }: { params: { id: string } }) {
  const session = await portalSession(`/producer/titles/${params.id}/campaigns`);
  const locale = producerLocale();
  const w = await loadTitleWorkspace(session, params.id);
  const canEdit = !isStaffPreview(session) && (session.producerRole === "reviewer" || session.producerRole === "approver");
  const x = w.title;
  const rounds = [...x.campaigns].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const spend = adSpend(x.results);
  const ctr = adCtr(x.results);
  const adStep = w.ads.flow ? t(locale, `workflow.step.${w.ads.flow.step}`) : null;
  const returnTo = encodeURIComponent(`/producer/titles/${params.id}/campaigns`);

  return (
    <TitleShell locale={locale} titleId={params.id} name_zh={w.detail.title.name_zh} name_en={w.detail.title.name_en} platform={w.platform} ads={w.ads.status} adStep={adStep} section="campaigns"
      actions={canEdit ? <a className="btn btn-primary" href={`/producer/promote/new?title=${params.id}`}>{t(locale, "ws.exp.new")}</a> : undefined}>
      <div className="tw-strip">
        <div><span>{t(locale, "tw.ads.spendToDate")}</span><strong>{spend == null ? "–" : fmtUsd(spend, 2)}</strong></div>
        <div><span>{t(locale, "tw.ads.ctrToDate")}</span><strong>{ctr ? <>{fmtPct(ctr.ctr, 2)} <small>{ctr.ctr >= BENCHMARK.ctr ? "✓" : "✗"} ≥ {(BENCHMARK.ctr * 100).toFixed(1)}%</small></> : "–"}</strong></div>
        <div><span>{t(locale, "tw.ads.rounds")}</span><strong>{rounds.length}</strong></div>
        <div><span>{t(locale, "tw.ads.attributed")}</span><strong><a href={`/producer/titles/${params.id}/analytics/acquisition`}>{t(locale, "tw.nav.tiktok")} →</a></strong></div>
      </div>
      <p className="tw-note">{t(locale, "ws.exp.mock")}</p>

      {rounds.length === 0 ? (
        <section className="rs-panel rs-empty">
          <p>{t(locale, "ws.assess.noExperiments")}</p>
          {canEdit && <a className="btn btn-primary btn-sm" href={`/producer/promote/new?title=${params.id}`}>{t(locale, "ws.exp.new")}</a>}
        </section>
      ) : (
        <section className="rs-panel">
          <table className="tw-table">
            <caption className="sr-only">{t(locale, "tw.nav.campaigns")}</caption>
            <thead><tr>
              <th scope="col">{t(locale, "ws.exp.col.experiment")}</th>
              <th scope="col">{t(locale, "ws.exp.col.stage")}</th>
              <th scope="col" className="tw-num">{t(locale, "ws.exp.col.budget")}</th>
              <th scope="col" className="tw-num">{t(locale, "rd.col.spend")}</th>
              <th scope="col">{t(locale, "tw.ads.resultsCol")}</th>
              <th scope="col" />
            </tr></thead>
            <tbody>
              {rounds.map((c, i) => {
                const flow = campaignWorkflow(c, x.results);
                const own = x.results.filter((r) => r.campaign_id === c.id);
                const reading = readResults(own, [], BENCHMARK);
                const met = reading.rows.filter((r) => r.verdict === "met_both").length;
                return (
                  <tr key={c.id}>
                    <th scope="row"><a href={`/producer/promote/${c.id}?returnTo=${returnTo}`}>{c.name}</a><small>{t(locale, "tw.ads.roundN", { n: i + 1 })} · {c.created_at.slice(0, 10)}</small></th>
                    <td><WorkflowBadge step={flow.step} locale={locale} />{flow.waiting && <small className="tw-muted"> {t(locale, "ws.exp.waiting.results")}</small>}</td>
                    <td className="tw-num">{c.experiment ? <>{fmtUsd(c.experiment.budget_usd, 0)}<small>{t(locale, c.experiment.approved_at ? "workflow.budgetApproved" : "workflow.budgetUnapproved")}</small></> : "–"}</td>
                    <td className="tw-num">{own.length ? fmtUsd(reading.totals.spend_usd, 2) : "–"}</td>
                    <td>{own.length ? <><b>{t(locale, "tw.ads.metCount", { met, total: reading.rows.length })}</b><small>{reading.demo_only ? t(locale, "rd.sourceDemo") : t(locale, "rd.sourceGrow")}</small></> : <span className="tw-muted">{t(locale, "tw.ads.noResults")}</span>}</td>
                    <td className="tw-action"><a className={`btn btn-sm ${flow.waiting ? "btn-outline" : "btn-primary"}`} href={`${flow.href.replace("#", `?returnTo=${returnTo}#`)}`}>{t(locale, flow.action)}</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </TitleShell>
  );
}
