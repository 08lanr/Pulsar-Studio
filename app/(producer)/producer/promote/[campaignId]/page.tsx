import { notFound } from "next/navigation";
import PromoWorkspace from "@/components/producer/promote/PromoWorkspace";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { getData, isDataError } from "@/lib/data";
import { mediaUrl } from "@/lib/data/storage";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function PromotionPage({ params }: { params: { campaignId: string } }) {
  const session = await portalSession(`/producer/promote/${params.campaignId}`); const locale = producerLocale();
  let detail; try { detail = await getData().getPromoCampaign(session, params.campaignId); } catch (e) { if (isDataError(e) && (e.code === "not_found" || e.code === "forbidden")) notFound(); throw e; }
  const media = Object.fromEntries(detail.episodes.map((e) => [e.id, mediaUrl(e.video_path)]));
  const stages = ["approved", "submitted", "launching", "live"]; const current = stages.includes(detail.campaign.status) ? stages.indexOf(detail.campaign.status) + 2 : detail.campaign.status === "review" ? 1 : 0;
  return <><nav className="studio-crumbs"><a href="/producer/promote">{t(locale, "promote.home.title")}</a><span>›</span><span>{detail.campaign.name}</span></nav><div className="page-head promo-work-head"><div><span className="page-kicker">{detail.title.name_en || detail.title.name_zh} · {detail.campaign.target_market}</span><h2>{detail.campaign.name}</h2><p className="page-sub">{t(locale, "promote.workspace.sub")}</p></div></div><div className="promo-launch-steps">{["creative", "approval", "pulsar", "tiktok", "live"].map((step, i) => <div className={i <= current ? "is-done" : ""} key={step}><i>{i < current ? "✓" : i + 1}</i><span>{t(locale, `promote.step.${step}`)}</span></div>)}</div><PromoWorkspace detail={detail} media={media} canAct={!isStaffPreview(session)} /></>;
}
