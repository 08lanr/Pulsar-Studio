import { notFound } from "next/navigation";
import UploadEpisodes from "@/components/producer/UploadEpisodes";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { getData, isDataError } from "@/lib/data";
import { t } from "@/lib/i18n";
import type { EpisodeStatus, EpisodeSummary } from "@/lib/types";

// /producer/titles/[id] — one work's console: the pipeline step strip, the
// per-episode table (第 n 集 · 台词 · 状态 · one action), and the uploader for
// more episodes. The action per row names the next thing to do, so nobody
// has to understand the machinery to keep moving.

export const dynamic = "force-dynamic";

const STATUS_PILL: Record<EpisodeStatus, string> = {
  ingested: "pill-neutral",
  adapting: "pill-accent",
  in_review: "pill-warning",
  approved: "pill-success",
};

function actionKey(e: EpisodeSummary): string {
  if (e.status === "approved") return "pw.title.subs";
  if (e.status === "in_review") return "pw.title.review";
  if (e.status === "adapting") return "pw.title.continue";
  return "pw.title.start";
}

export default async function ProducerTitlePage({ params }: { params: { id: string } }) {
  const session = await portalSession(`/producer/titles/${params.id}`);
  const locale = producerLocale();
  let detail;
  try {
    detail = await getData().getTitle(session, params.id);
  } catch (e) {
    if (isDataError(e) && (e.code === "not_found" || e.code === "forbidden")) notFound();
    throw e;
  }
  const episodes = detail.episodes;
  const anyAdapted = episodes.some((e) => e.lines_adapted > 0 || e.status !== "ingested");
  const allApproved = episodes.length > 0 && episodes.every((e) => e.status === "approved");
  const anyConfirming = episodes.some((e) => e.status === "adapting" || e.status === "in_review");
  // 上传剧本 → AI 改编 → 审阅修改 → 定稿 → 字幕交付
  const step = allApproved ? 5 : anyConfirming ? 3 : anyAdapted ? 2 : episodes.length ? 1 : 0;
  const steps = ["pw.steps.upload", "pw.steps.generate", "pw.steps.confirm", "pw.steps.final", "pw.steps.subs"];
  const nextNumber = episodes.reduce((m, e) => Math.max(m, e.number), 0) + 1;
  const canEdit = !isStaffPreview(session);
  const approvedCount = episodes.filter((e) => e.status === "approved").length;
  const activeCount = episodes.filter((e) => e.status === "adapting" || e.status === "in_review").length;

  return (
    <>
      <nav className="studio-crumbs" aria-label={t(locale, "v3.breadcrumbs")}>
        <a href="/producer">{t(locale, "v3.nav.library")}</a>
        <span aria-hidden>›</span>
        <span>{detail.title.name_en || detail.title.name_zh}</span>
      </nav>

      <div className="page-head title-console-head">
        <div>
          <span className="page-kicker">{t(locale, "v3.title.workspace")}</span>
          <h2 className="bilingual" lang="zh-CN">
            {detail.title.name_zh}
          </h2>
          {(detail.title.name_en || detail.title.genre) && (
            <p className="page-sub">
              {[detail.title.name_en, detail.title.genre].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
        {canEdit && <a className="btn btn-outline" href="#add-episodes">{t(locale, "v3.title.addEpisodes")}</a>}
      </div>

      <section className="title-overview" aria-label={t(locale, "v3.title.overview")}>
        <div>
          <span>{t(locale, "v3.title.progress")}</span>
          <strong>{t(locale, "v3.title.approvedCount", { done: approvedCount, total: episodes.length })}</strong>
        </div>
        <div>
          <span>{t(locale, "v3.title.inProgress")}</span>
          <strong>{activeCount}</strong>
        </div>
        <div className="title-next-step">
          <span>{t(locale, "review.nextStep")}</span>
          <strong>{t(locale, steps[Math.max(0, Math.min(steps.length - 1, step - 1))])}</strong>
        </div>
      </section>

      <section className="episode-list" aria-label={t(locale, "v3.title.episodes")}>
        <header className="episode-list-head">
          <div><span>{t(locale, "v3.title.episodes")}</span><strong>{episodes.length}</strong></div>
          <span>{t(locale, "v3.title.actionHint")}</span>
        </header>
        {episodes.length === 0 && <p className="hint">{t(locale, "pw.title.noEpisodes")}</p>}
        {episodes.map((e) => (
          <article className="episode-row" key={e.id}>
            <span className="episode-row-number">{String(e.number).padStart(2, "0")}</span>
            <div className="episode-row-name">
              <strong>{e.name_en || e.name_zh || t(locale, "portal.episode", { n: e.number })}</strong>
              <span>{t(locale, "pw.title.lines", { done: e.lines_adapted, total: e.lines_total })}</span>
              <div className="episode-progress" aria-hidden><i style={{ width: `${e.lines_total ? Math.round((e.lines_adapted / e.lines_total) * 100) : 0}%` }} /></div>
            </div>
            <span className={`pill ${STATUS_PILL[e.status]}`}>{t(locale, `pw.epStatus.${e.status}`)}</span>
            <a
              className={`btn btn-sm ${e.status === "ingested" || e.status === "adapting" ? "btn-primary" : "btn-outline"}`}
              href={`/producer/titles/${detail.title.id}/episodes/${e.number}${e.status === "approved" ? "/subtitles" : ""}`}
            >
              {t(locale, actionKey(e))}
            </a>
          </article>
        ))}
      </section>

      {canEdit && (
        <details className="add-episodes-panel" id="add-episodes">
          <summary>{t(locale, "v3.title.addEpisodes")}<span>{t(locale, "v3.title.addEpisodesHint")}</span></summary>
          <div className="add-episodes-content"><UploadEpisodes titleId={detail.title.id} nextNumber={nextNumber} /></div>
        </details>
      )}
    </>
  );
}
