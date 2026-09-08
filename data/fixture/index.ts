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
  CompanyAccount,
  CreativeResult,
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
  PromoApproval,
  PromoCampaign,
  PromoCreative,
  PromoHandoff,
  Scene,
  SceneDecision,
  Title,
  Variant,
  Version,
} from "@/lib/types";
import type { AnalyticsLink } from "@/lib/analytics/types";
import type { ReportBatch, ReportRow, WatchRow } from "@/lib/research/types";
import { buildDemoAnalytics } from "./demo-analytics";
import { buildDemoSeed } from "./demo-catalog";
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
  promo_campaigns: PromoCampaign[];
  promo_creatives: PromoCreative[];
  promo_approvals: PromoApproval[];
  promo_handoffs: PromoHandoff[];
  audit_events: AuditEvent[];
  research_watchlist: WatchRow[];
  report_batches: ReportBatch[];
  report_rows: ReportRow[];
  promo_results: CreativeResult[];
  company_accounts: CompanyAccount[];
  /** Title -> platform listing mappings for title analytics (migration 0007). */
  analytics_links: AnalyticsLink[];
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
  promo_campaigns: [],
  promo_creatives: [],
  promo_approvals: [],
  promo_handoffs: [],
  audit_events: [],
  research_watchlist: [],
  report_batches: [],
  report_rows: [],
  promo_results: [],
  company_accounts: [],
  analytics_links: [],
};

export type FixtureSeed = "demo" | "empty";

/** FIXTURE_SEED=empty restores the bare seed; anything else seeds the demo catalog. */
export function defaultFixtureSeed(): FixtureSeed {
  return process.env.FIXTURE_SEED === "empty" ? "empty" : "demo";
}

/**
 * A deep copy for a data layer that mutates in fixture mode. The demo seed
 * (data/fixture/demo-catalog.ts) fills the studio's catalog, profile,
 * watchlist, reports, experiments and accounts so every workspace screen
 * has something to stand on; the empty seed is what the localization demo
 * and the workflow tests expect.
 */
export function cloneFixtureDb(seed: FixtureSeed = defaultFixtureSeed()): FixtureDb {
  const db = structuredClone(fixtureDb);
  if (seed === "empty") return db;
  const demo = buildDemoSeed();
  db.producers[0] = { ...db.producers[0], research_profile: demo.profile };
  db.titles.push(...demo.titles);
  db.episodes.push(...demo.episodes);
  db.adaptations.push(...demo.adaptations);
  db.scenes.push(...demo.scenes);
  db.lines.push(...demo.lines);
  db.adapted_lines.push(...demo.adapted_lines);
  db.versions.push(...demo.versions);
  db.research_watchlist.push(...demo.watchlist);
  db.report_batches.push(...demo.report_batches);
  db.report_rows.push(...demo.report_rows);
  db.promo_campaigns.push(...demo.campaigns);
  db.promo_creatives.push(...demo.creatives);
  db.promo_approvals.push(...demo.approvals);
  db.promo_handoffs.push(...demo.handoffs);
  db.promo_results.push(...demo.results);
  db.company_accounts.push(...demo.accounts);
  db.analytics_links.push(...structuredClone(buildDemoAnalytics().links));
  return db;
}

export { buildVersionSnapshot, snapshotSha256 } from "./snapshot";
export { STAFF_USER_ID, PRODUCER_USER_ID, PRODUCER_ID } from "./ids";
