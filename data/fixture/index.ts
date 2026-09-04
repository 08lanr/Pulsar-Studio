// The whole fixture database for DATA_SOURCE=fixture — V2.1 seed
// (2026-09-04, docs/decisions.md): EMPTY. One producer and the two login
// personas, no titles — the portal opens on the 新建剧集 card and the demo
// starts from the founder's own upload (docs/demo/xiangyuan-ep1.srt + .mp4,
// the clean, never-dubbed cut). The replay bank (canned.ts + canned-user.ts)
// answers 生成 for that footage, so the whole flow works offline.
//
// Read-mostly: `fixtureDb` is a frozen constant. The data layer works on
// `cloneFixtureDb()` and keeps its copy for the process lifetime (state
// resets on server restart — that is the point of fixture mode).

import type {
  AdaptedLine,
  Adaptation,
  AuditEvent,
  Character,
  Clip,
  Episode,
  Job,
  Line,
  LineAlternative,
  Producer,
  Profile,
  Scene,
  SceneDecision,
  Title,
  Variant,
  Version,
} from "@/lib/types";
import { producer, profiles } from "./title";

/** Table name -> rows; the key is the studio.* / core.* table name. */
export type FixtureDb = {
  producers: Producer[];
  profiles: Profile[];
  titles: Title[];
  episodes: Episode[];
  characters: Character[];
  scenes: Scene[];
  lines: Line[];
  adaptations: Adaptation[];
  versions: Version[];
  adapted_lines: AdaptedLine[];
  line_alternatives: LineAlternative[];
  scene_decisions: SceneDecision[];
  variants: Variant[];
  clips: Clip[];
  jobs: Job[];
  audit_events: AuditEvent[];
};

export const fixtureDb: FixtureDb = {
  producers: [producer],
  profiles,
  titles: [],
  episodes: [],
  characters: [],
  scenes: [],
  lines: [],
  adaptations: [],
  versions: [],
  adapted_lines: [],
  line_alternatives: [],
  scene_decisions: [],
  variants: [],
  clips: [],
  jobs: [],
  audit_events: [],
};

/** A deep copy for a data layer that mutates in fixture mode. */
export function cloneFixtureDb(): FixtureDb {
  return structuredClone(fixtureDb);
}

export { buildVersionSnapshot, snapshotSha256 } from "./snapshot";
export { STAFF_USER_ID, PRODUCER_USER_ID, PRODUCER_ID } from "./ids";
