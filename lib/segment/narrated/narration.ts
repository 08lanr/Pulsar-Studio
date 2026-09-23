// The narration's two picture checks (narrated spec N1, E5 and E6).
//
// E5 frames — every narration line judged against the frames that play under
// it: `frame_claims.py prepare`, then `status`; the pending lines go to the
// API readers (fv-2 through the shim: two lenses per line, amendment 6) or,
// without them, to the person as the exact Workflow call; the verdicts enter
// the project ONLY through `frame_claims.py record`, then `status` again.
// One reader's "contradicted" is enough (ST/frame_claims.py:120-126): the
// lane waits for `{kind: "line", action: reword | waive, id, text?, reason}`.
// A waiver is `<id>_frames` in epN/waivers.json; a reword changes that
// line's `text` in narration.json (the one field Studio writes there), runs
// narr_lint over the episode (paid Jev), and sends the lane back to the voice
// (only the changed line bills: its sig no longer matches).
//
// E6 joins — every skip in the cut: `cut_joins.py prepare`, then `status`
// (which also counts a join as reviewed when at most one line drifted,
// ST/cut_joins.py:62-73, so status is asked before paying); the pending joins
// to the readers (cv-2) or the hand-off; `cut_joins.py record`; `status`. A
// join judged lost waits for `{kind: "join", action: restore | narrate |
// waive, key, reason}`: a waiver is `cut_join_<src_out>-<src_in>`; restore and
// narrate send the episode back to its prep with the note (restoring footage
// changes the cut, so the prep approval and the picture are redone).
//
// Every pending line / join decision of the episode is applied, in order, in
// one step (a waiver and a reword made before the step ran both land). A
// pass that left items unjudged — a reader call failed, the recorder
// refused, the account ran out of credit — with nothing contradicted or lost
// waits for a Retry, with the count and the errors, not for a decision no
// line needs; a Retry also wakes a `line` / `join` wait. Nothing runs from a
// synced copy of the scripts that no longer matches its sync record: the
// passes compile the copy's `*.workflow.js` in Studio's own process.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readSyncRecord } from "@/lib/segment/scripts-sync";
import type { FilmRunEpisode, Json } from "@/lib/types";
import { readJson, tailLines } from "../stages";
import { runCheck } from "./gate";
import { writeWaivers } from "./prep";
import { dataOf, epDir, NARRATED_DECISION, narratedRefusal, pendingEpisodeDecision, pendingEpisodeDecisions, runFilmStep, scriptsDriftRefusal, writeProjectFile, type EpisodeStepOutcome, type NarratedContext, type PictureOutcome, type PictureReaders } from "./stages";

/** The exact Workflow call for a picture check hand-off: the synced workflow, the premise, the pending items as the pipeline wrote them. */
export function pictureHandoffCommand(film: string, workflow: "frame_verify" | "cut_verify", pendingFile: string): string {
  const script = path.join(film, "scripts", `${workflow}.workflow.js`).replace(/\\/g, "/");
  const premise = (() => {
    try {
      return readFileSync(path.join(film, "frame_premise.txt"), "utf8").trim();
    } catch {
      return "";
    }
  })();
  const items = readJson<unknown>(pendingFile) ?? [];
  return `Workflow({ scriptPath: ${JSON.stringify(script)}, args: { premise: ${JSON.stringify(premise)}, items: ${JSON.stringify(items)} } })`;
}

/**
 * A status run: its exit, its last lines, and what its exit 1 is about —
 * `pending` items nobody judged yet, `person` a contradicted line / a lost
 * join that is not waived (a decision for a person).
 */
type Status = { code: number | null; lines: string[]; pending: boolean; person: boolean };

/** What frame_claims.py / cut_joins.py status printed, read the way they print it (ST/frame_claims.py status, ST/cut_joins.py status). Pure. */
export function statusSays(kind: "frames" | "joins", text: string): { pending: boolean; person: boolean } {
  return kind === "frames"
    ? { pending: /line\(s\) not yet checked against the picture/.test(text), person: /^\s*CONTRADICTED\b/m.test(text) }
    : { pending: /join\(s\) not yet reviewed/.test(text), person: /loses the viewer - restore the footage/.test(text) };
}

async function runStatus(ctx: NarratedContext, kind: "frames" | "joins", ep: string): Promise<Status> {
  const script = kind === "frames" ? "frame_claims.py" : "cut_joins.py";
  const r = await runFilmStep(ctx, { script, args: ["status", "--ep", ep], what: `${script.replace(/\.py$/, "")} status ${ep}` });
  const text = `${r.stdoutTail}\n${r.stderrTail}`;
  return { code: r.code, lines: tailLines(text, 20), ...statusSays(kind, r.stdoutTail) };
}

const frameStatus = (ctx: NarratedContext, ep: string) => runStatus(ctx, "frames", ep);
const joinStatus = (ctx: NarratedContext, ep: string) => runStatus(ctx, "joins", ep);

/**
 * The lane's wait after a picture pass when status still exits 1. A
 * contradicted line / a lost join waits for the person (`line` / `join`,
 * which a Retry also wakes, for the lines the pass left unjudged). Only
 * unjudged items — a reader call failed, the recorder refused, the account
 * ran out of credit — wait for a Retry, with the count and the errors: no
 * decision about a line is due. An exit other than 0 or 1 is the script's
 * refusal.
 */
function afterPass(kind: "frames" | "joins", status: Status, pass: PictureOutcome | null, base: Record<string, Json | undefined>): EpisodeStepOutcome {
  const script = kind === "frames" ? "frame_claims.py" : "cut_joins.py";
  if (status.code !== 1) return { kind: "refused", error: `${script} status exited ${status.code ?? "killed"}\n${status.lines.join("\n")}`, patch: { stage_detail: base } };
  const done = pass?.status === "done" ? pass : null;
  const errors = done && Array.isArray((done.detail as { errors?: unknown }).errors) ? ((done.detail as { errors: Json[] }).errors as Json) : null;
  const incomplete = done ? done.incomplete ?? 0 : null;
  const found = kind === "frames" ? { contradicted: done?.contradicted ?? [] } : { lost: done?.lost ?? [] };
  const record = { status: status.lines, ...found, incomplete, errors, pass: done ? done.detail : null } as unknown as Json;
  // Only a status that says items are still unjudged and nothing waits for a person is the Retry's; anything else (a
  // contradiction, a lost join, words this reading does not know) is shown to the person, whose wait a Retry also wakes.
  if (status.person || !status.pending) return { kind: "wait", for: kind === "frames" ? "line" : "join", patch: { stage_detail: { ...base, [kind]: record } } };
  const what = kind === "frames" ? "line" : "join";
  const note = `the ${kind === "frames" ? "frame" : "join"} check left ${incomplete ?? "some"} ${what}(s) unjudged and nothing ${kind === "frames" ? "contradicted" : "lost"}: no decision is due; Retry runs the check again for the ${what}s still pending${errors ? ` (the errors: ${JSON.stringify(errors).slice(0, 600)})` : ""}`;
  return { kind: "wait", for: "retry", detail: { [`${kind}_unjudged`]: { incomplete, errors } as unknown as Json }, patch: { stage_detail: { ...base, [kind]: record, note } } };
}

/** Change one narration line's `text` (and nothing else) through the project writer. */
export function rewordLine(ctx: NarratedContext, n: number, id: string, text: string, by: { by: string; why: string; at: string }): boolean {
  const rel = `${epDir(n)}/narration.json`;
  const file = path.join(ctx.paths.film, rel);
  const j = readJson<{ lines?: { id?: string; text?: string }[] } & Record<string, unknown>>(file);
  if (!j || !Array.isArray(j.lines)) return false;
  const line = j.lines.find((l) => l.id === id);
  if (!line) return false;
  line.text = text;
  writeProjectFile(ctx, rel, `${JSON.stringify(j, null, 1)}\n`, { by: by.by, why: `line ${id} reworded: ${by.why}`, decision_at: by.at });
  return true;
}

// ---- E5 ----------------------------------------------------------------------------------------------------------------

export async function runFramesStep(ctx: NarratedContext, ep: FilmRunEpisode): Promise<EpisodeStepOutcome> {
  const d = ep.stage_detail as Record<string, Json | undefined>;
  const e = epDir(ep.n);
  const consumed = { decisions_seen: ctx.run.decisions.length };

  // The person's answers to the contradictions: every one made since the lane last looked, in order — all the waivers
  // and all the rewords written, then narr_lint and the voice follow-up once.
  const lines = pendingEpisodeDecisions(ctx.run, ep).filter((x) => x.action === NARRATED_DECISION.line);
  if (lines.length) {
    const reworded: { id: string; by: string; at: string }[] = [];
    const waived: string[] = [];
    const missing: string[] = [];
    for (const line of lines) {
      const data = dataOf(line);
      const id = typeof data.id === "string" ? data.id : "";
      if (data.action === "waive" && id && (line.why ?? "").trim()) {
        writeWaivers(ctx, ep.n, [{ key: `${id}_frames`, reason: (line.why ?? "").trim() }], { by: line.by, at: line.at });
        waived.push(id);
      } else if (data.action === "reword" && id && typeof data.text === "string" && data.text.trim()) {
        if (rewordLine(ctx, ep.n, id, data.text.trim(), { by: line.by, why: line.why ?? "reworded against its frames", at: line.at })) reworded.push({ id, by: line.by, at: line.at });
        else missing.push(id);
      }
    }
    const note = missing.length ? `${e}/narration.json has no line ${missing.join(", ")}` : null;
    if (reworded.length) {
      // narr_lint runs from the synced copy: not from one a session changed (the voice step refuses that copy too, and
      // build_ep.sh runs narr_lint again), so the rewords are kept and the lane still goes to the voice.
      const drift = scriptsDriftRefusal(ctx);
      const lint = drift ? { skipped: drift } : await runCheck(ctx, { script: "narr_lint.py", args: ["--ep", e, "--narration", "narration.json"], what: "narr_lint (Jev)" }, ep.n);
      // The changed lines re-render (their sigs miss), the placement and the frame check follow.
      return { kind: "moved", patch: { words_stage: "voice", stage_detail: { ...d, ...consumed, reworded: reworded as unknown as Json, waived, narr_lint_after_reword: lint as unknown as Json, ...(note ? { note } : {}) } } };
    }
    if (note) return { kind: "wait", for: "line", patch: { stage_detail: { ...d, ...consumed, waived, note } } };
  }

  // Every script below, and the frame_verify.workflow.js the API pass compiles in Studio's own process, is the film's copy.
  const drift = scriptsDriftRefusal(ctx);
  if (drift) return { kind: "refused", error: drift, patch: { stage_detail: { ...d, ...consumed } } };
  const prep = await runFilmStep(ctx, { script: "frame_claims.py", args: ["prepare", "--ep", e, "--narration", "narration.json"], what: `frame_claims prepare ${e}` });
  if (prep.code !== 0) return { kind: "refused", error: narratedRefusal({ script: "frame_claims.py" }, prep), patch: { stage_detail: { ...d, ...consumed } } };
  let status = await frameStatus(ctx, e);
  if (status.code === 0) return { kind: "moved", patch: { words_stage: "joins", error_text: null, stage_detail: { ...d, ...consumed, frames: { status: status.lines } as unknown as Json } } };

  const pendingFile = path.join(ctx.paths.film, e, "review", "frame_pending.json");
  const done = pendingEpisodeDecision(ctx.run, ep, NARRATED_DECISION.handoff_done);
  const output = done && typeof dataOf(done).output_path === "string" ? String(dataOf(done).output_path) : null;
  let pass: PictureOutcome | null = null;
  if (output) {
    if (!existsSync(output)) return { kind: "wait", for: "handoff", patch: { stage_detail: { ...d, ...consumed, note: `${output} is not there` } } };
    const rec = await runFilmStep(ctx, { script: "frame_claims.py", args: ["record", "--ep", e, "--verdicts", output], what: `frame_claims record ${e}` });
    if (rec.code !== 0) return { kind: "refused", error: narratedRefusal({ script: "frame_claims.py" }, rec), patch: { stage_detail: { ...d, ...consumed } } };
  } else if (ctx.settings.vision === "api" && ctx.readers) {
    pass = await ctx.readers.frames(ctx, ep);
    if (pass.status === "unavailable" || pass.status === "failed") {
      const why = pass.status === "failed" ? pass.error : pass.reason;
      return { kind: "wait", for: "handoff", detail: { handoff: { command: pictureHandoffCommand(ctx.paths.film, "frame_verify", pendingFile) } as unknown as Json }, patch: { stage_detail: { ...d, ...consumed, frames_unavailable: why } } };
    }
  } else {
    return { kind: "wait", for: "handoff", detail: { handoff: { command: pictureHandoffCommand(ctx.paths.film, "frame_verify", pendingFile), record: `python scripts/frame_claims.py record --ep ${e} --verdicts <the Workflow's .output>` } as unknown as Json }, patch: { stage_detail: { ...d, ...consumed } } };
  }
  status = await frameStatus(ctx, e);
  if (status.code === 0) return { kind: "moved", patch: { words_stage: "joins", error_text: null, stage_detail: { ...d, ...consumed, frames: { status: status.lines, pass: pass?.status === "done" ? pass.detail : null } as unknown as Json } } };
  return afterPass("frames", status, pass, { ...d, ...consumed });
}

// ---- E6 ----------------------------------------------------------------------------------------------------------------

export async function runJoinsStep(ctx: NarratedContext, ep: FilmRunEpisode): Promise<EpisodeStepOutcome> {
  const d = ep.stage_detail as Record<string, Json | undefined>;
  const e = epDir(ep.n);
  const consumed = { decisions_seen: ctx.run.decisions.length };

  // The person's answers to the lost joins, every one since the lane last looked, in order: all the waivers written; any
  // restore or narrate sends the episode back to its prep once, with every such note.
  const joins = pendingEpisodeDecisions(ctx.run, ep).filter((x) => x.action === NARRATED_DECISION.join);
  const back: { note: string; key: string; action: string; by: string; at: string }[] = [];
  for (const join of joins) {
    const data = dataOf(join);
    const key = typeof data.key === "string" && /^\d+(\.\d+)?-\d+(\.\d+)?$/.test(data.key) ? data.key : "";
    const why = (join.why ?? "").trim();
    if (data.action === "waive" && key && why) {
      writeWaivers(ctx, ep.n, [{ key: `cut_join_${key}`, reason: why }], { by: join.by, at: join.at });
    } else if ((data.action === "restore" || data.action === "narrate") && key) {
      const note = data.action === "restore" ? `The join at ${key} (source seconds) loses the viewer: restore the footage that was cut there (the walk, the arrival), then re-run the checks. ${why}` : `The join at ${key} (source seconds) loses the viewer: narrate the move right after the skip (name the new place or who is there), then re-run the checks. ${why}`;
      back.push({ note: note.trim(), key, action: String(data.action), by: join.by, at: join.at });
    }
  }
  if (back.length) {
    const rest = { ...d } as Record<string, Json | undefined>;
    delete rest.prep_approved;
    const last = back[back.length - 1];
    const restore = back.some((b) => b.action === "restore");
    return {
      kind: "moved",
      patch: { words_stage: "prep", picture_stage: restore ? "waiting" : ep.picture_stage, stage_detail: { ...rest, ...consumed, send_back: { note: back.map((b) => b.note).join("\n"), by: last.by, at: last.at } } },
      note: `ep${ep.n}: join${back.length > 1 ? "s" : ""} ${back.map((b) => `${b.key} (${b.action})`).join(", ")} go${back.length > 1 ? "" : "es"} back to the prep`,
    };
  }

  // Every script below, and the cut_verify.workflow.js the API pass compiles in Studio's own process, is the film's copy.
  const drift = scriptsDriftRefusal(ctx);
  if (drift) return { kind: "refused", error: drift, patch: { stage_detail: { ...d, ...consumed } } };
  const prep = await runFilmStep(ctx, { script: "cut_joins.py", args: ["prepare", "--ep", e], what: `cut_joins prepare ${e}` });
  if (prep.code !== 0) return { kind: "refused", error: narratedRefusal({ script: "cut_joins.py" }, prep), patch: { stage_detail: { ...d, ...consumed } } };
  let status = await joinStatus(ctx, e);
  if (status.code === 0) return { kind: "moved", patch: { words_stage: "ready", error_text: null, stage_detail: { ...d, ...consumed, joins: { status: status.lines } as unknown as Json } } };

  const pendingFile = path.join(ctx.paths.film, e, "review", "cut_pending.json");
  const done = pendingEpisodeDecision(ctx.run, ep, NARRATED_DECISION.handoff_done);
  const output = done && typeof dataOf(done).output_path === "string" ? String(dataOf(done).output_path) : null;
  let pass: PictureOutcome | null = null;
  if (output) {
    if (!existsSync(output)) return { kind: "wait", for: "handoff", patch: { stage_detail: { ...d, ...consumed, note: `${output} is not there` } } };
    const rec = await runFilmStep(ctx, { script: "cut_joins.py", args: ["record", "--ep", e, "--verdicts", output], what: `cut_joins record ${e}` });
    if (rec.code !== 0) return { kind: "refused", error: narratedRefusal({ script: "cut_joins.py" }, rec), patch: { stage_detail: { ...d, ...consumed } } };
  } else if (ctx.settings.vision === "api" && ctx.readers) {
    pass = await ctx.readers.joins(ctx, ep);
    if (pass.status === "unavailable" || pass.status === "failed") {
      const why = pass.status === "failed" ? pass.error : pass.reason;
      return { kind: "wait", for: "handoff", detail: { handoff: { command: pictureHandoffCommand(ctx.paths.film, "cut_verify", pendingFile) } as unknown as Json }, patch: { stage_detail: { ...d, ...consumed, joins_unavailable: why } } };
    }
  } else {
    return { kind: "wait", for: "handoff", detail: { handoff: { command: pictureHandoffCommand(ctx.paths.film, "cut_verify", pendingFile), record: `python scripts/cut_joins.py record --ep ${e} --verdicts <the Workflow's .output>` } as unknown as Json }, patch: { stage_detail: { ...d, ...consumed } } };
  }
  status = await joinStatus(ctx, e);
  if (status.code === 0) return { kind: "moved", patch: { words_stage: "ready", error_text: null, stage_detail: { ...d, ...consumed, joins: { status: status.lines, pass: pass?.status === "done" ? pass.detail : null } as unknown as Json } } };
  return afterPass("joins", status, pass, { ...d, ...consumed });
}

// ---- the API readers (amendment 6), over the picture passes ------------------------------------------------------------

/**
 * The three picture checks through the API: the shim's passes
 * (lib/segment/narrated/picture/*: the synced `*.workflow.js` prompts, one
 * `sheet_read` / `frame_verify` / `cut_verify` job per call, at most two
 * calls at once, recorded only by the pipeline's recorders) answered in the
 * stages' PictureOutcome. The worker passes this as `readers` when a run's
 * `settings.vision` is `api`; a pass the shim reports unavailable (no key)
 * becomes the hand-off.
 */
/** What a pass left unjudged: the items a reader call failed on, plus every item when the recorder refused the verdicts; the errors in words (the first ten). Pure. */
export function unjudged(r: { complete: string[]; incomplete: { key: string; error: string }[]; recorded: { code: number | null; refusal: string | null } | null }, recorder: string): { incomplete: number; errors: string[] } {
  const refused = r.recorded && r.recorded.code !== 0 ? r.recorded.refusal ?? `exit ${r.recorded.code}` : null;
  const errors = [...(refused ? [`${recorder} record refused: ${refused}`] : []), ...r.incomplete.map((i) => `${i.key}: ${i.error}`)].slice(0, 10);
  return { incomplete: r.incomplete.length + (refused ? r.complete.length : 0), errors };
}

export function apiPictureReaders(): PictureReaders {
  const deps = (ctx: NarratedContext) => ({ film: ctx.paths.film, run_id: ctx.run.id, work_dir: ctx.paths.work, env: ctx.env, signal: ctx.signal, session: ctx.session, ...(ctx.settings.reader_model ? { model: ctx.settings.reader_model } : {}), onLog: (l: string) => ctx.log(l) });
  // The workflow's SHA-256 as the sync recorded it: the shim compiles only those bytes (the stage checked the whole copy
  // before; this closes the moment between that check and the read, while another episode's session runs).
  const synced = (ctx: NarratedContext, file: string): { workflow_sha256?: string } => {
    const sha = readSyncRecord(ctx.paths.film)?.file_sha256?.[file];
    return sha ? { workflow_sha256: sha } : {};
  };
  return {
    async sheets(ctx) {
      const { runSheetPass } = await import("./picture/sheets");
      const { isWorkflowUnavailable } = await import("@/lib/segment/workflow-shim");
      try {
        const r = await runSheetPass({ ...deps(ctx), ...synced(ctx, "sheet_read.workflow.js"), premise: ctx.settings.sheet_premise ?? undefined });
        if (isWorkflowUnavailable(r)) return { status: "unavailable", reason: r.unavailable };
        if (!r.file) return { status: "failed", error: `${r.failed_groups.length} sheet group(s) failed: ${r.failed_groups.map((g) => `${g.label}: ${g.error}`).join("; ").slice(0, 1500)}`, detail: { cost_cents: r.cost_cents, reader_version: r.reader_version } };
        return { status: "done", detail: { file: path.relative(ctx.paths.film, r.file).split(path.sep).join("/"), entries: r.entries, cost_cents: r.cost_cents, reader_version: r.reader_version, model: r.model } };
      } catch (e) {
        return { status: "failed", error: (e as Error).message };
      }
    },
    async frames(ctx, ep) {
      const { runFramePass } = await import("./picture/frames");
      const { isWorkflowUnavailable } = await import("@/lib/segment/workflow-shim");
      try {
        const r = await runFramePass({ ...deps(ctx), ...synced(ctx, "frame_verify.workflow.js"), ep: epDir(ep.n) });
        if (isWorkflowUnavailable(r)) return { status: "unavailable", reason: r.unavailable };
        const u = unjudged(r, "frame_claims.py");
        return { status: "done", detail: { complete: r.complete.length, incomplete: u.incomplete, errors: u.errors, cost_cents: r.cost_cents, reader_version: r.reader_version, model: r.model }, contradicted: r.contradicted.map((c) => ({ id: c.id, claim: c.claim, evidence: c.evidence })), incomplete: u.incomplete };
      } catch (e) {
        return { status: "failed", error: (e as Error).message };
      }
    },
    async joins(ctx, ep) {
      const { runJoinPass } = await import("./picture/joins");
      const { isWorkflowUnavailable } = await import("@/lib/segment/workflow-shim");
      try {
        const r = await runJoinPass({ ...deps(ctx), ...synced(ctx, "cut_verify.workflow.js"), ep: epDir(ep.n) });
        if (isWorkflowUnavailable(r)) return { status: "unavailable", reason: r.unavailable };
        const u = unjudged(r, "cut_joins.py");
        return { status: "done", detail: { complete: r.complete.length, incomplete: u.incomplete, errors: u.errors, cost_cents: r.cost_cents, reader_version: r.reader_version, model: r.model }, lost: r.lost.map((l) => ({ id: l.id, why: l.why })), incomplete: u.incomplete };
      } catch (e) {
        return { status: "failed", error: (e as Error).message };
      }
    },
  };
}
