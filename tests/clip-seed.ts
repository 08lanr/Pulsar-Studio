// Shared setup for the organic clip-posting tests: a company with rendered
// clips on real stored files, and an assigned Meta account. Everything goes
// through the real data layer, so the fixture guards under test are the ones
// the routes use.

import { readFileSync } from "node:fs";
import path from "node:path";
import { FIXTURE_PRODUCER_ID, fixtureSession, type Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { fixtureData } from "@/lib/data/fixture";
import { ingestEpisodeFile } from "@/lib/ingest";
import type { LaunchConnection } from "@/lib/launch/types";
import type { Clip, Episode, Title } from "@/lib/types";
import { seedRenderedClips, staff } from "./seed-minute";

export type SeededTitle = { title: Title; episodes: Episode[]; clips: Clip[] };

const script = () => new Uint8Array(readFileSync(path.join(process.cwd(), "docs", "demo", "xiangyuan-ep1.srt")));

/** A title with `episodes` episodes, each carrying `clipsPerEpisode` finished clips. */
export async function seedClipTitle(session: Session, producerId: string, name: string, opts: { episodes?: number; clipsPerEpisode?: number } = {}): Promise<SeededTitle> {
  const title = await fixtureData.createTitle(session, { name_zh: name, name_en: name, producer_id: producerId });
  const ingest = ingestEpisodeFile(script(), "xiangyuan-ep1.srt");
  const episodes: Episode[] = [];
  const clips: Clip[] = [];
  for (let n = 1; n <= (opts.episodes ?? 1); n++) {
    const episode = await fixtureData.addEpisodeFromIngest(session, title.id, n, ingest, { subtitlePath: null, videoPath: null });
    episodes.push(episode);
    clips.push(...await seedRenderedClips(title.id, episode.id, opts.clipsPerEpisode ?? 2));
  }
  return { title, episodes, clips };
}

/** An enabled Meta account for a company, with a Page and an Instagram identity. */
export function assignMeta(producerId: string, opts: { instagram?: boolean; page?: boolean; index?: number } = {}): Promise<LaunchConnection> {
  const index = opts.index ?? 1;
  return getData().assignLaunchConnection(staff(), {
    producer_id: producerId, provider: "meta", advertiser_id: `act_900000000000000${index}`,
    name: `Test Meta ${index}`, currency: "USD", timezone: "America/Los_Angeles",
    page_id: opts.page === false ? null : `900000000000001${index}`,
    instagram_id: opts.instagram === false ? null : `900000000000002${index}`,
    business_id: null, enabled: true,
  });
}

export const approver = () => fixtureSession("producer");
export const viewer = (): Session => ({ ...fixtureSession("producer"), producerRole: "viewer" });
export const reviewer = (): Session => ({ ...fixtureSession("producer"), producerRole: "reviewer" });
export const staffEditor = (): Session => ({ ...fixtureSession("staff"), staffRole: "editor" });
export const ownCompany = FIXTURE_PRODUCER_ID;
