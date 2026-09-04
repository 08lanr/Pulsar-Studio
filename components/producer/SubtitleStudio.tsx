"use client";

// The subtitle studio — delivery stage two (2026-09-05: "first we finalize
// the script, and then we finalize the subtitles"), now with the timing
// desk (the founder's footage ran ~500 ms late):
//
//   · Live styled preview: the player shows the current cue as an overlay,
//     restyled instantly by the controls; the burn uses the same mapping.
//   · GLOBAL OFFSET: nudge every cue ±100/±500 ms or type an exact signed
//     millisecond value; the pending shift previews live and applies once
//     through /timing/offset — repeated exports never re-apply it.
//   · PER-CUE EDITOR: millisecond start/end for the selected cue, set-to-
//     playhead, , / . keyboard nudges (Shift = 500 ms). Edits stay pending
//     client-side (undo per cue or all) until saved via /timing/cues.
//   · Playback desk: loop-current-cue, 0.5–1.5x speeds, play-from-2s-before.
//   · Warnings: overlaps, reversed ranges, <300 ms cues, past-video cues.
//   · AUTO-SYNC: forced alignment behind lib/align's provider interface;
//     with none configured the button is disabled with the honest reason.
//     Proposals (when a provider exists) render as a per-cue diff to accept
//     or reject — the text is never touched, nothing applies silently.
//
// Gates: script finalized first; cues need timecodes (the stamp repair
// offers itself when the times are trapped in the text).

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getJson, postJson } from "@/lib/api-client";
import { unwrap, type ApiEnvelope } from "@/components/workbench/util";
import type { AdaptedLine, Line, WorkbenchPayload } from "@/lib/types";
import type { SubtitleStyle } from "@/lib/subtitle-video";
import { preciseTimecode, timingIssues, type TimingIssue } from "@/lib/subtitle-timing";
import type { AlignmentProposal } from "@/lib/align";
import { useT } from "@/components/locale";
import { IconArrowLeft, IconCheck } from "./icons";

function timecode(ms: number | null) {
  if (ms == null) return "—";
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// The preview mirrors the burn's face/size mapping (lib/subtitle-video.ts).
const PREVIEW_FONT: Record<SubtitleStyle["font"], string> = {
  sans: '"Arial", "Microsoft YaHei", sans-serif',
  serif: 'Georgia, "SimSun", serif',
};
const PREVIEW_SIZE: Record<SubtitleStyle["size"], string> = { s: "13px", m: "16px", l: "20px" };

const SPEEDS = [0.5, 0.75, 1, 1.5] as const;

type Props = { payload: WorkbenchPayload; readOnly: boolean };

type PendingCue = { start_ms: number; end_ms: number };

const STAMP_HINT_RE = /^[\[（(]\s*\d{1,2}:\d{1,2}/;

export default function SubtitleStudio({ payload, readOnly }: Props) {
  const { tt } = useT();
  const router = useRouter();
  const base = `/api/titles/${payload.title.id}/episodes/${payload.episode.number}`;
  const episodeHref = `/producer/titles/${payload.title.id}/episodes/${payload.episode.number}`;
  const videoRef = useRef<HTMLVideoElement>(null);

  const [layout, setLayout] = useState<SubtitleStyle["layout"]>("en");
  const [font, setFont] = useState<SubtitleStyle["font"]>("sans");
  const [size, setSize] = useState<SubtitleStyle["size"]>("m");
  const [currentMs, setCurrentMs] = useState(0);
  const [videoMs, setVideoMs] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [renderElapsed, setRenderElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rendered, setRendered] = useState<{ video_url: string; lines: number } | null>(null);
  const [repairing, setRepairing] = useState(false);

  // ---- timing state ----------------------------------------------------------
  const [pending, setPending] = useState<Map<string, PendingCue>>(new Map());
  const [pendingOffset, setPendingOffset] = useState(0);
  const [exactOffset, setExactOffset] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loopCue, setLoopCue] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [align, setAlign] = useState<{ available: boolean; reason?: string } | null>(null);
  const [proposals, setProposals] = useState<AlignmentProposal[] | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());

  const finalized = payload.version?.status === "approved";
  const timed = payload.episode.has_timecodes;

  useEffect(() => {
    let alive = true;
    getJson<{ available: boolean; reason?: string }>(`${base}/timing/auto-sync`)
      .then((r) => alive && setAlign(r))
      .catch(() => alive && setAlign({ available: false, reason: "" }));
    return () => {
      alive = false;
    };
  }, [base]);

  /** A line's effective window: pending per-cue edit first, then the pending
   * global offset (preview only — the server applies it on save). */
  function effective(l: Line): { start: number | null; end: number | null } {
    const p = pending.get(l.id);
    let start = p?.start_ms ?? l.start_ms;
    let end = p?.end_ms ?? l.end_ms;
    if (start != null && end != null && pendingOffset !== 0) {
      const dur = end - start;
      start = Math.max(0, start + pendingOffset);
      end = start + dur;
    }
    return { start, end };
  }

  // Cues from the current adapted lines (cut and untimed lines drop out).
  const cues = useMemo(() => {
    const byLine = new Map<string, AdaptedLine>();
    for (const a of payload.adapted_lines) if (a.line_id) byLine.set(a.line_id, a);
    return payload.lines
      .filter((l) => !l.merged_into_id && l.start_ms != null && l.end_ms != null)
      .sort((a, b) => a.seq - b.seq)
      .map((l) => ({ line: l, adapted: byLine.get(l.id) ?? null }))
      .filter((c) => c.adapted?.text_en && c.adapted.change_type !== "cut");
  }, [payload.lines, payload.adapted_lines]);

  const effectiveCues = cues.map((c) => ({ ...c, ...effective(c.line) }));
  const current = effectiveCues.find((c) => (c.start ?? 0) <= currentMs && currentMs < (c.end ?? 0)) ?? null;
  const selected = effectiveCues.find((c) => c.line.id === selectedId) ?? null;
  const durationMs = payload.episode.duration_ms ?? Math.max(1, ...effectiveCues.map((c) => c.end ?? 0));

  const issues: TimingIssue[] = timingIssues(
    effectiveCues.map((c) => ({ start_ms: c.start, end_ms: c.end })),
    videoMs
  );

  function seek(ms: number | null, { play = false }: { play?: boolean } = {}) {
    if (ms == null) return;
    setCurrentMs(ms);
    const v = videoRef.current;
    if (v) {
      v.currentTime = ms / 1000;
      if (play) void v.play();
    }
  }

  function selectCue(lineId: string, start: number | null) {
    setSelectedId(lineId);
    seek(start);
  }

  /** Stage a per-cue edit in STORED coordinates (pending values exclude the
   * preview offset, which the server applies separately). */
  function stagePending(lineId: string, start: number, end: number) {
    setPending((m) => {
      const next = new Map(m);
      next.set(lineId, { start_ms: Math.max(0, Math.round(start)), end_ms: Math.round(end) });
      return next;
    });
  }

  /** The selected cue's stored (offset-free) window. */
  function selectedStored(): { start: number; end: number } | null {
    if (!selected) return null;
    const p = pending.get(selected.line.id);
    const start = p?.start_ms ?? selected.line.start_ms;
    const end = p?.end_ms ?? selected.line.end_ms;
    return start != null && end != null ? { start, end } : null;
  }

  function nudgeSelected(delta: number) {
    const s = selectedStored();
    if (!selected || !s) return;
    const start = Math.max(0, s.start + delta);
    stagePending(selected.line.id, start, start + (s.end - s.start));
  }

  // , / . nudge the selected cue; Shift makes it 500 ms.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (readOnly || !selectedId) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key !== "," && e.key !== ".") return;
      e.preventDefault();
      nudgeSelected((e.key === "," ? -1 : 1) * (e.shiftKey ? 500 : 100));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function onTimeUpdate(t: number) {
    setCurrentMs(t);
    if (loopCue && selected && selected.start != null && selected.end != null && t >= selected.end) {
      seek(selected.start, { play: true });
    }
  }

  function setPlaybackSpeed(s: number) {
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
  }

  // ---- persistence -----------------------------------------------------------

  function afterRepair(r: { refinalized: boolean; needs_review: boolean }, doneKey: string) {
    if (r.needs_review) {
      // The refinalize was held back by QC — the workspace's card explains.
      router.push(episodeHref);
      return;
    }
    setNotice(tt(doneKey));
    router.refresh();
  }

  async function applyOffset() {
    if (!pendingOffset) return;
    setBusy("offset");
    setError(null);
    try {
      const r = unwrap(
        await postJson<{ shifted: number; clamped: number; refinalized: boolean; needs_review: boolean } & ApiEnvelope>(
          `${base}/timing/offset`,
          { offset_ms: pendingOffset }
        )
      );
      setPendingOffset(0);
      setExactOffset("");
      afterRepair(r, "st.t.offsetDone");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function saveCues() {
    if (!pending.size) return;
    setBusy("cues");
    setError(null);
    try {
      const updates = [...pending.entries()].map(([line_id, p]) => ({ line_id, ...p }));
      const r = unwrap(
        await postJson<{ updated: number; refinalized: boolean; needs_review: boolean } & ApiEnvelope>(`${base}/timing/cues`, {
          updates,
        })
      );
      setPending(new Map());
      afterRepair(r, "st.t.saved");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function autoSync() {
    setBusy("autosync");
    setError(null);
    try {
      const r = unwrap(
        await postJson<{ available: boolean; reason?: string; proposals?: AlignmentProposal[] } & ApiEnvelope>(
          `${base}/timing/auto-sync`,
          {}
        )
      );
      setProposals(r.proposals ?? []);
      setAccepted(new Set((r.proposals ?? []).map((p) => p.line_id)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function stageAcceptedProposals() {
    if (!proposals) return;
    for (const p of proposals) {
      if (accepted.has(p.line_id)) stagePending(p.line_id, p.new_start_ms, p.new_end_ms);
    }
    setProposals(null);
  }

  async function renderVideo() {
    setBusy("render");
    setError(null);
    setRendered(null);
    setRenderElapsed(0);
    const started = Date.now();
    const ticker = setInterval(() => setRenderElapsed(Date.now() - started), 500);
    try {
      const r = unwrap(
        await postJson<{ video_url: string; lines: number } & ApiEnvelope>(`${base}/subtitle-video`, { layout, font, size })
      );
      setRendered(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      clearInterval(ticker);
      setBusy(null);
    }
  }

  async function repairTimecodes() {
    setRepairing(true);
    setError(null);
    try {
      const r = unwrap(
        await postJson<{ timed: number; refinalized: boolean; needs_review: boolean } & ApiEnvelope>(`${base}/retime`, {})
      );
      if (r.needs_review) {
        router.push(episodeHref);
        return;
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRepairing(false);
    }
  }

  const overlayStyle = { fontFamily: PREVIEW_FONT[font], fontSize: PREVIEW_SIZE[size] };
  const renderEstMs = Math.max(20_000, 15_000 + durationMs * 0.35);
  const renderFrac = Math.min(renderElapsed / renderEstMs, 0.95);
  const stampsInText = payload.lines.some((l) => STAMP_HINT_RE.test(l.text_zh));

  const header = (
    <header className="review-studio-head">
      <a className="title-back" href={episodeHref}>
        <IconArrowLeft /> {tt("st.back")}
      </a>
      <div className="review-studio-title">
        <div>
          <span>{payload.title.name_zh}</span>
          <strong>{payload.title.name_en}</strong>
        </div>
        <small>
          {tt("review.episode", { n: payload.episode.number })} · {tt("st.stage")}
        </small>
      </div>
      <div className="head-actions">
        <span className={finalized ? "pill status-approved" : "pill status-review"}>
          {finalized ? tt("pw.epStatus.approved") : tt("st.notFinal.pill")}
        </span>
      </div>
    </header>
  );

  // ---- gates -----------------------------------------------------------------

  if (!finalized) {
    return (
      <div className="creative-review-shell">
        {header}
        <div className="card genbox">
          <h3>{tt("st.notFinal.title")}</h3>
          <p>{tt("st.notFinal.body")}</p>
          <a className="btn btn-primary" href={episodeHref}>
            {tt("st.notFinal.cta")}
          </a>
        </div>
      </div>
    );
  }

  if (!timed || cues.length === 0) {
    return (
      <div className="creative-review-shell">
        {header}
        {error && (
          <div className="note note-warn" role="alert">
            {error}
          </div>
        )}
        <div className="card genbox">
          <h3>{tt("st.untimed.title")}</h3>
          <p>{stampsInText ? tt("st.retime.body") : tt("st.untimed.body")}</p>
          {stampsInText && !readOnly && (
            <button type="button" className="btn btn-primary" disabled={repairing} onClick={repairTimecodes}>
              {repairing ? <span className="spinner" /> : null} {tt("st.retime.cta")}
            </button>
          )}
          <a className="btn btn-outline" href={`/api/titles/${payload.title.id}/export?format=script&episode=${payload.episode.number}`}>
            {tt("pw.export.script")}
          </a>
        </div>
      </div>
    );
  }

  // ---- the studio ------------------------------------------------------------

  const warnLabel = (i: TimingIssue) => {
    const seq = effectiveCues[i.index]?.line.seq ?? i.index + 1;
    return tt(`st.t.warn.${i.code}`, { n: seq, v: i.detail ?? 0 });
  };

  const storedSelected = selectedStored();

  return (
    <div className="creative-review-shell">
      {header}

      {notice && (
        <div className="note note-success" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="note note-warn" role="alert">
          {error}
        </div>
      )}

      <div className="review-work-grid">
        <main className="review-stage-column">
          <section className="st-stage">
            <div className="st-frame">
              {payload.video_url ? (
                <video
                  ref={videoRef}
                  controls
                  preload="metadata"
                  src={payload.video_url}
                  onLoadedMetadata={(e) => setVideoMs(Math.round(e.currentTarget.duration * 1000))}
                  onTimeUpdate={(e) => onTimeUpdate(Math.round(e.currentTarget.currentTime * 1000))}
                />
              ) : (
                <div className="st-blank">
                  <time>{timecode(currentMs)}</time>
                  <span>{tt("st.noVideo")}</span>
                </div>
              )}
              {current && (
                <div className={`st-overlay st-overlay-${size}`} style={overlayStyle} aria-live="off">
                  <span lang="en">{current.adapted!.text_en}</span>
                  {layout === "en_zh" && (
                    <span lang="zh-CN" className="st-overlay-zh">
                      {current.line.text_zh}
                    </span>
                  )}
                </div>
              )}
            </div>
            {/* Playback desk: speed, loop, run-up, clock. */}
            <div className="st-playdesk">
              <span className="st-playdesk-label">{tt("st.t.speed")}</span>
              <div className="st-seg st-seg-inline">
                {SPEEDS.map((sp) => (
                  <button type="button" key={sp} className={speed === sp ? "on" : ""} onClick={() => setPlaybackSpeed(sp)}>
                    {sp}x
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={`btn btn-sm ${loopCue ? "btn-primary" : "btn-ghost"}`}
                disabled={!selected}
                onClick={() => setLoopCue((v) => !v)}
              >
                {tt("st.t.loop")}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={!selected || selected.start == null}
                onClick={() => selected && seek(Math.max(0, (selected.start ?? 0) - 2000), { play: true })}
              >
                {tt("st.t.before")}
              </button>
              <span className="spacer" />
              <span className="st-playdesk-time">
                <b>{timecode(currentMs)}</b> / {timecode(durationMs)}
              </span>
            </div>
          </section>

          <section className="review-script-sheet">
            <div className="review-script-head">
              <div>
                <span>{tt("st.cues")}</span>
                <strong>{tt("st.cues.hint", { n: cues.length })}</strong>
              </div>
            </div>
            <div className="review-script-list">
              {effectiveCues.map(({ line, adapted, start, end }) => (
                <button
                  type="button"
                  key={line.id}
                  className={`st-cue ${selectedId === line.id ? "is-active" : ""} ${pending.has(line.id) ? "is-pending" : ""}`}
                  onClick={() => selectCue(line.id, start)}
                >
                  <time>
                    {preciseTimecode(start)}
                    <small>{end != null && start != null ? `${end - start}ms` : ""}</small>
                  </time>
                  <span lang="en">{adapted!.text_en}</span>
                  {layout === "en_zh" && (
                    <span lang="zh-CN" className="st-cue-zh">
                      {line.text_zh}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        </main>

        <aside className="review-feedback-panel">
          {/* The timing desk: global offset, the selected cue, warnings, auto-sync. */}
          <section className="pline-panel">
            <div className="review-feedback-head">
              <div>
                <span>{tt("st.t.panel")}</span>
                <strong>{tt("st.t.panelHint")}</strong>
              </div>
            </div>

            <div className="st-control">
              <span className="label">{tt("st.t.offset")}</span>
              <div className="st-seg">
                {[-500, -100, 100, 500].map((d) => (
                  <button type="button" key={d} disabled={readOnly} onClick={() => setPendingOffset((v) => v + d)}>
                    {d > 0 ? `+${d}` : d}
                  </button>
                ))}
              </div>
              <div className="st-offset-row">
                <input
                  className="input st-ms-input"
                  type="number"
                  step={1}
                  placeholder={tt("st.t.exact")}
                  value={exactOffset}
                  disabled={readOnly}
                  onChange={(e) => {
                    setExactOffset(e.target.value);
                    const v = Number(e.target.value);
                    if (Number.isInteger(v)) setPendingOffset(v);
                    else if (e.target.value === "") setPendingOffset(0);
                  }}
                />
                <span className={`st-offset-pending ${pendingOffset ? "is-live" : ""}`}>
                  {pendingOffset
                    ? tt("st.t.offsetPending", { v: pendingOffset > 0 ? `+${pendingOffset}` : pendingOffset })
                    : tt("st.t.offsetNone")}
                </span>
              </div>
              <p className="hint">{tt("st.t.offsetHint")}</p>
              {!readOnly && (
                <button
                  type="button"
                  className="btn btn-sm btn-primary btn-block"
                  disabled={!pendingOffset || busy === "offset"}
                  onClick={applyOffset}
                >
                  {busy === "offset" ? <span className="spinner" /> : null} {tt("st.t.offsetApply")}
                </button>
              )}
            </div>

            <div className="st-control">
              <span className="label">{tt("st.t.cue")}</span>
              {selected && storedSelected ? (
                <>
                  <div className="st-cue-times">
                    <label>
                      <span>{tt("st.t.start")}</span>
                      <input
                        className="input st-ms-input"
                        type="number"
                        min={0}
                        step={1}
                        value={storedSelected.start}
                        disabled={readOnly}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isInteger(v)) stagePending(selected.line.id, v, storedSelected.end);
                        }}
                      />
                    </label>
                    <label>
                      <span>{tt("st.t.end")}</span>
                      <input
                        className="input st-ms-input"
                        type="number"
                        min={0}
                        step={1}
                        value={storedSelected.end}
                        disabled={readOnly}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isInteger(v)) stagePending(selected.line.id, storedSelected.start, v);
                        }}
                      />
                    </label>
                  </div>
                  <p className="hint">
                    {preciseTimecode(selected.start)} → {preciseTimecode(selected.end)} ·{" "}
                    {tt("st.t.dur", { t: `${(selected.end ?? 0) - (selected.start ?? 0)}ms` })}
                  </p>
                  {!readOnly && (
                    <>
                      <div className="st-btnrow">
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => stagePending(selected.line.id, currentMs, Math.max(currentMs + 100, storedSelected.end))}
                        >
                          {tt("st.t.setStart")}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => stagePending(selected.line.id, storedSelected.start, Math.max(storedSelected.start + 100, currentMs))}
                        >
                          {tt("st.t.setEnd")}
                        </button>
                      </div>
                      <div className="st-btnrow">
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={!pending.has(selected.line.id)}
                          onClick={() =>
                            setPending((m) => {
                              const next = new Map(m);
                              next.delete(selected.line.id);
                              return next;
                            })
                          }
                        >
                          {tt("st.t.resetCue")}
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" disabled={!pending.size} onClick={() => setPending(new Map())}>
                          {tt("st.t.resetAll")}
                        </button>
                      </div>
                      <p className="hint">{tt("st.t.keys")}</p>
                    </>
                  )}
                </>
              ) : (
                <p className="hint">{tt("st.t.pickCue")}</p>
              )}
            </div>

            {issues.length > 0 && (
              <div className="st-warnings" role="alert">
                {issues.slice(0, 6).map((i, k) => (
                  <button
                    type="button"
                    key={`${i.code}:${i.index}:${k}`}
                    onClick={() => selectCue(effectiveCues[i.index].line.id, effectiveCues[i.index].start)}
                  >
                    {warnLabel(i)}
                  </button>
                ))}
              </div>
            )}

            {!readOnly && (
              <button type="button" className="btn btn-primary btn-block" disabled={!pending.size || busy === "cues"} onClick={saveCues}>
                {busy === "cues" ? <span className="spinner" /> : <IconCheck />} {tt("st.t.save", { n: pending.size })}
              </button>
            )}

            {!readOnly && (
              <div className="st-control">
                <button
                  type="button"
                  className="btn btn-outline btn-block"
                  disabled={!align?.available || busy === "autosync"}
                  title={align && !align.available ? align.reason : undefined}
                  onClick={autoSync}
                >
                  {busy === "autosync" ? <span className="spinner" /> : null} {tt("st.t.autosync")}
                </button>
                {align && !align.available && <p className="hint">{tt("st.t.autosyncOff", { reason: align.reason ?? "" })}</p>}
              </div>
            )}

            {proposals && proposals.length > 0 && (
              <div className="st-proposals">
                <div className="st-proposals-head">
                  <b>{tt("st.t.proposals", { n: proposals.length })}</b>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAccepted(new Set(proposals.map((p) => p.line_id)))}>
                    {tt("st.t.acceptAll")}
                  </button>
                </div>
                {proposals.map((p) => (
                  <div key={p.line_id} className={`st-proposal ${accepted.has(p.line_id) ? "is-accepted" : ""}`}>
                    <span className="st-proposal-diff">
                      {preciseTimecode(p.old_start_ms)} → <b>{preciseTimecode(p.new_start_ms)}</b>
                      <small>{tt("st.t.conf", { v: Math.round(p.confidence * 100) })}</small>
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() =>
                        setAccepted((s) => {
                          const next = new Set(s);
                          if (next.has(p.line_id)) next.delete(p.line_id);
                          else next.add(p.line_id);
                          return next;
                        })
                      }
                    >
                      {accepted.has(p.line_id) ? tt("st.t.reject") : tt("st.t.accept")}
                    </button>
                  </div>
                ))}
                <button type="button" className="btn btn-sm btn-primary btn-block" disabled={!accepted.size} onClick={stageAcceptedProposals}>
                  {tt("st.t.applyProposals")}
                </button>
              </div>
            )}
          </section>

          {/* Style controls: every change restyles the overlay immediately. */}
          <section className="pline-panel">
            <div className="review-feedback-head">
              <div>
                <span>{tt("st.style")}</span>
                <strong>{tt("st.style.hint")}</strong>
              </div>
            </div>

            <div className="st-control">
              <span className="label">{tt("st.layout")}</span>
              <div className="st-seg">
                <button type="button" className={layout === "en" ? "on" : ""} onClick={() => setLayout("en")}>
                  {tt("st.layout.en")}
                </button>
                <button type="button" className={layout === "en_zh" ? "on" : ""} onClick={() => setLayout("en_zh")}>
                  {tt("st.layout.enzh")}
                </button>
              </div>
            </div>

            <div className="st-control">
              <span className="label">{tt("st.font")}</span>
              <div className="st-seg">
                <button type="button" className={font === "sans" ? "on" : ""} onClick={() => setFont("sans")}>
                  {tt("st.font.sans")}
                </button>
                <button type="button" className={font === "serif" ? "on" : ""} onClick={() => setFont("serif")}>
                  {tt("st.font.serif")}
                </button>
              </div>
            </div>

            <div className="st-control">
              <span className="label">{tt("st.size")}</span>
              <div className="st-seg">
                {(["s", "m", "l"] as const).map((k) => (
                  <button type="button" key={k} className={size === k ? "on" : ""} onClick={() => setSize(k)}>
                    {tt(`st.size.${k}`)}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* Deliverables: the burn with the chosen style, and the files. */}
          <section className="pline-panel">
            <div className="review-feedback-head">
              <div>
                <span>{tt("st.deliver")}</span>
                <strong>{tt("st.deliver.hint")}</strong>
              </div>
            </div>

            {payload.video_url ? (
              !readOnly && (
                <>
                  <button type="button" className="btn btn-approve btn-block" disabled={busy === "render"} onClick={renderVideo}>
                    {busy === "render" ? <span className="spinner" /> : <IconCheck />}
                    {busy === "render" ? tt("st.render.busy", { t: timecode(renderElapsed) }) : tt("st.render.cta")}
                  </button>
                  {busy === "render" && (
                    <>
                      <div className="genbar" aria-hidden="true">
                        <i style={{ width: `${Math.round(renderFrac * 100)}%` }} />
                      </div>
                      <p className="genbar-meta">
                        {renderElapsed > renderEstMs
                          ? tt("pw.gen.overrun")
                          : tt("pw.gen.remaining", { t: timecode(renderEstMs - renderElapsed) })}
                      </p>
                    </>
                  )}
                  {rendered && (
                    <a className="btn btn-primary btn-block" href={rendered.video_url} download>
                      {tt("st.render.download", { n: rendered.lines })}
                    </a>
                  )}
                </>
              )
            ) : (
              <p className="hint">{tt("st.render.noVideo")}</p>
            )}

            <a className="btn btn-outline btn-block" href={`/api/titles/${payload.title.id}/export?format=srt&episode=${payload.episode.number}`}>
              {tt("st.dl.srt")}
            </a>
            <a className="btn btn-outline btn-block" href={`/api/titles/${payload.title.id}/export?format=vtt&episode=${payload.episode.number}`}>
              {tt("st.dl.vtt")}
            </a>
            <a
              className="btn btn-ghost btn-block"
              href={`/api/titles/${payload.title.id}/export?format=script&episode=${payload.episode.number}`}
            >
              {tt("pw.export.script")}
            </a>
          </section>
        </aside>
      </div>
    </div>
  );
}
