// Render one creative into the finished ad file the producer approves and
// the launch uploads (decision 2026-09-09): the chosen range cut from the
// episode's source video, framed 9:16 at 1080×1920. Since 2026-09-14 the
// cut is the shared clip renderer (lib/clips/cut.ts), the same one the
// auto-cut ad clips use, and nothing is burned into the picture any more:
// the hook is the ad's text, not an overlay (founders, 2026-09-14).
//
// The output is stored beside the episode (`<title>/<episode>/ad-<pc_>-v<n>.mp4`)
// and hashed; the approval manifest freezes that hash and the launch refuses
// bytes that do not match it. Without ffmpeg nothing is rendered: the
// creative keeps render_path null and the launch gate says so.

import { spawn } from "node:child_process";
import { cutClip, ffmpegBin, withSourceFile, type RenderedAd } from "@/lib/clips/cut";
import type { PromoCreative } from "@/lib/types";

export { AD_WIDTH, AD_HEIGHT, type RenderedAd } from "@/lib/clips/cut";

const availStore = globalThis as unknown as { __studioFfmpeg?: { at: number; ok: boolean } };

/** Is ffmpeg on PATH? Cached for a minute; PROMO_RENDER=off reports false (tests, machines without it). */
export async function ffmpegAvailable(): Promise<boolean> {
  if (process.env.PROMO_RENDER === "off") return false;
  const hit = availStore.__studioFfmpeg;
  if (hit && Date.now() - hit.at < 60_000) return hit.ok;
  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn(ffmpegBin(), ["-version"]);
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
  availStore.__studioFfmpeg = { at: Date.now(), ok };
  return ok;
}

/**
 * Cut + frame + hook. `sourcePath` is the episode's stored video path;
 * `storedDir` is the `<title>/<episode>` prefix the output lands under.
 */
export async function renderAd(creative: PromoCreative, sourcePath: string, storedDir: string): Promise<RenderedAd> {
  const start = creative.source_start_ms ?? 0;
  const end = creative.source_end_ms ?? start + 15_000;
  if (end <= start) throw new Error("the clip range is empty");
  return withSourceFile(sourcePath, (srcAbs, workDir) =>
    cutClip({ srcAbs, workDir, startMs: start, endMs: end, storedPath: `${storedDir}/ad-${creative.external_id}-v${creative.version}.mp4` })
  );
}
