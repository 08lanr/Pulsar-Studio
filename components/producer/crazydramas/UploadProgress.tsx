"use client";

// Step 2 of "Upload to crazydramas" (publish spec §1c, §2, §8–10): the
// per-episode progress, one row per episode number, read from Studio's
// ledger (studio.cd_publications) and crazydramas' own episode status.
// Uploading never publishes. The words, in the order an episode walks them:
// queued, uploading x%, processing (Mux has the bytes), ready (checking),
// verified (ready to publish), published; or failed with its reason. The
// toolbar uploads every episode not yet on crazydramas or a chosen range,
// cancels what is queued or running, and retries the failed ones (a row that
// failed because someone else's upload holds the episode now offers Replace,
// with its viewer warning, never a plain Retry); a row's action column is
// fixed-width (Cancel, Retry, Replace) so rows align.

import { useState } from "react";
import { useT } from "@/components/locale";
import { ACTIVE_LEDGER_STEPS, needsReplace, type CdLedgerStep, type PublishEpisode } from "@/lib/crazydramas/publish-types";

type Props = {
  episodes: readonly PublishEpisode[];
  /** The series exists on crazydramas and Studio manages it; before that the table only lists what would go. */
  seriesReady: boolean;
  /** The person may act and writes are on. */
  canWrite: boolean;
  /** A write is in flight (the parent's); every button waits. */
  busy: boolean;
  onUpload: (episodes: number[] | "all", replace?: boolean) => void;
  onCancel: (episode?: number) => void;
  onReplace: (episode: number) => void;
};

/** What a row says, derived from the ledger step and crazydramas' own status. */
export type RowStage = "none" | "no_file" | "queued" | "uploading" | "processing" | "checking" | "verified" | "published" | "failed" | "replaced" | "on_cd";

export function rowStage(e: PublishEpisode): RowStage {
  if (e.is_published && (e.ledger_step === null || e.ledger_step === "published" || e.ledger_step === "verified")) return "published";
  switch (e.ledger_step as CdLedgerStep | null) {
    case "planned":
      return "queued";
    case "upload_created":
      return "uploading";
    case "bytes_sent":
      return "processing";
    case "asset_ready":
      return "checking";
    case "verified":
      return "verified";
    case "published":
      return e.is_published ? "published" : "verified";
    case "failed":
      return "failed";
    case "superseded":
      return "replaced";
    default:
      if (e.cd_status) return "on_cd";
      return e.studio_frames === null ? "no_file" : "none";
  }
}

export const STAGE_PILL: Record<RowStage, string> = {
  none: "pill-neutral",
  no_file: "pill-neutral",
  queued: "pill-neutral",
  uploading: "pill-accent",
  processing: "pill-accent",
  checking: "pill-accent",
  verified: "pill-success",
  published: "pill-success",
  failed: "pill-error",
  replaced: "pill-neutral",
  on_cd: "pill-neutral",
};

/** The episode is Studio's to send now: a file, and nothing on crazydramas or in flight for it. */
export function canUploadEpisode(e: PublishEpisode): boolean {
  const stage = rowStage(e);
  return e.studio_frames !== null && (stage === "none" || stage === "replaced") && !e.cd_status;
}

export function isActive(e: PublishEpisode): boolean {
  return !!e.ledger_step && ACTIVE_LEDGER_STEPS.includes(e.ledger_step);
}

/** A failed row's way forward: Replace when someone else's upload holds the episode now (a plain Retry never overwrites it), else Retry. */
export function failedAction(e: PublishEpisode): "retry" | "replace" | null {
  if (rowStage(e) !== "failed" || e.studio_frames === null) return null;
  return needsReplace(e.error_code) ? "replace" : "retry";
}

function percent(e: PublishEpisode): number | null {
  if (!e.bytes_total || e.bytes_sent == null) return null;
  return Math.max(0, Math.min(100, Math.floor((e.bytes_sent / e.bytes_total) * 100)));
}

/** The bar's counts: episode files, those crazydramas holds (verified, published or already there), those on their way, failed, published. */
export function uploadTotals(rows: readonly PublishEpisode[]): { files: number; onCd: number; moving: number; failed: number; published: number } {
  const files = rows.filter((e) => e.studio_frames !== null);
  const stages = files.map(rowStage);
  return {
    files: files.length,
    onCd: stages.filter((st) => st === "verified" || st === "published" || st === "on_cd").length,
    moving: files.filter(isActive).length,
    failed: stages.filter((st) => st === "failed").length,
    published: stages.filter((st) => st === "published").length,
  };
}

const COLS = "84px 110px 76px minmax(220px,2fr) minmax(150px,1fr) 128px";

export default function UploadProgress({ episodes, seriesReady, canWrite, busy, onUpload, onCancel, onReplace }: Props) {
  const { tt } = useT();
  const rows = [...episodes].sort((a, b) => a.n - b.n);
  const numbers = rows.filter((e) => e.studio_frames !== null).map((e) => e.n);
  const first = numbers.length ? Math.min(...numbers) : 1;
  const last = numbers.length ? Math.max(...numbers) : 1;
  const [from, setFrom] = useState(String(first));
  const [to, setTo] = useState(String(last));
  const uploadable = rows.filter(canUploadEpisode);
  const active = rows.filter(isActive);
  const failed = rows.filter((e) => failedAction(e) === "retry");
  const on = canWrite && seriesReady && !busy;
  const a = Number(from);
  const b = Number(to);
  const rangeOk = Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= a && b <= 500;
  const range = rangeOk ? rows.filter((e) => e.n >= a && e.n <= b && canUploadEpisode(e)).map((e) => e.n) : [];
  const totals = uploadTotals(rows);

  function stageCell(e: PublishEpisode) {
    const stage = rowStage(e);
    const pct = stage === "uploading" ? percent(e) : null;
    return (
      <span className="cdp-stage">
        <span>
          <span className={`pill ${STAGE_PILL[stage]}`}>{stage === "uploading" && pct !== null ? tt("cdp.stage.uploadingPct", { pct }) : tt(`cdp.stage.${stage}`)}</span>
        </span>
        {stage === "uploading" && pct !== null && <span className="track cdp-track" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>}
        {stage === "failed" && <small className="err">{e.error ? tt("cdp.stage.failed.reason", { reason: e.error }) : tt("cdp.stage.failed.noReason")}</small>}
        {stage !== "failed" && e.error && <small className="gt-muted">{e.error}</small>}
        {stage === "processing" && <small className="gt-muted">{tt("cdp.stage.processing.hint")}</small>}
        {stage === "verified" && !e.is_published && <small className="gt-muted">{tt("cdp.stage.verified.hint")}</small>}
      </span>
    );
  }

  function cdCell(e: PublishEpisode) {
    if (!e.cd_status) return <span className="gt-muted">{tt("cdp.cd.none")}</span>;
    return (
      <span className="cdp-stage">
        <span>{tt(`cdp.cd.status.${["uploading", "processing", "ready", "failed"].includes(e.cd_status) ? e.cd_status : "other"}`, { status: e.cd_status })}</span>
        <small className={e.is_published ? "cdp-ok" : "gt-muted"}>{tt(e.is_published ? "cdp.cd.published" : "cdp.cd.notPublished")}</small>
      </span>
    );
  }

  function actionCell(e: PublishEpisode) {
    if (!canWrite || !seriesReady) return <span className="gt-muted">—</span>;
    const stage = rowStage(e);
    if (stage === "queued" || stage === "uploading") {
      return <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => onCancel(e.n)} aria-label={tt("cdp.row.cancel.aria", { n: e.n })}>{tt("cdp.row.cancel")}</button>;
    }
    const onFailed = failedAction(e);
    if (onFailed === "replace") {
      return <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => onReplace(e.n)} aria-label={tt("cdp.row.replace.aria", { n: e.n })}>{tt("cdp.row.replace")}</button>;
    }
    if (onFailed === "retry") {
      return <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => onUpload([e.n])} aria-label={tt("cdp.row.retry.aria", { n: e.n })}>{tt("cdp.row.retry")}</button>;
    }
    if (e.replace_needed && e.studio_frames !== null && (e.cd_status === "ready" || e.cd_status === "failed")) {
      return <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => onReplace(e.n)} aria-label={tt("cdp.row.replace.aria", { n: e.n })}>{tt("cdp.row.replace")}</button>;
    }
    return <span className="gt-muted">—</span>;
  }

  return (
    <div className="cdp-uploads">
      {canWrite && (
        <div className="cdp-toolbar">
          <button type="button" className="btn btn-primary btn-sm" disabled={!on || uploadable.length === 0} onClick={() => onUpload("all")}>
            {tt("cdp.upload.all", { n: uploadable.length })}
          </button>
          <span className="cdp-range">
            <span className="hint">{tt("cdp.upload.range.or")}</span>
            <input className="input input-inline" inputMode="numeric" aria-label={tt("cdp.upload.range.from")} value={from} onChange={(ev) => setFrom(ev.target.value)} disabled={!on} />
            <span className="hint">{tt("cdp.upload.range.to")}</span>
            <input className="input input-inline" inputMode="numeric" aria-label={tt("cdp.upload.range.toLabel")} value={to} onChange={(ev) => setTo(ev.target.value)} disabled={!on} />
            {tt("cdp.upload.range.suffix") && <span className="hint">{tt("cdp.upload.range.suffix")}</span>}
            <button type="button" className="btn btn-outline btn-sm" disabled={!on || range.length === 0} onClick={() => onUpload(range)}>{tt("cdp.upload.range")}</button>
          </span>
          <span className="spacer" />
          {active.length > 0 && <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => onCancel()}>{tt("cdp.upload.cancelAll", { n: active.length })}</button>}
          {failed.length > 0 && <button type="button" className="btn btn-outline btn-sm" disabled={!on} onClick={() => onUpload(failed.map((e) => e.n))}>{tt("cdp.upload.retryFailed", { n: failed.length })}</button>}
        </div>
      )}
      {canWrite && !seriesReady && <p className="hint">{tt("cdp.upload.needSeries")}</p>}
      {seriesReady && totals.files > 0 && (
        // The whole upload at a glance (2026-09-24): how many of the title's episode files crazydramas holds, and what is on its way.
        <div className="cdp-bar cdp-upload-bar" role="status" data-uploaded={totals.onCd} data-total={totals.files}>
          <span className="track" aria-hidden="true"><span style={{ width: `${Math.round((100 * totals.onCd) / totals.files)}%` }} /></span>
          <small>
            <strong>{tt("cdp.upload.bar", { n: totals.onCd, total: totals.files })}</strong>
            {totals.moving > 0 && <> · {tt("cdp.upload.bar.moving", { n: totals.moving })}</>}
            {totals.failed > 0 && <> · <span className="err">{tt("cdp.upload.bar.failed", { n: totals.failed })}</span></>}
            {totals.published > 0 && <> · {tt("cdp.upload.bar.published", { n: totals.published })}</>}
          </small>
        </div>
      )}
      {active.length > 0 && <p className="hint" role="status"><span className="spinner" /> {active.length === 1 ? tt("cdp.upload.runningOne") : tt("cdp.upload.running", { n: active.length })}</p>}
      {rows.length === 0 ? (
        <p className="hint">{tt("cdp.upload.none")}</p>
      ) : (
        <div className="gtable cdp-table" role="region" aria-label={tt("cdp.step.upload")} tabIndex={0} style={{ "--cols": COLS } as React.CSSProperties}>
          <div className="gt-head">
            <span>{tt("cd.col.episode")}</span>
            <span className="gt-num">{tt("cdp.col.file")}</span>
            <span>{tt("cd.col.access")}</span>
            <span>{tt("cdp.col.upload")}</span>
            <span>{tt("cdp.col.cd")}</span>
            <span>{tt("cdp.col.action")}</span>
          </div>
          {rows.map((e) => (
            <div className="gt-row" key={e.n} data-episode={e.n} data-stage={rowStage(e)}>
              <strong>{tt("cd.episodeN", { n: e.n })}</strong>
              <span className="gt-num">{e.studio_frames !== null ? tt("cd.frames", { n: e.studio_frames }) : <span className="gt-muted">{tt("cdp.file.none")}</span>}</span>
              <span>{tt(e.is_free ? "cd.access.free" : "cd.access.paid")}</span>
              {stageCell(e)}
              {cdCell(e)}
              <span className="cdp-action">{actionCell(e)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
