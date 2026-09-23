// The minute-sheet read through the API (narrated spec N1 stage 2, N0.2):
// the vision log `build_script.py` merges into `index/script_raw.md`, by the
// synced `sheet_read.workflow.js` run through the Workflow shim.
//
//   - The groups are the workflow's args exactly: {premise, groups:
//     [{project, sheets: [{minute, path}]}]}, three minute-sheets per call
//     (`index/sheets/min-<k>.png`, 60 one-second tiles each, written by
//     index_chain.sh), the premise the project's `sheet_premise.txt`.
//   - A minute sheet is 3.2-5 MB of PNG; one over the API's image size goes
//     as a JPEG copy in the run's work folder. The prompt says to ignore the
//     subtitle line, so no caption crop is sent here.
//   - Every group's answer is checked before it is accepted (inside its
//     minutes, in order, no gaps or overlaps, as the prompt asks); a failing
//     answer gets the gateway's one repair turn.
//   - The grouped return (sheet_read.workflow.js:51-54) is flattened into ONE
//     file, `index/sheet_read_<first>_<last>.json` (`sheet_read_0_<last>` for
//     a whole source), the bare entry list the hand-run readers wrote, sorted
//     by start — because build_script.py globs `index/sheet_read_*.json` and
//     concatenates them, a second file over the same minutes would double
//     every stretch, so the pass refuses to write beside another one. A
//     group whose call failed writes nothing: a gap in the log is a gap in
//     the script; Retry re-runs only the failed calls (the done rows are
//     reused).

import { existsSync, promises as fsp, readdirSync } from "node:fs";
import path from "node:path";
import { PICTURE_JOB_KINDS, apiImageOf, apiReaderVersion, callDigest, isWorkflowUnavailable, runWorkflow, type ShimCallRecord, type ShimImage, type WorkflowCall, type WorkflowUnavailable } from "@/lib/segment/workflow-shim";
import { visionUnavailableReason } from "@/lib/segment/vision";
import type { LlmProvider } from "@/lib/llm";
import type { Json } from "@/lib/types";
import { PicturePassError, readPremise, type PassDeps } from "./frames";

/** Minute sheets per call (narrated spec N1 stage 2). */
export const SHEETS_PER_CALL = 3;

/** The answer room of one call: three minutes of 2-10 s stretches (the hand-run log averaged ten per minute). */
export const SHEET_MAX_TOKENS = 16_000;

export type MinuteSheet = { minute: number; path: string };
export type SheetGroup = { project: string; sheets: MinuteSheet[] };

/** One entry of the vision log, the workflow's ENTRIES item. */
export type SheetEntry = { start: number; end: number; where: string; who: string; action: string; shot: string; text_on_screen: string; visual_value: number };

/** The minute sheets of a project, by minute: `index/sheets/min-<k>.png`, paths absolute with forward slashes (the pipeline's spelling). */
export function listMinuteSheets(film: string): MinuteSheet[] {
  const dir = path.join(film, "index", "sheets");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => ({ f, m: f.match(/^min-(\d+)\.png$/) }))
    .filter((x): x is { f: string; m: RegExpMatchArray } => !!x.m)
    .map(({ f, m }) => ({ minute: Number(m[1]), path: path.resolve(dir, f).replace(/\\/g, "/") }))
    .sort((a, b) => a.minute - b.minute);
}

/** The workflow's groups: `perCall` consecutive sheets each. Pure. */
export function sheetGroups(sheets: MinuteSheet[], project: string, perCall = SHEETS_PER_CALL): SheetGroup[] {
  const groups: SheetGroup[] = [];
  for (let i = 0; i < sheets.length; i += perCall) groups.push({ project, sheets: sheets.slice(i, i + perCall) });
  return groups;
}

/** `sheet_read_<first>_<last>.json`. Pure. */
export function sheetReadFileName(first: number, last: number): string {
  return `sheet_read_${first}_${last}.json`;
}

/** The seconds a group covers: minute m0's first second to minute m1's last. Pure. */
export function groupSpan(minutes: number[]): { start: number; end: number } {
  return { start: Math.min(...minutes) * 60, end: Math.max(...minutes) * 60 + 59 };
}

/** Allowed slack at the edges and between stretches, in seconds. */
const EDGE_S = 2;
const GAP_S = 3;

/**
 * What is wrong with a group's entries against the prompt's own rules (every
 * second of every sheet, in order, no gaps), or null. `final`: the group
 * holds the source's last minute, which ends before its sheet does. Pure.
 */
export function sheetEntriesProblem(entries: SheetEntry[], span: { start: number; end: number }, final: boolean): string | null {
  if (!entries.length) return `no entries: describe seconds ${span.start}-${span.end}`;
  const sorted = [...entries].sort((a, b) => a.start - b.start);
  for (const e of sorted) {
    if (!Number.isInteger(e.start) || !Number.isInteger(e.end) || e.end < e.start) return `entry ${e.start}-${e.end}: start and end must be whole seconds with end >= start`;
    if (e.start < span.start || e.end > span.end) return `entry ${e.start}-${e.end} is outside these sheets (seconds ${span.start}-${span.end}, absolute from the start of the episode)`;
  }
  if (sorted[0].start > span.start + EDGE_S) return `the first entry starts at ${sorted[0].start}; cover from second ${span.start}`;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (b.start < a.end) return `entries ${a.start}-${a.end} and ${b.start}-${b.end} overlap`;
    if (b.start - a.end > GAP_S) return `seconds ${a.end + 1}-${b.start - 1} are not covered (between ${a.start}-${a.end} and ${b.start}-${b.end})`;
  }
  const last = sorted[sorted.length - 1];
  if (!final && last.end < span.end - EDGE_S) return `the last entry ends at ${last.end}; cover to second ${span.end}`;
  return null;
}

/** The grouped return flattened: every group's entries, sorted by start. Pure. */
export function flattenSheetRead(groups: { entries?: SheetEntry[] }[]): SheetEntry[] {
  return groups.flatMap((g) => g.entries ?? []).sort((a, b) => a.start - b.start || a.end - b.end);
}

/** The minutes a call's label names (`sheets:<project>:<first>-<last>`). Pure. */
export function labelMinutes(label: string): { first: number; last: number } | null {
  const m = label.match(/:(\d+)-(\d+)$/);
  return m ? { first: Number(m[1]), last: Number(m[2]) } : null;
}

export type SheetPassOptions = PassDeps & {
  film: string;
  run_id: string;
  work_dir: string;
  /** Default `<film>/sheet_premise.txt`'s text. */
  premise?: string;
  /** The project's name in the groups (default the film folder's name). */
  project?: string;
  /** Only these minutes (a calibration slice); default every sheet. */
  minutes?: number[];
  per_call?: number;
  /** Write the log here instead of `<film>/index/` (the calibration writes into the work folder); no overlap check then. */
  out_file?: string;
  scripts_dir?: string;
  workflow_file?: string;
};

export type SheetPassResult = {
  /** The file written, or null when a group failed (nothing is written then). */
  file: string | null;
  entries: number;
  minutes: { first: number; last: number } | null;
  groups: number;
  /** The groups whose call did not end done, by label. */
  failed_groups: { label: string; error: string }[];
  calls: ShimCallRecord[];
  cost_cents: number;
  cost_usd: number;
  provider: LlmProvider;
  model: string;
  reader_version: string;
  workflow_sha256: string;
};

/** The index files a new log would sit beside (every consumer concatenates them). */
export function existingSheetReads(film: string): string[] {
  const dir = path.join(film, "index");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^sheet_read_.*\.json$/.test(f)).sort();
}

export async function runSheetPass(opts: SheetPassOptions): Promise<SheetPassResult | WorkflowUnavailable> {
  const unavailable = visionUnavailableReason(opts.env ?? process.env);
  if (unavailable) return { unavailable };
  const scripts = opts.scripts_dir ?? path.join(opts.film, "scripts");
  let sheets = listMinuteSheets(opts.film);
  if (opts.minutes) {
    const want = new Set(opts.minutes);
    sheets = sheets.filter((s) => want.has(s.minute));
  }
  if (!sheets.length) throw new PicturePassError(`${path.join(opts.film, "index", "sheets")}: no minute sheets (min-<k>.png); run the index step first`);
  const first = sheets[0].minute;
  const last = sheets[sheets.length - 1].minute;
  for (let i = 1; i < sheets.length; i++) if (sheets[i].minute !== sheets[i - 1].minute + 1) throw new PicturePassError(`minute sheets ${sheets[i - 1].minute} and ${sheets[i].minute} are not consecutive: the log would have a hole`);
  const outFile = opts.out_file ?? path.join(opts.film, "index", sheetReadFileName(first, last));
  if (!opts.out_file) {
    const others = existingSheetReads(opts.film).filter((f) => f !== path.basename(outFile));
    if (others.length) throw new PicturePassError(`index/ already holds ${others.join(", ")}: build_script.py concatenates every index/sheet_read_*.json, so ${path.basename(outFile)} beside it would repeat those minutes`);
  }
  const premise = opts.premise ?? readPremise(path.join(opts.film, "sheet_premise.txt"));
  const project = opts.project ?? path.basename(path.resolve(opts.film));
  const groups = sheetGroups(sheets, project, opts.per_call ?? SHEETS_PER_CALL);
  const copyDir = path.join(opts.work_dir, "picture", "sheets");

  const attachments = new Map<string, ShimImage[]>();
  for (const s of sheets) {
    const sent = await apiImageOf(s.path, copyDir, { run: opts.ffmpeg });
    attachments.set(s.path, [{ path: sent.path, media_type: sent.media_type, note: `${s.path} (minute ${s.minute}${sent.reencoded ? ", sent as a JPEG copy" : ""})` }]);
  }

  const job = async (call: WorkflowCall) => {
    const m = labelMinutes(call.label);
    const readerVersion = apiReaderVersion(call.workflow.reader_version ?? call.workflow.name, call.model);
    const digest = await callDigest(call);
    return {
      kind: PICTURE_JOB_KINDS.sheet_read,
      target_id: opts.run_id,
      idempotency_key: `sr:${opts.run_id}:${m ? `${m.first}-${m.last}` : `call${call.index}`}:${readerVersion}:${digest}`,
      input: { workflow: call.workflow.name, workflow_sha: call.workflow.sha256.slice(0, 12), minutes: m ? [m.first, m.last] : null, reader_version: readerVersion, images: call.images.map((i) => path.basename(i.path)), digest } satisfies Json,
    };
  };
  const check = (call: WorkflowCall, data: unknown) => {
    const m = labelMinutes(call.label);
    if (!m) return null;
    const entries = ((data as { entries?: SheetEntry[] })?.entries ?? []) as SheetEntry[];
    return sheetEntriesProblem(entries, groupSpan([m.first, m.last]), m.last === last);
  };

  const r = await runWorkflow({
    file: opts.workflow_file ?? path.join(scripts, "sheet_read.workflow.js"),
    expect_name: "sheet-read",
    args: { premise, groups },
    images: (p) => attachments.get(p) ?? null,
    image_paths: [...attachments.keys()],
    job,
    check,
    llm: opts.llm,
    session: opts.session,
    env: opts.env,
    model: opts.model,
    effort: opts.effort,
    max_tokens: SHEET_MAX_TOKENS,
    signal: opts.signal,
    max_usd: opts.max_usd,
    onLog: opts.onLog,
    onCall: opts.onCall,
  });
  if (isWorkflowUnavailable(r)) return r;
  const failed = r.failed.map((c) => ({ label: c.label, error: c.error ?? c.status }));
  const returned = Array.isArray(r.result) ? (r.result as { project?: string; minutes?: number[]; entries?: SheetEntry[] }[]) : [];
  if (!failed.length && returned.length !== groups.length) failed.push({ label: "(workflow)", error: `${returned.length} of ${groups.length} groups returned${r.stage_errors.length ? `: ${r.stage_errors.join("; ")}` : ""}` });
  const readerVersion = apiReaderVersion(r.workflow.reader_version ?? r.workflow.name, r.model);
  const base = { groups: groups.length, failed_groups: failed, calls: r.calls, cost_cents: r.cost_cents, cost_usd: r.cost_usd, provider: r.provider, model: r.model, reader_version: readerVersion, workflow_sha256: r.workflow.sha256 };
  if (failed.length) return { ...base, file: null, entries: 0, minutes: null };
  const entries = flattenSheetRead(returned);
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(entries, null, 1)}\n`, "utf8");
  await fsp.rename(tmp, outFile);
  opts.onLog?.(`${path.basename(outFile)}: ${entries.length} stretches over minutes ${first}-${last}`);
  return { ...base, file: outFile, entries: entries.length, minutes: { first, last } };
}
