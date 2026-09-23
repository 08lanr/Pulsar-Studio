// What the review screens may read of a run's film (plan B3, "serving
// images and clips"): `.png`, `.json` and `.mp4` under the film's
// `cut/review/` and `cut/index/`, and under Studio's own work folder for the
// run (`STUDIO_WORK_DIR/<run id>/`: proxy clips, dense strips, QA copies).
// Nothing else — not an episode file, not the source, not another film — and
// never through `localPathOf`, which stays the local tier's rule. A proxy
// clip (±5 s around a time, 480 px wide) is made by ffmpeg from the source
// into the work folder on first request, never into projects/.

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { BAD_SEGMENT_CHARS } from "@/lib/data/storage";
import type { FilmRun } from "@/lib/types";
import { runDirs, type Env, type PipelineRunner, type RunDirs } from "./stages";

export const EVIDENCE_AREAS = ["review", "index", "work"] as const;
export type EvidenceArea = (typeof EVIDENCE_AREAS)[number];
export const EVIDENCE_EXT = /\.(png|json|mp4)$/i;

export type EvidenceRef = { area: EvidenceArea; rel: string; abs: string };

/** The absolute file a request's segments name, or null when the path is not one the route serves. */
export function evidencePathOf(dirs: Pick<RunDirs, "cut" | "work">, segments: string[]): EvidenceRef | null {
  if (segments.length < 2) return null;
  if (segments.some((s) => !s || s === "." || s === ".." || BAD_SEGMENT_CHARS.test(s))) return null;
  const area = segments[0] as EvidenceArea;
  if (!EVIDENCE_AREAS.includes(area)) return null;
  const rel = segments.slice(1);
  if (!EVIDENCE_EXT.test(rel[rel.length - 1])) return null;
  const base = area === "work" ? dirs.work : path.join(dirs.cut, area);
  const abs = path.resolve(base, ...rel);
  const back = path.relative(base, abs);
  if (!back || back.startsWith("..") || path.isAbsolute(back)) return null;
  return { area, rel: rel.join("/"), abs };
}

/** The URL of one evidence file: `/api/film-runs/<id>/evidence/<area>/<rel>`. */
export function evidenceUrl(runId: string, area: EvidenceArea, rel: string): string {
  return `/api/film-runs/${runId}/evidence/${area}/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

/** A path relative to `cut/` (as options.json and qa.json write them: `review/frames/x.png`) → its URL, or null when it is not servable. */
export function cutRelUrl(runId: string, cutRel: string): string | null {
  const parts = cutRel.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const area = parts[0];
  if (area !== "review" && area !== "index") return null;
  if (!EVIDENCE_EXT.test(parts[parts.length - 1])) return null;
  return evidenceUrl(runId, area, parts.slice(1).join("/"));
}

// ---- proxy clips ------------------------------------------------------------------------------------------------------------

export const PROXY_HALF_WINDOW_S = 5;
const PROXY_NAME = /^t(\d+)_(\d{3})\.mp4$/;

/** `work/proxies/t<seconds>_<millis>.mp4`: the file name of the proxy around `t`. */
export function proxyName(t: number): string {
  const ms = Math.round(t * 1000);
  return `t${Math.floor(ms / 1000)}_${String(ms % 1000).padStart(3, "0")}.mp4`;
}

export function proxyTimeOf(name: string): number | null {
  const m = PROXY_NAME.exec(name);
  return m ? Number(m[1]) + Number(m[2]) / 1000 : null;
}

export function proxyUrl(runId: string, t: number): string {
  return evidenceUrl(runId, "work", `proxies/${proxyName(t)}`);
}

const inFlight = new Map<string, Promise<string>>();

/** The proxy clip around `t` for the run, made on first request (one ffmpeg per file at a time); its absolute path. */
export function ensureProxy(run: Pick<FilmRun, "id" | "bucket" | "slug">, t: number, runner: PipelineRunner, env: Env = process.env): Promise<string> {
  const dirs = runDirs(run, env);
  const out = path.join(dirs.work, "proxies", proxyName(t));
  if (existsSync(out)) return Promise.resolve(out);
  const have = inFlight.get(out);
  if (have) return have;
  const p = (async () => {
    mkdirSync(path.dirname(out), { recursive: true });
    await runner.proxy(dirs.source, t, out);
    return out;
  })().finally(() => inFlight.delete(out));
  inFlight.set(out, p);
  return p;
}
