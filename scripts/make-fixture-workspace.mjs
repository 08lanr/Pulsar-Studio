// Regenerates the media of the checked-in fixture workspace under
// tests/fixtures/workspace/ (decision 2026-09-22, "the workspace import"):
// three tiny films the scanner and the import e2e read as if they were the
// pipeline's. The JSON and text beside them (the delivered plan, the index,
// the vision record, film-meta.json) are hand-written and committed; this
// script writes only the mp4s and the poster, deterministically (testsrc2 +
// a sine tone, x264 on one thread, bitexact, no metadata), so a rerun
// changes nothing and `git status` stays clean.
//
//   node scripts/make-fixture-workspace.mjs
//
// Needs ffmpeg on PATH or FFMPEG_PATH. Every file stays under 150 KB.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ffmpeg = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const root = path.join(process.cwd(), "tests", "fixtures", "workspace");

/** 720x1280 at 30 fps, `seconds` long, capped at 80 kbit/s so a 6 s file is about 90 KB. */
function clip(out, seconds) {
  mkdirSync(path.dirname(out), { recursive: true });
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", String(seconds), "-threads", "1",
    "-c:v", "libx264", "-preset", "veryslow", "-b:v", "80k", "-maxrate", "80k", "-bufsize", "160k", "-g", "60", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "16k", "-ac", "1",
    "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
    "-movflags", "+faststart",
    out,
  ];
  const r = spawnSync(ffmpeg, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${out}`);
  const bytes = statSync(out).size;
  if (bytes > 150_000) throw new Error(`${out} is ${bytes} bytes; the fixture must stay under 150 KB`);
  console.log(`${path.relative(process.cwd(), out)}  ${bytes} bytes`);
}

/** A 120x160 poster, a few KB. */
function poster(out) {
  mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=120x160:rate=1", "-frames:v", "1", "-q:v", "20", "-map_metadata", "-1", "-fflags", "+bitexact", out], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${out}`);
  console.log(`${path.relative(process.cwd(), out)}  ${statSync(out).size} bytes`);
}

// fixture-film: three delivered episodes, 4 + 5 + 6 s (the plan says 0-4, 4-9, 9-15).
const fixture = path.join(root, "low-quality", "fixture-film");
clip(path.join(fixture, "cut", "eps", "ep01.mp4"), 4);
clip(path.join(fixture, "cut", "eps", "ep02.mp4"), 5);
clip(path.join(fixture, "cut", "eps", "ep03.mp4"), 6);
poster(path.join(fixture, "poster", "final", "fixture-film-a.jpg"));

// rendering-film: ep01 done, ep02 still being written (a truncated `.part.mp4`, as cut_episodes.py leaves mid-render).
const rendering = path.join(root, "low-quality", "rendering-film");
clip(path.join(rendering, "cut", "eps", "ep01.mp4"), 4);
const partSrc = path.join(rendering, "cut", "eps", "ep02.part.mp4");
clip(partSrc, 3);
writeFileSync(partSrc, readFileSync(partSrc).subarray(0, 20_000));
console.log(`${path.relative(process.cwd(), partSrc)}  truncated to 20000 bytes`);

// undelivered-film: two episodes on disk, no DELIVERED plan yet.
const undelivered = path.join(root, "low-quality", "undelivered-film");
clip(path.join(undelivered, "cut", "eps", "ep01.mp4"), 4);
clip(path.join(undelivered, "cut", "eps", "ep02.mp4"), 4);
