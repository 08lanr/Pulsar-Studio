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
  const titleName = detail.title.name_en || detail.title.name_zh;

  return (
    <>
      <nav className="studio-crumbs" aria-label={t(locale, "v3.breadcrumbs")}>
        <a href="/producer/promote">{t(locale, "ws.nav.launch")}</a>
        <span>›</span>
        <span>{detail.campaign.name}</span>
      </nav>
      <div className="page-head">
        <div>
          <span className="page-kicker">{t(locale, "ws.exp.forTitle", { title: titleName })} · {detail.campaign.target_market}</span>
          <h2>{detail.campaign.name}</h2>
          <p className="page-sub">{t(locale, "ws.exp.sub")}</p>
        </div>
        <span className="rs-tool-row">
          <a className="btn btn-outline btn-sm" href={`/producer/titles/${detail.title.id}/potential`}>{t(locale, "ws.actions.assess")}</a>
          <span className="state state-collecting_history">{t(locale, `ws.exp.waiting.${st.waiting}`)}</span>
        </span>
      </div>
      <StageStrip stage={st.stage} locale={locale} />
      <p className="note note-info">{t(locale, "ws.exp.mock")}</p>

      <ExperimentPanel campaign={detail.campaign} creatives={detail.creatives} results={detail.results} canEdit={canEdit} canApprove={canApprove} fixtureMode={dataSource() === "fixture"} benchmark={BENCHMARK} titleName={titleName} />

      <section style={{ marginTop: 20 }} id="concepts">
        <div className="rs-panel-head" style={{ padding: "0 0 10px" }}>
          <div>
            <h3>{t(locale, "ws.exp.stage.concepts")}</h3>
            <p>{detail.campaign.experiment ? t(locale, "ws.exp.selectBatch", { n: detail.campaign.experiment.first_batch, total: detail.creatives.filter((c) => c.status !== "superseded").length || 5 }) : t(locale, "promote.workspace.sub")}</p>
          </div>
        </div>
        <PromoWorkspace detail={detail} media={media} canAct={canEdit} />
      </section>
    </>
  );
}
