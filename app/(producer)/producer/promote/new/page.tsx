import NewPromoForm from "@/components/producer/promote/NewPromoForm";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function NewPromotion({ searchParams }: { searchParams: { title?: string } }) {
  const session = await portalSession("/producer/promote/new"); const locale = producerLocale(); const data = getData();
  const summaries = await data.listTitles(session); const details = await Promise.all(summaries.map((x) => data.getTitle(session, x.id)));
  const titles = details.map((d) => ({ id: d.title.id, name: d.title.name_en || d.title.name_zh, episodeCount: d.episodes.length, hasVideo: d.episodes.some((e) => e.has_video) }));
  return <><nav className="studio-crumbs"><a href="/producer/promote">{t(locale, "promote.home.title")}</a><span>›</span><span>{t(locale, "promote.new.title")}</span></nav><div className="page-head"><div><span className="page-kicker">{t(locale, "promote.new.kicker")}</span><h2>{t(locale, "promote.new.title")}</h2><p className="page-sub">{t(locale, "promote.new.sub")}</p></div></div><NewPromoForm titles={titles} initialTitleId={searchParams.title} readOnly={isStaffPreview(session)} /></>;
}
