// Burn the adapted English subtitles into the episode's video (2026-09-04,
// docs/decisions.md "subtitles, not dubbing"): the deliverable a producer
// can post or send — their footage, our English on it. ffmpeg's subtitles
// filter over the episode's source video; the original audio is untouched.
//
// Fixture-mode only (the bytes and ffmpeg are local). The output is stored
// beside the source and returned as a download URL; the episode keeps
// pointing at its clean source video.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Session } from "@/lib/auth";
import { DataError, getData } from "@/lib/data";
import { mediaUrl, resolveUploadPath, storagePath } from "@/lib/data/storage";
import { dataSource } from "@/lib/data-source";
import { toSrt } from "@/lib/export";
import type { SnapshotScene } from "@/lib/types";

export type SubtitleVideoResult = { video_url: string; lines: number };

// The style the producer picks in the subtitle studio; the same choices
// drive the on-page preview (CSS) and the burn (libass force_style).
export type SubtitleStyle = {
  /** en = English only; en_zh = English with the Chinese original beneath. */
  layout: "en" | "en_zh";
  font: "sans" | "serif";
  size: "s" | "m" | "l";
};
export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = { layout: "en", font: "sans", size: "m" };

// Bilingual burns need a font with CJK glyphs; the Latin-only faces would
// draw tofu for the Chinese line.
const FONTS: Record<SubtitleStyle["font"], Record<SubtitleStyle["layout"], string>> = {
  sans: { en: "Arial", en_zh: "Microsoft YaHei" },
  serif: { en: "Georgia", en_zh: "SimSun" },
};
const SIZES: Record<SubtitleStyle["size"], { fontSize: number; marginV: number }> = {
  s: { fontSize: 12, marginV: 24 },
  m: { fontSize: 15, marginV: 28 },
  l: { fontSize: 18, marginV: 32 },
};

/** The SRT for a layout; exported for the studio preview tests. */
export function styledSrt(scenes: SnapshotScene[], layout: SubtitleStyle["layout"]): string {
  const lines = scenes.flatMap((sc) => sc.adapted_lines);
  const sources = scenes.flatMap((sc) => sc.lines);
  if (layout === "en") return toSrt(lines, sources);
  const byId = new Map(sources.map((src) => [src.id, src]));
  const bilingual = lines.map((l) => {
    const zh = l.line_id ? byId.get(l.line_id)?.text_zh : null;
    return { ...l, text_en: l.text_en && zh ? `${l.text_en}
${zh}` : l.text_en };
  });
  return toSrt(bilingual, sources);
}

/** ffmpeg's subtitles= filter parses its argument, so Windows paths need the drive colon escaped. */
function ffPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

export async function renderSubtitledVideo(
  session: Session,
  titleId: string,
  episodeNumber: number,
  style: SubtitleStyle = DEFAULT_SUBTITLE_STYLE
): Promise<SubtitleVideoResult> {
  if (dataSource() !== "fixture") {
    throw new DataError("invalid", "the subtitled-video render runs in fixture mode only (video bytes and ffmpeg are local)");
  }
  const data = getData();
  const snap = await data.getExportSnapshot(session, titleId, episodeNumber);
  const wb = await data.getWorkbench(session, titleId, episodeNumber);
  const source = wb.episode.video_path;
  if (!source) throw new DataError("invalid", "this episode has no video — upload one first");
  if (!wb.episode.has_timecodes) throw new DataError("invalid", "subtitles need a timed episode");

  const srt = styledSrt(snap.snapshot.scenes, style.layout);
  if (!srt.trim()) throw new DataError("invalid", "no adapted lines to burn — generate the adaptation first");

  const srtFile = path.join(tmpdir(), `studio-subs-${wb.episode.id}.srt`);
  await writeFile(srtFile, srt, "utf-8");

  const stored = storagePath(titleId, wb.episode.id, `subtitled-${Date.now().toString(36)}.mp4`);
  const outAbs = resolveUploadPath(stored);
  await mkdir(path.dirname(outAbs), { recursive: true });
  const videoAbs = resolveUploadPath(source);

  // A quiet, cinematic base: white with a soft outline, no box; face and
  // size from the producer's picks in the subtitle studio.
  const face = FONTS[style.font][style.layout];
  const dims = SIZES[style.size];
  const forceStyle = `FontName=${face},FontSize=${dims.fontSize},PrimaryColour=&H00FFFFFF,OutlineColour=&H66000000,BorderStyle=1,Outline=1.2,Shadow=0.6,MarginV=${dims.marginV}`;
  const vf = `subtitles='${ffPath(srtFile)}':force_style='${forceStyle}'`;

  await new Promise<void>((resolve, reject) => {
    const p = spawn("ffmpeg", ["-y", "-i", videoAbs, "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "copy", outAbs]);
    let err = "";
    p.stderr.on("data", (d) => (err += String(d)));
    const timer = setTimeout(() => {
      p.kill();
      reject(new DataError("invalid", "the render timed out after 5 minutes"));
    }, 5 * 60 * 1000);
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(new DataError("invalid", `could not run ffmpeg: ${e.message}`));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new DataError("invalid", `render failed: ${err.slice(-400) || `exit ${code}`}`));
    });
  });

  const cueCount = srt.trim().split(/\r?\n\r?\n/).length;
  return { video_url: mediaUrl(stored)!, lines: cueCount };
}
