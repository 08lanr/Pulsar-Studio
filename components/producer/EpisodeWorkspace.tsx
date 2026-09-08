"use client";

// The producer's episode studio, V2 (2026-09-04, docs/decisions.md
// "subtitles, not dubbing"): localization ships as SUBTITLES, and the
// screen is built around reading the script.
//
//   · The script sheet is one continuous scroll — no scenes, no per-scene
//     confirms. Column one is ORIGINAL (the Chinese line with its literal
//     English underneath); column two is ADAPTED (our American rewrite,
//     key phrase highlighted, WHY THIS CHANGE on the row beneath — the
//     flagship).
//   · The right rail stays on screen while the sheet scrolls: a compact
//     player (click a timecode, it seeks) above the 审阅与修改 panel
//     (explanation-free by design — the why lives in the sheet; the panel
//     edits: text box, 3 alternatives, confirm).
//   · Finalize sits in the header. The deliverables are the clean English
//     script report and, when a video is attached, the subtitled video.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/api-client";
import { ApiError, patchJson, unwrap, type ApiEnvelope } from "@/components/workbench/util";
import { adaptedLineIssue } from "@/lib/data/views";
import type { AdaptTag, AdaptedLine, Line, LineAlternative, WorkbenchPayload } from "@/lib/types";
import { runQc, type QcIssue } from "@/lib/qc";
import { TAGS, TAG_LABELS } from "@/lib/types";
import { useT } from "@/components/locale";
import { IconCheck } from "./icons";

const GEN_STEPS = ["pw.gen.step1", "pw.gen.step2", "pw.gen.step3", "pw.gen.step4"] as const;

function fmtDur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function timecode(ms: number | null, seq?: number) {
  if (ms == null) return seq ? `L${seq}` : "—";
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The English line with its key phrase marked — the visible face of "why this change". */
function highlightPhrase(text: string, phrase: string | null) {
  if (!phrase) return text;
  const i = text.indexOf(phrase);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="key-phrase">{phrase}</mark>
      {text.slice(i + phrase.length)}
    </>
  );
}

type Props = { payload: WorkbenchPayload; readOnly: boolean };

export default function EpisodeWorkspace({ payload, readOnly }: Props) {
  const { tt, locale } = useT();
  const router = useRouter();
  // Server errors are English (they also serve staff and the logs); their
  // codes are the localization hook. Map the ones a producer can hit here.
  const errText = (e: unknown) =>
    e instanceof ApiError && e.code === "llm_unavailable" ? tt("pw.err.aiOff") : (e as Error).message;
  // Only a deliberate cut reads as “line cut”; a row that simply has no
  // English yet (a manual draft awaiting its translation) says so instead of
  // alarming the producer that their line was deleted.
  const adaptedText = (a: AdaptedLine | null | undefined) =>
    !a
      ? tt("pw.line.pending")
      : a.text_en?.trim()
        ? a.text_en
        : a.change_type === "cut"
          ? tt("review.lineCut")
          : tt("pw.line.blank");
  const base = `/api/titles/${payload.title.id}/episodes/${payload.episode.number}`;
  const videoRef = useRef<HTMLVideoElement>(null);

  const [adapted, setAdapted] = useState<AdaptedLine[]>(payload.adapted_lines);
  const [alts, setAlts] = useState<LineAlternative[]>(payload.alternatives);
  const [generating, setGenerating] = useState(false);
  const [genElapsed, setGenElapsed] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);

  const version = payload.version;
  const inReview = version?.status === "in_review";
  const finalized = version?.status === "approved";
  const editable = !readOnly && !!version && version.status === "draft";

  const lines = useMemo(
    () => payload.lines.filter((l) => !l.merged_into_id).sort((a, b) => a.seq - b.seq),
    [payload.lines]
  );
  const [selectedLineId, setSelectedLineId] = useState<string | null>(lines[0]?.id ?? null);
  const selectedLine = lines.find((l) => l.id === selectedLineId) ?? lines[0] ?? null;
  const [currentMs, setCurrentMs] = useState<number>(selectedLine?.start_ms ?? 0);

  const byLine = useMemo(() => {
    const m = new Map<string, AdaptedLine>();
    for (const a of adapted) if (a.line_id) m.set(a.line_id, a);
    return m;
  }, [adapted]);
  const altsByLine = useMemo(() => {
    const m = new Map<string, LineAlternative[]>();
    for (const a of alts) {
      const list = m.get(a.adapted_line_id) ?? [];
      list.push(a);
      m.set(a.adapted_line_id, list);
    }
    return m;
  }, [alts]);

  const selectedAdapted = selectedLine ? byLine.get(selectedLine.id) ?? null : null;
  const [draft, setDraft] = useState<string>(selectedAdapted?.text_en ?? "");
  const [pickedAltId, setPickedAltId] = useState<string | null>(null);
  const [showAlts, setShowAlts] = useState(false);
  const dirty = !!selectedAdapted && draft !== (selectedAdapted.text_en ?? "");

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const adaptedCount = lines.filter((l) => byLine.has(l.id)).length;
  const editedCount = adapted.filter((a) => a.authored_by === "editor").length;
  const majorCount = adapted.filter((a) => a.is_major).length;
  const allAdapted = lines.length > 0 && adaptedCount === lines.length;
  // The finalize gate's own rule (views.ts adaptedLineIssue), mirrored here so
  // the banner and the button can never say ready while the server would
  // refuse. Rare — the first pass always writes rationale + back-translation —
  // but an AI take can arrive without them (e.g. an alternative that carries
  // no back-translation); hand-editing such a line clears it.
  const unexplainedCount = lines.filter((l) => {
    const a = byLine.get(l.id);
    return !!a && adaptedLineIssue(a) === "unexplained";
  }).length;
  const hasAdaptation = adapted.length > 0;
  const durationMs = payload.episode.duration_ms ?? Math.max(1, ...lines.map((l) => l.end_ms ?? 0));

  // QC preflight, recomputed live as lines are edited — the same rules the
  // server enforces on finalize (errors block; warnings ship, but visibly).
  const qc = useMemo(
    () =>
      runQc({
        lines,
        adapted,
        characterNames: new Map(payload.characters.map((c) => [c.id, c.name_en])),
      }),
    [lines, adapted, payload.characters]
  );

  // ---- selection -------------------------------------------------------------

  function seek(ms: number | null) {
    if (ms == null) return;
    setCurrentMs(ms);
    if (videoRef.current) videoRef.current.currentTime = ms / 1000;
  }

  function selectLine(line: Line) {
    setSelectedLineId(line.id);
    seek(line.start_ms);
    setError(null);
    setNotice(null);
    setShowAlts(false);
    setPickedAltId(null);
    setDraft(byLine.get(line.id)?.text_en ?? "");
  }

  // Text issues are fixed by a rewrite; overlaps by trimming the previous
  // cue (the one timing repair a producer should never be blocked on — the
  // full timing desk only unlocks after finalize, see decisions 2026-09-04).
  const FIXABLE = new Set(["reading_speed", "line_too_long", "too_many_lines"]);
  const TIMING_FIXABLE = new Set(["overlap"]);
  const canFix = (code: string) => FIXABLE.has(code) || TIMING_FIXABLE.has(code);
  const fixableErrors = new Set(qc.errors.filter((i) => canFix(i.code)).map((i) => i.line_id)).size;
  const fixableWarnings = new Set(qc.warnings.filter((i) => canFix(i.code)).map((i) => i.line_id)).size;
  const [qcFixStep, setQcFixStep] = useState<{ i: number; n: number; pass: number } | null>(null);

  /** Same 17 cps budget the prompts carry (lib/prompts/shared.ts charBudget). */
  const charBudgetFor = (startMs: number, endMs: number) => Math.max(10, Math.floor(((endMs - startMs) / 1000) * 17));
  const qcCharNames = () => new Map(payload.characters.map((c) => [c.id, c.name_en]));

  /** One rewrite call fitting the line to its window; harder wording on retry.
   * Returns the updated row set (state is updated live along the way). */
  async function rewriteLineToBudget(rows: AdaptedLine[], lineId: string, harder: boolean): Promise<AdaptedLine[]> {
    const line = lines.find((l) => l.id === lineId);
    const a = rows.find((x) => x.line_id === lineId);
    if (!line || !a || line.start_ms == null || line.end_ms == null) return rows;
    const budget = charBudgetFor(line.start_ms, line.end_ms);
    const extra = harder ? " This is a HARD limit - cut words if needed; shorter always beats longer." : "";
    const instruction = `shorten to fit its ${((line.end_ms - line.start_ms) / 1000).toFixed(1)}s window: at most ${budget} characters excluding spaces, on a single line, keeping the meaning and tone.${extra}`;
    const r = unwrap(await postJson<{ line: AdaptedLine } & ApiEnvelope>(`${base}/lines/${a.id}/rewrite`, { instruction }));
    const next = rows.map((x) => (x.id === a.id ? r.line : x));
    setAdapted(next);
    if (selectedLineId === lineId) setDraft(r.line.text_en ?? "");
    return next;
  }

  const lineStillFlagged = (rows: AdaptedLine[], lineId: string) => {
    const rep = runQc({ lines, adapted: rows, characterNames: qcCharNames() });
    return [...rep.errors, ...rep.warnings].some((x) => x.line_id === lineId && FIXABLE.has(x.code));
  };

  /**
   * Overlaps: trim the PREVIOUS cue's end to a 2-frame gap before this cue
   * (never below a 300 ms cue); when that is not enough, nudge this cue's
   * start too. One batched write through the timing API; the page refreshes
   * with the new stamps and QC re-runs. Returns how many cues were touched.
   */
  async function fixOverlaps(issues: QcIssue[]): Promise<number> {
    const byId = new Map(lines.map((l) => [l.id, l]));
    const updates = new Map<string, { line_id: string; start_ms: number; end_ms: number }>();
    for (const issue of issues) {
      if (issue.code !== "overlap" || !issue.detail) continue;
      const cur = byId.get(issue.line_id);
      const prev = byId.get(issue.detail);
      if (!cur || !prev || cur.start_ms == null || prev.start_ms == null || prev.end_ms == null || cur.end_ms == null) continue;
      const prevEnd = Math.max(prev.start_ms + 300, cur.start_ms - 80);
      updates.set(prev.id, { line_id: prev.id, start_ms: prev.start_ms, end_ms: prevEnd });
      if (prevEnd > cur.start_ms) {
        updates.set(cur.id, { line_id: cur.id, start_ms: prevEnd + 80, end_ms: Math.max(cur.end_ms, prevEnd + 80 + 300) });
      }
    }
    if (!updates.size) return 0;
    unwrap(await postJson<ApiEnvelope>(`${base}/timing/cues`, { updates: [...updates.values()] }));
    router.refresh();
    return updates.size;
  }

  /** Fix exactly ONE issue's line — the row-level button. Two attempts max. */
  async function qcFixOne(issue: QcIssue) {
    setBusy(`fix:${issue.line_id}`);
    setError(null);
    setNotice(null);
    try {
      if (TIMING_FIXABLE.has(issue.code)) {
        const n = await fixOverlaps([issue]);
        setNotice(tt("qc.fix.timingDone", { n }));
        return;
      }
      let rows = await rewriteLineToBudget(adapted, issue.line_id, false);
      if (lineStillFlagged(rows, issue.line_id)) rows = await rewriteLineToBudget(rows, issue.line_id, true);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  // The bulk fix walks the flagged lines FROM THE CLIENT: each rewrite lands
  // in state immediately (the card updates live, no refresh), progress is
  // real, and lines the model leaves over-budget get a second, harsher pass.
  // Timing issues stay human work (the subtitle studio's timing desk).
  async function qcAutoFix(scope: "errors" | "warnings" = "errors") {
    setBusy("qcfix");
    setError(null);
    setNotice(null);
    let rows = adapted;
    let attempted = 0;
    try {
      attempted += await fixOverlaps(qc.errors.filter((i) => TIMING_FIXABLE.has(i.code)));
      for (let pass = 1; pass <= 2; pass++) {
        const report = runQc({ lines, adapted: rows, characterNames: qcCharNames() });
        const pool = scope === "warnings" ? [...report.errors, ...report.warnings] : report.errors;
        const targets = [...new Map(pool.filter((i) => FIXABLE.has(i.code)).map((i) => [i.line_id, i])).values()];
        if (!targets.length) break;
        for (let i = 0; i < targets.length; i++) {
          setQcFixStep({ i: i + 1, n: targets.length, pass });
          rows = await rewriteLineToBudget(rows, targets[i].line_id, pass > 1);
          attempted += 1;
        }
      }
      const after = runQc({ lines, adapted: rows, characterNames: qcCharNames() });
      const left = scope === "warnings" ? after.errors.length + after.warnings.length : after.errors.length;
      setNotice(left ? tt("qc.fix.done", { n: attempted, m: left }) : tt("qc.fix.allclear", { n: attempted }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setQcFixStep(null);
      setBusy(null);
    }
  }

  function qcLabel(issue: QcIssue) {
    return tt(`qc.${issue.code}`, { value: issue.value ?? 0, limit: issue.limit ?? 0, detail: issue.detail ?? "" });
  }
  function jumpToIssue(issue: QcIssue) {
    const line = lines.find((l) => l.id === issue.line_id);
    if (line) selectLine(line);
  }

  // ---- mutations -------------------------------------------------------------

  async function generate() {
    setError(null);
    setGenerating(true);
    setGenElapsed(0);
    const started = Date.now();
    const ticker = setInterval(() => setGenElapsed(Date.now() - started), 250);
    try {
      const r = unwrap(await postJson<{ unmatched?: number } & ApiEnvelope>(`${base}/first-pass`, {}));
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 3600 - (Date.now() - started))));
      if (r.unmatched && r.unmatched >= lines.length) {
        // Nothing in this episode is in the demo bank: no adapted rows were
        // written, so no remount will come — stop the spinner and explain.
        setError(tt("pw.gen.nomatch"));
        setGenerating(false);
        return;
      }
      if (r.unmatched) setError(tt("pw.gen.unmatched", { n: r.unmatched }));
      router.refresh();
    } catch (e) {
      setError(errText(e));
      setGenerating(false);
    } finally {
      clearInterval(ticker);
    }
  }

  const [altStep, setAltStep] = useState(1);

  async function viewAlternatives(a: AdaptedLine) {
    if (showAlts) {
      setShowAlts(false);
      return;
    }
    setShowAlts(true);
    if ((altsByLine.get(a.id) ?? []).length) return;
    setBusy(`alts:${a.id}`);
    // One call writes both takes; the 1/2 → 2/2 tick paces the wait.
    setAltStep(1);
    const ticker = setInterval(() => setAltStep((n) => Math.min(n + 1, 2)), 2800);
    try {
      const r = unwrap(
        await postJson<{ alternatives: LineAlternative[]; available: boolean } & ApiEnvelope>(`${base}/lines/${a.id}/alternatives`, {})
      );
      setAlts((rows) => [...rows.filter((x) => x.adapted_line_id !== a.id), ...r.alternatives]);
      if (!r.alternatives.length) setNotice(tt("pw.alts.none"));
    } catch (e) {
      setError(errText(e));
    } finally {
      clearInterval(ticker);
      setBusy(null);
    }
  }

  // "Take it another direction": one more take that leans into the tapped
  // tag. It lands in the edit box exactly like picking an alternative does -
  // nothing commits until 保存本句.
  async function takeDirection(a: AdaptedLine, direction: AdaptTag) {
    setBusy(`dir:${a.id}:${direction}`);
    try {
      const r = unwrap(
        await postJson<{ alternatives: LineAlternative[]; added: LineAlternative[]; available: boolean } & ApiEnvelope>(
          `${base}/lines/${a.id}/alternatives`,
          { direction }
        )
      );
      setAlts((rows) => [...rows.filter((x) => x.adapted_line_id !== a.id), ...r.alternatives]);
      const fresh = r.added[0];
      if (fresh) {
        pickAlternative(fresh);
        setNotice(tt("pw.alts.picked"));
      } else {
        setNotice(tt("pw.alts.dir.none"));
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  function pickAlternative(alt: LineAlternative) {
    setDraft(alt.text_en);
    setPickedAltId(alt.id);
    // Collapse straight to the edit box + save button: picking IS the
    // decision; no second "hide alternatives" click.
    setShowAlts(false);
    setNotice(tt("pw.alts.picked"));
  }

  async function confirmChange(a: AdaptedLine) {
    setBusy("confirm");
    setError(null);
    try {
      const picked = pickedAltId ? (altsByLine.get(a.id) ?? []).find((x) => x.id === pickedAltId) : null;
      let updated: AdaptedLine;
      if (picked && picked.text_en === draft.trim()) {
        const r = unwrap(await postJson<{ line: AdaptedLine } & ApiEnvelope>(`${base}/lines/${a.id}/choose`, { alternative_id: picked.id }));
        updated = r.line;
      } else {
        const r = unwrap(await patchJson<{ line: AdaptedLine } & ApiEnvelope>(`${base}/lines/${a.id}`, { text_en: draft }));
        updated = r.line;
      }
      setAdapted((rows) => rows.map((x) => (x.id === a.id ? updated : x)));
      setDraft(updated.text_en ?? "");
      setPickedAltId(null);
      setShowAlts(false);
      setNotice(tt("v3.line.saved"));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  const subtitlesHref = `/producer/titles/${payload.title.id}/episodes/${payload.episode.number}/subtitles`;

  async function finalize() {
    setBusy("finalize");
    setError(null);
    try {
      unwrap(await postJson<ApiEnvelope>(`${base}/finalize`, {}));
      // Stage one is done - carry the producer straight into timing & delivery.
      router.push(subtitlesHref);
    } catch (e) {
      setError(errText(e));
      setBusy(null);
      setArmed(false);
    }
  }

  async function approveSubmitted() {
    if (!version) return;
    setBusy("approve");
    setError(null);
    try {
      unwrap(await postJson<ApiEnvelope>(`/api/producer/versions/${version.id}/approve`, {}));
      router.push(subtitlesHref);
    } catch (e) {
      setError(errText(e));
      setBusy(null);
    }
  }

  async function editMyself() {
    setBusy("fork");
    setError(null);
    try {
      unwrap(await postJson<ApiEnvelope>(`${base}/fork`, {}));
      router.refresh();
    } catch (e) {
      setError(errText(e));
      setBusy(null);
    }
  }

  async function attachVideo(file: File) {
    setBusy("video");
    setError(null);
    try {
      const form = new FormData();
      form.set("video", file);
      const res = await fetch(`${base}/video`, { method: "POST", body: form });
      unwrap((await res.json()) as ApiEnvelope);
      setNotice(tt("pw.video.attached"));
      router.refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  // ---- the generate hero -----------------------------------------------------

  // Progress against a line-count estimate: real generation scales with the
  // episode, and the rationale/back-translation step dominates. The bar
  // parks at 95% until the request actually resolves.
  const genEstMs = 15_000 + lines.length * 2_500;
  const genFrac = Math.min(genElapsed / genEstMs, 0.95);
  const genStep = genFrac < 0.12 ? 0 : genFrac < 0.3 ? 1 : genFrac < 0.55 ? 2 : 3;
  const genOverrun = genElapsed > genEstMs;

  if (!hasAdaptation && !readOnly) {
    return (
      <div className="creative-review-shell">
        <div className="card genbox">
          <h3>{tt("pw.gen.title")}</h3>
          <p>{tt("pw.gen.body")}</p>
          {generating ? (
            <div className="genprog" role="status">
              {GEN_STEPS.map((key, i) => (
                <div key={key} className={`genprog-step ${i < genStep ? "done" : i === genStep ? "on" : ""}`}>
                  {i < genStep ? <IconCheck size={14} /> : <span className="spinner" hidden={i !== genStep} />}
                  <span>{tt(key)}</span>
                </div>
              ))}
              <div className="genbar" aria-hidden="true">
                <i style={{ width: `${Math.round(genFrac * 100)}%` }} />
              </div>
              <p className="genbar-meta">
                {tt("pw.gen.elapsed", { t: fmtDur(genElapsed) })}
                {" · "}
                {genOverrun ? tt("pw.gen.overrun") : tt("pw.gen.remaining", { t: fmtDur(genEstMs - genElapsed) })}
              </p>
            </div>
          ) : (
            <button className="btn btn-primary" onClick={generate}>
              {tt("pw.gen.cta")}
            </button>
          )}
          {error && <p className="err">{error}</p>}
          <p className="hint">{tt("pw.gen.hint", { n: lines.length })}</p>
        </div>
      </div>
    );
  }

  // ---- command strip ---------------------------------------------------------

  const workflow = finalized
    ? { tone: "done", title: tt("v3.done.next"), body: tt("v3.done.body") }
    : inReview
      ? { tone: "ready", title: tt("pw.cmd.review.title"), body: tt("pw.cmd.review.body") }
      : allAdapted && qc.errors.length > 0
        ? { tone: "blocked", title: tt("pw.cmd.blocked.title", { n: qc.errors.length }), body: tt("pw.cmd.blocked.body") }
        : allAdapted && unexplainedCount > 0
          ? { tone: "blocked", title: tt("pw.cmd.explain.title", { n: unexplainedCount }), body: tt("pw.cmd.explain.body") }
          : allAdapted
            ? { tone: "ready", title: tt("pw.cmd.ready.title"), body: tt("pw.cmd2.ready.body") }
            : { tone: "next", title: tt("pw.cmd2.lines.title", { n: lines.length - adaptedCount }), body: tt("pw.cmd2.lines.body") };

  const selectedAlternatives = selectedAdapted ? altsByLine.get(selectedAdapted.id) ?? [] : [];
  // Directions nobody has tried on this line yet: not on the current take,
  // not on any alternative already offered.
  const takenTags = new Set<AdaptTag>([
    ...(selectedAdapted?.tags ?? []),
    ...selectedAlternatives.flatMap((alt) => alt.tags ?? []),
  ]);
  const openDirections = TAGS.filter((tag) => !takenTags.has(tag));
  const directionBusy = busy?.startsWith(`dir:${selectedAdapted?.id ?? ""}:`) ? (busy.split(":")[2] as AdaptTag) : null;

  return (
    <div className="creative-review-shell">
      <header className="workspace-actionbar">
        <div className="workspace-state">
          <span>{tt("reviewStudio.version", { n: version?.number ?? 1 })}</span>
          <strong>{workflow.title}</strong>
        </div>
        <div className="head-actions">
          <span className={finalized ? "pill status-approved" : inReview ? "pill status-review" : "pill status-adapting"}>
            {finalized ? tt("pw.epStatus.approved") : inReview ? tt("pw.epStatus.in_review") : tt("pw.epStatus.adapting")}
          </span>
          {editable && (
            <>
              {armed && (
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy === "finalize"} onClick={() => setArmed(false)}>
                  {tt("common.cancel")}
                </button>
              )}
              <button
                type="button"
                className="btn btn-sm btn-approve"
                disabled={busy === "finalize" || !allAdapted || qc.errors.length > 0 || unexplainedCount > 0}
                title={
                  !allAdapted
                    ? tt("pw.finalize.blocked2")
                    : qc.errors.length
                      ? tt("qc.errors", { n: qc.errors.length })
                      : unexplainedCount
                        ? tt("pw.cmd.explain.title", { n: unexplainedCount })
                        : undefined
                }
                onClick={() => (armed ? finalize() : setArmed(true))}
              >
                {busy === "finalize" ? <span className="spinner" /> : <IconCheck />}
                {armed ? tt("v3.finalize.go") : tt("v3.finalize.cta")}
              </button>
            </>
          )}
          {finalized && (
            <a className="btn btn-sm btn-primary" href={subtitlesHref}>
              {tt("v3.goSubtitles")}
            </a>
          )}
          {finalized && !readOnly && (
            <button type="button" className="btn btn-sm btn-outline" disabled={busy === "fork"} onClick={editMyself}>
              {busy === "fork" ? <span className="spinner" /> : null} {tt("v3.revise.cta")}
            </button>
          )}
        </div>
      </header>

      <section className={`review-command review-command-${workflow.tone}`} aria-live="polite">
        <div>
          <span>{tt("review.nextStep")}</span>
          <strong>{workflow.title}</strong>
          <p>{workflow.body}</p>
        </div>
        <div className="review-command-metrics">
          <span>{tt("pw.count.lines", { x: adaptedCount, n: lines.length })}</span>
          <span>{tt("pw.count.edited", { n: editedCount })}</span>
          <span className={majorCount ? "has-changes" : ""}>{tt("pw.count.major", { n: majorCount })}</span>
        </div>
      </section>

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

      {/* Player and delivery preflight share the top band, level with each
          other; the edit panel keeps the whole right rail to itself below. */}
      <div className="workspace-top">
        <div className="rail-player">
          <div className="review-viewer">
            <div className="review-viewer-frame">
              {payload.video_url ? (
                <video
                  ref={videoRef}
                  controls
                  preload="metadata"
                  src={payload.video_url}
                  onTimeUpdate={(event) => setCurrentMs(Math.round(event.currentTarget.currentTime * 1000))}
                />
              ) : (
                <div className="review-script-frame">
                  <span>{tt("reviewStudio.noVideo")}</span>
                  <time>{timecode(currentMs)}</time>
                  <p lang="zh-CN">{selectedLine?.text_zh}</p>
                  <strong>{adaptedText(selectedAdapted)}</strong>
                </div>
              )}
            </div>
            <div className="review-timeline" aria-label={tt("reviewStudio.timeline")}>
              <div className="review-timeline-track">
                {lines
                  .filter((line) => line.start_ms != null)
                  .map((line) => {
                    const marked = byLine.get(line.id)?.is_major ?? false;
                    return (
                      <button
                        type="button"
                        key={line.id}
                        className={marked ? "review-marker has-feedback" : "review-marker"}
                        style={{ left: `${Math.max(0, Math.min(100, ((line.start_ms ?? 0) / durationMs) * 100))}%` }}
                        aria-label={`${marked ? tt("pw.line.major") : tt("reviewStudio.lineMarker")} ${timecode(line.start_ms)}`}
                        onClick={() => selectLine(line)}
                      />
                    );
                  })}
                <span className="review-playhead" style={{ left: `${Math.max(0, Math.min(100, (currentMs / durationMs) * 100))}%` }} />
              </div>
              <div className="review-timeline-meta">
                <b>{timecode(currentMs)}</b>
                <span>{timecode(durationMs)}</span>
              </div>
            </div>
          </div>
          {!readOnly && (
            <div className="rail-media-actions">
              <label className="btn btn-sm btn-ghost">
                {busy === "video" ? (
                  <>
                    <span className="spinner" /> {tt("pw.video.uploading")}
                  </>
                ) : payload.video_url ? (
                  tt("pw.video.replace")
                ) : (
                  tt("pw.video.attach")
                )}
                <input
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                  hidden
                  disabled={busy === "video"}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void attachVideo(f);
                    e.target.value = "";
                  }}
                />
              </label>
              <span className="spacer" />
              <a className="btn btn-sm btn-outline" href={`/api/titles/${payload.title.id}/export?format=script&episode=${payload.episode.number}`}>
                {tt("pw.export.script")}
              </a>
            </div>
          )}
        </div>

        {hasAdaptation && (
          <section
            className={`rail-qc ${qc.errors.length ? "has-errors" : qc.warnings.length ? "has-warnings" : "is-clean"}`}
            aria-live="polite"
          >
            <div className="rail-qc-head">
              <span>{tt("qc.title")}</span>
              <b>
                {qc.errors.length
                  ? tt("qc.errors", { n: qc.errors.length })
                  : qc.warnings.length
                    ? tt("qc.warnings", { n: qc.warnings.length })
                    : tt("qc.pass", { n: qc.lines })}
              </b>
            </div>
            {editable && (
              <div className="rail-qc-fix">
                <button
                  type="button"
                  className={`btn btn-sm ${fixableErrors > 0 ? "btn-primary" : "btn-outline"} btn-block`}
                  disabled={busy !== null || (fixableErrors === 0 && fixableWarnings === 0)}
                  onClick={() => qcAutoFix(fixableErrors > 0 ? "errors" : "warnings")}
                >
                  {busy === "qcfix" ? (
                    <>
                      <span className="spinner" />{" "}
                      {qcFixStep ? tt("qc.fix.progress", { i: qcFixStep.i, n: qcFixStep.n, p: qcFixStep.pass }) : tt("qc.fix.busy")}
                    </>
                  ) : fixableErrors > 0 ? (
                    <>
                      {tt("qc.fix.all")} <b className="qc-badge">{fixableErrors}</b>
                    </>
                  ) : fixableWarnings > 0 ? (
                    <>
                      {tt("qc.fix.polishAll")} <b className="qc-badge">{fixableWarnings}</b>
                    </>
                  ) : (
                    tt("qc.fix.none")
                  )}
                </button>
              </div>
            )}
            {(qc.errors.length > 0 || qc.warnings.length > 0) && (
              <div className="rail-qc-list">
                {[...qc.errors, ...qc.warnings].map((issue, i) => (
                  <div
                    key={`${issue.line_id}:${issue.code}:${i}`}
                    className={`rail-qc-row is-${issue.severity} ${issue.line_id === selectedLine?.id ? "is-active" : ""}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => jumpToIssue(issue)}
                    onKeyDown={(e) => e.key === "Enter" && jumpToIssue(issue)}
                  >
                    <i aria-hidden="true" />
                    <time>{timecode(issue.start_ms, issue.seq)}</time>
                    <span>{qcLabel(issue)}</span>
                    {editable && canFix(issue.code) && (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost rail-qc-row-fix"
                        disabled={busy !== null}
                        onClick={(e) => {
                          e.stopPropagation();
                          void qcFixOne(issue);
                        }}
                      >
                        {busy === `fix:${issue.line_id}` ? (
                          <span className="spinner" />
                        ) : TIMING_FIXABLE.has(issue.code) ? (
                          tt("qc.fix.timingRow")
                        ) : (
                          tt("qc.fix.row")
                        )}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      <div className="review-work-grid">
        {/* The script: one continuous, scrolling sheet. */}
        <main className="review-stage-column">
          <section className="review-script-sheet">
            <div className="review-script-head">
              <div>
                <span>{tt("reviewStudio.script")}</span>
                <strong>{tt("reviewStudio.clickTimestamp")}</strong>
              </div>
              <div className="review-script-columns">
                <span>{tt("pw.col.original")}</span>
                <span>{tt("pw.col.adapted")}</span>
              </div>
            </div>
            <div className="review-script-list">
              {lines.map((line) => {
                const a = byLine.get(line.id);
                const active = line.id === selectedLine?.id;
                const why = a ? (locale === "zh" ? a.rationale_zh : a.rationale_en ?? a.rationale_zh) : null;
                const tone = a ? (locale === "zh" ? a.tone_note_zh : a.tone_note_en ?? a.tone_note_zh) : null;
                return (
                  <button
                    type="button"
                    className={`review-script-row ${active ? "is-active" : ""} ${a?.is_major ? "has-feedback" : ""}`}
                    key={line.id}
                    onClick={() => selectLine(line)}
                  >
                    <time>
                      {timecode(line.start_ms, line.seq)}
                      {a?.is_major && <i aria-hidden="true" />}
                    </time>
                    <div lang="zh-CN">
                      <small>{line.speaker}</small>
                      <p>{line.text_zh}</p>
                      {line.literal_en && (
                        <p className="row-literal" lang="en">
                          {line.literal_en}
                        </p>
                      )}
                    </div>
                    <div lang="en">
                      <small>
                        {line.speaker}
                        {a?.authored_by === "editor" ? ` · ${tt("pw.line.edited")}` : ""}
                      </small>
                      <p>{a?.text_en ? highlightPhrase(a.text_en, a.key_phrase_en) : adaptedText(a)}</p>
                    </div>
                    {why && (
                      <span className="review-script-why">
                        <b>{tt("adapt.whyThisChange")}</b>
                        <span className="bilingual" lang={locale === "zh" ? "zh-CN" : "en"}>
                          {why}
                          {tone ? ` · ${tone}` : ""}
                        </span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        </main>

        {/* The rail stays on screen while the sheet scrolls: the edit panel only. */}
        <aside className="review-feedback-panel">
          <div className="review-feedback-head">
            <div>
              <span>{tt("pw.panel.title")}</span>
              <strong>{timecode(selectedLine?.start_ms ?? null, selectedLine?.seq)}</strong>
            </div>
            {selectedAdapted?.is_major && <span className="pill pill-warning">{tt("pw.line.major")}</span>}
          </div>

          {inReview && !readOnly && (
            <section className="moment-action-card">
              <span>{tt("pw.review.banner")}</span>
              <button type="button" className="btn btn-approve btn-block" disabled={busy === "approve"} onClick={approveSubmitted}>
                {busy === "approve" ? <span className="spinner" /> : <IconCheck />} {tt("v3.finalize.submitted")}
              </button>
              <button type="button" className="btn btn-outline btn-block" disabled={busy === "fork"} onClick={editMyself}>
                {busy === "fork" ? <span className="spinner" /> : null} {tt("pw.review.editMyself")}
              </button>
            </section>
          )}

          {selectedAdapted ? (
            <section className="pline-panel" aria-live="polite">
              {(selectedAdapted.tags?.length ?? 0) > 0 && (
                <div className="tags">
                  {selectedAdapted.tags.map((tag) => (
                    <span className="tag" key={tag}>
                      {locale === "zh" ? TAG_LABELS[tag].zh : TAG_LABELS[tag].en}
                    </span>
                  ))}
                </div>
              )}

              {editable ? (
                <>
                  <label className="pline-edit-label" htmlFor="pw-line-edit">
                    {tt("pw.panel.editLabel")}
                  </label>
                  <div className="pline-en bilingual" lang="en">
                    <textarea
                      id="pw-line-edit"
                      className="textarea"
                      value={draft}
                      rows={2}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        setPickedAltId(null);
                      }}
                    />
                  </div>

                  <button
                    type="button"
                    className="btn btn-outline btn-block"
                    disabled={busy === `alts:${selectedAdapted.id}`}
                    onClick={() => viewAlternatives(selectedAdapted)}
                  >
                    {busy === `alts:${selectedAdapted.id}` ? (
                      <>
                        <span className="spinner" /> {tt("pw.alts.busyN", { i: altStep })}
                      </>
                    ) : showAlts ? (
                      tt("pw.alts.hide")
                    ) : (
                      tt("pw.alts.view")
                    )}
                  </button>
                  {showAlts && selectedAlternatives.length > 0 && (
                    <>
                      <div className="pline-alts">
                        {selectedAlternatives.map((alt, altIdx) => (
                          <button
                            key={alt.id}
                            type="button"
                            className={`pline-alt ${pickedAltId === alt.id ? "is-picked" : ""}`}
                            onClick={() => pickAlternative(alt)}
                          >
                            <span className="pline-alt-idx">
                              {altIdx + 1} / {selectedAlternatives.length}
                            </span>
                            {(alt.tags?.length ?? 0) > 0 && (
                              <span className="tags pline-alt-direction">
                                {alt.tags.map((tag, i) => (
                                  <span className={i === 0 ? "tag tag-direction" : "tag tag-neutral"} key={tag}>
                                    {locale === "zh" ? TAG_LABELS[tag].zh : TAG_LABELS[tag].en}
                                  </span>
                                ))}
                              </span>
                            )}
                            <span className="pline-alt-en bilingual" lang="en">
                              {alt.text_en}
                            </span>
                            <small className="bilingual" lang={locale === "zh" ? "zh-CN" : "en"}>
                              {locale === "zh" ? alt.rationale_zh : alt.rationale_en ?? alt.rationale_zh}
                            </small>
                          </button>
                        ))}
                      </div>

                      {openDirections.length > 0 && (
                        <div className="pline-directions">
                          <p className="pline-directions-label">{tt("pw.alts.dir.title")}</p>
                          <div className="pline-directions-row">
                            {openDirections.map((tag) => (
                              <button
                                key={tag}
                                type="button"
                                className={`tag-btn ${directionBusy === tag ? "is-busy" : ""}`}
                                disabled={busy !== null}
                                onClick={() => takeDirection(selectedAdapted, tag)}
                              >
                                {directionBusy === tag ? <span className="spinner" /> : null}
                                {locale === "zh" ? TAG_LABELS[tag].zh : TAG_LABELS[tag].en}
                              </button>
                            ))}
                          </div>
                          {directionBusy && (
                            <p className="hint">
                              {tt("pw.alts.dir.busy", { tag: locale === "zh" ? TAG_LABELS[directionBusy].zh : TAG_LABELS[directionBusy].en })}
                            </p>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  <button type="button" className="btn btn-primary btn-block" disabled={busy === "confirm" || !dirty} onClick={() => confirmChange(selectedAdapted)}>
                    {busy === "confirm" ? <span className="spinner" /> : <IconCheck />} {tt("v3.line.save")}
                  </button>
                  <p className="hint">{dirty ? tt("pw.confirm.hint") : tt("pw.confirm.clean")}</p>
                </>
              ) : (
                <div className="pline-en bilingual" lang="en">
                  <p>{adaptedText(selectedAdapted)}</p>
                </div>
              )}
            </section>
          ) : (
            <p className="hint">{tt("pw.line.pending")}</p>
          )}

          {readOnly && !finalized && <div className="note note-info">{tt("review.previewDisabled")}</div>}
        </aside>
      </div>
    </div>
  );
}
