import Link from "next/link";
import { notFound } from "next/navigation";
import PromoDesk from "@/components/admin/promote/PromoDesk";
import { adminLocale, staffSession } from "@/components/admin/server";
import { getData, isDataError } from "@/lib/data";
import { mediaUrl } from "@/lib/data/storage";
import { t } from "@/lib/i18n";

// /promote/[campaignId] — one campaign on Pulsar's desk: the brief, the
// producer's change requests to answer, and the Grow launch record.

export const dynamic = "force-dynamic";

export default async function PromoteCampaign({ params }: { params: { campaignId: string } }) {
  const session = await staffSession();
  const locale = adminLocale();
  const data = getData();
  let detail;
  try { detail = await data.getPromoCampaign(session, params.campaignId); } catch (e) { if (isDataError(e) && (e.code === "not_found" || e.code === "forbidden")) notFound(); throw e; }
  const summary = (await data.listPromoCampaigns(session)).find((c) => c.id === detail.campaign.id);
  const media = Object.fromEntries(detail.episodes.map((e) => [e.id, mediaUrl(e.video_path)]));
  return <>
    <nav className="studio-crumbs"><Link href="/promote">{t(locale, "admin.promote.title")}</Link><span>›</span><span>{detail.campaign.name}</span></nav>
    <div className="page-head"><div><span className="page-kicker bilingual">{detail.title.name_en || detail.title.name_zh} · {summary?.producer_name_en || summary?.producer_name_zh || ""}</span><h2>{detail.campaign.name}</h2></div><Link className="btn btn-outline" href={`/titles/${detail.title.id}`}>{t(locale, "admin.head.title")}</Link></div>
    <PromoDesk detail={detail} media={media} />
  </>;
}
