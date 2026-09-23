// The watermark stage (plan B2, stage 1): `watermark.py --detect`, then a
// person looks at `index/watermark-found.png` and `index/watermark-median.png`
// and decides — accept the box, redraw the search region (a re-detect with
// `--force`, because the person asked for exactly that), or say the film
// has no logo (`--no-delogo` at the render). Optional `unmark.py`
// --find / --fit / --test / --edge-fill for a see-through mark, each shown
// with the script's own PASS / FAIL. The stage never trusts a box the
// person has not looked at: it waits.
//
// An existing `index/watermark.json` (a film adopted from a session) is
// shown, not re-detected: watermark.py refuses to overwrite it because
// delivered episodes may have been rendered with it.

import path from "node:path";
import { DECISION, SRC_ARG, decisionData, fail, fileExists, next, noDelogo, pendingDecision, readJson, refusalOf, runStep, wait, type StageContext, type StageDetail, type StageOutcome } from "./stages";

export const WATERMARK_IMAGES = ["index/watermark-found.png", "index/watermark-median.png"] as const;

/** A search region as the API takes it: fractions of the frame, `{x, y, w, h}`. */
export type Region = { x: number; y: number; w: number; h: number };

/** `{x, y, w, h}` fractions → watermark.py's `--region x0,y0,x1,y1`. */
export function regionArg(r: Region): string {
  const f = (v: number) => String(Math.round(v * 10000) / 10000);
  return `${f(r.x)},${f(r.y)},${f(r.x + r.w)},${f(r.y + r.h)}`;
}

export function validRegion(r: Region): boolean {
  const ok = (v: number) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  return ok(r.x) && ok(r.y) && ok(r.w) && ok(r.h) && r.w > 0 && r.h > 0 && r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001;
}

type Box = { x: number; y: number; w: number; h: number };

/** What the screen shows: the box on disk, the two evidence images that exist, the unmark state. */
export function watermarkView(cutDir: string): StageDetail["watermark"] {
  const rec = readJson<{ box?: Box; video?: { w: number; h: number }; parts?: number }>(path.join(cutDir, "index", "watermark.json"));
  const images = WATERMARK_IMAGES.filter((rel) => fileExists(path.join(cutDir, ...rel.split("/"))));
  const unmark = {
    found: fileExists(path.join(cutDir, "index", "unmark-found.png")) ? "index/unmark-found.png" : null,
    fit: fileExists(path.join(cutDir, "index", "unmark", "mark_model.json")),
    test: fileExists(path.join(cutDir, "index", "unmark-test.png")) ? "index/unmark-test.png" : null,
  };
  return { box: rec?.box ?? null, video: rec?.video ?? null, parts: rec?.parts ?? null, images: [...images], unmark };
}

const UNMARK_ACTIONS = ["find", "fit", "test", "edge_fill"] as const;
export type UnmarkAction = (typeof UNMARK_ACTIONS)[number];

export function isUnmarkAction(v: unknown): v is UnmarkAction {
  return typeof v === "string" && (UNMARK_ACTIONS as readonly string[]).includes(v);
}

export async function runWatermarkStage(ctx: StageContext): Promise<StageOutcome> {
  const { run, dirs } = ctx;
  const watermarkFile = path.join(dirs.cut, "index", "watermark.json");
  if (noDelogo(run)) {
    ctx.log("no logo: the render will pass --no-delogo");
    return next("index", { no_delogo: true, watermark: watermarkView(dirs.cut) });
  }

  const decision = pendingDecision(run, DECISION.watermark_accept, DECISION.watermark_region, DECISION.no_logo, DECISION.unmark);
  if (decision?.action === DECISION.watermark_accept) {
    if (!fileExists(watermarkFile)) return fail("the box was accepted but index/watermark.json is not there: detect again");
    return next("index", { watermark: watermarkView(dirs.cut) });
  }
  if (decision?.action === DECISION.watermark_region) {
    const region = decisionData(decision).region as unknown as Region;
    if (!region || !validRegion(region)) return fail("the redrawn region is not x, y, w, h fractions of the frame");
    // The person asked for a new box over the old one: --force is their decision, recorded on the run.
    const args = ["--detect", "--src", SRC_ARG, "--region", regionArg(region)];
    if (fileExists(watermarkFile)) args.push("--force");
    const r = await runStep(ctx, { script: "watermark.py", args, what: "watermark --detect (redrawn region)" });
    if (r.code !== 0) return fail(refusalOf({ script: "watermark.py", args, what: "" }, r));
    return wait("watermark", { watermark: watermarkView(dirs.cut), region_used: regionArg(region), detect_tail: lastLines(r.stdoutTail) });
  }
  if (decision?.action === DECISION.unmark) {
    const data = decisionData(decision);
    const action = data.action;
    if (!isUnmarkAction(action)) return fail(`unknown unmark action ${String(action)}`);
    const args = [`--${action.replace("_", "-")}`, "--src", SRC_ARG];
    if (action === "fit") {
      if (typeof data.boxes !== "string" || !data.boxes.trim()) return fail("unmark --fit needs the boxes --find printed");
      args.push("--boxes", data.boxes.trim());
    }
    const r = await runStep(ctx, { script: "unmark.py", args, what: `unmark --${action}` });
    const tail = lastLines(r.stdoutTail);
    const verdict = r.code === 0 ? (action === "test" ? "PASS" : "ok") : "FAIL";
    // A FAIL from --test is the script's own finding (a mark that is only mostly gone); it is shown, not fatal, and the person decides.
    if (r.code !== 0 && action !== "test") return fail(refusalOf({ script: "unmark.py", args, what: "" }, r));
    return wait("watermark", { watermark: watermarkView(dirs.cut), unmark_result: { action, verdict, output: r.code === 0 ? tail : refusalOf({ script: "unmark.py", args, what: "" }, r) } });
  }

  // First entry: detect, unless a box is already on disk (adopted from a session).
  if (fileExists(watermarkFile)) {
    ctx.log("index/watermark.json exists: showing it, not re-detecting (delivered episodes may use it)");
    return wait("watermark", { watermark: watermarkView(dirs.cut), existing_box: true });
  }
  const args = ["--detect", "--src", SRC_ARG];
  const region = run.settings.watermark_region;
  if (typeof region === "string" && region.trim()) args.push("--region", region.trim());
  const r = await runStep(ctx, { script: "watermark.py", args, what: "watermark --detect" });
  if (r.code !== 0) return fail(refusalOf({ script: "watermark.py", args, what: "" }, r));
  return wait("watermark", { watermark: watermarkView(dirs.cut), region_used: typeof region === "string" ? region : null, detect_tail: lastLines(r.stdoutTail) });
}

function lastLines(tail: string, n = 12): string[] {
  return tail
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter(Boolean)
    .slice(-n);
}
