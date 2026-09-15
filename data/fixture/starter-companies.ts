// Starter companies (2026-09-15, Ruobin: "make sure to hand off the video
// and the company"): real footage committed with the repo so a cofounder
// who pulls gets the same second company Ruobin tested with, without a
// file transfer. Unlike the demo studio, a starter is seeded ONCE: after
// that the saved fixture state owns it (lib/data/fixture.ts
// mergeOtherCompanies), so campaigns built on it survive restarts and
// Reset demo. Its clips are cut by the real engine on first load
// (ensureStarterCuts), footage path, since there are no subtitles.
//
// Idiots in Cars: the first five minutes of a YouTube compilation Ruobin
// used for the launch test, split into five ~60 s episodes, re-encoded to
// 720p for the repository (docs/demo/idiots-in-cars/ep1..5.mp4).

import type { Adaptation, Episode, Producer, Title } from "@/lib/types";
import { STAFF_USER_ID, ext, uuid } from "./ids";

const B = { producer: 0x50, title: 0x51, episode: 0x52, adaptation: 0x53 } as const;
const AT = "2026-09-15T06:00:00.000Z";

export const IDIOTS_PRODUCER_ID = uuid(B.producer, 1);
export const IDIOTS_TITLE_ID = uuid(B.title, 1);
const IDIOTS_EPISODES = 5;

export type StarterSeed = {
  producers: Producer[];
  titles: Title[];
  episodes: Episode[];
  adaptations: Adaptation[];
  /** Stored video path -> file in the repository the fixture store links it from. */
  media: Record<string, string>;
};

export function buildStarterCompanies(): StarterSeed {
  const producer: Producer = {
    id: IDIOTS_PRODUCER_ID,
    external_id: ext("pr", "idiots-in-cars"),
    slug: "idiots-in-cars",
    name_zh: "车祸集锦工作室",
    name_en: "Idiots in Cars",
    contact_email: null,
    contact_wechat: null,
    deliverables: { clean_master: true, dialogue_stem: false, script_or_srt: false, music_note: "" },
    research_profile: null,
    created_at: AT,
  };
  const title: Title = {
    id: IDIOTS_TITLE_ID,
    external_id: ext("ttl", "starter:idiots-in-cars"),
    producer_id: producer.id,
    name_zh: "车祸集锦",
    name_en: "Idiots in Cars — Five-Episode Launch Test",
    genre: "compilation · dashcam",
    synopsis_zh: null,
    synopsis_en: "Five one-minute episodes cut from a dashcam compilation; no script. Used to test the clip engine and the launch flow on real, non-drama footage.",
    character_notes: null,
    logline_zh: null,
    logline_en: null,
    episode_count: IDIOTS_EPISODES,
    source_locale: "en-US",
    status: "selected",
    china_metrics: {},
    localization_effort: null,
    deliverables: { clean_master: true, dialogue_stem: false, script_or_srt: false, music_note: "" },
    notes: "Starter company shipped with the repository (docs/demo/idiots-in-cars).",
    license_start: null,
    license_end: null,
    created_at: AT,
    updated_at: AT,
  };
  const adaptation: Adaptation = { id: uuid(B.adaptation, 1), external_id: ext("ad", "starter:idiots-in-cars:en-US"), title_id: title.id, target_locale: "en-US", label: "U.S. general", display_title_en: title.name_en, created_by: STAFF_USER_ID, created_at: AT };
  const episodes: Episode[] = [];
  const media: Record<string, string> = {};
  for (let n = 1; n <= IDIOTS_EPISODES; n++) {
    const video_path = `${title.id}/episode-${n}/ep${n}.mp4`;
    episodes.push({
      id: uuid(B.episode, n),
      external_id: ext("ep", `starter:idiots-in-cars:${n}`),
      title_id: title.id,
      number: n,
      name_zh: null,
      name_en: `Episode ${n}`,
      duration_ms: null,
      source_script_path: null,
      script_format: null,
      has_timecodes: false,
      video_path,
      created_at: AT,
    });
    media[video_path] = `docs/demo/idiots-in-cars/ep${n}.mp4`;
  }
  return { producers: [producer], titles: [title], episodes, adaptations: [adaptation], media };
}
