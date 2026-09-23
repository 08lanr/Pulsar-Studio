// The narrated intake (narrated spec N1 stage 0, amendment 4): a new source
// episode becomes a project under `projects/high-quality/<slug>`.
//
//   1. What the source cannot default: the sheet premise, the season's key
//      and first number, a voice (defaulted from the last prior project's
//      narration manifest). Missing → wait `intake`; the answer is an
//      `intake` decision whose `settings` fold over the row's. A first
//      number a prior project already holds (lbl-e04 holds ep26–35, so 30
//      would ship a second ep30) waits the same way, naming that project.
//   2. The source: there, downloaded (not a OneDrive placeholder), a video
//      ffprobe reads, 16:9 (the route reframes a landscape source into
//      9:16; this reverses the cut-only intake's refusal).
//   3. The folder: new sources only. A folder that exists is driven only
//      when a Studio run made it (`.studio-scripts.json` at the film root);
//      a session's project (lbl-e03, lbl-e04) is refused, whatever the
//      settings say — there is no claim for the narrated route.
//   4. The lock `<film>/.studio-run.json`, taken only after the folder check.
//   5. The scripts synced from drama-remix `scripts/skip-through/` into
//      `<film>/scripts/`, the record `<film>/.studio-scripts.json`, the sha
//      and dirty flag on the row — first, before anything else lands in the
//      folder: its likely refusal (a dirty drama-remix tree, which other
//      sessions edit) then leaves only the lock, and the slug stays usable;
//      once it succeeds the record marks the folder as Studio's.
//   6. The source hardlinked (copied across volumes) to `source/original.mp4`
//      — the scripts take the first `source/*.mp4`, so one video only.
//   7. The season: `mklink /J` junctions `epK → <prior project>/epK` for every
//      earlier episode (ledger_check walks ep1..epN, continuity reads epN-1);
//      a junction, never a copy, never a write into the prior project.
//      `sheet_premise.txt` from the settings.
//   8. `checks.py --project <film> --strict`, run FROM the canonical copy.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { LockHeldError, STUDIO_RUN_LOCK_FILE } from "@/lib/locks";
import { readSyncRecord, ScriptsSyncError, SYNC_RECORD_FILE } from "@/lib/segment/scripts-sync";
import { missingNarratedSettings, NARRATED_BUCKET } from "@/lib/segment/settings";
import type { FilmRun, Json } from "@/lib/types";
import { isPlaceholder, linkOrCopy } from "../intake";
import { fail, next, readJson, type StageOutcome } from "../stages";
import { narratedRefusal, narratedRunLock, narratedWait, runFilmStep, writeProjectFile, type NarratedContext } from "./stages";

/** A film folder is Studio's to drive when a Studio run made it: its sync record is at the film root. */
export function studioMadeFolder(film: string): boolean {
  return readSyncRecord(film) !== null;
}

/** True when the film folder holds anything but Studio's own lock (a restarted run re-takes its lock; a bare lock left by a dead worker is not a session's work). */
export function folderInUse(film: string): boolean {
  try {
    return readdirSync(film).some((n) => n !== STUDIO_RUN_LOCK_FILE && !n.startsWith(`${STUDIO_RUN_LOCK_FILE}.`));
  } catch {
    return false;
  }
}

/** Why the run may not drive this folder, or null (amendment 4: new sources only; a session's project is never taken over). */
export function narratedFolderRefusal(run: Pick<FilmRun, "bucket" | "slug">, film: string): string | null {
  if (run.bucket !== NARRATED_BUCKET) return `a narrated run lives under projects/${NARRATED_BUCKET}/, not ${run.bucket}/`;
  if (!folderInUse(film)) return null;
  if (studioMadeFolder(film)) return null;
  return `${run.bucket}/${run.slug} already exists and no Studio run made it (no ${SYNC_RECORD_FILE}): a session's project. The narrated route in Studio takes new sources only; choose another slug.`;
}

/** The voice of the newest `epK/narration/manifest.json` in the last prior project that has one, or null. */
export function voiceFromPriorProjects(projectsRoot: string, prior: string[]): string | null {
  for (const p of [...prior].reverse()) {
    const dir = path.join(projectsRoot, ...p.split("/"));
    let eps: { n: number; file: string }[] = [];
    try {
      eps = readdirSync(dir)
        .map((name) => ({ m: /^ep(\d+)$/.exec(name), name }))
        .filter((x): x is { m: RegExpExecArray; name: string } => !!x.m)
        .map((x) => ({ n: Number(x.m[1]), file: path.join(dir, x.name, "narration", "manifest.json") }))
        .sort((a, b) => b.n - a.n);
    } catch {
      continue;
    }
    for (const e of eps) {
      const m = readJson<{ voice?: unknown }>(e.file);
      if (m && typeof m.voice === "string" && m.voice.trim()) return m.voice.trim();
    }
  }
  return null;
}

/** Every `epK` folder of the prior projects below `firstN`, the newest project winning a number, as `{n, target}` with the junction's real target. */
export function priorEpisodes(projectsRoot: string, prior: string[], firstN: number): { n: number; target: string; project: string }[] {
  const byN = new Map<number, { n: number; target: string; project: string }>();
  for (const p of prior) {
    const dir = path.join(projectsRoot, ...p.split("/"));
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^ep(\d+)$/.exec(name);
      if (!m) continue;
      const n = Number(m[1]);
      if (n >= firstN) continue;
      let target: string;
      try {
        target = realpathSync.native(path.join(dir, name));
        if (!statSync(target).isDirectory()) continue;
      } catch {
        continue;
      }
      byN.set(n, { n, target, project: p });
    }
  }
  return [...byN.values()].sort((a, b) => a.n - b.n);
}

/** The highest `epK` folder any prior project holds, with the project, or null. */
export function highestPriorEpisode(projectsRoot: string, prior: string[]): { n: number; project: string } | null {
  let best: { n: number; project: string } | null = null;
  for (const p of prior) {
    let names: string[] = [];
    try {
      names = readdirSync(path.join(projectsRoot, ...p.split("/")));
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^ep(\d+)$/.exec(name);
      if (m && (!best || Number(m[1]) > best.n)) best = { n: Number(m[1]), project: p };
    }
  }
  return best;
}

/** Why the season's first number cannot be this one, or null: a prior project already holds that number (a second epN of the season). */
export function firstNumberRefusal(projectsRoot: string, prior: string[], firstN: number): string | null {
  const top = highestPriorEpisode(projectsRoot, prior);
  if (!top || firstN > top.n) return null;
  return `season.first_episode_n is ${firstN}, but ${top.project} already holds ep${top.n}: the numbers continue at ${top.n + 1}. Answer the intake with first_episode_n ${top.n + 1} (or name the prior projects this source follows).`;
}

/** Make `<film>/epK` a junction to each prior episode; an existing one pointing at the same folder is kept, anything else there is a refusal. */
export function linkSeason(film: string, eps: { n: number; target: string }[]): { linked: number[]; kept: number[]; refused: string | null } {
  const linked: number[] = [];
  const kept: number[] = [];
  for (const e of eps) {
    const link = path.join(film, `ep${e.n}`);
    let st: import("node:fs").Stats | null = null;
    try {
      st = lstatSync(link);
    } catch {
      st = null;
    }
    if (st) {
      let same = false;
      try {
        same = realpathSync.native(link).toLowerCase() === e.target.toLowerCase();
      } catch {
        same = false;
      }
      if (same) {
        kept.push(e.n);
        continue;
      }
      return { linked, kept, refused: `${link} exists and is not the junction to ${e.target}: the season cannot be linked` };
    }
    // A directory junction needs no elevation on Windows (mklink /J); elsewhere a directory symlink.
    symlinkSync(e.target, link, process.platform === "win32" ? "junction" : "dir");
    linked.push(e.n);
  }
  return { linked, kept, refused: null };
}

export async function runNarratedIntakeStage(ctx: NarratedContext): Promise<StageOutcome> {
  const { run, paths, settings } = ctx;

  // 1. What the source cannot default.
  const priorVoice = voiceFromPriorProjects(paths.projects, settings.season.prior_projects);
  const missing = missingNarratedSettings(settings, priorVoice);
  if (missing.length) {
    return narratedWait("intake", { intake: { missing, voice_from_prior: priorVoice, note: "the intake waits for these; answer with an intake decision carrying the settings" } as unknown as Json });
  }
  const voice = settings.voice_id ?? priorVoice;
  // The season's numbers continue after the prior projects': a first number one of them already holds would ship a second
  // epN (the held-number rule only sees Studio's own rows).
  const numbering = settings.season.first_episode_n === null ? null : firstNumberRefusal(paths.projects, settings.season.prior_projects, settings.season.first_episode_n);
  if (numbering) return narratedWait("intake", { intake: { missing: ["season.first_episode_n"], problem: numbering, note: numbering } as unknown as Json });

  // 2. The source.
  const src = run.source_path.replace(/\//g, path.sep);
  let st: import("node:fs").Stats;
  try {
    st = statSync(src);
  } catch {
    return fail(`the source ${run.source_path} is not there any more; pick it again`);
  }
  if (!st.isFile()) return fail(`the source ${run.source_path} is not a file`);
  if (isPlaceholder({ size: st.size, blocks: typeof st.blocks === "number" ? st.blocks : null })) {
    return fail(`${run.source_path} is a OneDrive placeholder (${st.size} bytes on record, nothing on disk): open it once so OneDrive downloads it, then retry`);
  }
  const facts = await ctx.runner.probe(src);
  if (!facts) return fail(`ffprobe could not read ${run.source_path}: not a video Studio can open (FFPROBE_PATH / FFMPEG_PATH name the binary)`);
  if (facts.width <= facts.height) {
    return fail(`${path.basename(src)} is ${facts.width}×${facts.height}: the narrated route reframes a 16:9 source into 9:16. A vertical film goes through the cut-only route.`);
  }

  // 3. The folder: new sources only.
  const refusal = narratedFolderRefusal(run, paths.film);
  if (refusal) return fail(refusal);

  // 4. The lock, only now.
  try {
    ctx.lock();
  } catch (e) {
    if (e instanceof LockHeldError) return fail(e.message);
    throw e;
  }
  mkdirSync(paths.work, { recursive: true });

  // 5. The scripts, before the source and the junctions: a refusal here leaves nothing in the folder but the lock.
  let sync;
  try {
    sync = ctx.sync(paths.film, { allowDirty: settings.allow_dirty });
  } catch (e) {
    if (e instanceof ScriptsSyncError) return fail(e.message, { sync_refused: e.code });
    return fail(`could not sync the skip-through scripts: ${(e as Error).message}`);
  }
  ctx.log(`scripts synced from ${sync.source} @ ${sync.sha.slice(0, 12)}${sync.dirty ? " (dirty tree, allowed)" : ""}: ${sync.files.length} files`);

  // 6. The source: one video under source/.
  const sourceDir = path.dirname(paths.source);
  mkdirSync(sourceDir, { recursive: true });
  const others = readdirSync(sourceDir).filter((f) => /\.mp4$/i.test(f) && f !== "original.mp4");
  if (others.length) return fail(`${sourceDir} holds ${others.join(", ")} beside original.mp4: the scripts take the first source/*.mp4, so a narrated project keeps one video there`);
  let placed: "linked" | "copied" | "existing";
  if (existsSync(paths.source)) {
    const have = statSync(paths.source);
    if (have.size !== st.size) return fail(`${paths.source} already exists with a different size (${have.size} bytes there, ${st.size} picked): this folder belongs to another source. Choose another slug.`);
    placed = "existing";
  } else {
    try {
      placed = linkOrCopy(src, paths.source);
    } catch (e) {
      return fail(`could not place the source at ${paths.source}: ${(e as Error).message}`);
    }
  }
  const source = { path: run.source_path, placed, bytes: st.size, width: facts.width, height: facts.height, fps: facts.fps, duration_s: facts.duration_s, frames: facts.frames };
  ctx.log(`source ${placed}: ${paths.source} (${facts.width}×${facts.height} @ ${facts.fps} fps${facts.duration_s ? `, ${Math.round(facts.duration_s)} s` : ""})`);
  await ctx.progress({ source: source as unknown as Json });

  // 7. The season's earlier episodes, junctioned in read-only.
  const firstN = settings.season.first_episode_n ?? 1;
  const prior = priorEpisodes(paths.projects, settings.season.prior_projects, firstN);
  const missingPrior: number[] = [];
  for (let n = 1; n < firstN; n++) if (!prior.some((p) => p.n === n)) missingPrior.push(n);
  const season = linkSeason(paths.film, prior);
  if (season.refused) return fail(season.refused);
  const warnings: string[] = [];
  if (missingPrior.length) warnings.push(`no prior project holds ep${missingPrior.join(", ep")}: ledger_check walks ep1..epN and continuity reads the episode before, so those checks will say so`);

  // The sheet premise.
  const premise = settings.sheet_premise ?? "";
  const premiseFile = path.join(paths.film, "sheet_premise.txt");
  if (!existsSync(premiseFile) || readFileSync(premiseFile, "utf8") !== premise) {
    writeProjectFile(ctx, "sheet_premise.txt", premise, { by: "studio", why: "the sheet premise from the run's settings (spec N2: reproducible, not a Temp args file)" });
  }

  // 8. The pipeline's own audit of the copy, from the canonical folder.
  const checks = await runFilmStep(ctx, { script: path.join(ctx.canonicalScripts, "checks.py"), args: ["--project", paths.film, "--strict"], what: "checks --strict" });
  if (checks.code !== 0) return fail(narratedRefusal({ script: "checks.py" }, checks));

  return next(
    "index",
    {
      source: source as unknown as Json,
      warnings,
      scripts: { sha: sync.sha, dirty: sync.dirty, files: sync.files.length, source: sync.source, route: "skip-through" },
      season: { series_key: settings.season.series_key, first_episode_n: firstN, linked: season.linked, kept: season.kept, prior: prior.map((p) => ({ n: p.n, project: p.project })) } as unknown as Json,
      voice: { id: voice, from: settings.voice_id ? "settings" : "prior manifest" },
    },
    { drama_remix_sha: sync.sha, drama_remix_dirty: sync.dirty }
  );
}
