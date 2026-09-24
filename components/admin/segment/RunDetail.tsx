"use client";

// One run's screen (plan B2): the header facts, the stage timeline on the
// left, and on the right the panel of the stage the run is at — the
// watermark proof, the cards picker (source-episodes mode), the index log,
// the vision pass (or the Claude Code hand-off with the exact Workflow
// call and the field for its .output file), the door to the boundary
// review, the render progress, the QA sheets, the film-meta form, "Import
// now", and the title once it exists. A refusal is shown verbatim, and a
// failed run offers Retry (back to the stage that failed). Polls every
// 2.5 s until the run is done, failed or cancelled; every decision goes
// through POST …/decide and the reply replaces the row.

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, getJson, postJson } from "@/lib/api-client";
import { useT } from "@/components/locale";
import type { DecisionBody, RunDetailReply, RunReply, WatermarkJson } from "@/lib/segment/api-types";
import type { Json } from "@/lib/types";
import Elsewhere from "./Elsewhere";
import FilmMetaForm from "./FilmMetaForm";
import { fmtT, isTerminal, progressText, sourceFactsOf, stageIndex, waitingFor } from "./model";
import { stagePill } from "./RunList";
import RunTimeline from "./RunTimeline";
import WatermarkStep from "./WatermarkStep";

const POLL_MS = 2500;

type Reply = Partial<RunReply> & { error?: string };

function baseName(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

function rec(v: Json | null | undefined): Record<string, Json | undefined> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json | undefined>) : null;
}

function str(v: Json | undefined): string | null {
  return typeof v === "string" && v ? v : null;
}

export default function RunDetail({ runId }: { runId: string }) {
  const { tt, locale } = useT();
  // A decision's action in words (UI sweep 2026-09-24: the log printed the codes, "watermark_accept", "import_now"); an unknown one reads with spaces.
  const decisionLabel = (action: string) => {
    const key = `seg.decision.${action}`;
    const words = tt(key);
    return words === key ? action.replaceAll("_", " ") : words;
  };
  const [data, setData] = useState<RunDetailReply | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [outputPath, setOutputPath] = useState("");
  const [templates, setTemplates] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getJson<RunDetailReply>(`/api/admin/films/runs/${encodeURIComponent(runId)}`);
      setData(next);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof ApiRequestError ? e.message : (e as Error).message);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const alive = !!data && !isTerminal(data.run.stage);
  useEffect(() => {
    if (!alive && data) return;
    timer.current = setTimeout(() => void load(), POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [alive, data, load]);

  async function decide(body: DecisionBody) {
    setBusy(true);
    setActionError(null);
    try {
      const r = await postJson<Reply>(`/api/admin/films/runs/${encodeURIComponent(runId)}/decide`, body);
      if (r.error) setActionError(r.error);
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!window.confirm(tt("seg.run.cancelConfirm"))) return;
    setBusy(true);
    setActionError(null);
    try {
      const r = await postJson<Reply>(`/api/admin/films/runs/${encodeURIComponent(runId)}/cancel`, {});
      if (r.error) setActionError(r.error);
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  if (loadError) {
    return (
      <div className="sgm-actions">
        <p className="err" role="alert" style={{ margin: 0 }}>{tt("seg.run.loadFailed", { detail: loadError })}</p>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => void load()}>{tt("seg.refresh")}</button>
        <a className="btn btn-ghost btn-sm" href="/films/runs">{tt("seg.run.back")}</a>
      </div>
    );
  }
  if (!data) return <p className="hint" role="status">{tt("seg.loading")}</p>;
  if (data.elsewhere) return <Elsewhere run={data.run} computer={data.elsewhere.name} />;

  const { run, stage_view: view } = data;
  const stage = run.stage;
  const detail = rec(run.stage_detail) ?? {};
  const waiting = waitingFor(run.stage_detail);
  const progress = progressText(run.stage_detail);
  const source = sourceFactsOf(run.stage_detail);
  const reviewHref = `/films/runs/${run.id}/review`;
  const handoff = rec(detail.handoff);
  const handoffCommand = handoff ? str(handoff.command) : null;
  const unavailable = str(detail.unavailable);
  const handoffError = str(detail.handoff_error);
  const applyRefused = str(detail.apply_refused);
  const heavyLock = rec(detail.waiting_for_heavy_lock);
  const cards = rec(detail.cards);
  const importError = str(detail.import_error);
  const importProgress = view.import.progress;
  const titleId = run.title_id ?? view.import.title_id;
  const qaSheets = view.qa ? view.qa.episodes.map((e) => ({ ...e, url: view.qa!.sheets.find((s) => s.n === e.n)?.url ?? null })) : [];
  const metaInitial = view.film_meta ? { ...view.film_meta.default, ...((rec(view.film_meta.current) as Partial<typeof view.film_meta.default> | null) ?? {}) } : null;
  const templateTimes = templates.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n >= 0);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="page-head">
        <div>
          <h1 lang="en">{run.slug}</h1>
          <p className="sgm-facts">
            <span title={run.source_path}>{baseName(run.source_path)}</span>
            <span>{tt(`seg.mode.${run.mode}`)}</span>
            <span>{run.lang}</span>
            {source ? <span>{source.width}×{source.height} · {source.fps} fps{source.duration_s ? ` · ${fmtT(source.duration_s)}` : ""}</span> : null}
            {run.settings.to_s ? <span>{tt("seg.run.toS", { t: fmtT(run.settings.to_s) })}</span> : null}
            {run.drama_remix_sha ? <span>drama-remix <code>{run.drama_remix_sha.slice(0, 10)}</code>{run.drama_remix_dirty ? ` · ${tt("seg.run.dirty")}` : ""}</span> : null}
            {run.lease_owner ? <span>{tt("seg.run.worker", { owner: run.lease_owner })}</span> : null}
            {view.film.cut_dir ? <span><code>{view.film.cut_dir}</code></span> : null}
          </p>
        </div>
        <div className="title-actions sgm-actions">
          <span className={`pill ${stagePill(stage)}`} data-stage={stage}>{tt(`seg.stage.${stage}`)}</span>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void load()}>{tt("seg.refresh")}</button>
          {!isTerminal(stage) && <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void cancel()}>{tt("seg.run.cancel")}</button>}
          <a className="btn btn-ghost btn-sm" href="/films/runs">{tt("seg.run.back")}</a>
        </div>
      </div>

      {run.error_text && <pre className="sgm-refusal" role="alert" data-testid="refusal">{run.error_text}</pre>}
      {actionError && <p className="err" role="alert">{tt("seg.run.actionFailed", { detail: actionError })}</p>}
      {heavyLock && <p className="note note-info" role="status">{tt("seg.run.heavyLock", { holder: str(heavyLock.owner) ?? "?", what: str(heavyLock.what) ?? "?" })}</p>}

      <div className="sgm-layout">
        <aside className="card"><RunTimeline run={run} /></aside>
        <div className="sgm-panel">
          {stage === "queued" && <section className="card"><p className="hint" role="status"><span className="spinner" /> {tt("seg.run.queued")}</p></section>}

          {stage === "intake" && <section className="card"><p className="hint" role="status"><span className="spinner" /> {progress || tt("seg.stageHint.intake")}</p></section>}

          {stage === "watermark" && (
            <section className="card" aria-label={tt("seg.stage.watermark")}>
              <h2 className="section-title">{tt("seg.wm.title")}</h2>
              {str(detail.detect_tail) && <pre className="sgm-cmd" style={{ marginBottom: 12 }}>{str(detail.detect_tail)}</pre>}
              <WatermarkStep view={view.watermark as WatermarkJson | null} busy={busy || waiting !== "watermark"} onDecide={(d) => void decide(d)} />
            </section>
          )}

          {stage === "index" && (
            <section className="card" aria-label={tt("seg.stage.index")}>
              <h2 className="section-title">{tt("seg.stage.index")}</h2>
              <p className="hint" role="status"><span className="spinner" /> {progress || tt("seg.stageHint.index")}</p>
            </section>
          )}

          {stage === "cards" && (
            <section className="card" aria-label={tt("seg.stage.cards")}>
              <h2 className="section-title">{tt("seg.cards.title")}</h2>
              <p className="hint">{tt("seg.cards.hint")}</p>
              {cards && str(cards.evidence) ? (
                /* eslint-disable-next-line @next/next/no-img-element -- evidence served by our own route */
                <img src={`${view.evidence_base}/${str(cards.evidence)}`} alt={tt("seg.cards.evidenceAlt")} style={{ maxWidth: "100%", borderRadius: "var(--radius)", marginTop: 12 }} />
              ) : null}
              <label className="field" style={{ marginTop: 12 }}>
                <span className="label">{tt("seg.cards.templates")}</span>
                <input className="input" value={templates} onChange={(e) => setTemplates(e.target.value)} placeholder="121.4, 243.9" spellCheck={false} />
                <span className="hint">{tt("seg.cards.templatesHint", { duration: cards && typeof cards.duration_s === "number" ? fmtT(cards.duration_s) : "—" })}</span>
              </label>
              <div className="sgm-actions" style={{ marginTop: 12 }}>
                <button type="button" className="btn btn-primary" disabled={busy || waiting !== "cards" || templateTimes.length === 0} onClick={() => void decide({ kind: "cards", templates: templateTimes })}>{tt("seg.cards.save", { n: templateTimes.length })}</button>
              </div>
            </section>
          )}

          {(stage === "plan" || stage === "vision") && (
            <section className="card" aria-label={tt(`seg.stage.${stage}`)}>
              <h2 className="section-title">{tt(`seg.stage.${stage}`)}</h2>
              {stage === "plan" && <p className="hint" role="status"><span className="spinner" /> {progress || tt("seg.stageHint.plan")}</p>}
              {stage === "vision" && waiting !== "vision" && <p className="hint" role="status"><span className="spinner" /> {progress || tt("seg.vision.running")}</p>}
              {stage === "vision" && waiting === "vision" && (
                <div style={{ display: "grid", gap: 12 }}>
                  {unavailable ? <p className="note note-warn" role="status">{tt("seg.vision.unavailable", { reason: unavailable })}</p> : <p className="hint">{tt("seg.vision.handoffHint")}</p>}
                  {handoffError && <pre className="sgm-refusal" role="alert">{handoffError}</pre>}
                  {handoffCommand && (
                    <div style={{ display: "grid", gap: 6 }}>
                      <span className="label" style={{ margin: 0 }}>{tt("seg.vision.command")}</span>
                      <pre className="sgm-cmd" data-testid="handoff-command">{handoffCommand}</pre>
                      <div className="sgm-actions"><button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(handoffCommand)}>{copied ? tt("seg.copied") : tt("seg.copy")}</button></div>
                    </div>
                  )}
                  <label className="field">
                    <span className="label">{tt("seg.vision.outputPath")}</span>
                    <input className="input" value={outputPath} onChange={(e) => setOutputPath(e.target.value)} spellCheck={false} placeholder="C:\\Users\\…\\task.output" />
                    <span className="hint">{tt("seg.vision.outputHint")}</span>
                  </label>
                  <div className="sgm-actions">
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy || !outputPath.trim()} onClick={() => void decide({ kind: "handoff_vision", output_path: outputPath.trim() })}>{tt("seg.vision.outputApply")}</button>
                    {!unavailable && <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void decide({ kind: "retry" })}>{tt("seg.vision.retryApi")}</button>}
                  </div>
                </div>
              )}
              {stage === "vision" && waiting !== "vision" && run.settings.vision !== "handoff" && (
                <div className="sgm-actions" style={{ marginTop: 12 }}>
                  <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void decide({ kind: "handoff_vision" })}>{tt("seg.vision.handoff")}</button>
                </div>
              )}
            </section>
          )}

          {stage === "review" && (
            <section className="card" aria-label={tt("seg.stage.review")}>
              <h2 className="section-title">{tt("seg.review.title")}</h2>
              {applyRefused && <pre className="sgm-refusal" role="alert" style={{ marginBottom: 12 }}>{applyRefused}</pre>}
              <p className="hint">{tt("seg.review.doorHint")}</p>
              {view.review && <p className="hint">{tt("seg.review.doorCounts", { need: view.review.needs_decision, decided: view.review.decided, pre: view.review.pre_accepted, rejudging: view.review.rejudging })}</p>}
              <div className="sgm-actions" style={{ marginTop: 12 }}>
                <a className="btn btn-primary" href={reviewHref}>{tt("seg.review.open")}</a>
              </div>
            </section>
          )}

          {stage === "render" && (
            <section className="card" aria-label={tt("seg.stage.render")}>
              <h2 className="section-title">{tt("seg.stage.render")}</h2>
              <p className="hint" role="status"><span className="spinner" /> {progress || tt("seg.stageHint.render")}</p>
            </section>
          )}

          {(stage === "qa" || stage === "film_meta") && (
            <>
              {qaSheets.length > 0 && (
                <section className="card" aria-label={tt("seg.qa.title")}>
                  <h2 className="section-title">{tt("seg.qa.title")}</h2>
                  <p className="hint">{tt("seg.qa.hint")}</p>
                  <div className="sgm-qa-grid" style={{ marginTop: 12 }}>
                    {qaSheets.map((s) => (
                      <figure className="sgm-qa-sheet" key={s.n} data-episode={s.n}>
                        {s.url ? (
                          /* eslint-disable-next-line @next/next/no-img-element -- evidence served by our own route */
                          <img src={s.url} alt={tt("seg.qa.sheetAlt", { n: s.n })} loading="lazy" />
                        ) : null}
                        <figcaption>
                          <strong>{tt("seg.qa.episode", { n: s.n })}</strong> · {fmtT(s.start)} – {fmtT(s.end)}
                          {s.faults.length ? <span className="faults"> · {s.faults.join("; ")}</span> : <span> · {tt("seg.qa.clean")}</span>}
                          {s.notes.length ? <span> · {s.notes.join("; ")}</span> : null}
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                  <div className="sgm-actions" style={{ marginTop: 12 }}>
                    <a className="btn btn-outline btn-sm" href={reviewHref}>{tt("seg.qa.joins")}</a>
                  </div>
                </section>
              )}
              {stage === "qa" && (
                <section className="card"><p className="hint" role="status"><span className="spinner" /> {progress || tt("seg.qa.running")}</p></section>
              )}
              {stage === "film_meta" && (
                <section className="card" aria-label={tt("seg.meta.title")}>
                  <h2 className="section-title">{tt("seg.meta.title")}</h2>
                  {str(detail.film_meta_error) && <pre className="sgm-refusal" role="alert" style={{ marginBottom: 12 }}>{str(detail.film_meta_error)}</pre>}
                  <p className="hint">{tt("seg.meta.hintQa")}</p>
                  <FilmMetaForm slug={run.slug} initial={metaInitial} busy={busy || waiting !== "film_meta"} onSubmit={(d) => void decide(d)} />
                </section>
              )}
            </>
          )}

          {(stage === "handoff" || stage === "done") && (
            <section className="card" aria-label={tt("seg.stage.handoff")}>
              <h2 className="section-title">{tt("seg.handoff.title")}</h2>
              {importError && <pre className="sgm-refusal" role="alert" style={{ marginBottom: 12 }}>{importError}</pre>}
              {titleId ? (
                <div className="sgm-actions">
                  <a className="btn btn-primary" href={`/titles/${titleId}`} data-testid="open-title">{tt("seg.handoff.openTitle")}</a>
                </div>
              ) : (
                <div className="sgm-actions">
                  <button type="button" className="btn btn-primary" disabled={busy || waiting !== "import"} onClick={() => void decide({ kind: "import_now" })}>{tt("seg.handoff.importNow")}</button>
                  {waiting === "ready" && <span className="hint" role="status"><span className="spinner" /> {tt("seg.handoff.waitingReady")}{str(detail.note) ? ` · ${str(detail.note)}` : ""}</span>}
                  {importProgress && progressText(importProgress) && <span className="hint" role="status"><span className="spinner" /> {tt("seg.handoff.importing", { detail: progressText(importProgress) })}</span>}
                </div>
              )}
              <p className="hint" style={{ marginTop: 12 }}>{tt("seg.handoff.hint")}</p>
            </section>
          )}

          {(stage === "failed" || stage === "cancelled") && (
            <section className="card">
              <h2 className="section-title">{tt(`seg.stage.${stage}`)}</h2>
              <p className="hint">{tt("seg.run.failedHint")}</p>
              {stage === "failed" && (
                <div className="sgm-actions" style={{ marginTop: 12 }}>
                  <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void decide({ kind: "retry" })}>{tt("seg.run.retry", { stage: tt(`seg.stage.${str(detail.failed_stage) ?? "intake"}`) })}</button>
                </div>
              )}
            </section>
          )}

          {view.plan && stageIndex(stage, run.mode) >= stageIndex("qa", run.mode) && (
            <section className="card" aria-label={tt("seg.run.episodes")}>
              <h2 className="section-title">{tt("seg.run.episodes")}</h2>
              {view.plan.delivered && <p className="hint">{view.plan.delivered}</p>}
              <div className="gtable gtable-flush" style={{ "--cols": "60px 110px 110px 90px 90px" } as React.CSSProperties}>
                <div className="gt-head"><span>#</span><span>{tt("seg.review.start")}</span><span>{tt("seg.review.end")}</span><span>{tt("seg.review.length")}</span><span>{tt("seg.run.file")}</span></div>
                {view.plan.episodes.map((e) => (
                  <div className="gt-row" key={e.n}><span className="gt-num">{e.n}</span><span>{fmtT(e.start)}</span><span>{fmtT(e.end)}</span><span className="gt-num">{e.dur.toFixed(1)} s</span><span className="gt-muted">{e.file_exists ? tt("seg.run.fileBuilt") : "—"}</span></div>
                ))}
              </div>
            </section>
          )}

          {run.decisions.length > 0 && (
            <section className="card" aria-label={tt("seg.run.decisions")}>
              <h2 className="section-title">{tt("seg.run.decisions")}</h2>
              <ul className="sgm-log">
                {run.decisions.slice().reverse().map((d, i) => (
                  <li key={i}>
                    <time dateTime={d.at}>{new Date(d.at).toLocaleString(locale === "zh" ? "zh-CN" : "en-GB", { hour12: false })}</time> · {d.by} · {decisionLabel(d.action)}
                    {d.boundary_s !== null && d.boundary_s !== undefined ? ` · ${fmtT(d.boundary_s)}` : ""}
                    {typeof d.to_s === "number" ? ` → ${fmtT(d.to_s)}` : ""}
                    {d.why ? ` · ${d.why}` : ""}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!waiting && !isTerminal(stage) ? <p className="hint" role="status">{tt("seg.run.polling")}</p> : null}
        </div>
      </div>
    </div>
  );
}
