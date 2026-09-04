import { notFound } from "next/navigation";
import AddEpisodes from "@/components/admin/AddEpisodes";
import ExportMenu from "@/components/admin/ExportMenu";
import { formatCents, percent } from "@/components/admin/format";
import { adminLocale, staffSession } from "@/components/admin/server";
import { EpisodePill, episodeStatusKey } from "@/components/admin/StatusPill";
import { getData, isDataError } from "@/lib/data";
import { t, type Locale } from "@/lib/i18n";
import type { EpisodeSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

function nextAction(locale: Locale, episode: EpisodeSummary) {
  if (episode.status === "approved") {
    return {
      label: t(locale, "admin.episodeAction.viewApproved"),
      detail: t(locale, "admin.episodeNext.complete"),
      owner: t(locale, "admin.episodeOwner.complete"),
      tone: "done",
    };
  }
  if (
    episode.status === "in_review" &&
    episode.partner_scenes_needing_alternative > 0 &&
    episode.partner_scenes_decided === episode.scenes_total
  ) {
    return {
      label: t(locale, "admin.episodeAction.openRequest"),
      detail: t(locale, "admin.episodeNext.changes", { n: episode.partner_scenes_needing_alternative }),
      owner: t(locale, "admin.episodeOwner.staff"),
      tone: "blocked",
    };
  }
  if (episode.status === "in_review") {
    return {
      label: episode.partner_scenes_needing_alternative > 0
        ? t(locale, "admin.episodeAction.openRequest")
        : t(locale, "admin.episodeAction.viewReview"),
      detail: episode.partner_scenes_needing_alternative > 0
        ? t(locale, "admin.episodeNext.feedbackPending", {
            remaining: episode.scenes_total - episode.partner_scenes_decided,
            changes: episode.partner_scenes_needing_alternative,
          })
        : episode.partner_scenes_decided < episode.scenes_total
          ? t(locale, "admin.episodeNext.producerScenes", {
              n: episode.scenes_total - episode.partner_scenes_decided,
            })
          : t(locale, "admin.episodeNext.producer"),
      owner: t(locale, "admin.episodeOwner.producer"),
      tone: "waiting",
    };
  }
  if (episode.lines_adapted < episode.lines_total) {
    return {
      label: episode.lines_adapted > 0
        ? t(locale, "admin.episodeAction.continue")
        : t(locale, "admin.episodeAction.start"),
      detail: episode.lines_adapted > 0
        ? t(locale, "admin.episodeNext.lines", { n: episode.lines_total - episode.lines_adapted })
        : t(locale, "admin.episodeNext.start", { n: episode.lines_total }),
      owner: t(locale, "admin.episodeOwner.staff"),
      tone: "next",
    };
  }
  if (episode.scenes_approved < episode.scenes_total) {
    return {
      label: t(locale, "admin.episodeAction.reviewScenes"),
      detail: t(locale, "admin.episodeNext.scenes", { n: episode.scenes_total - episode.scenes_approved }),
      owner: t(locale, "admin.episodeOwner.staff"),
      tone: "next",
    };
  }
  return {
    label: t(locale, "admin.episodeAction.send"),
    detail: t(locale, "admin.episodeNext.send"),
    owner: t(locale, "admin.episodeOwner.staff"),
    tone: "ready",
  };
}

export default async function TitlePage({ params }: { params: { id: string } }) {
  const session = await staffSession();
  const locale = adminLocale();

  try {
    const detail = await getData().getTitle(session, params.id);
    const next = Math.max(0, ...detail.episodes.map((episode) => episode.number)) + 1;
    const staffActions = detail.episodes.filter((episode) =>
      episode.status === "ingested" ||
      episode.status === "adapting" ||
      (episode.status === "in_review" &&
        episode.partner_scenes_needing_alternative > 0 &&
        episode.partner_scenes_decided === episode.scenes_total)
    ).length;
    const withProducer = detail.episodes.filter(
      (episode) => episode.status === "in_review" && !(
        episode.partner_scenes_needing_alternative > 0 &&
        episode.partner_scenes_decided === episode.scenes_total
      )
    ).length;

    return (
      <>
        <div className="title-head">
          <a className="title-back" href="/titles">← {t(locale, "title.backToTitles")}</a>
          <div className="title-main">
            <div className="title-row">
              <h1 className="bilingual" lang="zh-CN">{detail.title.name_zh}</h1>
            </div>
            <div className="title-meta">
              {detail.title.name_en && <span>{detail.title.name_en}</span>}
              <span>{detail.producer.name_en || detail.producer.name_zh}</span>
              <span>{detail.title.genre}</span>
            </div>
          </div>
          <div className="title-actions">
            <a className="btn" href={`/titles/${detail.title.id}/pack`}>Creative pack</a>
            <ExportMenu titleId={detail.title.id} episodes={detail.episodes} />
          </div>
        </div>

        <div className="stat-grid">
          <div className="stat">
            <span className="stat-label">{t(locale, "admin.title.episodes")}</span>
            <strong className="stat-value">{detail.episodes.length}/{detail.title.episode_count || "—"}</strong>
          </div>
          <div className="stat stat-attention">
            <span className="stat-label">{t(locale, "admin.title.needsStaff")}</span>
            <strong className="stat-value">{staffActions}</strong>
          </div>
          <div className="stat">
            <span className="stat-label">{t(locale, "admin.title.withProducer")}</span>
            <strong className="stat-value">{withProducer}</strong>
          </div>
          <div className="stat">
            <span className="stat-label">{t(locale, "admin.title.cost")}</span>
            <strong className="stat-value">{formatCents(detail.cost_cents)}</strong>
          </div>
        </div>

        <section className="card">
          <h3 className="field-group-title">{t(locale, "admin.title.episodes")}</h3>
          <p className="section-sub">{t(locale, "admin.title.episodesHelp")}</p>
          <div
            className="gtable gtable-flush episode-action-table"
            style={{ "--cols": "72px minmax(120px, .8fr) 126px minmax(180px, 1fr) minmax(210px, 1fr) 124px" } as React.CSSProperties}
          >
            <div className="gt-row gt-head" aria-hidden="true">
              <span>{t(locale, "admin.title.col.episode")}</span>
              <span>{t(locale, "admin.title.col.name")}</span>
              <span>{t(locale, "admin.title.col.status")}</span>
              <span>{t(locale, "admin.title.col.progress")}</span>
              <span>{t(locale, "admin.title.col.next")}</span>
              <span />
            </div>
            {detail.episodes.map((episode) => {
              const action = nextAction(locale, episode);
              const progress = episode.lines_total
                ? percent((episode.lines_adapted / episode.lines_total) * 100)
                : 0;
              return (
                <a
                  key={episode.id}
                  className="gt-row clickable"
                  href={`/titles/${detail.title.id}/episodes/${episode.number}`}
                >
                  <span>{t(locale, "admin.episode.short", { n: episode.number })}</span>
                  <span>{episode.name_en || episode.name_zh || t(locale, "admin.episode.untitled")}</span>
                  <span>
                    {episode.partner_scenes_needing_alternative > 0 && episode.partner_scenes_decided === episode.scenes_total
                      ? <span className="pill status-changes">{t(locale, "admin.episodeStatus.changes")}</span>
                      : <EpisodePill status={episode.status} label={t(locale, episodeStatusKey(episode.status))} />}
                  </span>
                  <span>
                    <span>{t(locale, "admin.episode.progress", {
                      lines: episode.lines_adapted,
                      totalLines: episode.lines_total,
                      scenes: episode.scenes_approved,
                      totalScenes: episode.scenes_total,
                    })}</span>
                    <span className="track"><span style={{ width: `${progress}%` }} /></span>
                  </span>
                  <span className={`next-action next-action-${action.tone}`}>
                    <strong>{action.detail}</strong>
                    <small>{t(locale, "admin.episode.owner", { owner: action.owner })}</small>
                  </span>
                  <span className={`btn btn-sm ${action.tone === "ready" || action.tone === "blocked" ? "btn-primary" : "btn-outline"}`}>
                    {action.label}
                  </span>
                </a>
              );
            })}
          </div>
        </section>

        <AddEpisodes titleId={detail.title.id} nextNumber={next} />
      </>
    );
  } catch (error) {
    if (isDataError(error) && error.code === "not_found") notFound();
    throw error;
  }
}
