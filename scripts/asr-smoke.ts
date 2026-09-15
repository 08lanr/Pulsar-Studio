// Real-whisper smoke run of the transcription path on a demo episode
// (decision 2026-09-15). Fixture mode, empty seed, no API key: the
// local-whisper provider reads the audio, the cues attach through the
// normal ingest path, and — when the episode has a reference SRT — the
// transcript is scored against it (character overlap and timing drift).
//   npx tsx scripts/asr-smoke.ts                          (Mandarin demo minute)
//   npx tsx scripts/asr-smoke.ts docs/demo/idiots-in-cars/ep2.mp4   (any video)
// STUDIO_ASR_PYTHON=<python with faster-whisper>; STUDIO_ASR_MODEL=small by default.

process.env.DATA_SOURCE = "fixture";
process.env.FIXTURE_SEED = "empty";
process.env.FIXTURE_PERSIST = "off";
process.env.PROMO_RENDER = "off"; // the clip re-cut is not what this smoke measures
process.env.STUDIO_ASR_PROVIDER = process.env.STUDIO_ASR_PROVIDER || "local-whisper";

import { readFileSync } from "node:fs";
import path from "node:path";
import { runTranscribeEpisode } from "@/lib/asr";
import { fixtureSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { uploadMedia } from "@/lib/data/storage";
import { ingestEpisodeFile } from "@/lib/ingest";

const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;

async function main() {
  const videoArg = process.argv[2] ?? "docs/demo/xiangyuan-ep1.mp4";
  const refPath = videoArg.includes("xiangyuan") ? "docs/demo/xiangyuan-ep1.srt" : null;

  const data = getData();
  const producer = fixtureSession("producer");
  const title = await data.createTitle(producer, { name_zh: "转写冒烟测试", name_en: "ASR smoke", producer_id: "ignored" });
  const bytes = new Uint8Array(readFileSync(path.join(process.cwd(), videoArg)));
  const videoPath = await uploadMedia(title.id, "smoke", path.basename(videoArg), bytes, "video/mp4");
  await data.addVideoOnlyEpisode(producer, title.id, 1, videoPath);

  const t0 = Date.now();
  const r = await runTranscribeEpisode(producer, title.id, 1);
  console.log(`transcribed in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, JSON.stringify(r.summary), r.warnings.length ? `warnings: ${r.warnings.join("; ")}` : "no warnings");

  const wb = await data.getWorkbench(producer, title.id, 1);
  for (const l of wb.lines) console.log(`  ${mmss(l.start_ms ?? 0)} → ${mmss(l.end_ms ?? 0)}  ${l.text_zh}`);

  if (refPath) {
    const ref = ingestEpisodeFile(new Uint8Array(readFileSync(path.join(process.cwd(), refPath))), path.basename(refPath));
    const strip = (s: string) => s.replace(/[\s，。！？、：；「」『』（）()\[\]…·—～\-,.!?:;"']+/g, "");
    const refText = strip(ref.lines.map((l) => l.text_zh.replace(/^[^：:]{1,6}[：:]/, "")).join(""));
    const gotText = strip(wb.lines.map((l) => l.text_zh).join(""));
    const refChars = new Map<string, number>();
    for (const ch of refText) refChars.set(ch, (refChars.get(ch) ?? 0) + 1);
    let hit = 0;
    for (const ch of gotText) {
      const left = refChars.get(ch) ?? 0;
      if (left > 0) { hit++; refChars.set(ch, left - 1); }
    }
    const recall = refText.length ? hit / refText.length : 0;
    const starts = wb.lines.map((l) => l.start_ms ?? 0);
    const refStarts = ref.lines.map((l) => l.start_ms ?? 0);
    const drift = refStarts.map((t) => Math.min(...starts.map((s) => Math.abs(s - t)))).sort((a, b) => a - b);
    console.log(`reference: ${ref.lines.length} lines, ${refText.length} chars`);
    console.log(`character recall vs reference: ${(recall * 100).toFixed(1)}%`);
    console.log(`nearest-cue start drift: median ${drift[Math.floor(drift.length / 2)]}ms, p90 ${drift[Math.floor(drift.length * 0.9)]}ms`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
