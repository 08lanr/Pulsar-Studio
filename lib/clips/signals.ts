// What the footage itself says, read with ffmpeg (decision 2026-09-14): the
// duration, where the picture cuts, and how loud each moment is. The
// parsing is pure and lives in lib/clips/footage.ts; this file only runs
// the probes. Every probe works on the materialized source file (see
// lib/clips/cut.ts withSourceFile).

import { parseDurationMs, parseLoudness, parseSceneCuts, type LoudnessSample } from "./footage";
import { runFfmpeg } from "./cut";

const PROBE_TIMEOUT_MS = 3 * 60 * 1000;

/** The container duration from ffmpeg's input dump (ffmpeg exits non-zero without an output; that is fine). */
export async function probeDurationMs(srcAbs: string): Promise<number | null> {
  const err = await runFfmpeg(["-hide_banner", "-i", srcAbs], { timeoutMs: PROBE_TIMEOUT_MS, tolerateExit: true });
  return parseDurationMs(err);
}

/** Seconds at which the picture changes enough to count as a cut. */
export async function sceneCuts(srcAbs: string, threshold = 0.3): Promise<number[]> {
  const err = await runFfmpeg(["-hide_banner", "-i", srcAbs, "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"], { timeoutMs: PROBE_TIMEOUT_MS });
  return parseSceneCuts(err);
}

/** Momentary loudness (EBU R128, one sample per 100 ms) over the whole file. */
export async function loudness(srcAbs: string): Promise<LoudnessSample[]> {
  const err = await runFfmpeg(["-hide_banner", "-i", srcAbs, "-vn", "-af", "ebur128=peak=none", "-f", "null", "-"], { timeoutMs: PROBE_TIMEOUT_MS });
  return parseLoudness(err);
}
