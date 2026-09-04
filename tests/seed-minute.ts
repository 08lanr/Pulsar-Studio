// Test helper: build the founder's minute through the REAL pipeline on the
// empty V2.1 seed — create the title, ingest docs/demo/xiangyuan-ep1.srt,
// and (optionally) run the demo replay. What the tests exercise is exactly
// what the demo does.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fixtureSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { replayFirstPass } from "@/lib/demo-replay";
import { ingestEpisodeFile } from "@/lib/ingest";
import type { Title } from "@/lib/types";

export const producer = () => fixtureSession("producer");
export const staff = () => fixtureSession("staff");

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
