import { notFound } from "next/navigation";
import AddEpisodes from "@/components/admin/AddEpisodes";
import ExportMenu from "@/components/admin/ExportMenu";
import { formatCents, percent } from "@/components/admin/format";
import { adminLocale, staffSession } from "@/components/admin/server";
import { EpisodePill, episodeStatusKey } from "@/components/admin/StatusPill";
import { chipReading, CrazydramasChip } from "@/components/producer/CrazydramasChip";
import TitleFlow from "@/components/TitleFlow";
import { episodeClipsPayload } from "@/lib/clips/payload";
import { loadCrazydramasStatus } from "@/lib/crazydramas";
import { getData, isDataError } from "@/lib/data";
import { isVideoOnly, usesTranslationWorkflow } from "@/lib/data/views";
import { t, type Locale } from "@/lib/i18n";
import { loadTitleFlow } from "@/lib/titles/flow";
import type { EpisodeSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

/** An episode's length as m:ss; "—" when it was never measured. */
function lengthText(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

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
  // A video without a script (QA 2026-09-15): nothing to adapt; the ad clips cut themselves and the producer picks ads.
  if (episode.lines_total === 0 && episode.has_video) {
    return {
      label: t(locale, "admin.episodeAction.open"),
      detail: t(locale, "admin.episodeNext.videoOnly"),
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
    // Each episode's auto-cut ad clips (decision 2026-09-14): staff see readiness beside the subtitle status.
    const clipStates = new Map(await Promise.all(detail.episodes.filter((e) => e.has_video).map(async (e) => [e.id, await episodeClipsPayload(session, detail.title.id, e.number)] as const)));
    // An imported film that never entered the translation workflow reads as imported (2026-09-24): its episodes, their
    // videos and ad clips, and where it stands on crazydramas — not "ingesting", "needs staff" or "with producer".
    const translation = usesTranslationWorkflow(detail.title, detail.episodes);
    // A title made in Studio whose every episode is a video with no script (UI sweep 2026-09-24) has nothing in the
    // translation workflow either: it reads as its videos and ad clips, and keeps Add episodes for a later script.
    const videoOnly = translation && isVideoOnly(detail.episodes);
    const simple = !translation || videoOnly;
    const withVideo = detail.episodes.filter((e) => e.has_video).length;
    const clipsReady = [...clipStates.values()].reduce((n, c) => n + c.clips.filter((x) => x.render_status === "rendered").length, 0);
    const crazydramas = await loadCrazydramasStatus(session, detail.title);
    const flow = await loadTitleFlow(session, detail.title, withVideo, crazydramas.state, "admin");
    const staffActions = detail.episodes.filter((episode) =>
      (episode.status === "ingested" && !(episode.has_video && episode.lines_total === 0)) ||
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
              {!translation && <span className="pill pill-neutral" data-imported="true">{t(locale, "admin.titles.imported", { n: detail.episodes.length })}</span>}
              {videoOnly && <span className="pill pill-neutral" data-video-only="true">{t(locale, "admin.titles.videoOnly", { n: detail.episodes.length })}</span>}
              <CrazydramasChip {...chipReading(crazydramas)} locale={locale} />
            </div>
            <div className="title-meta">
              {detail.title.name_en && detail.title.name_en !== detail.title.name_zh && <span>{detail.title.name_en}</span>}
              <span>{detail.producer.name_en || detail.producer.name_zh}</span>
              {detail.title.genre && <span>{detail.title.genre}</span>}
            </div>
          </div>
          <div className="title-actions">
            <a className="btn" href={`/titles/${detail.title.id}/pack`}>Creative pack</a>
            {/* The staff mirror of the CrazyDramas section (plan A4.4): where staff read the series' state and may press Check now. */}
            <a className="btn" href={`/titles/${detail.title.id}/crazydramas`}>{t(locale, "cd.admin.open")}</a>
            <a className="btn" href={`/titles/${detail.title.id}/clips`}>{t(locale, "clips.staff.open")}</a>
            {/* What this title's launches spent and brought (by title, 2026-09-24). */}
            <a className="btn" href={`/promote/monitor/titles/${detail.title.id}`}>{t(locale, "mad.openResults")}</a>
            <ExportMenu titleId={detail.title.id} episodes={detail.episodes} />
          </div>
        </div>

        <TitleFlow locale={locale} steps={flow} />

        {simple ? (
          <div className="stat-grid">
            <div className="stat">
              <span className="stat-label">{t(locale, "admin.title.episodes")}</span>
              <strong className="stat-value">{detail.episodes.length}</strong>
            </div>
            <div className="stat">
              <span className="stat-label">{t(locale, "admin.title.videos")}</span>
              <strong className="stat-value">{withVideo}</strong>
            </div>
            <div className="stat">
              <span className="stat-label">{t(locale, "admin.title.clipsReady")}</span>
              <strong className="stat-value">{clipsReady}</strong>
            </div>
            <div className="stat">
              <span className="stat-label">{t(locale, "admin.title.cost")}</span>
              <strong className="stat-value">{formatCents(detail.cost_cents)}</strong>
            </div>
          </div>
        ) : (
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
        )}

        {simple ? (
          <section className="card">
            <h2 className="field-group-title">{t(locale, "admin.title.episodes")}</h2>
            <p className="section-sub">{t(locale, videoOnly ? "admin.title.videoOnlyHelp" : "admin.title.importedHelp")}</p>
            <div className="gtable gtable-flush gt-resp episode-action-table" style={{ "--cols-lg": "72px minmax(140px, 1fr) 96px 150px 110px", "--cols-sm": "56px minmax(0, 1fr) 84px" } as React.CSSProperties}>
              <div className="gt-row gt-head" aria-hidden="true">
                <span>{t(locale, "admin.title.col.episode")}</span>
                <span className="gt-sm-hide">{t(locale, "admin.title.col.name")}</span>
                <span className="gt-sm-hide">{t(locale, "admin.title.col.length")}</span>
                <span>{t(locale, "admin.title.col.clips")}</span>
                <span />
              </div>
              {detail.episodes.map((episode) => {
                const clips = clipStates.get(episode.id);
                const ready = clips ? clips.clips.filter((c) => c.render_status === "rendered").length : 0;
                const cls = !clips ? "pill-neutral" : clips.state === "ready" ? "pill-success" : clips.state === "cutting" ? "pill-accent" : clips.state === "failed" ? "pill-error" : "pill-neutral";
                return (
                  <a key={episode.id} className="gt-row clickable" href={`/titles/${detail.title.id}/episodes/${episode.number}`} data-episode={episode.number}>
                    <span>{t(locale, "admin.episode.short", { n: episode.number })}</span>
                    <span className="gt-sm-hide">{episode.name_en || episode.name_zh || <span className="gt-muted">—</span>}</span>
                    <span className="gt-muted gt-sm-hide">{lengthText(episode.duration_ms)}</span>
                    <span><span className={`pill ${cls}`} title={clips?.note ?? undefined}>{!clips ? t(locale, "clips.noFile") : clips.state === "ready" ? t(locale, "clips.state.ready", { n: ready }) : t(locale, `clips.state.${clips.state}`)}</span></span>
                    <span className="btn btn-sm btn-outline">{t(locale, "admin.episodeAction.open")}</span>
                  </a>
                );
              })}
            </div>
          </section>
        ) : (
        <section className="card">
          <h2 className="field-group-title">{t(locale, "admin.title.episodes")}</h2>
          <p className="section-sub">{t(locale, "admin.title.episodesHelp")}</p>
          <div
            className="gtable gtable-flush episode-action-table"
            style={{ "--cols": "72px minmax(120px, .8fr) 126px 132px minmax(180px, 1fr) minmax(210px, 1fr) 124px" } as React.CSSProperties}
          >
            <div className="gt-row gt-head" aria-hidden="true">
              <span>{t(locale, "admin.title.col.episode")}</span>
              <span>{t(locale, "admin.title.col.name")}</span>
              <span>{t(locale, "admin.title.col.status")}</span>
              <span>{t(locale, "admin.title.col.clips")}</span>
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
                    {(() => {
                      const clips = clipStates.get(episode.id);
                      if (!clips) return <span className="pill pill-neutral">{t(locale, "clips.noFile")}</span>;
                      const ready = clips.clips.filter((c) => c.render_status === "rendered").length;
                      const cls = clips.state === "ready" ? "pill-success" : clips.state === "cutting" ? "pill-accent" : clips.state === "failed" ? "pill-error" : "pill-neutral";
                      return <span className={`pill ${cls}`} title={clips.note ?? undefined}>{clips.state === "ready" ? t(locale, "clips.state.ready", { n: ready }) : t(locale, `clips.state.${clips.state}`)}</span>;
                    })()}
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
        )}

        {translation && <AddEpisodes titleId={detail.title.id} nextNumber={next} />}
      </>
    );
  } catch (error) {
    if (isDataError(error) && error.code === "not_found") notFound();
    throw error;
  }
}
