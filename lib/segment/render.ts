// The render stage (plan B2, stage 6): `pick_cuts.py --choices review/choices.json`
// (the plan, frame-snapped by the pipeline's own writer; `--pin-from` the
// newest DELIVERED file when the film has one), then `cut_episodes.py --src …`
// under the machine's heavy lock, with per-episode progress read from its
// stdout and a REFUSED shown verbatim. A join move after the QA
// (`{kind: "join"}`) comes through here too: `pick_cuts.py --repin OLD=NEW`
// declares the one move, and `cut_episodes.py` re-encodes only the two
// episodes it touches. Studio never passes `--allow-recut`, `--rerender-all`
// or `--no-pin`.

import path from "node:path";
import { choicesConsumed } from "@/lib/film-import/scan";
import { parseDeliveredPlan } from "@/lib/film-import/manifest";
import type { DeliveredPlan } from "@/lib/film-import/types";
import {
  DECISION,
  SRC_ARG,
  bandArgs,
  consumed,
  decisionData,
  fail,
  fileExists,
  newestDelivered,
  next,
  noDelogo,
  pendingDecision,
  planDuration,
  readJson,
  refusalOf,
  runStep,
  snapshotReview,
  tailLines,
  withHeavyLock,
  type StageContext,
  type StageOutcome,
} from "./stages";

/** ~5 s of encoding per minute of film (README); the limit is four times that, never under an hour. */
export function renderTimeoutMs(durationS: number | null): number {
  const s = durationS ? (durationS / 60) * 5 * 4 : 0;
  return Math.max(60 * 60 * 1000, Math.round(s * 1000));
}

/** `cut/cuts.json`, parsed, or null. */
export function readPlan(cutDir: string): DeliveredPlan | null {
  const raw = readJson(path.join(cutDir, "cuts.json"));
  if (!raw) return null;
  try {
    return parseDeliveredPlan(raw);
  } catch {
    return null;
  }
}

const EPISODE_LINE = /^\s*ep(\d+)\s+([\d.]+)s(.*)$/;

export async function runRenderStage(ctx: StageContext): Promise<StageOutcome> {
  const { run, dirs } = ctx;
  const duration = planDuration(run, dirs.cut);
  const pin = newestDelivered(dirs.cut);
  const common = [...(duration ? ["--duration", String(duration)] : []), ...(pin ? ["--pin-from", pin.arg] : []), ...bandArgs(run)];
  const join = pendingDecision(run, DECISION.join);
  let only: number[] | null = null;

  snapshotReview(ctx, join ? "join" : "render");

  if (join) {
    // One delivered boundary moves; everything else stays pinned (README, "Moving one delivered boundary").
    if (!pin) return fail("a join can only move once the film has a DELIVERED render");
    const old = join.boundary_s;
    const to = join.to_s;
    const index = Number(decisionData(join).join_index);
    if (old === null || typeof to !== "number") return fail("a join move names the old end and the new time");
    const args = [...common, "--repin", `${old}=${to}`];
    const r = await runStep(ctx, { script: "pick_cuts.py", args, what: `pick_cuts --repin ${old}=${to}`, timeoutMs: 30 * 60 * 1000 });
    if (r.code !== 0) return fail(refusalOf({ script: "pick_cuts.py", args, what: "" }, r));
    only = Number.isInteger(index) && index > 0 ? [index, index + 1] : null;
  } else if (run.mode === "by_eye_2min") {
    const choices = readJson<Record<string, number>>(path.join(dirs.cut, "review", "choices.json"));
    if (!choices) return fail("review/choices.json is missing: the review was not applied");
    if (choicesConsumed(choices, readPlan(dirs.cut))) {
      ctx.log("cut/cuts.json already carries review/choices.json: pick_cuts --choices skipped");
    } else {
      const args = [...common, "--choices", "review/choices.json"];
      const r = await runStep(ctx, { script: "pick_cuts.py", args, what: "pick_cuts --choices", timeoutMs: 30 * 60 * 1000 });
      if (r.code !== 0) return fail(refusalOf({ script: "pick_cuts.py", args, what: "" }, r));
    }
  } else if (!fileExists(path.join(dirs.cut, "cuts.json"))) {
    return fail("cut/cuts.json is missing: cards.py --plan did not write the source-episodes plan");
  }

  const plan = readPlan(dirs.cut);
  if (!plan) return fail("cut/cuts.json is not a plan Studio can read");
  const total = plan.episodes.length;
  const args = ["--src", SRC_ARG];
  if (noDelogo(run)) args.push("--no-delogo");

  return withHeavyLock(ctx, "render", async () => {
    let rendered = 0;
    let kept = 0;
    let last = 0;
    await ctx.progress({ progress: { step: "render", t: 0, of: total, kept: 0 } });
    const r = await runStep(ctx, {
      script: "cut_episodes.py",
      args,
      what: "cut_episodes",
      timeoutMs: renderTimeoutMs(plan.source_duration ?? duration),
      onLine: (stream, line) => {
        if (stream !== "stdout") return;
        const m = EPISODE_LINE.exec(line);
        if (!m) return;
        const n = Number(m[1]);
        if (/kept/.test(m[3])) kept += 1;
        else rendered += 1;
        if (n > last) last = n;
        void ctx.progress({ progress: { step: "render", t: last, of: total, kept, rendered } }).catch(() => undefined);
      },
    });
    if (r.code !== 0) return fail(refusalOf({ script: "cut_episodes.py", args, what: "" }, r), { render_tail: tailLines(r.stdoutTail) });
    const delivered = newestDelivered(dirs.cut);
    return next("qa", {
      render: { episodes: total, rendered, kept, delivered: delivered?.file ?? null, verify_tail: tailLines(r.stdoutTail, 10), repin: join ? { from: join.boundary_s, to: join.to_s, only } : null },
      qa_only: only,
      progress: null,
      ...(join ? consumed(run) : {}),
    });
  });
}
