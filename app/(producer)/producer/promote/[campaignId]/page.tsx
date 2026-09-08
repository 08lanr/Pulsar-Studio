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
import { WORKFLOW_STEPS, campaignWorkflow, workflowStepForStage } from "@/lib/research/workflow";
import { nextRoundName } from "@/lib/research/results";

// /producer/promote/[campaignId] — one experiment: the stage strip, the
// structured brief with budget approval, the concept review (generate
// broadly, keep a small first batch, approve, submit), results, and the
// next-spend decision.

export const dynamic = "force-dynamic";

export default async function ExperimentPage({ params, searchParams }: { params: { campaignId: string }; searchParams: { returnTo?: string } }) {
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
  // Where "back" goes: the title's campaigns section unless the caller said otherwise (a local path only).
  const raw = searchParams.returnTo ?? "";
  const returnTo = raw.startsWith("/producer/") && !raw.startsWith("//") ? raw : `/producer/titles/${detail.title.id}/campaigns`;
  const returnLabel = returnTo.startsWith("/producer/promote") ? t(locale, "ws.exp.title") : returnTo.includes("/analytics") ? t(locale, "tw.nav.tiktok") : returnTo === "/producer" ? t(locale, "ws.nav.overview") : t(locale, "tw.nav.campaigns");
  // Budget approval is step 4: it opens once the ads are approved, so the page and the stage strip agree.
  const budgetStepReached = WORKFLOW_STEPS.indexOf(flow.step) >= WORKFLOW_STEPS.indexOf("budget") || launched;
  // The next round is a new campaign on the same title: numbered after every round the title already has.
  const roundNumber = summaries.filter((c) => c.title_id === detail.title.id).length + 1;
  const nextRound = { number: roundNumber, name: nextRoundName(detail.campaign.name, roundNumber, locale) };
  const panelProps = { campaign: detail.campaign, creatives: detail.creatives, results: detail.results, canEdit, canApprove, fixtureMode: dataSource() === "fixture", benchmark: BENCHMARK, titleName, nextRound, analyticsHref: `/producer/titles/${detail.title.id}/analytics/acquisition?campaign=${detail.campaign.id}` };
  // Sections stay in step order on every visit: brief → ads → results. Past steps collapse; they never move.
  const briefSection = <div id="brief"><ExperimentPanel {...panelProps} section="brief" briefExpanded={flow.step === "prepare" || flow.step === "budget"} budgetStepReached={budgetStepReached} /></div>;
  const resultsSection = launched || detail.results.length > 0 ? <ExperimentPanel {...panelProps} section="results" /> : null;
  const ads = detail.campaign.status === "generating" || (detail.campaign.status === "failed" && !detail.creatives.length) ? null : <section id="ads" className="fc-ads-section"><span id="concepts"/><header className="fc-section-heading"><h2>{t(locale, ["choose", "approveAds"].includes(flow.step) ? `workflow.step.${flow.step}` : "fc.ads")}</h2>{launched && <p>{t(locale, "fc.adsArchiveHint")}</p>}</header><PromoWorkspace detail={detail} media={media} canAct={canEdit} canApprove={canApprove} /></section>;
  const adSection = launched || flow.step === "budget" ? <details className="fc-disclosure fc-archive"><summary><span>{t(locale, "fc.adsArchive")}</span><span>{detail.creatives.filter(c => c.status !== "superseded").length}</span></summary>{ads}</details> : ads;

  return (
    <div className="fc-campaign">
      <nav className="studio-crumbs" aria-label={t(locale, "v3.breadcrumbs")}>
        <a href="/producer/titles">{t(locale, "ws.nav.catalog")}</a>
        <span>›</span>
        <a href={`/producer/titles/${detail.title.id}`}>{titleName}</a>
        <span>›</span>
        <a href={`/producer/titles/${detail.title.id}/campaigns`}>{t(locale, "tw.nav.campaigns")}</a>
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
          <a className="btn btn-outline btn-sm" href={returnTo}>{t(locale, "tw.backTo", { section: returnLabel })}</a>
        </span>
      </div>
      <StageStrip stage={st.stage} step={flow.step} locale={locale} />
      {(flow.step === "launch" || flow.waiting) && <p className="note note-info">{t(locale, "ws.exp.mock")}</p>}

      {flow.waiting && <div className="fc-current-task" id="launch-status"><strong>{t(locale, `workflow.step.${flow.step}`)}</strong><span>{t(locale, flow.hint)}</span></div>}
      {briefSection}
      {adSection}
      {resultsSection}
    </div>
  );
}
