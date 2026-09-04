import { notFound } from "next/navigation";
import UploadEpisodes from "@/components/producer/UploadEpisodes";
import { IconArrowLeft, IconCheck } from "@/components/producer/icons";
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

  return (
    <>
      <div className="page-head">
        <div>
          <a className="title-back" href="/producer">
            <IconArrowLeft size={14} /> {t(locale, "portal.back.titles")}
          </a>
          <h2 className="bilingual" lang="zh-CN">
            {detail.title.name_zh}
          </h2>
          {(detail.title.name_en || detail.title.genre) && (
            <p className="page-sub">
              {[detail.title.name_en, detail.title.genre].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="flowsteps" aria-label={t(locale, "pw.steps.label")}>
          {steps.map((key, i) => (
            <span key={key} className={`flowstep ${i + 1 < step ? "done" : i + 1 === step ? "active" : ""}`}>
              <span className="flowstep-dot">{i + 1 < step ? <IconCheck size={12} /> : i + 1}</span>
              {t(locale, key)}
            </span>
          ))}
        </div>
      </div>

      <div className="card gtable-flush">
        {episodes.length === 0 && <p className="hint">{t(locale, "pw.title.noEpisodes")}</p>}
        {episodes.map((e) => (
          <div className="gt-row" key={e.id} style={{ ["--cols" as never]: "80px 1fr auto auto" }}>
            <span>{t(locale, "portal.episode", { n: e.number })}</span>
            <span className="gt-muted">
              {t(locale, "pw.title.lines", { done: e.lines_adapted, total: e.lines_total })}
            </span>
            <span className={`pill ${STATUS_PILL[e.status]}`}>{t(locale, `pw.epStatus.${e.status}`)}</span>
            <a
              className={`btn btn-sm ${e.status === "ingested" || e.status === "adapting" ? "btn-primary" : "btn-outline"}`}
              href={`/producer/titles/${detail.title.id}/episodes/${e.number}${e.status === "approved" ? "/subtitles" : ""}`}
            >
              {t(locale, actionKey(e))}
            </a>
          </div>
        ))}
      </div>

      {canEdit && (
        <div className="card">
          <UploadEpisodes titleId={detail.title.id} nextNumber={nextNumber} />
        </div>
      )}
    </>
  );
}
