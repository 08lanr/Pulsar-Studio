import { notFound } from "next/navigation";
import { adminLocale, staffSession } from "@/components/admin/server";
import { chipReading, CrazydramasChip } from "@/components/producer/CrazydramasChip";
import CrazydramasPanel from "@/components/producer/CrazydramasPanel";
import { crazydramasPublicUrl, loadCrazydramasStatus, shownPosterUrl } from "@/lib/crazydramas";
import { getData, isDataError } from "@/lib/data";
import { t } from "@/lib/i18n";

// /titles/[id]/crazydramas — the staff mirror of the producer's CrazyDramas
// section (plan A4.4): the same panel over the same snapshots, and Check now
// for staff (the route admits requireStaff as it does requireProducer).

export const dynamic = "force-dynamic";

export default async function StaffCrazydramasPage({ params }: { params: { id: string } }) {
  const session = await staffSession();
  const locale = adminLocale();
  try {
    const detail = await getData().getTitle(session, params.id);
    const status = await loadCrazydramasStatus(session, detail.title);
    return (
      <>
        <div className="title-head">
          <a className="title-back" href={`/titles/${detail.title.id}`}>← {t(locale, "cd.admin.back")}</a>
          <div className="title-main">
            <div className="title-row">
              <h1 className="bilingual" lang="zh-CN">{detail.title.name_zh}</h1>
              <CrazydramasChip {...chipReading(status)} locale={locale} />
            </div>
            <div className="title-meta">
              {detail.title.name_en && <span>{detail.title.name_en}</span>}
              <span>{detail.producer.name_en || detail.producer.name_zh}</span>
              <span>{t(locale, "cd.admin.open")}</span>
            </div>
          </div>
        </div>
        <p className="page-sub">{t(locale, "cd.sub")}</p>
        <CrazydramasPanel
          titleId={detail.title.id}
          status={status}
          publicUrl={status.slug ? crazydramasPublicUrl(status.slug) : null}
          posterUrl={shownPosterUrl(status.series?.poster_url)}
          imported={!!detail.title.source_ref}
          canCheck
        />
      </>
    );
  } catch (error) {
    if (isDataError(error) && error.code === "not_found") notFound();
    throw error;
  }
}
