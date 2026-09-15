// Real-ffmpeg smoke run of the clip engine on the demo episode (decision
// 2026-09-14). Fixture mode, empty seed, no model key needed: the footage
// path selects, the cutter renders, and the finished files are probed.
//   npx tsx scripts/clips-smoke.ts            (video only → footage path)
//   npx tsx scripts/clips-smoke.ts --srt      (with subtitles; in replay mode still the footage path)
// FFMPEG_PATH=<abs path to ffmpeg.exe> when ffmpeg is not on PATH.

process.env.DATA_SOURCE = "fixture";
process.env.FIXTURE_SEED = "empty";
delete process.env.PROMO_RENDER;

import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixtureSession } from "@/lib/auth";
import { cutEpisodeClips } from "@/lib/clips/run";
import { ffmpegBin } from "@/lib/clips/cut";
import { getData } from "@/lib/data";
import { resolveUploadPath, uploadMedia } from "@/lib/data/storage";
import { ingestEpisodeFile } from "@/lib/ingest";

async function main() {
  const data = getData();
  const producer = fixtureSession("producer");
  const title = await data.createTitle(producer, { name_zh: "向园", name_en: "Xiang Yuan", producer_id: "ignored" });
  const bytes = new Uint8Array(readFileSync(path.join(process.cwd(), "docs/demo/xiangyuan-ep1.mp4")));
  const videoPath = await uploadMedia(title.id, "smoke", "xiangyuan-ep1.mp4", bytes, "video/mp4");
  if (process.argv.includes("--srt")) {
    const srt = ingestEpisodeFile(new Uint8Array(readFileSync(path.join(process.cwd(), "docs/demo/xiangyuan-ep1.srt"))), "xiangyuan-ep1.srt");
    await data.addEpisodeFromIngest(producer, title.id, 1, srt, { subtitlePath: null, videoPath });
  } else {
    await data.addVideoOnlyEpisode(producer, title.id, 1, videoPath);
  }
  const t0 = Date.now();
  const r = await cutEpisodeClips(title.id, 1);
  console.log("run:", JSON.stringify(r), `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const clips = await data.listEpisodeClips(producer, title.id, 1);
  for (const c of clips) {
    const line = `#${c.rank} ${c.moment} ${(c.start_ms / 1000).toFixed(1)}-${(c.end_ms / 1000).toFixed(1)}s ${c.render_status}${c.render_note ? ` (${c.render_note})` : ""} hook="${c.hook_en}"`;
    if (c.render_status !== "rendered" || !c.render_path) { console.log(line); continue; }
    const abs = resolveUploadPath(c.render_path);
    const probe = spawnSync(ffmpegBin(), ["-hide_banner", "-i", abs], { encoding: "utf8" }).stderr;
    const dur = probe.match(/Duration: ([\d:.]+)/)?.[1];
    const video = probe.match(/Video: (\w+).*?, (\d+x\d+)/);
    const audio = probe.match(/Audio: (\w+)/)?.[1];
    console.log(`${line}\n    file=${c.render_path} duration=${dur} video=${video?.[1]} ${video?.[2]} audio=${audio} sha=${c.render_sha256?.slice(0, 12)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
