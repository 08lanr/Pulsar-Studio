// The join check through the API (narrated spec N1 E6, N0.2): every place an
// episode skips source footage, judged by the synced `cut_verify.workflow.js`
// (cv-2: a picture lens and a story lens per join) through the Workflow
// shim, recorded ONLY by `cut_joins.py record`.
//
//   1. `cut_joins.py status --ep epN` first: it treats a join as reviewed
//      when at most one line drifted in or out of its words window
//      (cut_joins.py same_words), so nothing is paid for a join the pipeline
//      already counts as judged. Status rewrites `review/cut_pending.json`
//      every time, empty when nothing is pending (drama-remix 2d89b86); the
//      pass still reads that file only when this status call rewrote it, so
//      a stale list from an earlier status is never sent.
//   2. The items are the pending file's own ({key, ep, id, at_shipped,
//      skipped_seconds, pieces, words, words_fp, sheet}); `words_fp` rides
//      through the workflow's result unchanged, as the recorder demands.
//   3. Two calls per join (kind cut_verify, key
//      cv:<run>:<ep>:<join>:<words_fp>:<lens>:<reader_version>:<digest>).
//      `cut_joins.py record` does not store a reader version, so the job
//      rows' input carries it (`cv-2+api:<model>`); the verdict file carries
//      it too, where the recorder ignores it.
//   4. A join whose readers did not all answer stays pending.

import { existsSync, promises as fsp, readdirSync } from "node:fs";
import path from "node:path";
import { PICTURE_JOB_KINDS, type WorkflowUnavailable } from "@/lib/segment/workflow-shim";
import { PicturePassError, readPendingItems, readPremise, runLensPass, type LensPassResult, type PassDeps, type PendingItem } from "./frames";
import { cutJoinsStatus, type StatusOutcome } from "./recorders";

/** cut_joins.py lays its sheet out 6 tiles to a row, each 400 px wide (BEFORE, CUT OUT, AFTER). */
export const JOIN_SHEET_COLS = 6;

/** The answer room of one join reader: four descriptions and a verdict. */
export const JOIN_MAX_TOKENS = 6000;

export type LostJoin = { id: string; at_shipped: string; why: string };

/** The joins `cut_joins.json` records as lost among these ids (what `status` blocks on, before waivers). */
export async function lostJoinsOf(film: string, ep: string, ids: string[]): Promise<LostJoin[]> {
  const file = path.join(film, ep, "review", "cut_joins.json");
  const have = JSON.parse(await fsp.readFile(file, "utf8").catch(() => "{}")) as Record<string, { lost?: boolean; at_shipped?: string; readers?: { viewer_lost?: boolean; what_is_confusing?: string }[] }>;
  return ids
    .filter((id) => have[id]?.lost)
    .map((id) => ({ id, at_shipped: have[id].at_shipped ?? "", why: (have[id].readers ?? []).filter((x) => x.viewer_lost).map((x) => x.what_is_confusing ?? "").join("; ") }));
}

/** The source video the join sheets were grabbed from: the first `source/*.mp4`, as cut_joins.py takes it. */
export function joinSourceVideo(film: string): string | null {
  const dir = path.join(film, "source");
  if (!existsSync(dir)) return null;
  const mp4 = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".mp4")).sort();
  return mp4.length ? path.join(dir, mp4[0]) : null;
}

export type JoinPassOptions = PassDeps & {
  film: string;
  ep: string;
  run_id: string;
  work_dir: string;
  /** Default `<film>/frame_premise.txt`'s text (the premise both readers get). */
  premise?: string;
  /** Default: `status`, then `<ep>/review/cut_pending.json` when status rewrote it. */
  items?: PendingItem[];
  status?: boolean;
  record?: boolean;
  scripts_dir?: string;
  workflow_file?: string;
  /** Its SHA-256 as the sync recorded it (the shim refuses other bytes). */
  workflow_sha256?: string;
};

export type JoinPassResult = LensPassResult & {
  status_before: StatusOutcome | null;
  status_after: StatusOutcome | null;
  /** Joins this pass recorded as losing the viewer. */
  lost: LostJoin[];
};

export async function runJoinPass(opts: JoinPassOptions): Promise<JoinPassResult | WorkflowUnavailable> {
  const scripts = opts.scripts_dir ?? path.join(opts.film, "scripts");
  const doStatus = opts.status !== false;
  const statusOpts = { film: opts.film, ep: opts.ep, scripts_dir: scripts, python: opts.python, signal: opts.signal };
  const before = doStatus ? await cutJoinsStatus(statusOpts) : null;
  if (before && before.code !== 0 && before.code !== 1) throw new PicturePassError(`cut_joins.py status --ep ${opts.ep} failed: ${before.refusal}`);
  const pendingFile = path.join(opts.film, opts.ep, "review", "cut_pending.json");
  const items = opts.items ?? (before && !before.rewrote ? [] : readPendingItems(pendingFile));
  for (const it of items) if (typeof it.words_fp !== "string") throw new PicturePassError(`${it.key}: no words_fp; run cut_joins.py prepare again`);
  if (!items.length) {
    return { ep: opts.ep, items: 0, complete: [], incomplete: [], verdicts_file: null, recorded: null, calls: [], cost_cents: 0, cost_usd: 0, provider: "anthropic", model: "", reader_version: null, workflow_sha256: "", status_before: before, status_after: before, lost: [] };
  }
  const premise = opts.premise ?? readPremise(path.join(opts.film, "frame_premise.txt"));
  const r = await runLensPass({
    film: opts.film,
    ep: opts.ep,
    run_id: opts.run_id,
    work_dir: opts.work_dir,
    workflow_file: opts.workflow_file ?? path.join(scripts, "cut_verify.workflow.js"),
    workflow_sha256: opts.workflow_sha256,
    workflow_name: "cut-verify",
    recorder: "cut_joins",
    kind: PICTURE_JOB_KINDS.cut_verify,
    key_tag: "cv",
    item_key_part: (it) => `${it.id}:${String(it.words_fp)}`,
    premise,
    items,
    sheet_cols: JOIN_SHEET_COLS,
    video_file: joinSourceVideo(opts.film),
    max_tokens: JOIN_MAX_TOKENS,
    deps: opts,
    record: opts.record !== false,
    scripts_dir: scripts,
  });
  if ("unavailable" in r) return r;
  const after = doStatus ? await cutJoinsStatus(statusOpts) : null;
  const recordedIds = r.recorded?.code === 0 ? items.filter((it) => r.complete.includes(it.key)).map((it) => it.id) : [];
  return { ...r, status_before: before, status_after: after, lost: await lostJoinsOf(opts.film, opts.ep, recordedIds) };
}
