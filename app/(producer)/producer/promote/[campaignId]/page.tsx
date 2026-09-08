import { notFound } from "next/navigation";
import PromoWorkspace from "@/components/producer/promote/PromoWorkspace";
import ExperimentPanel from "@/components/producer/research/ExperimentPanel";
import { StageStrip } from "@/components/producer/research/workspace-ui";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { getData, isDataError } from "@/lib/data";
import { dataSource } from "@/lib/data-source";
import { mediaUrl } from "@/lib/data/storage";
import { t } from "@/lib/i18n";
import { BENCHMARK } from "@/lib/research/assessment";
import { experimentStage } from "@/lib/research/workspace";
import { campaignWorkflow, workflowStepForStage } from "@/lib/research/workflow";
import { nextRoundName } from "@/lib/research/results";

// /producer/promote/[campaignId] — one experiment: the stage strip, the
// structured brief with budget approval, the concept review (generate
// broadly, keep a small first batch, approve, submit), results, and the
// next-spend decision.

export const dynamic = "force-dynamic";

export default async function ExperimentPage({ params }: { params: { campaignId: string } }) {
  const session = await portalSession(`/producer/promote/${params.campaignId}`);
  const locale = producerLocale();
  const data = getData();
  let detail;
  try {
    detail = await data.getPromoCampaign(session, params.campaignId);
  } catch (e) {
    if (isDataError(e) && (e.code === "not_found" || e.code === "forbidden")) notFound();
    throw e;
  }
  const summaries = await data.listPromoCampaigns(session);
  const summary = summaries.find((c) => c.id === detail.campaign.id);
  const st = summary ? experimentStage(summary, detail.results) : { stage: "brief" as const, waiting: "generate" as const };
  const media = Object.fromEntries(detail.episodes.map((e) => [e.id, mediaUrl(e.video_path)]));
  const canEdit = !isStaffPreview(session) && (session.producerRole === "approver" || session.producerRole === "reviewer");
  const canApprove = !isStaffPreview(session) && session.producerRole === "approver";
  const titleName = locale === "en" ? detail.title.name_en || detail.title.name_zh : detail.title.name_zh;
  const flow = summary ? campaignWorkflow(summary, detail.results) : { step: workflowStepForStage[st.stage], hint: `workflow.hint.${workflowStepForStage[st.stage]}`, waiting: false };
  const launched = ["submitted", "launching", "live"].includes(detail.campaign.status);
  const panelFirst = ["prepare", "budget", "results"].includes(flow.step) || launched;
  // The next round is a new campaign on the same title: numbered after every round the title already has.
  const roundNumber = summaries.filter((c) => c.title_id === detail.title.id).length + 1;
  const nextRound = { number: roundNumber, name: nextRoundName(detail.campaign.name, roundNumber, locale) };
  const experimentPanel = <div id="brief"><ExperimentPanel campaign={detail.campaign} creatives={detail.creatives} results={detail.results} canEdit={canEdit} canApprove={canApprove} fixtureMode={dataSource() === "fixture"} benchmark={BENCHMARK} titleName={titleName} briefExpanded={flow.step === "prepare" || flow.step === "budget"} nextRound={nextRound} analyticsHref={`/producer/titles/${detail.title.id}/analytics/acquisition?campaign=${detail.campaign.id}`} /></div>;
  const ads = detail.campaign.status === "generating" || (detail.campaign.status === "failed" && !detail.creatives.length) ? null : <section id="ads" className="fc-ads-section"><span id="concepts"/><header className="fc-section-heading"><h2>{t(locale, ["choose", "approveAds"].includes(flow.step) ? `workflow.step.${flow.step}` : "fc.ads")}</h2>{launched && <p>{t(locale, "fc.adsArchiveHint")}</p>}</header><PromoWorkspace detail={detail} media={media} canAct={canEdit} canApprove={canApprove} /></section>;
  const adSection = launched || flow.step === "budget" ? <details className="fc-disclosure fc-archive"><summary><span>{t(locale, "fc.adsArchive")}</span><span>{detail.creatives.filter(c => c.status !== "superseded").length}</span></summary>{ads}</details> : ads;

  return (
    <div className="fc-campaign">
      <nav className="studio-crumbs" aria-label={t(locale, "v3.breadcrumbs")}>
        <a href="/producer/promote">{t(locale, "ws.nav.launch")}</a>
        <span>›</span>
        <span>{detail.campaign.name}</span>
      </nav>
      <div className="page-head">
        <div>
          <p className="fc-campaign-context">{t(locale, "ws.exp.forTitle", { title: titleName })} · {detail.campaign.target_market}</p>
          <h1>{detail.campaign.name}</h1>
          {!flow.waiting && <p className="page-sub">{t(locale, flow.hint)}</p>}
        </div>
        <span className="rs-tool-row">
          <a className="btn btn-outline btn-sm" href={`/producer/titles/${detail.title.id}/potential`}>{t(locale, "ws.actions.assess")}</a>
        </span>
      </div>
      <StageStrip stage={st.stage} step={flow.step} locale={locale} />
      <p className="note note-info">{t(locale, "ws.exp.mock")}</p>

      {flow.waiting && <div className="fc-current-task" id="launch-status"><strong>{t(locale, `workflow.step.${flow.step}`)}</strong><span>{t(locale, flow.hint)}</span></div>}
      {panelFirst ? <>{experimentPanel}{adSection}</> : <>{adSection}{experimentPanel}</>}
    </div>
  );
}
