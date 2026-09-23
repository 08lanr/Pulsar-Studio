// The script read and the episode plan (narrated spec N1 stages 3–5; the
// first two of the four approvals, amendment 3).
//
//   script_raw  `python scripts/build_script.py` → index/script_raw.md
//               (speech timing, burned-caption OCR, the vision log).
//   script ✋   A writing session (Opus, the drama-remix skill) reads
//               script_raw.md end to end and writes SCRIPT-<src>.md,
//               glossary.json and frame_premise.txt, and proposes the episode
//               windows into the run's work folder. Studio checks the files
//               (they exist; glossary.json is {canon, banned}; the premise
//               names the narrator when the run names one) and waits for
//               `{kind: "script", action: approve | send_back, note}`. A
//               send-back resumes the same session with the note.
//   episodes ✋ The proposed windows, checked (contiguous numbering from the
//               season's first number, in order, inside the source; a window
//               outside the 2:45–4:20 body band is shown, not refused — the
//               body is cut shorter than its window), and approved or edited
//               (an edit resumes the session with the note: Studio never
//               invents windows; a session that could not finish — a busy
//               slot, a limit, an interruption — runs again before the plan
//               is re-read, its note kept on its record). Approval writes the
//               film_run_episodes rows.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { NewRunEpisode } from "@/lib/data";
import { isDataError } from "@/lib/data/errors";
import type { Json } from "@/lib/types";
import { fail, next, type StageDetail, type StageOutcome } from "../stages";
import { EPISODE_PLAN_FILE, scriptBriefFor, scriptDocName } from "./briefs";
import {
  dataOf,
  NARRATED_DECISION,
  narratedRefusal,
  narratedWait,
  pendingRunDecisions,
  runFilmStep,
  runWritingSession,
  sessionRecordOf,
  snapshotMtimes,
  sourceDurationOf,
  writesOutside,
  type NarratedContext,
  type SessionRecord,
} from "./stages";

// ---- script_raw ---------------------------------------------------------------------------------------------------

export async function runScriptRawStage(ctx: NarratedContext): Promise<StageOutcome> {
  const out = path.join(ctx.paths.index, "script_raw.md");
  const r = await runFilmStep(ctx, { script: "build_script.py", args: [], what: "build_script.py" });
  if (r.code !== 0) return fail(narratedRefusal({ script: "build_script.py" }, r));
  if (!existsSync(out)) return fail("build_script.py exited 0 but index/script_raw.md is not there");
  return next("script", { script_raw: { file: "index/script_raw.md", bytes: readFileSync(out).length } });
}

// ---- the script read's outputs ----------------------------------------------------------------------------------

/** What the script session must leave, checked the pipeline's way; the problems in words (empty = fine). */
export function scriptOutputProblems(film: string, docName: string, narrator: string | null): string[] {
  const problems: string[] = [];
  const doc = path.join(film, docName);
  if (!existsSync(doc) || readFileSync(doc, "utf8").trim().length < 200) problems.push(`${docName} is missing or nearly empty`);
  const gl = path.join(film, "glossary.json");
  if (!existsSync(gl)) problems.push("glossary.json is missing");
  else {
    try {
      const g = JSON.parse(readFileSync(gl, "utf8")) as { canon?: unknown; banned?: unknown };
      if (!Array.isArray(g.canon) || !g.canon.every((x) => typeof x === "string")) problems.push("glossary.json has no canon list of names");
      if (!g.banned || typeof g.banned !== "object" || Array.isArray(g.banned) || !Object.values(g.banned).every((x) => typeof x === "string")) problems.push("glossary.json has no banned {wrong: right} map");
    } catch (e) {
      problems.push(`glossary.json does not parse: ${(e as Error).message}`);
    }
  }
  const fp = path.join(film, "frame_premise.txt");
  if (!existsSync(fp) || !readFileSync(fp, "utf8").trim()) problems.push("frame_premise.txt is missing or empty");
  else if (narrator && !readFileSync(fp, "utf8").toLowerCase().includes(narrator.toLowerCase())) problems.push(`frame_premise.txt does not name the narrator (${narrator})`);
  return problems;
}

/** What the script session may write in the project (N4): the script, beats, glossary, premise. */
export const SCRIPT_WRITES = [/^SCRIPT-[^/]+\.md$/, /^BEATS-[^/]+\.md$/, /^glossary(\.pre-[^/]+)?\.json$/, /^frame_premise\.txt$/, /^\.lock\//] as const;

// ---- the episode plan ---------------------------------------------------------------------------------------------

export type ProposedEpisode = { n: number; src_in: number; src_out: number; title: string | null; subtitle: string | null; hook: string | null; story: string | null };

/** The session's proposal (`{episodes: [...]}`), parsed, or why it cannot be read. */
export function readEpisodePlan(file: string): ProposedEpisode[] | string {
  if (!existsSync(file)) return `${path.basename(file)} is not there: the script session did not propose the episode windows`;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return `${path.basename(file)} does not parse: ${(e as Error).message}`;
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? (raw as { episodes?: unknown }).episodes : null;
  if (!Array.isArray(list) || !list.length) return `${path.basename(file)} holds no episodes`;
  const out: ProposedEpisode[] = [];
  for (const [i, e] of list.entries()) {
    if (!e || typeof e !== "object") return `episode ${i + 1} is not an object`;
    const x = e as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    out.push({ n: Number(x.n), src_in: Number(x.src_in), src_out: Number(x.src_out), title: str(x.title), subtitle: str(x.subtitle), hook: str(x.hook), story: str(x.story) });
  }
  return out;
}

export type PlanCheck = { problems: string[]; warnings: string[] };

/**
 * The spec's checks on a proposed plan (N1 stage 5). Problems block an
 * approval: numbering not contiguous from `firstN`, a window backwards, out
 * of order or overlapping, past the source's end. Warnings are shown: a
 * window shorter or longer than the body band (`target` seconds; the body is
 * cut from its window, so a longer window is normal and the person judges).
 */
export function checkEpisodePlan(eps: ProposedEpisode[], opts: { firstN: number; durationS: number | null; target: [number, number] }): PlanCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  eps.forEach((e, i) => {
    const want = opts.firstN + i;
    if (!Number.isInteger(e.n) || e.n !== want) problems.push(`episode ${i + 1} is numbered ${e.n}; the season continues at ${want}`);
    if (!Number.isFinite(e.src_in) || !Number.isFinite(e.src_out) || e.src_in < 0 || e.src_out <= e.src_in) problems.push(`ep${e.n}: the window ${e.src_in}–${e.src_out} s is not a forward span of the source`);
    const prev = i > 0 ? eps[i - 1] : null;
    if (prev && e.src_in < prev.src_out - 0.001) problems.push(`ep${e.n} starts at ${e.src_in} s, inside ep${prev.n} (ends ${prev.src_out} s)`);
    if (opts.durationS !== null && e.src_out > opts.durationS + 0.5) problems.push(`ep${e.n} ends at ${e.src_out} s, past the source's ${Math.round(opts.durationS)} s`);
    const len = e.src_out - e.src_in;
    if (Number.isFinite(len) && len < opts.target[0]) warnings.push(`ep${e.n}'s window is ${Math.round(len)} s, under the ${opts.target[0]} s body band: the episode will be short`);
    if (Number.isFinite(len) && len > opts.target[1] * 1.6) warnings.push(`ep${e.n}'s window is ${Math.round(len)} s: its body has to lose more than a third to reach ${opts.target[1]} s`);
    if (!e.story) warnings.push(`ep${e.n} has no story paragraph: its prep brief will ask the agent to read it from the SCRIPT`);
  });
  return { problems, warnings };
}

// ---- the stages -----------------------------------------------------------------------------------------------------

function sessionDetail(record: SessionRecord): StageDetail {
  return { session: record as unknown as Json };
}

/** The writing session of the script read (a fresh one, a resume, or the hand-off); `note` = a send-back or an edit. */
async function scriptSession(ctx: NarratedContext, note: string | null): Promise<{ done: true; record: SessionRecord } | { done: false; outcome: StageOutcome }> {
  const previous = sessionRecordOf((ctx.run.stage_detail as Record<string, Json | undefined>).session);
  const handoff = ctx.settings.creative === "handoff" || pendingRunDecisions(ctx.run, NARRATED_DECISION.run_yourself).length > 0 || previous?.message === "run it yourself";
  const handoffDone = pendingRunDecisions(ctx.run, NARRATED_DECISION.handoff_done).length > 0;
  if (handoff && handoffDone && previous) return { done: true, record: { ...previous, status: "done", ended_at: new Date().toISOString() } };
  const brief = scriptBriefFor(ctx, { note: previous ? null : note });
  const before = snapshotMtimes(ctx.paths.film);
  const r = await runWritingSession(
    ctx,
    { label: "script", holder: `${ctx.run.id}/script`, what: `script read of ${ctx.run.bucket}/${ctx.run.slug}`, brief, previous: previous?.brief_path ? { ...previous, brief_sha: previous.brief_sha } : null, continuation: note ? `Ruobin sent the script read back with this note: ${note}\nChange what the note asks for, keep the rest, and update ${EPISODE_PLAN_FILE} if the note touches the episode windows.` : null, extraDirs: [ctx.paths.handoff] },
    { handoff, progress: (record, progress) => ctx.progress({ session: record as unknown as Json, session_progress: progress }) }
  );
  if (r.kind === "wait") return { done: false, outcome: narratedWait(r.for, { ...sessionDetail(r.record), ...r.detail }, r.retryMs) };
  if (r.kind === "failed") return { done: false, outcome: narratedWait("session", { ...sessionDetail(r.record), session_problem: r.error }) };
  const outside = writesOutside(before, snapshotMtimes(ctx.paths.film), SCRIPT_WRITES);
  if (outside.length) ctx.log(`the script session wrote outside its files: ${outside.join(", ")}`);
  return { done: true, record: { ...r.record, ...(outside.length ? { message: `wrote outside its files: ${outside.slice(0, 20).join(", ")}` } : {}) } };
}

export async function runScriptStage(ctx: NarratedContext): Promise<StageOutcome> {
  const docName = scriptDocName(ctx);
  const decision = pendingRunDecisions(ctx.run, NARRATED_DECISION.script).pop() ?? null;
  const action = decision ? String(dataOf(decision).action ?? "") : "";
  const record = sessionRecordOf((ctx.run.stage_detail as Record<string, Json | undefined>).session);
  const problems = scriptOutputProblems(ctx.paths.film, docName, ctx.settings.narrator);

  if (decision && action === "approve" && record?.status === "done") {
    if (problems.length) return narratedWait("script", { script_check: { problems, note: "an approval is not taken while the files do not hold" } as unknown as Json });
    return next("episodes", { script: { approved_by: decision.by, approved_at: decision.at, doc: docName }, decisions_seen: ctx.run.decisions.length });
  }
  const note = decision && action === "send_back" ? decision.why ?? "" : null;
  if (record?.status === "done" && !note) {
    // Waiting for the approval: re-show the check (a person may have fixed a file by hand).
    return narratedWait("script", { script_check: { problems, doc: docName, glossary: "glossary.json", premise: "frame_premise.txt" } as unknown as Json });
  }
  const s = await scriptSession(ctx, note);
  if (!s.done) return s.outcome;
  const after = scriptOutputProblems(ctx.paths.film, docName, ctx.settings.narrator);
  return narratedWait("script", { ...sessionDetail(s.record), script_check: { problems: after, doc: docName } as unknown as Json }, undefined);
}

export async function runEpisodesStage(ctx: NarratedContext): Promise<StageOutcome> {
  const file = path.join(ctx.paths.handoff, EPISODE_PLAN_FILE);
  const firstN = ctx.settings.season.first_episode_n;
  const seriesKey = ctx.settings.season.series_key;
  if (firstN === null || !seriesKey) return fail("the season has no series_key or first_episode_n: the intake should have waited for them");
  const pending = pendingRunDecisions(ctx.run, NARRATED_DECISION.episodes);
  const decision = pending[pending.length - 1] ?? null;
  const action = decision ? String(dataOf(decision).action ?? "") : "";
  // Every edit since the stage last looked (an approval after them approved a plan nobody has seen yet).
  const edits = pending.filter((x) => dataOf(x).action === "edit").map((x) => (x.why ?? "").trim() || "(no note)");

  // Studio does not invent windows: an edit resumes the session with the person's note. A session that has not finished
  // (the machine's slot was busy, a limit or an interruption stopped it, it failed, Claude Code was missing, or the person
  // runs it themselves) runs again first: the decision that asked for it is already consumed, and its record carries the
  // note, so the edit is made rather than the old plan re-read and approvable.
  const record = sessionRecordOf((ctx.run.stage_detail as Record<string, Json | undefined>).session);
  let session: StageDetail = {};
  if (edits.length || (record && record.status !== "done")) {
    const s = await scriptSession(ctx, edits.length ? `The episode windows need changing: ${edits.join("\n")}` : null);
    if (!s.done) return s.outcome;
    session = sessionDetail(s.record);
  }
  const plan = readEpisodePlan(file);
  if (typeof plan === "string") return narratedWait("episodes", { ...session, plan: { file, problems: [plan], warnings: [] } as unknown as Json });
  const check = checkEpisodePlan(plan, { firstN, durationS: sourceDurationOf(ctx.run), target: ctx.settings.episode_target });
  const planDetail = { file, episodes: plan, ...check } as unknown as Json;
  if (!(decision && action === "approve")) return narratedWait("episodes", { ...session, plan: planDetail });
  // An approval given while an unfinished session was still to run approved the plan the person saw, not this one.
  if (session.session) return narratedWait("episodes", { ...session, plan: planDetail, note: "the session changed the plan after this approval was given: approve the plan as it is now" });
  if (check.problems.length) return narratedWait("episodes", { ...session, plan: planDetail, note: "an approval is not taken while the plan has problems" });

  const rows: NewRunEpisode[] = plan.map((e) => ({ n: e.n, src_in: e.src_in, src_out: e.src_out, title: e.title ?? `EPISODE ${e.n}`, subtitle: e.subtitle, stage_detail: { story: e.story, hook: e.hook, planned_by: "script session", approved_by: decision.by, approved_at: decision.at } }));
  try {
    const existing = await ctx.data.listRunEpisodes(ctx.session, ctx.run.id);
    if (!existing.length) await ctx.data.createRunEpisodes(ctx.session, ctx.run.id, { series_key: seriesKey, episodes: rows, source_duration_s: sourceDurationOf(ctx.run) });
  } catch (e) {
    if (isDataError(e)) return narratedWait("episodes", { plan: planDetail, note: e.message });
    throw e;
  }
  return next("episode_work", { plan: { file, approved_by: decision.by, approved_at: decision.at, episodes: plan.length, first: firstN, last: firstN + plan.length - 1 } as unknown as Json, decisions_seen: ctx.run.decisions.length });
}
