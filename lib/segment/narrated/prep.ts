// The prep and its review (narrated spec N1, E1–E2; amendments 1 and 3).
//
// E1 prep — a writing session per episode (Opus, the committed prep brief
// filled for this episode: lib/segment/narrated/briefs.ts), one at a time on
// the machine. When it returns Studio checks what it touched and runs the
// draft checks:
//
//   - writes outside the episode's files (edl/epN.json, epN/, anchors.json,
//     glossary.json, index/ fixes with their `.pre-epN.` backups, `.lock`)
//     are flagged on the review, not undone;
//   - W ids stay positional: `uid = W{k+1}` (ST/make_ep.py:192), so a
//     whisper row deleted or inserted misaligns every later en.json. The row
//     count must not change and every row outside this episode's window must
//     be byte-equal — a violation is a refusal;
//   - pictures still match their cues: stale_check.py for every episode
//     whose picture lane is done — this one too, when a send-back re-prepped
//     it after its picture finished; one that now reads stale is marked
//     `stale` (the ep8 defect: a cue added after the clean);
//   - the waivers the session wrote into epN/waivers.json itself (the brief
//     tells it to) are taken back: they become `proposed_waivers` on the row
//     and the file is put back as it was before the prep, so no check is
//     switched off before a person accepts it;
//   - the draft checks (./gate.ts); make_ep's refusal sends the episode back
//     to the prep with the verbatim text (the session is resumed with it,
//     twice at most, then a person decides), the rest are shown on the review.
//
// E2 prep review ✋ — the "must read" gate (drama-remix SKILL.md: read the
// transcript end to end before anything renders). The approval records the
// person's answers to PREP.md's "For you to decide" list and their decision
// on each proposed waiver: the accepted ones are written into
// epN/waivers.json through the project writer, a refused one is removed
// whoever wrote it. It is what starts the picture lane and allows paid
// voice: before it, neither starts (`requirePrepApproved`).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FilmRunEpisode, Json } from "@/lib/types";
import { readJson } from "../stages";
import { prepBriefFor } from "./briefs";
import { runDraftChecks, staleCheck, type CheckResult } from "./gate";
import {
  dataOf,
  epDir,
  NARRATED_DECISION,
  pendingEpisodeDecision,
  removeProjectFile,
  runWritingSession,
  sessionRecordOf,
  snapshotMtimes,
  withFilmLock,
  writeProjectFile,
  writesOutside,
  type EpisodeStepOutcome,
  type NarratedContext,
  type NeighbourPatch,
  type SessionRecord,
} from "./stages";

/** How many times a draft-check refusal resumes the session on its own before a person decides. */
export const PREP_AUTO_RETRIES = 2;

/** What a prep session may write for episode N (N4). */
export function prepWrites(n: number): RegExp[] {
  const ep = `ep${n}`;
  return [
    new RegExp(`^edl/${ep}\\.json$`),
    new RegExp(`^${ep}/`),
    new RegExp(`^(anchors|glossary)(\\.pre-${ep}[^/]*)?\\.json$`),
    /^index\/[^/]+$/,
    /^\.lock\//,
  ];
}

// ---- the W-id rule ------------------------------------------------------------------------------------------------

type WhisperShape = { segments?: { start?: number; end?: number }[] };

/** One hash per whisper row, with its time: what the W-id rule compares. */
export function whisperRows(film: string): { start: number; end: number; hash: string }[] | null {
  const w = readJson<WhisperShape>(path.join(film, "index", "whisper.json"));
  if (!w || !Array.isArray(w.segments)) return null;
  return w.segments.map((s) => ({ start: Number(s.start ?? 0), end: Number(s.end ?? 0), hash: createHash("sha1").update(JSON.stringify(s)).digest("hex") }));
}

/**
 * The W-id rule after a prep of the window [src_in, src_out): null when it
 * holds, else the refusal. Rows inside the window may be re-timed or
 * neutralised (the brief's cue fixes); none may be added or removed, and no
 * row outside the window may change.
 */
export function wIdViolation(before: { start: number; end: number; hash: string }[] | null, after: { start: number; end: number; hash: string }[] | null, win: { src_in: number; src_out: number; n: number }): string | null {
  if (!before || !after) return null;
  if (before.length !== after.length) {
    return `index/whisper.json had ${before.length} rows and now has ${after.length}: W ids are positional (uid = W{k+1}), so a row deleted or inserted by ep${win.n}'s prep misaligns every later en.json. Neutralise a row (empty its text) instead of removing it, restore index/whisper.pre-ep${win.n}.json, and Retry.`;
  }
  const changed: number[] = [];
  for (let k = 0; k < before.length; k++) {
    const b = before[k];
    const inside = b.end > win.src_in - 1 && b.start < win.src_out + 1;
    if (!inside && b.hash !== after[k].hash) changed.push(k + 1);
  }
  if (changed.length) {
    return `ep${win.n}'s prep changed whisper rows outside its window (${win.src_in}–${win.src_out} s): W${changed.slice(0, 12).join(", W")}${changed.length > 12 ? ", …" : ""}. Those rows belong to other episodes' captions; restore them from index/whisper.pre-ep${win.n}.json and Retry.`;
  }
  return null;
}

// ---- E1 ---------------------------------------------------------------------------------------------------------------

type PrepDetail = {
  prep_session?: SessionRecord;
  prep_refusals?: number;
  send_back?: { note: string; by: string; at: string } | null;
};

/**
 * What the project looked like when the prep session started (the whisper
 * rows, the mtimes, the episode's waivers.json text — null when there was
 * none), kept in the run's work folder, not on the row: a session can run
 * for hours across a worker restart.
 */
type PrepBefore = { whisper: { start: number; end: number; hash: string }[] | null; mtimes: Record<string, { mtime_ms: number; size: number }>; waivers?: string | null };

function beforeFile(ctx: NarratedContext, n: number): string {
  return path.join(ctx.paths.sessions, `prep-ep${n}.before.json`);
}

const waiversRel = (n: number): string => `${epDir(n)}/waivers.json`;

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The snapshot taken when this episode's prep began, taking it now if there is none. */
export function prepBefore(ctx: NarratedContext, n: number): PrepBefore {
  const file = beforeFile(ctx, n);
  const have = readJson<PrepBefore>(file);
  if (have && have.mtimes) return have;
  const snap: PrepBefore = { whisper: whisperRows(ctx.paths.film), mtimes: snapshotMtimes(ctx.paths.film), waivers: readText(path.join(ctx.paths.film, ...waiversRel(n).split("/"))) };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(snap), "utf8");
  return snap;
}

/** Forget the snapshot once the prep's result was checked (the next prep of the episode takes a new one). */
export function clearPrepBefore(ctx: NarratedContext, n: number): void {
  rmSync(beforeFile(ctx, n), { force: true });
}

const detailOf = (ep: FilmRunEpisode): PrepDetail & Record<string, Json | undefined> => ep.stage_detail as PrepDetail & Record<string, Json | undefined>;

// ---- the waivers a prep proposes ----------------------------------------------------------------------------------------

/** A waiver the prep session proposed (it wrote it into waivers.json; Studio took it back for the review). */
export type ProposedWaiverEntry = { key: string; reason: string; by: string; at: string };

/** `{check_id: reason}` from a waivers.json text; {} for none or a file that does not parse. Pure. */
export function waiverMap(text: string | null | undefined): Record<string, string> {
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

/** The proposals on an episode row (`stage_detail.proposed_waivers`). Pure. */
export function proposedWaiversOf(detail: Record<string, Json | undefined>): ProposedWaiverEntry[] {
  const list = Array.isArray(detail.proposed_waivers) ? detail.proposed_waivers : [];
  return list.filter((w): w is Record<string, Json> => !!w && typeof w === "object" && !Array.isArray(w) && typeof w.key === "string" && typeof w.reason === "string").map((w) => ({ key: String(w.key), reason: String(w.reason), by: String(w.by ?? "prep session"), at: String(w.at ?? "") }));
}

/**
 * The waivers a prep session wrote itself, taken back: every key it added
 * (or re-reasoned) in epN/waivers.json since `before` becomes a proposal,
 * and the file is put back as it was before the prep, through the project
 * writer. A waiver switches a check off, so it is the person's to accept at
 * the prep review (amendment 3; spec N5.4: each proposed waiver is accepted
 * or refused) — the PREP-BRIEF tells the agent to write its own. `before`
 * undefined (a snapshot from before this rule) takes nothing back.
 */
export function takeBackAgentWaivers(ctx: NarratedContext, n: number, before: string | null | undefined): { key: string; reason: string }[] {
  if (before === undefined) return [];
  const rel = waiversRel(n);
  const now = readText(path.join(ctx.paths.film, ...rel.split("/")));
  if (now === before) return [];
  const was = waiverMap(before);
  const proposed = Object.entries(waiverMap(now))
    .filter(([k, v]) => was[k] !== v)
    .map(([key, reason]) => ({ key, reason }));
  const why = { by: "studio", why: `ep${n}'s prep wrote waivers.json itself${proposed.length ? ` (${proposed.map((w) => w.key).join(", ")})` : ""}: a waiver waits for the prep review, where each is accepted or refused; the file is back as it was before the prep` };
  if (before === null) removeProjectFile(ctx, rel, why);
  else writeProjectFile(ctx, rel, before, why);
  return proposed;
}

/**
 * E1 for one episode: run (or resume, or hand off) the prep session, then
 * check what it did and run the draft checks. Moves the words lane to
 * `prep_review`, or waits (a session limit / busy slot / hand-off), or sends
 * the episode back with a refusal.
 */
export async function runPrepStep(ctx: NarratedContext, ep: FilmRunEpisode, all: FilmRunEpisode[]): Promise<EpisodeStepOutcome> {
  const d = detailOf(ep);
  const previous = sessionRecordOf(d.prep_session as Json | undefined);
  const handoff = ctx.settings.creative === "handoff" || !!pendingEpisodeDecision(ctx.run, ep, NARRATED_DECISION.run_yourself) || previous?.message === "run it yourself";
  const handoffDone = !!pendingEpisodeDecision(ctx.run, ep, NARRATED_DECISION.handoff_done);
  const retried = !!pendingEpisodeDecision(ctx.run, ep, NARRATED_DECISION.retry);
  const consumed = { decisions_seen: ctx.run.decisions.length };

  // The session: fresh, resumed (limit, interruption, a send-back note, a refusal to fix), or the person's own run.
  let record: SessionRecord;
  if (previous?.status === "done" && !d.send_back && !retried && !(d.prep_refusals && ep.error_text)) {
    record = previous;
  } else if (handoff && handoffDone && previous) {
    record = { ...previous, status: "done", ended_at: new Date().toISOString() };
  } else {
    let brief;
    try {
      brief = prepBriefFor(ctx, ep, all);
    } catch (e) {
      return { kind: "refused", error: (e as Error).message, patch: { stage_detail: { ...d, ...consumed } } };
    }
    prepBefore(ctx, ep.n);
    const note = d.send_back?.note ? `Ruobin sent ep${ep.n}'s prep back with this note: ${d.send_back.note}\nFix what it asks at the source, re-run the checks the brief names, and update PREP.md.` : ep.error_text ? `Studio's check refused ep${ep.n} after your prep:\n${ep.error_text}\nFix it at the source (never by weakening a check), re-run the checks, and update PREP.md.` : null;
    const r = await runWritingSession(
      ctx,
      { label: `prep-ep${ep.n}`, holder: `${ctx.run.id}/ep${ep.n}`, what: `prep of ep${ep.n} (${ctx.run.bucket}/${ctx.run.slug})`, brief, previous, continuation: note },
      { handoff, progress: (record, progress) => ctx.progress({ writing_session: { ep: ep.n, session: record as unknown as Json, progress } as unknown as Json }) }
    );
    if (r.kind === "wait") {
      return { kind: "wait", for: r.for === "handoff" ? "handoff" : "session", detail: r.detail, retryMs: r.retryMs, patch: { stage_detail: { ...d, ...r.detail, prep_session: r.record as unknown as Json, ...consumed } } };
    }
    if (r.kind === "failed") return { kind: "refused", error: r.error, patch: { stage_detail: { ...d, prep_session: r.record as unknown as Json, ...consumed } } };
    record = r.record;
  }

  // What the session touched.
  const before = prepBefore(ctx, ep.n);
  const outside = writesOutside(before.mtimes, snapshotMtimes(ctx.paths.film), prepWrites(ep.n));
  // The waivers it wrote itself are proposals, not in force: taken back before any check reads the file.
  const at = new Date().toISOString();
  const proposals = new Map(proposedWaiversOf(d).map((w) => [w.key, w]));
  for (const w of takeBackAgentWaivers(ctx, ep.n, before.waivers)) proposals.set(w.key, { ...w, by: "prep session", at });
  const wid = await withFilmLock(ctx, async () => wIdViolation(before.whisper, whisperRows(ctx.paths.film), ep));
  const base = { ...d, prep_session: record as unknown as Json, send_back: null, writes_outside: outside, proposed_waivers: [...proposals.values()] as unknown as Json, ...consumed } as Record<string, Json | undefined>;
  if (wid) return { kind: "refused", error: wid, patch: { stage_detail: base } };

  // Pictures still match their cues (the shared-index rule), for every other episode whose picture is done.
  const pictureDone = (o: FilmRunEpisode) => o.stage !== "dropped" && o.stage !== "shipped" && (o.picture_stage === "ready" || o.picture_stage === "reframe_glance");
  const others: NeighbourPatch[] = [];
  for (const o of all) {
    if (o.id === ep.id || !pictureDone(o)) continue;
    const s = await staleCheck(ctx, o.n);
    if (s.stale) others.push({ n: o.n, patch: { picture_stage: "stale", stage: "lanes", stage_detail: { ...(o.stage_detail as Record<string, Json | undefined>), stale: { found_after: `ep${ep.n}'s prep`, lines: s.lines } as unknown as Json } }, why: `stale_check says ep${o.n}'s cleaned picture is older than its cues after ep${ep.n}'s prep` });
  }

  // The draft checks.
  const checks = await runDraftChecks(ctx, ep);
  const refusals = (typeof d.prep_refusals === "number" ? d.prep_refusals : 0) + (checks.refused ? 1 : 0);
  clearPrepBefore(ctx, ep.n);
  const detail: Record<string, Json | undefined> = { ...base, draft_checks: checks.results as unknown as Json, prep_refusals: refusals, prep_md: existsSync(path.join(ctx.paths.film, epDir(ep.n), "PREP.md")) ? `${epDir(ep.n)}/PREP.md` : null };
  if (checks.refused) {
    // Back to the prep with the verbatim text; the next step resumes the session with it — twice at most on its own.
    return { kind: "refused", error: checks.refused, patch: { words_stage: "prep", stage_detail: { ...detail, prep_session: { ...record, status: refusals <= PREP_AUTO_RETRIES ? "interrupted" : "done" } as unknown as Json } }, others };
  }
  // The episode's own picture, when a send-back re-prepped an episode whose picture lane had finished: the prep (brief
  // step 2) or make_ep may have re-cut base.mp4, and build_ep.sh would then stop on PICTURE IS STALE for good. Marked
  // stale, the prep review's approval re-arms the lane.
  let own: { picture_stage?: "stale" } = {};
  if (pictureDone(ep)) {
    const s = await staleCheck(ctx, ep.n);
    if (s.stale) {
      own = { picture_stage: "stale" };
      detail.stale = { found_after: `ep${ep.n}'s own prep`, lines: s.lines } as unknown as Json;
    }
  }
  return { kind: "moved", patch: { words_stage: "prep_review", ...own, error_text: null, stage_detail: { ...detail, prep_refusals: 0 } }, note: `ep${ep.n} prepared; waiting for the prep review${own.picture_stage ? " (its picture is stale after the re-prep)" : ""}`, others };
}

/** True when a refused prep should resume on its own (not yet PREP_AUTO_RETRIES refusals in a row). */
export function prepAutoRetry(ep: FilmRunEpisode): boolean {
  const n = (ep.stage_detail as { prep_refusals?: unknown }).prep_refusals;
  return typeof n === "number" && n > 0 && n <= PREP_AUTO_RETRIES;
}

// ---- E2 ---------------------------------------------------------------------------------------------------------------

export type ProposedWaiver = { key: string; reason: string; accept: boolean };

const WAIVER_KEY = /^[A-Za-z0-9_.:-]{1,80}$/;

const waiverItems = (data: Record<string, Json | undefined>): Record<string, Json>[] => (Array.isArray(data.waivers) ? data.waivers : []).filter((w): w is Record<string, Json> => !!w && typeof w === "object" && !Array.isArray(w) && typeof w.key === "string" && WAIVER_KEY.test(w.key));

/**
 * The waivers a prep decision accepts, from its `data.waivers` ([{key,
 * reason, accept}]); an accepted proposal with no reason of the person's
 * keeps the reason the prep gave. Pure.
 */
export function acceptedWaivers(data: Record<string, Json | undefined>, proposals: { key: string; reason: string }[] = []): { key: string; reason: string }[] {
  return waiverItems(data)
    .filter((w) => w.accept === true)
    .map((w) => ({ key: String(w.key), reason: (typeof w.reason === "string" && w.reason.trim() ? w.reason : proposals.find((p) => p.key === w.key)?.reason ?? "").trim() }))
    .filter((w) => w.reason.length > 0);
}

/** The waiver keys a prep decision refuses (`accept: false`). Pure. */
export function refusedWaivers(data: Record<string, Json | undefined>): string[] {
  return waiverItems(data)
    .filter((w) => w.accept === false)
    .map((w) => String(w.key));
}

/**
 * The prep review's waiver decisions on `epN/waivers.json`, through the
 * project writer: the accepted keys added (a key already there keeps its
 * reason), the refused keys removed — whoever wrote them. Returns what
 * changed.
 */
export function applyWaiverDecisions(ctx: NarratedContext, n: number, accepted: { key: string; reason: string }[], refused: string[], by: { by: string; at: string }): { written: string[]; removed: string[] } {
  const rel = waiversRel(n);
  const file = path.join(ctx.paths.film, ...rel.split("/"));
  const have = waiverMap(readText(file));
  const next = { ...have };
  const written: string[] = [];
  const removed: string[] = [];
  for (const w of accepted) {
    if (refused.includes(w.key) || w.key in next) continue;
    next[w.key] = w.reason;
    written.push(w.key);
  }
  for (const k of refused) {
    if (!(k in next)) continue;
    delete next[k];
    removed.push(k);
  }
  if (!written.length && !removed.length) return { written, removed };
  const why = [written.length ? `accepted ${written.join(", ")}` : "", removed.length ? `refused ${removed.join(", ")}` : ""].filter(Boolean).join("; ");
  writeProjectFile(ctx, rel, `${JSON.stringify(next, null, 1)}\n`, { by: by.by, why: `waivers decided at ep${n}'s prep review: ${why}`, decision_at: by.at });
  return { written, removed };
}

/** Merge accepted waivers into `epN/waivers.json` ({check_id: reason}) through the project writer; keys already there keep their reason. */
export function writeWaivers(ctx: NarratedContext, n: number, waivers: { key: string; reason: string }[], by: { by: string; at: string }): string[] {
  if (!waivers.length) return [];
  const rel = `${epDir(n)}/waivers.json`;
  const file = path.join(ctx.paths.film, rel);
  let have: Record<string, string> = {};
  if (existsSync(file)) {
    try {
      have = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    } catch {
      have = {};
    }
  }
  const added = waivers.filter((w) => !(w.key in have));
  if (!added.length) return [];
  const next = { ...have };
  for (const w of added) next[w.key] = w.reason;
  writeProjectFile(ctx, rel, `${JSON.stringify(next, null, 1)}\n`, { by: by.by, why: `waivers accepted at ep${n}'s prep review: ${added.map((w) => w.key).join(", ")}`, decision_at: by.at });
  return added.map((w) => w.key);
}

/**
 * E2: wait for the person's prep decision. Approve (with the transcript
 * read) records the answers and the accepted waivers and starts the picture
 * lane and the voice; send back returns the words lane to the prep with the
 * note, and the session resumes with it.
 */
export async function runPrepReviewStep(ctx: NarratedContext, ep: FilmRunEpisode): Promise<EpisodeStepOutcome> {
  const d = ep.stage_detail as Record<string, Json | undefined>;
  const decision = pendingEpisodeDecision(ctx.run, ep, NARRATED_DECISION.prep);
  if (!decision) return { kind: "wait", for: "prep" };
  const data = dataOf(decision);
  const consumed = { decisions_seen: ctx.run.decisions.length };
  if (data.action === "send_back") {
    return { kind: "moved", patch: { words_stage: "prep", stage_detail: { ...d, send_back: { note: decision.why ?? "", by: decision.by, at: decision.at }, ...consumed } } };
  }
  if (data.action !== "approve") return { kind: "wait", for: "prep", patch: { stage_detail: { ...d, ...consumed, note: `unknown prep action ${String(data.action)}` } } };
  if (data.transcript_read !== true) {
    return { kind: "wait", for: "prep", patch: { stage_detail: { ...d, ...consumed, note: "the approval needs the transcript read end to end first (transcript_read)" } } };
  }
  // Only what the person accepted is in force: the prep's own waivers were taken back when it returned, and a refused key
  // is removed whoever wrote it.
  const proposals = proposedWaiversOf(d);
  const waivers = acceptedWaivers(data, proposals);
  const refused = refusedWaivers(data);
  const applied = applyWaiverDecisions(ctx, ep.n, waivers, refused, { by: decision.by, at: decision.at });
  const undecided = proposals.filter((p) => !waivers.some((w) => w.key === p.key) && !refused.includes(p.key)).map((p) => p.key);
  const approval = { by: decision.by, at: decision.at, answers: (data.answers ?? []) as Json, waivers: waivers as unknown as Json, refused, proposed: proposals as unknown as Json, not_decided: undecided, waivers_written: applied.written, waivers_removed: applied.removed };
  return {
    kind: "moved",
    patch: {
      words_stage: "voice",
      picture_stage: ep.picture_stage === "waiting" || ep.picture_stage === "stale" ? "picture" : ep.picture_stage,
      error_text: null,
      stage_detail: { ...d, prep_approved: approval as unknown as Json, proposed_waivers: [], ...consumed },
    },
    note: `ep${ep.n}: prep approved by ${decision.by}; voice and the picture lane may start`,
  };
}

export type { CheckResult };
