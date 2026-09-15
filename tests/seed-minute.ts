// Test helper: build the founder's minute through the REAL pipeline on the
// empty V2.1 seed — create the title, ingest docs/demo/xiangyuan-ep1.srt,
// and (optionally) run the demo replay. What the tests exercise is exactly
// what the demo does.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fixtureSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { replayFirstPass } from "@/lib/demo-replay";
import { putStoredBytes } from "@/lib/data/storage";
import { ingestEpisodeFile } from "@/lib/ingest";
import type { Clip, Title } from "@/lib/types";

export const producer = () => fixtureSession("producer");
export const staff = () => fixtureSession("staff");

/**
 * `n` finished ad clips on an episode (decision 2026-09-14): rows through
 * upsertClips, each rendered to its own small stored file whose sha256 is
 * recorded, so Generate ads and the fake launch treat them as real cuts.
 */
export async function seedRenderedClips(titleId: string, episodeId: string, n: number): Promise<Clip[]> {
  const rows = await fixtureData.upsertClips(staff(), episodeId, Array.from({ length: n }, (_, i) => ({
    rank: i + 1, start_ms: i * 30_000, end_ms: i * 30_000 + 25_000, scene_ids: [],
    hook_en: `Hook ${i + 1}: the line that needs no setup`, why_en: `Moment ${i + 1} works with zero context.`, why_zh: `第 ${i + 1} 个瞬间无需铺垫。`,
    source: "script" as const, moment: i === 0 ? ("opening" as const) : ("peak" as const),
  })));
  const out: Clip[] = [];
  for (const clip of rows) {
    const bytes = Buffer.from(`fake finished clip ${clip.external_id}`);
    const stored = `${titleId}/${episodeId}/clip-${clip.external_id}.mp4`;
    await putStoredBytes(stored, bytes, "video/mp4");
    out.push(await fixtureData.setClipRender(fixtureSession("staff"), clip.id, { render_status: "rendered", render_path: stored, render_sha256: createHash("sha256").update(bytes).digest("hex"), duration_ms: 25_000, width: 1080, height: 1920 }));
  }
  return out;
}

export async function seedMinute(opts: { adapt?: boolean } = {}): Promise<Title> {
  resetFixtureStore();
  const title = await fixtureData.createTitle(producer(), {
    name_zh: "向园",
    name_en: "Xiang Yuan",
    producer_id: "ignored-for-producers",
    character_notes: "董事长是向园的爷爷；杨总来访，总觉得向园面熟。",
  });
  const srt = readFileSync(path.join(process.cwd(), "docs", "demo", "xiangyuan-ep1.srt"));
  const ingest = ingestEpisodeFile(new Uint8Array(srt), "xiangyuan-ep1.srt");
  await fixtureData.addEpisodeFromIngest(producer(), title.id, 1, ingest, {
    subtitlePath: null,
    videoPath: null,
  });
  if (opts.adapt) await replayFirstPass(producer(), title.id, 1);
  return title;
}
