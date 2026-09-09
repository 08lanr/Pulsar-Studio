// Render one creative into the finished ad file the producer approves and
// the launch uploads (decision 2026-09-09): the chosen range cut from the
// episode's source video, framed 9:16 at 1080×1920, the hook burned in over
// the opening seconds. ffmpeg does the work through the same subtitles
// filter the subtitle studio already uses (libass; proven on this machine),
// so no font-file plumbing is needed for the hook text.
//
// The output is stored beside the episode (`<title>/<episode>/ad-<pc_>-v<n>.mp4`)
// and hashed; the approval manifest freezes that hash and the launch refuses
// bytes that do not match it. Without ffmpeg nothing is rendered: the
// creative keeps render_path null and the launch gate says so.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { putStoredBytes, readStoredBytes } from "@/lib/data/storage";
import { srtTime } from "@/lib/export/time";
import type { PromoCreative } from "@/lib/types";

export const AD_WIDTH = 1080;
export const AD_HEIGHT = 1920;
/** How long the hook stays on screen. */
const HOOK_MS = 3000;
const RENDER_TIMEOUT_MS = 5 * 60 * 1000;

const availStore = globalThis as unknown as { __studioFfmpeg?: { at: number; ok: boolean } };

/** Is ffmpeg on PATH? Cached for a minute; PROMO_RENDER=off reports false (tests, machines without it). */
export async function ffmpegAvailable(): Promise<boolean> {
  if (process.env.PROMO_RENDER === "off") return false;
  const hit = availStore.__studioFfmpeg;
  if (hit && Date.now() - hit.at < 60_000) return hit.ok;
  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn("ffmpeg", ["-version"]);
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
  availStore.__studioFfmpeg = { at: Date.now(), ok };
  return ok;
}

/** ffmpeg's subtitles= filter parses its argument, so Windows paths need the drive colon escaped. */
function ffPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

function srtEscape(s: string): string {
  return s.replace(/\r?\n/g, " ").trim();
}

export type RenderedAd = { render_path: string; render_sha256: string; duration_ms: number; width: number; height: number; bytes: number };

/**
 * Cut + frame + hook. `sourcePath` is the episode's stored video path;
 * `storedDir` is the `<title>/<episode>` prefix the output lands under.
 */
export async function renderAd(creative: PromoCreative, sourcePath: string, storedDir: string): Promise<RenderedAd> {
  const start = creative.source_start_ms ?? 0;
  const end = creative.source_end_ms ?? start + 15_000;
  if (end <= start) throw new Error("the clip range is empty");
  const work = path.join(tmpdir(), `studio-ad-${creative.id}`);
  await mkdir(work, { recursive: true });
  const src = path.join(work, `source${path.extname(sourcePath) || ".mp4"}`);
  const hookSrt = path.join(work, "hook.srt");
  const out = path.join(work, "ad.mp4");
  try {
    await writeFile(src, await readStoredBytes(sourcePath));
    const hook = srtEscape(creative.hook);
    await writeFile(hookSrt, hook ? `1\n${srtTime(0)} --> ${srtTime(Math.min(HOOK_MS, end - start))}\n${hook}\n` : "", "utf-8");
    // Fill the 9:16 frame (scale up to cover, then center-crop), then the hook: bold, top third, outlined.
    const frame = `scale=${AD_WIDTH}:${AD_HEIGHT}:force_original_aspect_ratio=increase,crop=${AD_WIDTH}:${AD_HEIGHT}`;
    const style = "FontName=Arial,FontSize=30,Bold=1,Alignment=8,PrimaryColour=&H00FFFFFF,OutlineColour=&HAA000000,BorderStyle=1,Outline=2.5,Shadow=1,MarginV=140,MarginL=60,MarginR=60";
    const vf = hook ? `${frame},subtitles='${ffPath(hookSrt)}':force_style='${style}'` : frame;
    await run(["-y", "-ss", (start / 1000).toFixed(3), "-to", (end / 1000).toFixed(3), "-i", src, "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "128k", out]);
    const bytes = await readFile(out);
    const render_sha256 = createHash("sha256").update(bytes).digest("hex");
    const stored = `${storedDir}/ad-${creative.external_id}-v${creative.version}.mp4`;
    await putStoredBytes(stored, bytes, "video/mp4");
    return { render_path: stored, render_sha256, duration_ms: end - start, width: AD_WIDTH, height: AD_HEIGHT, bytes: bytes.length };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

function run(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const p = spawn("ffmpeg", args);
    let err = "";
    p.stderr.on("data", (d) => (err += String(d)));
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error("the render timed out after 5 minutes"));
    }, RENDER_TIMEOUT_MS);
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error((e as NodeJS.ErrnoException).code === "ENOENT" ? "ffmpeg is not installed on this machine" : `could not run ffmpeg: ${e.message}`));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`render failed: ${err.slice(-400) || `exit ${code}`}`));
    });
  });
}
