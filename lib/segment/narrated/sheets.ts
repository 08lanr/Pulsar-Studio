// The sheets stage (narrated spec N1 stage 2): the minute-sheet vision log
// build_script.py merges into `index/script_raw.md`. With `settings.vision =
// "api"` and a reader wired (`ctx.readers.sheets`, the shim over the synced
// sheet_read.workflow.js — lib/segment/narrated/picture/sheets.ts), Studio
// runs it through the API into ONE non-overlapping
// `index/sheet_read_0_<last>.json`. Otherwise — the default until the N8
// reader bar passes, no provider key, or the pass failed and the person
// prefers it — the stage waits with the exact Workflow call; the person's
// `handoff_done` names the Workflow's `.output`, which Studio flattens into
// the same one file (every consumer globs `index/sheet_read_*.json` and
// concatenates, so a second file over the same minutes would double every
// stretch). An existing log that covers every minute is kept.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Json } from "@/lib/types";
import { fail, next, type StageOutcome } from "../stages";
import { flattenSheetRead, listMinuteSheets, sheetGroups, sheetReadFileName, type SheetEntry } from "./picture/sheets";
import { dataOf, NARRATED_DECISION, narratedWait, pendingRunDecisions, writeProjectFile, type NarratedContext } from "./stages";

/** The minutes the existing `index/sheet_read_<a>_<b>.json` files cover (by their names). */
export function coveredMinutes(indexDir: string): Set<number> {
  const out = new Set<number>();
  let names: string[] = [];
  try {
    names = readdirSync(indexDir);
  } catch {
    return out;
  }
  for (const n of names) {
    const m = /^sheet_read_(\d+)_(\d+)\.json$/.exec(n);
    if (!m) continue;
    for (let k = Number(m[1]); k <= Number(m[2]); k++) out.add(k);
  }
  return out;
}

/** The exact Workflow call a person runs for the sheet read (the args the workflow reads: premise, groups). */
export function sheetHandoffCommand(ctx: Pick<NarratedContext, "paths" | "settings" | "run">): string {
  const sheets = listMinuteSheets(ctx.paths.film);
  const groups = sheetGroups(sheets, ctx.run.slug);
  const script = path.join(ctx.paths.scripts, "sheet_read.workflow.js").replace(/\\/g, "/");
  return `Workflow({ scriptPath: ${JSON.stringify(script)}, args: { premise: ${JSON.stringify(ctx.settings.sheet_premise ?? "")}, groups: ${JSON.stringify(groups)} } })`;
}

/** A Workflow `.output` (the grouped return, as a list or `{result: [...]}`) flattened to the entry list, or a refusal. */
export function entriesFromWorkflowOutput(text: string): SheetEntry[] | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    return `the Workflow output is not JSON: ${(e as Error).message}`;
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { result?: unknown }).result) ? (raw as { result: unknown[] }).result : null;
  if (!list) return "the Workflow output is neither a list of groups nor {result: [...]}";
  const groups = list.filter((g): g is { entries?: SheetEntry[] } => !!g && typeof g === "object");
  const entries = flattenSheetRead(groups);
  if (!entries.length) return "the Workflow output holds no entries";
  return entries;
}

export async function runSheetsStage(ctx: NarratedContext): Promise<StageOutcome> {
  const sheets = listMinuteSheets(ctx.paths.film);
  if (!sheets.length) return fail("index/sheets has no min-<k>.png: the index did not cut the minute sheets");
  const last = sheets[sheets.length - 1].minute;
  const covered = coveredMinutes(ctx.paths.index);
  const missing = sheets.filter((s) => !covered.has(s.minute)).map((s) => s.minute);
  if (!missing.length) return next("script_raw", { sheets: { minutes: sheets.length, kept: true } });
  if (covered.size) return fail(`index/ already holds a sheet read that covers only part of the source (minutes ${[...covered].sort((a, b) => a - b).join(", ")}); a second file beside it would double those stretches in script_raw.md. Remove it or complete it by hand, then Retry.`);

  // The person ran it: flatten their Workflow output into the one file.
  const done = pendingRunDecisions(ctx.run, NARRATED_DECISION.handoff_done).pop() ?? null;
  const out = typeof dataOf(done).output_path === "string" ? String(dataOf(done).output_path) : null;
  if (done && out) {
    if (!existsSync(out)) return narratedWait("handoff", { handoff: { command: sheetHandoffCommand(ctx), note: `${out} is not there` } as unknown as Json });
    const entries = entriesFromWorkflowOutput(readFileSync(out, "utf8"));
    if (typeof entries === "string") return narratedWait("handoff", { handoff: { command: sheetHandoffCommand(ctx), note: entries } as unknown as Json });
    const file = sheetReadFileName(0, last);
    writeProjectFile(ctx, `index/${file}`, JSON.stringify(entries, null, 1), { by: done.by, why: `the sheet read the person ran as a Workflow (${out})`, decision_at: done.at });
    return next("script_raw", { sheets: { minutes: sheets.length, file: `index/${file}`, entries: entries.length, via: "handoff" }, decisions_seen: ctx.run.decisions.length });
  }

  if (ctx.settings.vision === "api" && ctx.readers) {
    await ctx.progress({ progress: { step: "sheet_read", minutes: sheets.length } }, { force: true });
    const r = await ctx.readers.sheets(ctx);
    if (r.status === "done") return next("script_raw", { sheets: { minutes: sheets.length, ...r.detail, via: "api" }, decisions_seen: ctx.run.decisions.length });
    if (r.status === "failed") return narratedWait("sheets", { sheets: { error: r.error, ...(r.detail ?? {}) } as unknown as Json, handoff: { command: sheetHandoffCommand(ctx) } as unknown as Json });
    return narratedWait("handoff", { unavailable: r.reason, handoff: { command: sheetHandoffCommand(ctx), writes: [`index/${sheetReadFileName(0, last)}`] } as unknown as Json });
  }
  return narratedWait("handoff", { handoff: { command: sheetHandoffCommand(ctx), writes: [`index/${sheetReadFileName(0, last)}`], note: "run the Workflow, then answer handoff_done with its .output path" } as unknown as Json });
}
