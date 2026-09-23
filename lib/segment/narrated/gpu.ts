// The picture lane (narrated spec N1, E3 and E3b): the cleaned, reframed,
// separated picture of one episode, under the machine's heavy lock, one step
// at a time with every exit code checked — never season_chain.sh,
// gpu_queue*.sh or post_chain2.sh, which hide exit codes behind `| tail`,
// touch GPU_DONE unconditionally and wait in unbounded loops.
//
//   1. <gpu-python> clean_lbl.py --src epN/base.mp4 --cues epN/cues_base.json --out epN/clean.mp4
//   2. python residue_fix.py --ep epN            exit 1 while hits remain: a refusal
//      (the chain removes clean2.mp4 first; with no hits to fix residue_fix
//      writes none, and clean.mp4 is copied to clean2.mp4, as the chain did)
//   3. <gpu-python> track_faces.py --src epN/base.mp4 --out epN/reframe_plan.json
//      always re-run when base.mp4 or edl.json is newer than the plan
//      (stale_check does not compare the plan)
//   4. <gpu-venv>/audio-separator epN/base.wav -m model_bs_roformer_ep_317_sdr_12.9755.ckpt --output_dir epN/stems --output_format WAV
//   5. python reframe.py --src epN/clean2.mp4 --plan epN/reframe_plan.json --out epN/vertical.mp4
//   6. python stale_check.py --ep epN            exit 1 blocks
//
// A step whose output is newer than its inputs is skipped, so a restarted
// worker resumes after the step that finished. Nothing here starts before
// the episode's prep approval (amendment 3). The reframe glance (E3b) shows
// `reframe_review.jpg`; with `settings.reframe_review = "required"` it
// blocks, and an override re-runs track_faces.py --box/--crop and
// reframe.py only.

import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { FilmRunEpisode, Json } from "@/lib/types";
import { tailLines, withHeavyLock } from "../stages";
import { staleCheck } from "./gate";
import { audioSeparator, dataOf, epDir, gpuPython, NARRATED_DECISION, narratedRefusal, pendingEpisodeDecision, requirePrepApproved, runFilmStep, type EpisodeStepOutcome, type FilmStep, type NarratedContext } from "./stages";

/** The separation model the chain uses. */
export const STEMS_MODEL = "model_bs_roformer_ep_317_sdr_12.9755.ckpt";

const mtime = (file: string): number | null => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

/** True when `out` exists and is newer than every input that exists. Pure over the disk. */
export function upToDate(out: string, inputs: string[]): boolean {
  const o = mtime(out);
  if (o === null) return false;
  return inputs.every((i) => {
    const t = mtime(i);
    return t === null || t <= o;
  });
}

/** Whether the stems folder holds the two stems (the chain's own test: at least two wavs). */
export function stemsDone(dir: string): boolean {
  try {
    return readdirSync(dir).filter((f) => /\.wav$/i.test(f)).length >= 2;
  } catch {
    return false;
  }
}

export type PictureStepPlan = { key: "clean" | "residue" | "track" | "stems" | "reframe" | "stale"; step: FilmStep; skip: boolean };

/** The six steps of E3 for episode N, each with whether it may be skipped. Pure over the disk. */
export function pictureSteps(film: string, n: number, env: Record<string, string | undefined>): PictureStepPlan[] {
  const ep = epDir(n);
  const f = (rel: string) => path.join(film, ep, rel);
  const base = f("base.mp4");
  const cues = f("cues_base.json");
  const edl = f("edl.json");
  const sep = audioSeparator(env);
  return [
    { key: "clean", step: { script: "clean_lbl.py", args: ["--src", `${ep}/base.mp4`, "--cues", `${ep}/cues_base.json`, "--out", `${ep}/clean.mp4`], what: `clean ep${n}`, interpreter: "gpu-python", timeoutMs: 2 * 60 * 60 * 1000 }, skip: upToDate(f("clean.mp4"), [base, cues]) },
    { key: "residue", step: { script: "residue_fix.py", args: ["--ep", ep], what: `residue_fix ep${n}`, timeoutMs: 2 * 60 * 60 * 1000 }, skip: upToDate(f("clean2.mp4"), [f("clean.mp4"), cues]) },
    { key: "track", step: { script: "track_faces.py", args: ["--src", `${ep}/base.mp4`, "--out", `${ep}/reframe_plan.json`], what: `track_faces ep${n}`, interpreter: "gpu-python", timeoutMs: 2 * 60 * 60 * 1000 }, skip: upToDate(f("reframe_plan.json"), [base, edl]) },
    { key: "stems", step: { script: `${ep}/base.wav`, args: [`${ep}/base.wav`, "-m", STEMS_MODEL, "--output_dir", `${ep}/stems`, "--output_format", "WAV"], what: `stems ep${n}`, interpreter: { exe: sep ?? "audio-separator" }, timeoutMs: 60 * 60 * 1000 }, skip: stemsDone(f("stems")) && upToDate(f("stems"), [f("base.wav")]) },
    { key: "reframe", step: { script: "reframe.py", args: ["--src", `${ep}/clean2.mp4`, "--plan", `${ep}/reframe_plan.json`, "--out", `${ep}/vertical.mp4`], what: `reframe ep${n}`, timeoutMs: 2 * 60 * 60 * 1000 }, skip: upToDate(f("vertical.mp4"), [f("clean2.mp4"), f("reframe_plan.json")]) },
    { key: "stale", step: { script: "stale_check.py", args: ["--ep", ep], what: `stale_check ep${n}` }, skip: false },
  ];
}

/** E3: the picture chain of one episode. Refused before the prep approval; every exit checked; the refusals verbatim. */
export async function runPictureStep(ctx: NarratedContext, ep: FilmRunEpisode): Promise<EpisodeStepOutcome> {
  const gate = requirePrepApproved(ep, "picture");
  if (gate) return { kind: "refused", error: gate, patch: { picture_stage: "waiting" } };
  if (!ctx.scripts.fake && !gpuPython(ctx.env)) return { kind: "refused", error: "the picture lane needs the GPU venv's python: set STUDIO_GPU_PYTHON (mini-drama-analysis/.gpu-venv/Scripts/python.exe)" };
  const d = ep.stage_detail as Record<string, Json | undefined>;
  const film = ctx.paths.film;
  const epFolder = path.join(film, epDir(ep.n));
  if (!existsSync(path.join(epFolder, "base.mp4"))) return { kind: "refused", error: `${epDir(ep.n)}/base.mp4 is not there: make_ep.py has not cut this episode` };

  return withHeavyLock(ctx, `picture ep${ep.n}`, async () => {
    const timings: Record<string, number | string> = {};
    for (const plan of pictureSteps(film, ep.n, ctx.env)) {
      if (plan.skip) {
        timings[plan.key] = "kept";
        continue;
      }
      if (plan.key === "residue") rmSync(path.join(epFolder, "clean2.mp4"), { force: true });
      if (plan.key === "stems") rmSync(path.join(epFolder, "stems"), { recursive: true, force: true });
      await ctx.progress({ progress: { step: plan.key, ep: ep.n } });
      const started = Date.now();
      const r = await runFilmStep(ctx, plan.step);
      timings[plan.key] = Math.round((Date.now() - started) / 1000);
      if (plan.key === "stale") {
        if (r.code === 1) return { kind: "refused", error: narratedRefusal({ script: "stale_check.py" }, r), patch: { picture_stage: "stale", stage_detail: { ...d, picture: { timings, stale: tailLines(r.stdoutTail, 12) } as unknown as Json } } };
      }
      if (r.code !== 0) return { kind: "refused", error: narratedRefusal({ script: plan.step.script }, r), patch: { stage_detail: { ...d, picture: { timings, failed_step: plan.key } as unknown as Json } } };
      if (plan.key === "residue" && !existsSync(path.join(epFolder, "clean2.mp4"))) copyFileSync(path.join(epFolder, "clean.mp4"), path.join(epFolder, "clean2.mp4"));
    }
    const glance = ctx.settings.reframe_review === "required";
    return {
      kind: "moved",
      patch: { picture_stage: glance ? "reframe_glance" : "ready", error_text: null, stage_detail: { ...d, picture: { timings, done_at: new Date().toISOString(), review_image: `${epDir(ep.n)}/reframe_review.jpg` } as unknown as Json } },
      note: `ep${ep.n}: picture lane done${glance ? "; the reframe glance waits for a person" : ""}`,
    };
  });
}

/** E3b: wait for the reframe decision; accept → ready, override → track_faces --box/--crop, reframe, stale_check, and glance again. */
export async function runReframeGlanceStep(ctx: NarratedContext, ep: FilmRunEpisode): Promise<EpisodeStepOutcome> {
  const decision = pendingEpisodeDecision(ctx.run, ep, NARRATED_DECISION.reframe);
  if (!decision) return { kind: "wait", for: "reframe" };
  const d = ep.stage_detail as Record<string, Json | undefined>;
  const data = dataOf(decision);
  const consumed = { decisions_seen: ctx.run.decisions.length };
  if (data.action === "accept") return { kind: "moved", patch: { picture_stage: "ready", stage_detail: { ...d, ...consumed, reframe_accepted: { by: decision.by, at: decision.at } } } };
  if (data.action !== "override") return { kind: "wait", for: "reframe", patch: { stage_detail: { ...d, ...consumed } } };
  const shots = (v: unknown) => (Array.isArray(v) ? v.filter((x) => Number.isInteger(x) && Number(x) >= 0).join(",") : typeof v === "string" && /^\d+(,\d+)*$/.test(v) ? v : "");
  const box = shots(data.box);
  const crop = shots(data.crop);
  if (!box && !crop) return { kind: "wait", for: "reframe", patch: { stage_detail: { ...d, ...consumed, note: "an override names shots to box or crop" } } };
  const ep_ = epDir(ep.n);
  return withHeavyLock(ctx, `reframe ep${ep.n}`, async () => {
    const steps: FilmStep[] = [
      { script: "track_faces.py", args: ["--src", `${ep_}/base.mp4`, "--out", `${ep_}/reframe_plan.json`, ...(box ? ["--box", box] : []), ...(crop ? ["--crop", crop] : [])], what: `track_faces override ep${ep.n}`, interpreter: "gpu-python", timeoutMs: 2 * 60 * 60 * 1000 },
      { script: "reframe.py", args: ["--src", `${ep_}/clean2.mp4`, "--plan", `${ep_}/reframe_plan.json`, "--out", `${ep_}/vertical.mp4`], what: `reframe ep${ep.n}`, timeoutMs: 2 * 60 * 60 * 1000 },
    ];
    for (const s of steps) {
      const r = await runFilmStep(ctx, s);
      if (r.code !== 0) return { kind: "refused", error: narratedRefusal({ script: s.script }, r), patch: { stage_detail: { ...d, ...consumed } } };
    }
    const stale = await staleCheck(ctx, ep.n);
    if (stale.stale) return { kind: "refused", error: `stale_check.py --ep ${ep_} exited 1\n${stale.lines.join("\n")}`, patch: { picture_stage: "stale", stage_detail: { ...d, ...consumed } } };
    return { kind: "wait", for: "reframe", patch: { stage_detail: { ...d, ...consumed, reframe_override: { by: decision.by, at: decision.at, box, crop } } } };
  });
}
