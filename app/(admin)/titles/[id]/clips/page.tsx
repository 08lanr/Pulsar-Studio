import { notFound } from "next/navigation";
import { adminLocale, staffSession } from "@/components/admin/server";
import EpisodeClips from "@/components/producer/EpisodeClips";
import { episodeClipsPayload } from "@/lib/clips/payload";
import { getData, isDataError } from "@/lib/data";
import { t } from "@/lib/i18n";

// /titles/[id]/clips — the staff side of the producer's ad clips (Materials):
// every episode with video, its clips with Preview and Download, and "Cut
// clips again", which a staff administrator may press (the clips route admits
// a staff admin as it does a reviewer or approver of the title). Added
// 2026-09-24 so Ruobin can cut clips for the first ads from his own login.

export const dynamic = "force-dynamic";

export default async function StaffTitleClipsPage({ params }: { params: { id: string } }) {
  const session = await staffSession();
  const locale = adminLocale();
  const canEdit = session.kind === "staff" && session.staffRole === "admin";
  try {
    const detail = await getData().getTitle(session, params.id);
    const withVideo = detail.episodes.filter((e) => e.has_video).sort((a, b) => a.number - b.number);
    const payloads = await Promise.all(withVideo.map(async (e) => [e, await episodeClipsPayload(session, params.id, e.number)] as const));
    return (
      <>
        <div className="title-head">
          <a className="title-back" href={`/titles/${detail.title.id}`}>← {t(locale, "cd.admin.back")}</a>
          <div className="title-main">
            <div className="title-row">
              <h1>{detail.title.name_en || detail.title.name_zh}</h1>
            </div>
          </div>
        </div>
        <p className="page-sub">{t(locale, "clips.staff.intro")}</p>
        <section className="card pd-panel">
          {payloads.length === 0 && <p className="pd-muted">{t(locale, "clips.staff.noVideo")}</p>}
          {payloads.map(([e, clips]) => (
            <div key={e.id} style={{ marginBottom: 18 }}>
              <h2 className="section-title">{t(locale, "clips.staff.episode", { n: e.number })}</h2>
              <EpisodeClips titleId={detail.title.id} episodeNumber={e.number} initial={clips} canEdit={canEdit} hasVideo={e.has_video} locale={locale} />
            </div>
          ))}
        </section>
      </>
    );
  } catch (error) {
    if (isDataError(error) && error.code === "not_found") notFound();
    throw error;
  }
}
