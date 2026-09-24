// DATA_SOURCE=fixture: the data layer over an in-memory copy of data/fixture.
//
// The store is a structuredClone of the bundled fixture, created once per
// process and parked on globalThis — Next bundles lib/ separately for every
// route, so a module-level `let` would give each route its own store and an
// approval made through one route would be invisible to the next (the
// sibling repo's cross-bundle lesson). Mutations edit the store in place and
// are LOST ON RESTART; that is the point of fixture mode (a demo that resets
// itself), not a bug. Reads return structuredClone'd rows so a caller cannot
// leak a mutation back in.
//
// Every guard the SQL functions and RLS enforce in supabase mode is
// re-implemented here with the same outcome, raised as DataError codes:
// producer visibility starts at in_review, frozen versions refuse edits,
// submit needs every scene staff-approved, in-app approval needs every scene
// partner-approved, on-behalf needs a staff admin and an evidence note.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canReadTitle, isSystemSession, type Session } from "@/lib/auth";
import { budgetCheck, overBudgetMessage } from "@/lib/angles";
import { AD_TEXT_MAX, clipIdOf, creativesFromClips, NO_CLIPS_MESSAGE, pickClipsForRound } from "@/lib/clips/creatives";
import { cutClip, withSourceFile } from "@/lib/clips/cut";
import { MONTAGE_RANK_BASE, montageClipProblem } from "@/lib/clips/montage";
import { ffmpegAvailable } from "@/lib/promote/render";
import { blockerMessage, isAssignedBusinessCenter, isReadyLaunchAccount, launchReadiness } from "@/lib/promote/launch-gate";
import { launchMode } from "@/lib/tiktok";
import { launchSettingsSchema, LaunchSettingsError, normalizeLaunchSettings, validateLaunchSettings, type LaunchSettings } from "@/lib/tiktok/settings";
import { LAST_CUE_MS, liftStamp, MAX_DERIVED_CUE_MS, SAMPLE_LATENCY_MS, type IngestResult } from "@/lib/ingest";
import { applyGlobalOffset, assertValidCue } from "@/lib/subtitle-timing";
import { splitSpeaker } from "@/lib/ingest/text";
import { isLlmAvailable } from "@/lib/llm";
import { marketView } from "@/lib/research/snapshot";
import type { ReportBatch, WatchRow } from "@/lib/research/types";
import type { AccountRequest, CompanyAccount, CreativeResult, InstantPageTemplate, LaunchPreset, PromoLaunch } from "@/lib/types";
import { examplesFromApprovedVersions } from "@/lib/translation-memory";
import { cloneFixtureDb, defaultFixtureSeed, type FixtureDb, type FixtureSeed } from "@/data/fixture";
import { buildDemoAnalytics, DEMO_TODAY } from "@/data/fixture/demo-analytics";
import { computeTitleAnalytics, performanceRow } from "@/lib/analytics/compute";
import { parseRange, AnalyticsRange, AnalyticsWindow } from "@/lib/analytics/types";
import type { AnalyticsLink } from "@/lib/analytics/types";
import { DEMO_CLIP_SOURCE } from "@/data/fixture/demo-catalog";
import { STARTER_MEDIA } from "@/data/fixture";
import { FIXTURE_PRODUCER_ID } from "@/lib/auth";
import { buildVersionSnapshot, snapshotSha256 } from "@/data/fixture/snapshot";
import type {
  AdaptedLine,
  Adaptation,
  AuditChannel,
  AuditEvent,
  Character,
  Clip,
  Episode,
  FilmAsset,
  FilmRun,
  FilmRunEpisode,
  Job,
  Json,
  Line,
  LineAlternative,
  PlatformLink,
  PlatformName,
  PlatformSnapshot,
  Producer,
  ProducerTitleSummary,
  PromoApproval,
  PromoCampaign,
  PromoCampaignDetail,
  PromoCampaignSummary,
  PromoCreative,
  PromoHandoff,
  Scene,
  SceneDecision,
  Title,
  Variant,
  Version,
  VersionSnapshot,
} from "@/lib/types";
import { withHistoricalPromoSeed, legacyCampaignRetired, conflict, forbidden, frozen, invalid, notFound } from "./errors";
import { episodeImportPatch, filmAssetRow, normalizeSourceRef, validateAdRules } from "./film-import";
import {
  claimFields,
  decisionRow,
  episodeClaimFields,
  episodeReleaseFields,
  episodeRenewFields,
  episodeStageFields,
  filmRunRow,
  filmRunStageAudited,
  heldNumbersConflict,
  normalizeFilmRun,
  normalizeRunEpisode,
  releaseFields,
  renewFields,
  runEpisodeAudited,
  runEpisodeRows,
  stageFields,
} from "./film-runs";
import { normalizePlatformSnapshot, platformLinkRow, platformSnapshotRow, PLATFORM_SNAPSHOTS_KEEP, PLATFORMS } from "@/lib/crazydramas/types";
import { cdCancelFields, cdClaimFields, cdPublicationRow, cdReleaseFields, cdRenewFields, cdStepAudited, cdUpdateFields, isActiveStep, newRowConflict, normalizeCdPublication } from "@/lib/crazydramas/ledger";
import type { CdPublication } from "@/lib/types";
import type {
  ApproveOptions,
  DataLayer,
  ExportSnapshot,
  FirstPassLine,
  NewJob,
} from "./index";
import { mediaUrl, resolveUploadPath, uploadsDir } from "./storage";
import {
  adaptedLineIssue,
  buildEpisodeSummary,
  buildProducerEpisodeSummary,
  buildProducerReview,
  buildTitleSummary,
  pickCurrentVersion,
  pickProducerVersion,
} from "./views";

// ---- the store ------------------------------------------------------------------------------

type Store = {
  db: FixtureDb;
  /** core.audit_events.id is a bigserial; keep counting from the seed. */
  auditSeq: number;
  /** Which seed shape built this store; a hot reload that changed the seed rebuilds it. */
  seedVersion?: string;
};

/** Bump when the fixture seed shape changes, so a dev server's parked store is rebuilt on hot reload. */
const SEED_VERSION = "demo-2026-09-14.4-clips";

const STORE_KEY = "__pulsarStudioFixtureStore";

function store(): Store {
  const g = globalThis as unknown as Record<string, Store | undefined>;
  let s = g[STORE_KEY];
  if (s && s.seedVersion !== SEED_VERSION) {
    // A code change bumped the seed version: the parked store is rebuilt and everything created since the
    // last restart is gone (fixture mode is in-memory by design). Say so in the log, so a tester whose
    // title vanished mid-session (2026-09-15) can see why.
    console.warn(`[fixture] seed version changed (${s.seedVersion} → ${SEED_VERSION}): the in-memory store was rebuilt; titles and campaigns created since the last restart are gone`);
  }
  if (!s || s.seedVersion !== SEED_VERSION) {
    const seed = (globalThis as unknown as Record<string, FixtureSeed | undefined>)[`${STORE_KEY}Seed`];
    let db = cloneFixtureDb(seed);
    if ((seed ?? defaultFixtureSeed()) === "demo" && persistenceOn()) {
      // Other companies survive: from the store this process had (seed bump, demo reset), else from disk.
      const prev = (g as unknown as Record<string, FixtureDb | undefined>)[`${STORE_KEY}Prev`] ?? s?.db ?? null;
      const saved = prev ? null : loadPersisted();
      if (prev) db = mergeOtherCompanies(db, prev);
      else if (saved) db = saved.seedVersion === SEED_VERSION ? saved.db : mergeOtherCompanies(db, saved.db);
      delete (g as unknown as Record<string, unknown>)[`${STORE_KEY}Prev`];
    }
    ensureDemoMedia(db);
    ensureDemoClips(db);
    s = { db, auditSeq: db.audit_events.reduce((m, e) => Math.max(m, e.id), 0), seedVersion: SEED_VERSION };
    g[STORE_KEY] = s;
    if ((seed ?? defaultFixtureSeed()) === "demo") ensureStarterCuts(db);
  }
  schedulePersist();
  // A store parked on globalThis survives a dev-server hot reload that added
  // tables to the fixture shape; default them so a stale store cannot throw.
  s.db.research_watchlist ??= [];
  s.db.report_batches ??= [];
  s.db.report_rows ??= [];
  s.db.promo_results ??= [];
  s.db.company_accounts ??= [];
  s.db.promo_launches ??= [];
  s.db.account_requests ??= [];
  s.db.launch_presets ??= [];
  s.db.instant_page_templates ??= [];
  s.db.film_assets ??= [];
  s.db.film_runs ??= [];
  // The platform tables (migration 0017) live beside the seed's shape: persisted and merged like every other table, defaulted here.
  platformTables(s.db);
  // So do the narrated episodes (migration 0018).
  episodeTable(s.db);
  // And the crazydramas ledger (migration 0019).
  cdTable(s.db);
  // Rows seeded or saved before the workspace import (migration 0015) lack its columns; a reader sees one shape.
  for (const t of s.db.titles) {
    t.source_ref ??= null;
    t.cover_path ??= null;
    t.crazydramas_slug ??= null;
    t.ad_rules ??= null;
  }
  for (const e of s.db.episodes) {
    e.source_ref ??= null;
    e.video_sha256 ??= null;
    e.video_bytes ??= null;
    e.video_frames ??= null;
    e.film_start_ms ??= null;
    e.film_end_ms ??= null;
    e.end_note ??= null;
    e.auto_cut ??= true;
  }
  // Rows saved before 2026-09-16 predate the launch-settings fields; fill them so every reader sees one shape.
  for (const l of s.db.promo_launches) {
    l.settings ??= {} as PromoLaunch["settings"];
    l.paused ??= false;
    l.duplicates ??= {};
    l.retired_adgroups ??= [];
    l.duplicated_at ??= null;
    l.activated_at ??= null;
    l.bid_usd ??= null;
    l.schedule_end ??= null;
  }
  for (const c of s.db.promo_campaigns) c.launch_settings ??= null;
  for (const a of s.db.company_accounts) a.preferred_advertiser_id ??= null;
  return s;
}

/**
 * Every seeded episode video points at a real file: the demo clip is hard
 * linked (or copied) under .uploads/ so ad previews and the subtitle studio
 * play in fixture mode with nothing uploaded. Idempotent and best effort: a
 * read-only disk leaves the row's path in place and the media route 404s
 * as it would for any missing upload.
 */
function ensureDemoMedia(db: FixtureDb): void {
  for (const e of db.episodes) {
    if (!e.video_path) continue;
    // Starter companies name their own files (data/fixture/starter-companies.ts); every demo-catalog episode uses the sample clip.
    const source = path.join(process.cwd(), STARTER_MEDIA[e.video_path] ?? DEMO_CLIP_SOURCE);
    if (!existsSync(source)) continue;
    try {
      const target = resolveUploadPath(e.video_path);
      if (existsSync(target)) continue;
      mkdirSync(path.dirname(target), { recursive: true });
      try { linkSync(source, target); } catch { copyFileSync(source, target); }
    } catch (err) {
      console.warn("[fixture] demo media not linked", e.video_path, (err as Error).message);
    }
  }
}

/**
 * A starter company's episodes have no clips when first seeded: the real
 * engine cuts them (footage path, no subtitles) the first time the store
 * is built, one episode after another, exactly as an upload would. Skipped
 * when clips already exist (saved state), when a run is going, or with
 * PROMO_RENDER=off; an imported episode (auto_cut false) is never in the
 * list — the ad engine cuts those. Deferred a tick because the engine reads
 * the store.
 */
function ensureStarterCuts(db: FixtureDb): void {
  if (process.env.PROMO_RENDER === "off") return;
  const starters = new Set(db.producers.filter((p) => p.id !== FIXTURE_PRODUCER_ID).map((p) => p.id));
  const titles = db.titles.filter((t) => starters.has(t.producer_id));
  const pending = db.episodes.filter((e) => e.video_path && e.auto_cut !== false && titles.some((t) => t.id === e.title_id) && !db.clips.some((c) => c.episode_id === e.id) && !db.jobs.some((j) => j.episode_id === e.id && j.kind === "cut_clips"));
  if (!pending.length) return;
  const g = globalThis as unknown as { __pulsarStarterCuts?: boolean };
  if (g.__pulsarStarterCuts) return;
  g.__pulsarStarterCuts = true;
  setTimeout(async () => {
    try {
      const { cutEpisodeClips } = await import("@/lib/clips/run");
      for (const e of pending) {
        const title = titles.find((t) => t.id === e.title_id)!;
        await cutEpisodeClips(title.id, e.number).catch((err) => console.warn("[fixture] starter clips", title.name_en, e.number, (err as Error).message));
      }
    } finally {
      g.__pulsarStarterCuts = false;
    }
    // The store may have been rebuilt while this ran (a demo reset): pick up whatever is still uncut.
    const current = (globalThis as unknown as Record<string, Store | undefined>)[STORE_KEY];
    if (current && current.db !== db) ensureStarterCuts(current.db);
  }, 0);
}

/**
 * The seeded ad clips are real cuts (decision 2026-09-14, "is it actually
 * cut for real?"): the rows come in `pending` pointing at
 * `<title>/<episode>/clip-demo-<k>.mp4`; a cut already on disk (with its
 * sha sidecar) is marked rendered at once, the rest are cut with ffmpeg in
 * the background from the linked sample episode (clean cuts, nothing
 * burned in) and marked as they finish. Without ffmpeg the rows
 * end `failed` with the honest note. `PROMO_RENDER=off` (the test runner)
 * skips all of it; the rows then stay pending and nothing asserts on them.
 */
function ensureDemoClips(db: FixtureDb): void {
  if (process.env.PROMO_RENDER === "off") return;
  const pending = db.clips.filter((c) => c.render_status === "pending" && c.render_path);
  if (!pending.length) return;
  const cuts = demoCuts();
  const toCut: Clip[] = [];
  for (const clip of pending) {
    // Already cut in this process, or by an earlier one (the sha sidecar beside the file): mark it, never cut again.
    let sha = cuts.done.get(clip.render_path!) ?? null;
    if (!sha) {
      try {
        const abs = resolveUploadPath(clip.render_path!);
        const sidecar = `${abs}.sha256`;
        if (existsSync(abs) && existsSync(sidecar)) {
          const read = readFileSync(sidecar, "utf8").trim();
          if (/^[0-9a-f]{64}$/.test(read)) sha = read;
        }
      } catch { /* fall through: cut it */ }
    }
    if (sha) {
      cuts.done.set(clip.render_path!, sha);
      Object.assign(clip, { render_status: "rendered", render_sha256: sha, duration_ms: clip.end_ms - clip.start_ms, width: 1080, height: 1920 });
      stampCreatives(db, clip, sha);
      continue;
    }
    toCut.push(clip);
  }
  // One cutting run per process (2026-09-14: every demo reset used to start another, and dozens of ffmpeg
  // processes piled up). A run in flight will stamp whichever store is current when each cut lands.
  if (!toCut.length || cuts.running) return;
  cuts.running = true;
  void (async () => {
    try {
      if (!(await ffmpegAvailable())) {
        for (const clip of toCut) Object.assign(clip, { render_status: "failed", render_note: "ffmpeg is not installed on this machine" });
        return;
      }
      for (const clip of toCut) {
        const episode = db.episodes.find((e) => e.id === clip.episode_id);
        if (!episode?.video_path) { Object.assign(clip, { render_status: "failed", render_note: "no source video" }); continue; }
        try {
          const r = await withSourceFile(episode.video_path, (srcAbs, workDir) =>
            cutClip({ srcAbs, workDir, startMs: clip.start_ms, endMs: clip.end_ms, storedPath: clip.render_path! })
          );
          writeFileSync(`${resolveUploadPath(r.render_path)}.sha256`, r.render_sha256);
          cuts.done.set(r.render_path, r.render_sha256);
          // The store may have been rebuilt since (a demo reset): stamp the rows that are current now, and the ones this run started from.
          const current = (globalThis as unknown as Record<string, Store | undefined>)[STORE_KEY]?.db;
          for (const target of new Set([db, current].filter(Boolean) as FixtureDb[])) {
            const row = target.clips.find((c) => c.render_path === clip.render_path);
            if (row) { Object.assign(row, { render_status: "rendered", render_sha256: r.render_sha256, duration_ms: r.duration_ms, width: r.width, height: r.height, render_note: null }); stampCreatives(target, row, r.render_sha256); }
          }
        } catch (e) {
          Object.assign(clip, { render_status: "failed", render_note: (e as Error).message });
          console.warn("[fixture] demo clip not cut", clip.external_id, (e as Error).message);
        }
      }
    } finally {
      cuts.running = false;
    }
  })();
}

/** Process-wide memory of demo cuts: which files are done (path -> sha) and whether a run is going. */
function demoCuts(): { running: boolean; done: Map<string, string> } {
  const g = globalThis as unknown as { __studioDemoCuts?: { running: boolean; done: Map<string, string> } };
  return (g.__studioDemoCuts ??= { running: false, done: new Map() });
}

/** A seeded round's creatives are built from clips: once the clip's file exists, the creative gets the same path and hash. */
function stampCreatives(db: FixtureDb, clip: Clip, sha: string): void {
  for (const creative of db.promo_creatives) {
    const settings = (creative.render_settings ?? {}) as { clip_id?: string };
    if (settings.clip_id === clip.id) { creative.render_path = clip.render_path; creative.render_sha256 = sha; }
  }
}

/** Which seed the process-wide store was built from (the demo badge and the reset route read it). */
export function currentFixtureSeed(): FixtureSeed {
  return (globalThis as unknown as Record<string, FixtureSeed | undefined>)[`${STORE_KEY}Seed`] ?? (process.env.FIXTURE_SEED === "empty" ? "empty" : "demo");
}

/**
 * Drop the process-wide store so the next call reseeds from data/fixture.
 * Tests use it between cases; in fixture mode the demo reset route
 * (POST /api/demo/reset) and `npm run demo:reset` call it so a rehearsed
 * journey starts from the same rows every time. Never reachable in
 * supabase mode: the route 404s there and this module is never the layer.
 */
export function resetFixtureStore(seed?: FixtureSeed): void {
  const g = globalThis as unknown as Record<string, unknown>;
  // With persistence on, a reset rebuilds the demo studio but keeps every other company (2026-09-15).
  const previous = (g[STORE_KEY] as Store | undefined)?.db;
  if (previous && persistenceOn()) g[`${STORE_KEY}Prev`] = previous;
  delete g[STORE_KEY];
  if (seed) g[`${STORE_KEY}Seed`] = seed;
  else delete g[`${STORE_KEY}Seed`];
}

// ---- persistence (demo mode keeps its data; decision 2026-09-15) ---------------------------------
//
// Fixture mode was in-memory only, so a restart, a seed bump or a demo reset
// lost every company a tester created ("can you just make it simple and
// save the data there?"). Now the whole store is written to
// .uploads/fixture-state.json (debounced, atomic rename) after every data
// access, and read back at start. The demo studio is always rebuilt from
// the seed (so demo rows follow the code); every OTHER company — its
// titles, episodes, clips, campaigns, accounts, audit — is carried over from
// the saved state, and from the previous in-memory store when the seed
// version changes or a demo reset runs. FIXTURE_PERSIST=off turns it off
// (the unit tests and the e2e server, which must not share a file with a
// developer's own server); FIXTURE_STATE_FILE moves the file.

const PERSIST_DEBOUNCE_MS = 1500;

function persistenceOn(): boolean {
  return process.env.FIXTURE_PERSIST !== "off" && defaultFixtureSeed() === "demo";
}

function stateFile(): string {
  return process.env.FIXTURE_STATE_FILE || path.join(uploadsDir(), "fixture-state.json");
}

function loadPersisted(): { seedVersion: string; db: FixtureDb } | null {
  try {
    const file = stateFile();
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { seedVersion?: string; db?: FixtureDb };
    return parsed && parsed.db && typeof parsed.seedVersion === "string" ? { seedVersion: parsed.seedVersion, db: parsed.db } : null;
  } catch (e) {
    console.warn("[fixture] saved state unreadable; starting from the seed", (e as Error).message);
    return null;
  }
}

function schedulePersist(): void {
  if (!persistenceOn()) return;
  const g = globalThis as unknown as { __pulsarPersistTimer?: NodeJS.Timeout };
  if (g.__pulsarPersistTimer) return;
  g.__pulsarPersistTimer = setTimeout(() => {
    delete g.__pulsarPersistTimer;
    const s = (globalThis as unknown as Record<string, Store | undefined>)[STORE_KEY];
    if (!s) return;
    try {
      const file = stateFile();
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ seedVersion: SEED_VERSION, saved_at: new Date().toISOString(), db: s.db }));
      renameSync(tmp, file);
    } catch (e) {
      console.warn("[fixture] could not save state", (e as Error).message);
    }
  }, PERSIST_DEBOUNCE_MS);
  g.__pulsarPersistTimer.unref?.();
}

/** Every row of `db` that belongs to one of `producers` (by producer, title or campaign key). */
function companyRows(db: FixtureDb, producers: Set<string>): (row: Record<string, unknown>, table: string) => boolean {
  const titles = new Set(db.titles.filter((t) => producers.has(t.producer_id)).map((t) => t.id));
  const campaigns = new Set(db.promo_campaigns.filter((c) => producers.has(c.producer_id) || titles.has(c.title_id)).map((c) => c.id));
  // A narrated episode row (migration 0018) belongs to its run's company.
  const runs = new Set((db.film_runs ?? []).filter((r) => producers.has(r.producer_id)).map((r) => r.id));
  return (row, table) =>
    (table === "producers" && typeof row.id === "string" && producers.has(row.id)) ||
    (typeof row.producer_id === "string" && producers.has(row.producer_id)) ||
    (typeof row.title_id === "string" && titles.has(row.title_id)) ||
    (typeof row.campaign_id === "string" && campaigns.has(row.campaign_id)) ||
    (table === "film_run_episodes" && typeof row.run_id === "string" && runs.has(row.run_id));
}

/**
 * Fresh seed + every company other than the demo studio, carried over from
 * `old` with all of its rows. The demo studio (Xinghai) always comes from
 * the seed; a starter company (data/fixture/starter-companies.ts) comes
 * from the seed only until the saved state has it — after that the saved
 * version wins, campaigns and all. A saved company with the same English
 * name as a starter replaces the starter (Ruobin created "Idiots in Cars"
 * by hand before the starter existed).
 */
function mergeOtherCompanies(fresh: FixtureDb, old: FixtureDb): FixtureDb {
  const carried = new Set(old.producers.filter((p) => p.id !== FIXTURE_PRODUCER_ID).map((p) => p.id));
  if (!carried.size) return fresh;
  const carriedNames = new Set(old.producers.filter((p) => carried.has(p.id)).map((p) => (p.name_en ?? p.name_zh).trim().toLowerCase()));
  const replaced = new Set(fresh.producers.filter((p) => p.id !== FIXTURE_PRODUCER_ID && (carried.has(p.id) || carriedNames.has((p.name_en ?? p.name_zh).trim().toLowerCase()))).map((p) => p.id));
  // Tables that live beside the seed's shape are merged too: default them on the fresh store first.
  episodeTable(fresh);
  cdTable(fresh);
  const dropFresh = companyRows(fresh, replaced);
  const keepOld = companyRows(old, carried);
  const out = fresh as unknown as Record<string, unknown>;
  const src = old as unknown as Record<string, unknown>;
  for (const key of Object.keys(out)) {
    const target = out[key];
    if (!Array.isArray(target)) continue;
    // The saved version of a company replaces its seeded starter rows wholesale.
    if (replaced.size) out[key] = (target as Array<Record<string, unknown>>).filter((row) => !dropFresh(row, key));
    const dest = out[key] as Array<Record<string, unknown>>;
    const rows = src[key];
    if (!Array.isArray(rows)) continue;
    const present = new Set(dest.map((r) => r.id).filter((id) => typeof id === "string"));
    for (const row of rows as Array<Record<string, unknown>>) {
      if (keepOld(row, key) && !(typeof row.id === "string" && present.has(row.id))) dest.push(row);
    }
  }
  return fresh;
}

const clone = <T>(v: T): T => structuredClone(v);
const now = () => new Date().toISOString();

/** What an episode carries before any import touched it (the column defaults of migration 0015). */
const EPISODE_IMPORT_DEFAULTS = {
  source_ref: null,
  video_sha256: null,
  video_bytes: null,
  video_frames: null,
  film_start_ms: null,
  film_end_ms: null,
  end_note: null,
  auto_cut: true,
} as const satisfies Partial<Episode>;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** prefix + 13 base32 chars from 8 random bytes: the shape of core.ext_id(). */
function extId(prefix: string): string {
  const bytes = randomBytes(8);
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < 13) {
      out += BASE32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  while (out.length < 13) out += BASE32[(acc << (5 - bits)) & 31];
  return `${prefix}_${out}`;
}

// ---- guards ------------------------------------------------------------------------------------

function requireStaff(session: Session): void {
  if (session.kind !== "staff") throw forbidden("Pulsar staff only");
}

/** A producer with an editing role (approver/reviewer); staff and viewers are refused. */
function requireProducerEditor(session: Session): void {
  if (session.kind !== "producer" || !session.producerId) throw forbidden("producer editors only");
  if (session.producerRole !== "approver" && session.producerRole !== "reviewer") throw forbidden("producer editors only");
}

/** Anyone signed in: a producer of any role, or staff previewing. */
function requireMemberSession(session: Session): void {
  if (session.kind !== "staff" && session.kind !== "producer") throw forbidden("sign in");
}

function requireStaffAdmin(session: Session): void {
  requireStaff(session);
  if (session.staffRole !== "admin") throw forbidden("staff admin only");
}

function isStaffAdmin(session: Session): boolean {
  return session.kind === "staff" && session.staffRole === "admin";
}

/** core.is_producer_reviewer(): approver or reviewer on the title's producer. */
function isProducerReviewer(session: Session, title: Title): boolean {
  return (
    session.kind === "producer" &&
    session.producerId === title.producer_id &&
    (session.producerRole === "approver" || session.producerRole === "reviewer")
  );
}

function isProducerApprover(session: Session, title: Title): boolean {
  return session.kind === "producer" && session.producerId === title.producer_id && session.producerRole === "approver";
}

/** RLS returns nothing rather than 403 for a title the caller cannot read; mirror that as not_found. */
function readableTitle(db: FixtureDb, session: Session, titleId: string): Title {
  const t = db.titles.find((x) => x.id === titleId);
  if (!t || !canReadTitle(session, t.producer_id)) throw notFound("title", titleId);
  return t;
}

/**
 * The self-serve check (2026-09-03 pivot, docs/decisions.md): the producer
 * does the work in their own portal, so staff OR the title's own producer
 * with the reviewer/approver role may edit. A viewer-role producer, or any
 * other producer, reads at most. Mirrors core.can_edit_title() in
 * supabase/migrations/0002_producer_selfserve.sql.
 */
function requireTitleEditor(db: FixtureDb, session: Session, titleId: string): Title {
  const t = readableTitle(db, session, titleId); // not_found before forbidden, like RLS
  if (session.kind === "staff") return t;
  if (
    session.producerId === t.producer_id &&
    (session.producerRole === "approver" || session.producerRole === "reviewer")
  ) {
    return t;
  }
  throw forbidden("editing needs the reviewer role on this title");
}

function readablePromoCampaign(db: FixtureDb, session: Session, campaignId: string): PromoCampaign {
  const campaign = db.promo_campaigns.find((x) => x.id === campaignId);
  if (!campaign) throw notFound("promotion campaign", campaignId);
  readableTitle(db, session, campaign.title_id);
  return campaign;
}

function promoDetail(db: FixtureDb, campaign: PromoCampaign): PromoCampaignDetail {
  const title = findTitle(db, campaign.title_id);
  return {
    campaign: clone(campaign),
    title: clone(title),
    episodes: clone(db.episodes.filter((e) => e.title_id === title.id).sort((a, b) => a.number - b.number)),
    creatives: clone(db.promo_creatives.filter((c) => c.campaign_id === campaign.id).sort((a, b) => a.created_at.localeCompare(b.created_at))),
    approval: clone(db.promo_approvals.find((a) => a.campaign_id === campaign.id) ?? null),
    handoffs: clone(db.promo_handoffs.filter((h) => h.campaign_id === campaign.id).sort((a, b) => b.attempted_at.localeCompare(a.attempted_at))),
    launch: clone(latestLaunch(db, campaign.id)),
    results: clone((db.promo_results ?? []).filter((r) => r.campaign_id === campaign.id).sort((a, b) => a.window_start.localeCompare(b.window_start))),
  };
}

function latestLaunch(db: FixtureDb, campaignId: string): PromoLaunch | null {
  return (db.promo_launches ?? []).filter((l) => l.campaign_id === campaignId).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

/** The producer's ready TikTok launch account, if any (decision 2026-09-09). */
function launchAccountOf(db: FixtureDb, producerId: string): CompanyAccount | null {
  return (db.company_accounts ?? []).find((a) => a.producer_id === producerId && isReadyLaunchAccount(a)) ?? null;
}

/** The producer's staff-assigned Business Center, if any. */
function launchBcOf(db: FixtureDb, producerId: string): CompanyAccount | null {
  return (db.company_accounts ?? []).find((a) => a.producer_id === producerId && isAssignedBusinessCenter(a)) ?? null;
}

/** The campaign's launch settings validated against its signed budget; `fallback` is a previous launch's snapshot (relaunch). */
function launchSettingsFor(campaign: PromoCampaign, fallback?: PromoLaunch["settings"]): LaunchSettings {
  try {
    return validateLaunchSettings(normalizeLaunchSettings(campaign.launch_settings ?? fallback ?? null), campaign.experiment?.budget_usd ?? 0);
  } catch (e) {
    if (e instanceof LaunchSettingsError) throw conflict(`launch settings: ${e.message}`);
    throw e;
  }
}

/** A launched campaign with its newest launch (done, or any status when `any`), or null. */
function launchedRow(db: FixtureDb, campaign: PromoCampaign, any: boolean): { campaign: PromoCampaign; launch: PromoLaunch; creatives: PromoCreative[] } | null {
  if (!campaign.grow_campaign_id || !/^\d+$/.test(campaign.grow_campaign_id)) return null;
  const launch = latestLaunch(db, campaign.id);
  if (!launch || (!any && launch.status !== "done")) return null;
  if (any && !launch.tiktok_campaign_id) return null;
  return { campaign: clone(campaign), launch: clone(launch), creatives: clone(db.promo_creatives.filter((c) => c.campaign_id === campaign.id && c.status === "approved")) };
}

/** The engine and the scheduler (system) or Pulsar staff. */
function requireSystemOrStaff(session: Session): void {
  if (!isSystemSession(session) && session.kind !== "staff") throw forbidden("Pulsar staff only");
}

// ---- platform links and snapshots (decision 2026-09-23; migration 0017) ----

/** The two platform tables, kept on the store beside the seed's own shape (data/fixture/index.ts is not touched by this phase). */
type PlatformTables = { platform_links: PlatformLink[]; platform_snapshots: PlatformSnapshot[] };

function platformTables(db: FixtureDb): PlatformTables {
  const ext = db as unknown as Partial<PlatformTables>;
  ext.platform_links ??= [];
  ext.platform_snapshots ??= [];
  // A link persisted before the review added title_slug (fixture-state.json) reads as made under its own slug, as the migration fills it.
  for (const l of ext.platform_links) {
    l.title_slug ??= l.slug;
    l.managed_by ??= null; // migration 0019's column default
  }
  return ext as PlatformTables;
}

function requirePlatform(platform: PlatformName): void {
  if (!PLATFORMS.includes(platform)) throw invalid(`unknown platform: ${String(platform)}`);
}

/** Mirrors the 0017 policy: staff and the system read every snapshot; a producer reads the rows of titles they can read (a row with no title is nobody's but staff's). */
function canReadSnapshot(db: FixtureDb, session: Session, row: PlatformSnapshot): boolean {
  if (session.kind === "staff") return true;
  if (!row.title_id) return false;
  const title = db.titles.find((t) => t.id === row.title_id);
  return !!title && canReadTitle(session, title.producer_id);
}

/** studio.cd_publications (migration 0019) lives beside the seed's shape, like the platform tables: defaulted on every store. */
type CdTable = { cd_publications: CdPublication[] };

function cdTable(db: FixtureDb): CdTable {
  const ext = db as unknown as Partial<CdTable>;
  ext.cd_publications ??= [];
  return ext as CdTable;
}

/** A ledger row the session may read (its title's readers, as 0019's RLS answers); anything else is not found. */
function readableCdRow(db: FixtureDb, session: Session, id: string): CdPublication {
  requireMemberSession(session);
  const row = cdTable(db).cd_publications.find((r) => r.id === id);
  if (!row) throw notFound("ledger row", id);
  const title = db.titles.find((t) => t.id === row.title_id);
  if (!title || !canReadTitle(session, title.producer_id)) throw notFound("ledger row", id);
  return row;
}

/** studio.film_run_episodes (migration 0018) lives beside the seed's shape, like the platform tables: defaulted on every store. */
type EpisodeTable = { film_run_episodes: FilmRunEpisode[] };

function episodeTable(db: FixtureDb): EpisodeTable {
  const ext = db as unknown as Partial<EpisodeTable>;
  ext.film_run_episodes ??= [];
  return ext as EpisodeTable;
}

/** A narrated episode the session may read: staff and the system only (0018's RLS is staff-only); anything else reads not found. */
function readableRunEpisode(db: FixtureDb, session: Session, episodeId: string): FilmRunEpisode {
  requireMemberSession(session);
  const ep = episodeTable(db).film_run_episodes.find((e) => e.id === episodeId);
  if (!ep || !(isSystemSession(session) || session.kind === "staff")) throw notFound("episode", episodeId);
  ep.stage_detail ??= {};
  return ep;
}

/** A film run the session may read: staff and the system see every run, a producer their own company's; a foreign run is not found (never forbidden), as RLS answers. */
function readableFilmRun(db: FixtureDb, session: Session, runId: string): FilmRun {
  requireMemberSession(session);
  const run = db.film_runs.find((r) => r.id === runId);
  if (!run || (session.kind === "producer" && run.producer_id !== session.producerId)) throw notFound("film run", runId);
  run.decisions ??= [];
  run.settings ??= {};
  run.stage_detail ??= {};
  return run;
}

function blank(s: string | null | undefined): boolean {
  return s === null || s === undefined || s.trim() === "";
}

/** m:ss for error messages; scenes are internal now, timestamps are the language. */
function timecodeHint(ms: number | null): string {
  if (ms === null) return "?";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---- lookups ------------------------------------------------------------------------------------

function findTitle(db: FixtureDb, id: string): Title {
  const t = db.titles.find((x) => x.id === id);
  if (!t) throw notFound("title", id);
  return t;
}

function findProducer(db: FixtureDb, id: string): Producer {
  const p = db.producers.find((x) => x.id === id);
  if (!p) throw notFound("producer", id);
  return p;
}

function findAdaptation(db: FixtureDb, titleId: string): Adaptation {
  const a = db.adaptations.find((x) => x.title_id === titleId);
  if (!a) throw notFound("adaptation for title", titleId);
  return a;
}

function findEpisode(db: FixtureDb, titleId: string, number: number): Episode {
  const e = db.episodes.find((x) => x.title_id === titleId && x.number === number);
  if (!e) throw notFound("episode", `${number}`);
  return e;
}

function findEpisodeById(db: FixtureDb, id: string): Episode {
  const e = db.episodes.find((x) => x.id === id);
  if (!e) throw notFound("episode", id);
  return e;
}

function findVersion(db: FixtureDb, id: string): Version {
  const v = db.versions.find((x) => x.id === id);
  if (!v) throw notFound("version", id);
  return v;
}

function findScene(db: FixtureDb, id: string): Scene {
  const s = db.scenes.find((x) => x.id === id);
  if (!s) throw notFound("scene", id);
  return s;
}

function findAdaptedLine(db: FixtureDb, id: string): AdaptedLine {
  const a = db.adapted_lines.find((x) => x.id === id);
  if (!a) throw notFound("adapted line", id);
  return a;
}

function episodeScenes(db: FixtureDb, episodeId: string): Scene[] {
  return db.scenes.filter((s) => s.episode_id === episodeId).sort((a, b) => a.number - b.number);
}

function episodeLines(db: FixtureDb, sceneIds: Set<string>): Line[] {
  return db.lines.filter((l) => sceneIds.has(l.scene_id)).sort((a, b) => a.seq - b.seq);
}

function episodeVersions(db: FixtureDb, episodeId: string): Version[] {
  return db.versions.filter((v) => v.episode_id === episodeId).sort((a, b) => a.number - b.number);
}

/** guard_frozen: adapted_lines and line_alternatives are writable only under a draft version. */
function requireDraft(db: FixtureDb, versionId: string): Version {
  const v = findVersion(db, versionId);
  if (v.status !== "draft") throw frozen(`version is ${v.status}; fork it to edit`);
  return v;
}

/** A scene can be marked ready only when its current draft has a usable
 * adaptation for every source line. This is deliberately enforced below
 * the UI: a stale tab or direct API call must not be able to submit an empty
 * frozen snapshot to a producer.
 *
 * Two strictnesses, matching the SQL functions they mirror:
 *   default      the staff path (set_scene_status / submit_version): every
 *                changed line explains itself to the producer, whoever wrote
 *                it.
 *   forFinalize  the producer's own gate (finalize_version): the shared
 *                adaptedLineIssue rule — editor-authored lines are their own
 *                explanation (decisions 2026-09-04). */
function sceneReadinessIssue(db: FixtureDb, scene: Scene, opts: { forFinalize?: boolean } = {}): string | null {
  const draft = episodeVersions(db, scene.episode_id).find((v) => v.status === "draft");
  if (!draft) return "no editable draft exists for this episode";
  const source = db.lines.filter((l) => l.scene_id === scene.id && l.merged_into_id === null);
  if (!source.length) return "the scene has no source lines";
  const adapted = db.adapted_lines.filter((a) => a.version_id === draft.id && a.scene_id === scene.id);
  const byLine = new Map(adapted.filter((a) => a.line_id).map((a) => [a.line_id as string, a]));
  const missing = source.filter((line) => !byLine.has(line.id)).length;
  if (missing) return `${missing} source line(s) still need an English adaptation`;
  const empty = source.filter((line) => {
    const row = byLine.get(line.id);
    return row?.change_type !== "cut" && blank(row?.text_en);
  }).length;
  if (empty) return `${empty} adapted line(s) are empty`;
  const unexplained = adapted.filter((row) =>
    opts.forFinalize
      ? adaptedLineIssue(row) === "unexplained"
      : row.change_type !== "keep" &&
        (blank(row.rationale_zh) || (row.change_type !== "cut" && blank(row.back_translation_zh)))
  ).length;
  return unexplained
    ? `${unexplained} ${opts.forFinalize ? "AI-changed" : "changed"} line(s) need a Chinese rationale and back-translation`
    : null;
}

function episodeSummaryOf(db: FixtureDb, episode: Episode) {
  const scenes = episodeScenes(db, episode.id);
  const sceneIds = new Set(scenes.map((s) => s.id));
  const versions = episodeVersions(db, episode.id);
  const versionIds = new Set(versions.map((v) => v.id));
  return buildEpisodeSummary({
    episode,
    scenes,
    lines: episodeLines(db, sceneIds),
    versions,
    adapted_lines: db.adapted_lines.filter((a) => versionIds.has(a.version_id)),
    decisions: db.scene_decisions.filter((decision) => versionIds.has(decision.version_id)),
  });
}

function costOf(db: FixtureDb, titleId: string): number {
  return db.jobs.filter((j) => j.title_id === titleId).reduce((n, j) => n + (j.cost_cents ?? 0), 0);
}

function snapshotOf(db: FixtureDb, version: Version): VersionSnapshot {
  const title = findTitle(db, version.title_id);
  const episode = findEpisodeById(db, version.episode_id);
  return buildVersionSnapshot({
    title,
    adaptation: findAdaptation(db, title.id),
    episode,
    version,
    characters: db.characters.filter((c) => c.title_id === title.id),
    scenes: episodeScenes(db, episode.id),
    lines: db.lines.filter((l) => l.title_id === title.id),
    adapted_lines: db.adapted_lines.filter((a) => a.version_id === version.id),
  });
}

// ---- audit ------------------------------------------------------------------------------------

function audit(
  s: Store,
  session: Session,
  action: string,
  table_name: string,
  row_id: string | null,
  title_id: string | null,
  before: Json | null,
  after: Json | null,
  note: string | null = null,
  channel: AuditChannel = "in_app"
): AuditEvent {
  const title = title_id ? s.db.titles.find((t) => t.id === title_id) : undefined;
  const row: AuditEvent = {
    id: ++s.auditSeq,
    at: now(),
    actor_id: session.userId,
    actor_kind: session.kind,
    product: "studio",
    action,
    table_name,
    row_id,
    title_id,
    producer_id: title?.producer_id ?? null,
    before,
    after,
    note,
    channel,
  };
  s.db.audit_events.push(row);
  return row;
}

// ---- the implementation ------------------------------------------------------------------------

/** After any timing change: draft adapted rows track their line's window,
 * scene bounds track their lines, and the episode's duration follows. */
function syncTimingMirrors(
  db: FixtureDb,
  episodeId: string,
  sceneRows: Scene[],
  lines: Line[]
): void {
  const byLine = new Map(lines.map((l) => [l.id, l]));
  for (const a of db.adapted_lines) {
    const l = a.line_id ? byLine.get(a.line_id) : undefined;
    if (l) {
      a.start_ms = l.start_ms;
      a.end_ms = l.end_ms;
    }
  }
  for (const sc of sceneRows) {
    const timed = lines.filter((l) => l.scene_id === sc.id && l.start_ms !== null);
    if (timed.length) {
      sc.start_ms = Math.min(...timed.map((l) => l.start_ms!));
      sc.end_ms = Math.max(...timed.map((l) => l.end_ms ?? l.start_ms!));
    }
  }
  const ep = db.episodes.find((e) => e.id === episodeId);
  if (ep) ep.duration_ms = Math.max(0, ...lines.map((l) => l.end_ms ?? 0)) || ep.duration_ms;
}

export { withHistoricalPromoSeed };

export const fixtureData: DataLayer = {
  // ---- titles and producers ----

  async listTitles(session) {
    const { db } = store();
    return db.titles
      .filter((title) => canReadTitle(session, title.producer_id))
      .map((title) =>
        buildTitleSummary({
          title,
          producer: findProducer(db, title.producer_id),
          episodes: db.episodes
            .filter((e) => e.title_id === title.id)
            .sort((a, b) => a.number - b.number)
            .map((e) => episodeSummaryOf(db, e)),
          // Pulsar's API spend never reaches a producer session.
          cost_cents: session.kind === "staff" ? costOf(db, title.id) : 0,
        })
      )
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  },

  async getTitle(session, titleId) {
    const { db } = store();
    const title = readableTitle(db, session, titleId);
    const episodes = db.episodes
      .filter((e) => e.title_id === titleId)
      .sort((a, b) => a.number - b.number)
      .map((e) => episodeSummaryOf(db, e));
    const versions = db.versions
      .filter((v) => v.title_id === titleId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(({ snapshot: _snapshot, ...rest }) => rest);
    return clone({
      title,
      producer: findProducer(db, title.producer_id),
      adaptation: findAdaptation(db, titleId),
      characters: db.characters.filter((c) => c.title_id === titleId),
      episodes,
      versions,
      cost_cents: session.kind === "staff" ? costOf(db, titleId) : 0,
      selected_title: db.variants.find((v) => v.title_id === titleId && v.kind === "title" && v.selected) ?? null,
      selected_hook: db.variants.find((v) => v.title_id === titleId && v.kind === "hook" && v.selected) ?? null,
    });
  },

  async createTitle(session, input) {
    const s = store();
    if (blank(input.name_zh)) throw invalid("name_zh is required");
    // A producer creates titles only under their own company, whatever the
    // request says; staff name any producer.
    let producerId = input.producer_id;
    if (session.kind === "producer") {
      if (session.producerRole !== "approver" && session.producerRole !== "reviewer") {
        throw forbidden("editing needs the reviewer role");
      }
      producerId = session.producerId!;
    }
    const producer = findProducer(s.db, producerId);
    const at = now();
    const title: Title = {
      id: randomUUID(),
      external_id: extId("ttl"),
      producer_id: producer.id,
      name_zh: input.name_zh.trim(),
      name_en: input.name_en?.trim() || null,
      genre: input.genre?.trim() || null,
      synopsis_zh: input.synopsis_zh?.trim() || null,
      synopsis_en: input.synopsis_en?.trim() || null,
      character_notes: input.character_notes?.trim() || null,
      logline_zh: null,
      logline_en: null,
      episode_count: null,
      source_locale: input.source_locale?.trim() || "zh-CN",
      status: "selected",
      china_metrics: {},
      localization_effort: null,
      deliverables: clone(producer.deliverables),
      notes: null,
      license_start: null,
      license_end: null,
      created_at: at,
      updated_at: at,
      source_ref: null,
      cover_path: null,
      crazydramas_slug: null,
      ad_rules: null,
    };
    // One adaptation per title in V1, created with the title (docs/data-model.md, studio.adaptations).
    const adaptation: Adaptation = {
      id: randomUUID(),
      external_id: extId("ad"),
      title_id: title.id,
      target_locale: "en-US",
      label: "U.S. general",
      display_title_en: title.name_en,
      // The system actor names the real caller (or nothing): in SQL this column is a foreign key to core.profiles.
      created_by: input.created_by ?? (isSystemSession(session) ? null : session.userId),
      created_at: at,
    };
    s.db.titles.push(title);
    s.db.adaptations.push(adaptation);
    audit(s, session, "create_title", "core.titles", title.id, title.id, null, { name_zh: title.name_zh });
    return clone(title);
  },

  async assertTitleEditable(session, titleId) {
    return clone(requireTitleEditor(store().db, session, titleId));
  },

  async updateTitle(session, titleId, patch) {
    requireStaff(session);
    const { db } = store();
    const title = findTitle(db, titleId);
    Object.assign(title, patch, { updated_at: now() });
    return clone(title);
  },

  async listProducers(session) {
    requireStaff(session);
    return clone(store().db.producers);
  },

  async createProducer(session, input) {
    requireStaff(session);
    const s = store();
    if (blank(input.name_zh)) throw invalid("name_zh is required");
    const base = (input.name_en ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    let slug = base || `producer-${s.db.producers.length + 1}`;
    if (s.db.producers.some((p) => p.slug === slug)) slug = `${slug}-${s.db.producers.length + 1}`;
    const producer: Producer = {
      id: randomUUID(),
      external_id: extId("pr"),
      slug,
      name_zh: input.name_zh.trim(),
      name_en: input.name_en?.trim() || null,
      contact_email: input.contact_email?.trim() || null,
      contact_wechat: input.contact_wechat?.trim() || null,
      deliverables: {},
      research_profile: null,
      created_at: now(),
    };
    s.db.producers.push(producer);
    return clone(producer);
  },

  // ---- ingest and the workbench ----

  async addEpisodeFromIngest(session, titleId, episodeNumber, ingest, files) {
    const s = store();
    const { db } = s;
    const title = requireTitleEditor(db, session, titleId);
    if (!Number.isInteger(episodeNumber) || episodeNumber < 1) throw invalid("episode_number must be a positive integer");
    if (db.episodes.some((e) => e.title_id === titleId && e.number === episodeNumber)) {
      throw conflict(`episode ${episodeNumber} already exists for this title`);
    }
    if (!ingest.lines.length) throw invalid("the file parsed to no lines");
    const at = now();
    const adaptation = findAdaptation(db, titleId);

    const lastEnd = ingest.lines.reduce<number | null>((m, l) => (l.end_ms !== null && (m === null || l.end_ms > m) ? l.end_ms : m), null);
    const episode: Episode = {
      id: randomUUID(),
      external_id: extId("ep"),
      title_id: titleId,
      number: episodeNumber,
      name_zh: null,
      name_en: null,
      duration_ms: ingest.hasTimecodes ? lastEnd : null,
      source_script_path: files.subtitlePath,
      script_format: ingest.format,
      has_timecodes: ingest.hasTimecodes,
      video_path: files.videoPath,
      created_at: at,
      ...EPISODE_IMPORT_DEFAULTS,
    };

    // Speakers become characters (understand_title refines name_en / notes later).
    const known = new Map(db.characters.filter((c) => c.title_id === titleId).map((c) => [c.name_zh, c]));
    for (const l of ingest.lines) {
      const name = l.speaker?.trim();
      if (!name || known.has(name)) continue;
      const c: Character = { id: randomUUID(), title_id: titleId, name_zh: name, name_en: null, notes: null, created_at: at };
      db.characters.push(c);
      known.set(name, c);
    }

    const scenes: Scene[] = ingest.scenes.map((sc) => ({
      id: randomUUID(),
      external_id: extId("sc"),
      title_id: titleId,
      episode_id: episode.id,
      number: sc.number,
      start_ms: ingest.hasTimecodes ? sc.start_ms : null,
      end_ms: ingest.hasTimecodes ? sc.end_ms : null,
      context_zh: null,
      context_en: null,
      status: "draft",
      status_by: null,
      status_at: null,
      created_at: at,
    }));
    const sceneFor = (seq: number): Scene => {
      const i = ingest.scenes.findIndex((sc) => seq >= sc.from_seq && seq <= sc.to_seq);
      return scenes[i >= 0 ? i : scenes.length - 1];
    };
    const lines: Line[] = ingest.lines.map((l) => {
      const start = ingest.hasTimecodes ? l.start_ms : null;
      const end = ingest.hasTimecodes ? l.end_ms : null;
      const speaker = l.speaker?.trim() || null;
      return {
        id: randomUUID(),
        external_id: extId("ln"),
        title_id: titleId,
        scene_id: sceneFor(l.seq).id,
        seq: l.seq,
        speaker,
        character_id: speaker ? known.get(speaker)?.id ?? null : null,
        start_ms: start,
        end_ms: end,
        duration_ms: start !== null && end !== null ? end - start : null,
        text_zh: l.text_zh,
        literal_en: null,
        merged_into_id: null,
        created_at: at,
      };
    });

    db.episodes.push(episode);
    db.scenes.push(...scenes);
    db.lines.push(...lines);

    // The cost-0 bookkeeping row: the episode's ingest state is derivable from jobs.
    db.jobs.push({
      id: randomUUID(),
      title_id: titleId,
      episode_id: episode.id,
      version_id: null,
      kind: "parse_subtitles",
      target_type: "episode",
      target_id: episode.id,
      idempotency_key: `parse_subtitles:${episode.id}:1`,
      status: "done",
      provider: null,
      model: null,
      input: { format: ingest.format, filename: files.subtitlePath },
      output: { lines: lines.length, scenes: scenes.length, has_timecodes: ingest.hasTimecodes, warnings: ingest.warnings },
      error: null,
      usage: null,
      cost_cents: 0,
      heartbeat_at: at,
      started_at: at,
      finished_at: at,
      created_at: at,
    });

    // A draft version so the first pass has somewhere to write.
    if (!db.versions.some((v) => v.episode_id === episode.id && v.status === "draft")) {
      db.versions.push({
        id: randomUUID(),
        external_id: extId("ver"),
        title_id: titleId,
        adaptation_id: adaptation.id,
        episode_id: episode.id,
        number: 1,
        parent_version_id: null,
        status: "draft",
        submitted_at: null,
        submitted_by: null,
        approved_at: null,
        approved_by: null,
        approval_mode: null,
        approval_evidence: null,
        approval_note: null,
        snapshot: null,
        snapshot_sha256: null,
        created_at: at,
        updated_at: at,
      });
    }

    if (title.status === "candidate" || title.status === "selected") title.status = "ingesting";
    title.updated_at = at;
    audit(s, session, "ingest_episode", "core.episodes", episode.id, titleId, null, {
      number: episodeNumber,
      format: ingest.format,
      lines: lines.length,
      scenes: scenes.length,
    });
    return clone(episode);
  },

  async addVideoOnlyEpisode(session, titleId, episodeNumber, videoPath, imported) {
    const s = store();
    const title = requireTitleEditor(s.db, session, titleId);
    // The import fields are the system's and staff's alone (0015 grants a producer none of those columns on insert).
    if (imported) requireSystemOrStaff(session);
    if (!Number.isInteger(episodeNumber) || episodeNumber < 1) throw invalid("episode_number must be a positive integer");
    if (s.db.episodes.some((e) => e.title_id === titleId && e.number === episodeNumber)) throw conflict(`episode ${episodeNumber} already exists for this title`);
    // The import's fields (hash, film window, auto_cut false) are validated before the row exists, so a bad value creates nothing.
    const fields = imported ? episodeImportPatch({ ...imported, video_path: undefined }) : {};
    const episode: Episode = { id: randomUUID(), external_id: extId("ep"), title_id: titleId, number: episodeNumber, name_zh: null, name_en: null, duration_ms: null, source_script_path: null, script_format: null, has_timecodes: false, video_path: videoPath, created_at: now(), ...EPISODE_IMPORT_DEFAULTS, ...fields };
    s.db.episodes.push(episode);
    title.status = "ingesting";
    title.updated_at = now();
    audit(s, session, "add_video_only_episode", "core.episodes", episode.id, title.id, null, { number: episodeNumber, video_path: videoPath, ...(imported ? { source_ref: episode.source_ref ?? null, video_sha256: episode.video_sha256 ?? null, auto_cut: episode.auto_cut ?? true } : {}) });
    return clone(episode);
  },

  async attachIngestToEpisode(session, titleId, episodeNumber, ingest, files) {
    const s = store();
    const { db } = s;
    const title = requireTitleEditor(db, session, titleId);
    const episode = findEpisode(db, titleId, episodeNumber);
    if (!ingest.lines.length) throw invalid("the file parsed to no lines");
    const existingScenes = episodeScenes(db, episode.id);
    const existingLines = episodeLines(db, new Set(existingScenes.map((sc) => sc.id)));
    if (existingLines.length) {
      throw conflict(`episode ${episodeNumber} already has a script (${existingLines.length} lines); a script is never silently replaced`);
    }
    if (existingScenes.length) {
      // Scenes without a single line are the debris of a torn earlier
      // attach (the writes are not one transaction); heal by replacing
      // them instead of refusing forever.
      const orphaned = new Set(existingScenes.map((sc) => sc.id));
      db.scenes = db.scenes.filter((sc) => !orphaned.has(sc.id));
    }
    const at = now();
    const adaptation = findAdaptation(db, titleId);

    const lastEnd = ingest.lines.reduce<number | null>((m, l) => (l.end_ms !== null && (m === null || l.end_ms > m) ? l.end_ms : m), null);
    episode.source_script_path = files.subtitlePath;
    episode.script_format = files.scriptFormat ?? ingest.format;
    episode.has_timecodes = ingest.hasTimecodes;
    if (episode.duration_ms === null && ingest.hasTimecodes) episode.duration_ms = lastEnd;

    // Speakers become characters, exactly as a fresh ingest would make them.
    const known = new Map(db.characters.filter((c) => c.title_id === titleId).map((c) => [c.name_zh, c]));
    for (const l of ingest.lines) {
      const name = l.speaker?.trim();
      if (!name || known.has(name)) continue;
      const c: Character = { id: randomUUID(), title_id: titleId, name_zh: name, name_en: null, notes: null, created_at: at };
      db.characters.push(c);
      known.set(name, c);
    }

    const scenes: Scene[] = ingest.scenes.map((sc) => ({
      id: randomUUID(),
      external_id: extId("sc"),
      title_id: titleId,
      episode_id: episode.id,
      number: sc.number,
      start_ms: ingest.hasTimecodes ? sc.start_ms : null,
      end_ms: ingest.hasTimecodes ? sc.end_ms : null,
      context_zh: null,
      context_en: null,
      status: "draft",
      status_by: null,
      status_at: null,
      created_at: at,
    }));
    const sceneFor = (seq: number): Scene => {
      const i = ingest.scenes.findIndex((sc) => seq >= sc.from_seq && seq <= sc.to_seq);
      return scenes[i >= 0 ? i : scenes.length - 1];
    };
    const lines: Line[] = ingest.lines.map((l) => {
      const start = ingest.hasTimecodes ? l.start_ms : null;
      const end = ingest.hasTimecodes ? l.end_ms : null;
      const speaker = l.speaker?.trim() || null;
      return {
        id: randomUUID(),
        external_id: extId("ln"),
        title_id: titleId,
        scene_id: sceneFor(l.seq).id,
        seq: l.seq,
        speaker,
        character_id: speaker ? known.get(speaker)?.id ?? null : null,
        start_ms: start,
        end_ms: end,
        duration_ms: start !== null && end !== null ? end - start : null,
        text_zh: l.text_zh,
        literal_en: null,
        merged_into_id: null,
        created_at: at,
      };
    });
    db.scenes.push(...scenes);
    db.lines.push(...lines);

    // The cost-0 bookkeeping row: the episode's ingest state is derivable from jobs.
    db.jobs.push({
      id: randomUUID(),
      title_id: titleId,
      episode_id: episode.id,
      version_id: null,
      kind: "parse_subtitles",
      target_type: "episode",
      target_id: episode.id,
      idempotency_key: `parse_subtitles:${episode.id}:1`,
      status: "done",
      provider: null,
      model: null,
      input: { format: episode.script_format, filename: files.subtitlePath },
      output: { lines: lines.length, scenes: scenes.length, has_timecodes: ingest.hasTimecodes, warnings: ingest.warnings },
      error: null,
      usage: null,
      cost_cents: 0,
      heartbeat_at: at,
      started_at: at,
      finished_at: at,
      created_at: at,
    });

    // A draft version so the first pass has somewhere to write.
    if (!db.versions.some((v) => v.episode_id === episode.id && v.status === "draft")) {
      db.versions.push({
        id: randomUUID(),
        external_id: extId("ver"),
        title_id: titleId,
        adaptation_id: adaptation.id,
        episode_id: episode.id,
        number: 1,
        parent_version_id: null,
        status: "draft",
        submitted_at: null,
        submitted_by: null,
        approved_at: null,
        approved_by: null,
        approval_mode: null,
        approval_evidence: null,
        approval_note: null,
        snapshot: null,
        snapshot_sha256: null,
        created_at: at,
        updated_at: at,
      });
    }

    if (title.status === "candidate" || title.status === "selected") title.status = "ingesting";
    title.updated_at = at;
    audit(s, session, "attach_script_to_episode", "core.episodes", episode.id, titleId, null, {
      number: episodeNumber,
      format: episode.script_format,
      lines: lines.length,
      scenes: scenes.length,
    });
    return clone(episode);
  },

  async getWorkbench(session, titleId, episodeNumber) {
    const { db } = store();
    const title = readableTitle(db, session, titleId);
    const episode = findEpisode(db, titleId, episodeNumber);
    const scenes = episodeScenes(db, episode.id);
    const sceneIds = new Set(scenes.map((s) => s.id));
    const version = pickCurrentVersion(episodeVersions(db, episode.id));
    const adapted = version
      ? db.adapted_lines.filter((a) => a.version_id === version.id).sort((a, b) => a.seq - b.seq)
      : [];
    const adaptedIds = new Set(adapted.map((a) => a.id));
    return clone({
      title,
      adaptation: findAdaptation(db, titleId),
      episode,
      characters: db.characters.filter((c) => c.title_id === titleId),
      scenes,
      lines: episodeLines(db, sceneIds),
      version,
      adapted_lines: adapted,
      alternatives: db.line_alternatives
        .filter((a) => adaptedIds.has(a.adapted_line_id))
        .sort((a, b) => a.seq - b.seq),
      decisions: version
        ? db.scene_decisions.filter((decision) =>
            decision.version_id === (version.status === "draft" ? version.parent_version_id : version.id)
          )
        : [],
      video_url: mediaUrl(episode.video_path),
      ai_available: isLlmAvailable(),
    });
  },

  async listApprovedTranslationMemory(session, titleId) {
    const { db } = store();
    readableTitle(db, session, titleId);
    const approved = db.versions.filter((version) => version.status === "approved" && version.snapshot);
    return clone(examplesFromApprovedVersions(approved));
  },

  async upsertCharacters(session, titleId, characters) {
    const { db } = store();
    requireTitleEditor(db, session, titleId);
    const at = now();
    for (const c of characters) {
      const name = c.name_zh.trim();
      if (!name) continue;
      let row = db.characters.find((x) => x.title_id === titleId && x.name_zh === name);
      if (!row) {
        row = { id: randomUUID(), title_id: titleId, name_zh: name, name_en: null, notes: null, created_at: at };
        db.characters.push(row);
      }
      if (c.name_en !== undefined) row.name_en = c.name_en;
      if (c.notes !== undefined) row.notes = c.notes;
      // Resolve lines that carry this speaker but no character yet.
      for (const l of db.lines) {
        if (l.title_id === titleId && l.character_id === null && l.speaker === name) l.character_id = row.id;
      }
    }
    return clone(db.characters.filter((c) => c.title_id === titleId));
  },

  async setSceneContext(session, sceneId, context) {
    const { db } = store();
    const scene = findScene(db, sceneId);
    requireTitleEditor(db, session, scene.title_id);
    scene.context_zh = context.context_zh;
    scene.context_en = context.context_en;
    return clone(scene);
  },

  async writeFirstPass(session, versionId, sceneId, lines) {
    const { db } = store();
    const version = requireDraft(db, versionId);
    requireTitleEditor(db, session, version.title_id);
    const scene = findScene(db, sceneId);
    if (scene.episode_id !== version.episode_id) throw invalid("scene is not in this version's episode");
    const at = now();
    for (const fp of lines) {
      const src = db.lines.find((l) => l.id === fp.line_id && l.scene_id === scene.id);
      if (!src) throw notFound("line in scene", fp.line_id);
      src.literal_en = fp.literal_en;
      const existing = db.adapted_lines.find((a) => a.version_id === version.id && a.line_id === src.id);
      // A hand-edited line is never overwritten by a re-run (docs/data-model.md § 5).
      if (existing?.authored_by === "editor") continue;
      const fields = {
        text_en: fp.text_en,
        key_phrase_en: fp.key_phrase_en ?? null,
        back_translation_zh: fp.back_translation_zh,
        change_type: fp.change_type,
        is_major: fp.is_major,
        rationale_en: fp.rationale_en,
        rationale_zh: fp.rationale_zh,
        tone_note_en: fp.tone_note_en ?? null,
        tone_note_zh: fp.tone_note_zh ?? null,
        tags: fp.tags ?? [],
        syllables_est: fp.syllables_est ?? null,
        authored_by: "ai" as const,
        model: fp.model,
        prompt_version: fp.prompt_version,
        ai_text_en: fp.text_en,
        ai_rationale_zh: fp.rationale_zh,
        edited_by: null,
        updated_at: at,
      };
      if (existing) {
        Object.assign(existing, fields);
      } else {
        db.adapted_lines.push({
          id: randomUUID(),
          external_id: extId("rw"),
          title_id: version.title_id,
          version_id: version.id,
          scene_id: scene.id,
          line_id: src.id,
          merges: [],
          seq: src.seq,
          start_ms: src.start_ms,
          end_ms: src.end_ms,
          created_at: at,
          ...fields,
        });
      }
    }
    version.updated_at = at;
    return clone(
      db.adapted_lines.filter((a) => a.version_id === version.id && a.scene_id === scene.id).sort((a, b) => a.seq - b.seq)
    );
  },

  async updateAdaptedLine(session, adaptedLineId, patch, opts) {
    const { db } = store();
    const line = findAdaptedLine(db, adaptedLineId);
    requireTitleEditor(db, session, line.title_id);
    requireDraft(db, line.version_id);
    if (patch.change_type === "cut") patch = { ...patch, text_en: null };
    // A hand-typed English invalidates the highlighted phrase unless the
    // caller re-anchors it; a phrase not present in the text is meaningless.
    if (patch.text_en !== undefined && patch.key_phrase_en === undefined) {
      patch = { ...patch, key_phrase_en: null };
    }
    Object.assign(line, patch, {
      authored_by: opts?.authored_by ?? "editor",
      edited_by: session.userId,
      updated_at: now(),
    });
    if (opts?.model !== undefined) line.model = opts.model;
    if (opts?.prompt_version !== undefined) line.prompt_version = opts.prompt_version;
    return clone(line);
  },

  async addAlternatives(session, adaptedLineId, alternatives) {
    const { db } = store();
    const line = findAdaptedLine(db, adaptedLineId);
    requireTitleEditor(db, session, line.title_id);
    requireDraft(db, line.version_id);
    const existing = db.line_alternatives.filter((a) => a.adapted_line_id === line.id);
    let seq = existing.reduce((m, a) => Math.max(m, a.seq), 0);
    const at = now();
    const rows: LineAlternative[] = alternatives.map((alt) => ({
      id: randomUUID(),
      external_id: extId("alt"),
      title_id: line.title_id,
      version_id: line.version_id,
      adapted_line_id: line.id,
      seq: ++seq,
      text_en: alt.text_en,
      back_translation_zh: alt.back_translation_zh ?? null,
      rationale_zh: alt.rationale_zh,
      rationale_en: alt.rationale_en ?? null,
      tags: alt.tags ?? [],
      syllables_est: alt.syllables_est ?? null,
      model: alt.model,
      prompt_version: alt.prompt_version,
      job_id: alt.job_id ?? null,
      chosen: false,
      chosen_by: null,
      chosen_at: null,
      created_at: at,
    }));
    db.line_alternatives.push(...rows);
    return clone(rows);
  },

  async chooseAlternative(session, adaptedLineId, alternativeId) {
    const s = store();
    const { db } = s;
    const line = findAdaptedLine(db, adaptedLineId);
    requireTitleEditor(db, session, line.title_id);
    requireDraft(db, line.version_id);
    const alt = db.line_alternatives.find((a) => a.id === alternativeId);
    if (!alt) throw notFound("alternative", alternativeId);
    if (alt.adapted_line_id !== line.id) throw invalid("alternative belongs to another line");
    const at = now();
    for (const other of db.line_alternatives) {
      if (other.adapted_line_id === line.id && other.chosen && other.id !== alt.id) {
        other.chosen = false;
        other.chosen_by = null;
        other.chosen_at = null;
      }
    }
    alt.chosen = true;
    alt.chosen_by = session.userId;
    alt.chosen_at = at;
    // Copy onto the line; authored_by stays 'ai', ai_text_en / ai_rationale_zh untouched.
    line.text_en = alt.text_en;
    line.key_phrase_en = null; // alternatives carry no anchored phrase
    line.back_translation_zh = alt.back_translation_zh;
    line.rationale_en = alt.rationale_en;
    line.rationale_zh = alt.rationale_zh;
    line.tags = [...alt.tags];
    line.syllables_est = alt.syllables_est;
    line.model = alt.model;
    line.prompt_version = alt.prompt_version;
    line.authored_by = "ai";
    line.edited_by = session.userId;
    line.updated_at = at;
    audit(s, session, "choose_alternative", "studio.adapted_lines", line.id, line.title_id, null, {
      alternative_id: alt.id,
      alternative_external_id: alt.external_id,
    });
    return clone(line);
  },

  async setSceneStatus(session, sceneId, status) {
    const s = store();
    const scene = findScene(s.db, sceneId);
    requireTitleEditor(s.db, session, scene.title_id);
    if (scene.status === status) return clone(scene);
    const draft = episodeVersions(s.db, scene.episode_id).find((v) => v.status === "draft");
    if (!draft) throw frozen("no editable draft exists; fork the submitted version first");
    if (status === "approved") {
      const issue = sceneReadinessIssue(s.db, scene);
      if (issue) throw invalid(`scene is not ready: ${issue}`);
    }
    const before = scene.status;
    scene.status = status;
    scene.status_by = session.userId;
    scene.status_at = now();
    audit(s, session, "set_scene_status", "studio.scenes", scene.id, scene.title_id, { status: before }, { status });
    return clone(scene);
  },

  async retimeEpisodeFromStamps(session, titleId, episodeNumber) {
    const s = store();
    requireTitleEditor(s.db, session, titleId);
    const episode = findEpisode(s.db, titleId, episodeNumber);
    const sceneRows = s.db.scenes.filter((sc) => sc.episode_id === episode.id);
    const sceneIds = new Set(sceneRows.map((sc) => sc.id));
    const lines = s.db.lines
      .filter((l) => sceneIds.has(l.scene_id) && !l.merged_into_id)
      .sort((a, b) => a.seq - b.seq);
    const stamps = lines.map((l) => liftStamp(l.text_zh));
    const stamped = stamps.filter(Boolean).length;
    if (stamped < 2 || stamped / Math.max(1, lines.length) < 0.6) {
      throw invalid("no per-line [hh:mm:ss] stamps found in this episode's text");
    }
    // Same frame-sampling correction the ingest applies (lib/ingest).
    const onSecond = stamps.filter((st) => st && st.ms % 1000 === 0).length;
    if (onSecond / stamped >= 0.6) {
      for (const st of stamps) if (st) st.ms = Math.max(0, st.ms - SAMPLE_LATENCY_MS);
    }
    let timed = 0;
    for (let i = 0; i < lines.length; i++) {
      const st = stamps[i];
      if (!st) continue;
      const sp = splitSpeaker(st.rest);
      lines[i].text_zh = sp.text;
      if (!lines[i].speaker && sp.speaker) lines[i].speaker = sp.speaker;
      const next = stamps.slice(i + 1).find(Boolean);
      const until = next && next.ms > st.ms ? next.ms : st.ms + LAST_CUE_MS;
      lines[i].start_ms = st.ms;
      lines[i].end_ms = Math.min(until, st.ms + MAX_DERIVED_CUE_MS);
      lines[i].duration_ms = lines[i].end_ms! - st.ms;
      timed += 1;
    }
    // Draft adaptation rows mirror their line's window; frozen snapshots stay
    // as approved — the route forks + refinalizes when one is current.
    const byLine = new Map(lines.map((l) => [l.id, l]));
    for (const a of s.db.adapted_lines) {
      const l = a.line_id ? byLine.get(a.line_id) : undefined;
      if (l) {
        a.start_ms = l.start_ms;
        a.end_ms = l.end_ms;
      }
    }
    for (const sc of sceneRows) {
      const timedLines = lines.filter((l) => l.scene_id === sc.id && l.start_ms !== null);
      if (timedLines.length) {
        sc.start_ms = Math.min(...timedLines.map((l) => l.start_ms!));
        sc.end_ms = Math.max(...timedLines.map((l) => l.end_ms ?? l.start_ms!));
      }
    }
    const before = episode.has_timecodes;
    episode.has_timecodes = true;
    episode.duration_ms = Math.max(...lines.map((l) => l.end_ms ?? 0));
    audit(s, session, "retime_episode", "core.episodes", episode.id, titleId, { has_timecodes: before }, { has_timecodes: true, timed });
    return { timed };
  },

  async applyEpisodeTimingOffset(session, titleId, episodeNumber, offsetMs) {
    const s = store();
    requireTitleEditor(s.db, session, titleId);
    if (!Number.isInteger(offsetMs) || offsetMs === 0) throw invalid("offset_ms must be a non-zero integer");
    if (Math.abs(offsetMs) > 60_000) throw invalid("offset_ms must stay within one minute");
    const episode = findEpisode(s.db, titleId, episodeNumber);
    if (!episode.has_timecodes) throw invalid("this episode has no timecodes to shift");
    const sceneRows = s.db.scenes.filter((sc) => sc.episode_id === episode.id);
    const sceneIds = new Set(sceneRows.map((sc) => sc.id));
    const lines = s.db.lines
      .filter((l) => sceneIds.has(l.scene_id) && !l.merged_into_id)
      .sort((a, b) => (a.start_ms ?? 0) - (b.start_ms ?? 0) || a.seq - b.seq);
    const r = applyGlobalOffset(lines, offsetMs);
    for (let i = 0; i < lines.length; i++) {
      lines[i].start_ms = r.cues[i].start_ms;
      lines[i].end_ms = r.cues[i].end_ms;
      lines[i].duration_ms =
        lines[i].start_ms !== null && lines[i].end_ms !== null ? lines[i].end_ms! - lines[i].start_ms! : null;
    }
    syncTimingMirrors(s.db, episode.id, sceneRows, lines);
    audit(s, session, "shift_episode_timing", "core.episodes", episode.id, titleId, {}, { offset_ms: offsetMs, shifted: r.shifted, clamped: r.clamped });
    return { shifted: r.shifted, clamped: r.clamped };
  },

  async updateLineTimings(session, titleId, episodeNumber, updates) {
    const s = store();
    requireTitleEditor(s.db, session, titleId);
    if (!updates.length) throw invalid("no timing updates given");
    const episode = findEpisode(s.db, titleId, episodeNumber);
    const sceneRows = s.db.scenes.filter((sc) => sc.episode_id === episode.id);
    const sceneIds = new Set(sceneRows.map((sc) => sc.id));
    const byId = new Map(s.db.lines.filter((l) => sceneIds.has(l.scene_id)).map((l) => [l.id, l]));
    for (const u of updates) {
      const line = byId.get(u.line_id);
      if (!line) throw notFound(`line ${u.line_id} is not in this episode`);
      try {
        assertValidCue(u);
      } catch (e) {
        throw invalid(`line seq ${line.seq}: ${(e as Error).message}`);
      }
    }
    for (const u of updates) {
      const line = byId.get(u.line_id)!;
      line.start_ms = u.start_ms;
      line.end_ms = u.end_ms;
      line.duration_ms = u.end_ms - u.start_ms;
    }
    episode.has_timecodes = true;
    const lines = s.db.lines.filter((l) => sceneIds.has(l.scene_id) && !l.merged_into_id);
    syncTimingMirrors(s.db, episode.id, sceneRows, lines);
    audit(s, session, "edit_line_timing", "core.episodes", episode.id, titleId, {}, { updated: updates.length });
    return { updated: updates.length };
  },

  async setEpisodeVideo(session, titleId, episodeNumber, storedPath) {
    const s = store();
    requireTitleEditor(s.db, session, titleId);
    const episode = findEpisode(s.db, titleId, episodeNumber);
    // An imported episode's hash, frames, window and end note describe the workspace snapshot; a file replaced by hand would leave them describing another file.
    if (episode.source_ref) throw conflict("this episode comes from the film workspace; update the film instead");
    const before = episode.video_path;
    episode.video_path = storedPath;
    audit(s, session, "set_episode_video", "core.episodes", episode.id, titleId, { video_path: before }, { video_path: storedPath });
    return clone(episode);
  },

  // ---- the workspace import (decision 2026-09-22; migration 0015) ----

  async findTitleBySourceRef(session, producerId, sourceRef) {
    const { db } = store();
    const ref = normalizeSourceRef(sourceRef);
    // A producer looks only inside their own company: another company's film reads as nothing, never as forbidden.
    if (session.kind === "producer" && session.producerId !== producerId) return null;
    const title = db.titles.find((t) => t.producer_id === producerId && t.source_ref === ref);
    return title && canReadTitle(session, title.producer_id) ? clone(title) : null;
  },

  async createImportedTitle(session, input) {
    const s = store();
    const display = input.display_title_en?.trim();
    if (!display) throw invalid("display_title_en is required");
    const ref = normalizeSourceRef(input.source_ref);
    // The same company rule as createTitle, checked here first so a duplicate film creates nothing.
    const producerId = session.kind === "producer" ? session.producerId! : input.producer_id;
    if (s.db.titles.some((t) => t.producer_id === producerId && t.source_ref === ref)) throw conflict(`this company already has a title for ${ref}`);
    const created = await fixtureData.createTitle(session, {
      name_zh: display,
      name_en: display,
      producer_id: input.producer_id,
      genre: input.genre ?? null,
      synopsis_en: input.synopsis_en ?? null,
      source_locale: input.source_locale?.trim() || "en-US",
      created_by: input.created_by ?? null,
    });
    const title = findTitle(s.db, created.id);
    title.source_ref = ref;
    title.crazydramas_slug = input.crazydramas_slug?.trim() || null;
    title.cover_path = input.cover_path?.trim() || null;
    audit(s, session, "import_title", "core.titles", title.id, title.id, null, { source_ref: ref, crazydramas_slug: title.crazydramas_slug, cover_path: title.cover_path });
    return clone(title);
  },

  async setTitleImport(session, titleId, patch) {
    const s = store();
    const title = requireTitleEditor(s.db, session, titleId);
    const before = { name_en: title.name_en, crazydramas_slug: title.crazydramas_slug ?? null, cover_path: title.cover_path ?? null };
    if (patch.display_title_en !== undefined) {
      const display = patch.display_title_en.trim();
      if (!display) throw invalid("display_title_en must not be empty");
      title.name_en = display;
      title.name_zh = display;
      findAdaptation(s.db, titleId).display_title_en = display;
    }
    if (patch.crazydramas_slug !== undefined) title.crazydramas_slug = patch.crazydramas_slug?.trim() || null;
    if (patch.cover_path !== undefined) title.cover_path = patch.cover_path?.trim() || null;
    title.updated_at = now();
    audit(s, session, "set_title_import", "core.titles", title.id, title.id, before, { name_en: title.name_en, crazydramas_slug: title.crazydramas_slug ?? null, cover_path: title.cover_path ?? null });
    return clone(title);
  },

  async setTitleAdRules(session, titleId, rules) {
    const s = store();
    const title = requireTitleEditor(s.db, session, titleId);
    const clean = validateAdRules(rules);
    const before = (title.ad_rules ?? null) as Json;
    title.ad_rules = clean;
    title.updated_at = now();
    audit(s, session, "set_title_ad_rules", "core.titles", title.id, title.id, before, clean as unknown as Json);
    return clone(title);
  },

  async setEpisodeImport(session, episodeId, patch) {
    const s = store();
    const episode = s.db.episodes.find((e) => e.id === episodeId);
    if (!episode) throw notFound("episode", episodeId);
    readableTitle(s.db, session, episode.title_id); // not_found for a foreign title, like RLS
    requireSystemOrStaff(session); // a producer session never writes what the ad engine trusts (0015: no column grant)
    const fields = episodeImportPatch(patch, episode);
    const before: Json = { video_path: episode.video_path, video_sha256: episode.video_sha256 ?? null, auto_cut: episode.auto_cut ?? true };
    Object.assign(episode, fields);
    audit(s, session, "set_episode_import", "core.episodes", episode.id, episode.title_id, before, { video_path: episode.video_path, video_sha256: episode.video_sha256 ?? null, auto_cut: episode.auto_cut ?? true, film_start_ms: episode.film_start_ms ?? null, film_end_ms: episode.film_end_ms ?? null });
    return clone(episode);
  },

  async listFilmAssets(session, titleId) {
    const { db } = store();
    readableTitle(db, session, titleId); // a foreign title is not found, never forbidden
    // Newest first; rows written in the same millisecond keep the later write first (a stable sort over the reversed list).
    const rows = db.film_assets.filter((a) => a.title_id === titleId).reverse();
    return clone(rows.sort((a, b) => b.created_at.localeCompare(a.created_at)));
  },

  async putFilmAsset(session, input) {
    const s = store();
    const row = filmAssetRow(input);
    requireTitleEditor(s.db, session, row.title_id); // staff, the system, or the title's own editor
    const existing = s.db.film_assets.find((a) => a.title_id === row.title_id && a.kind === row.kind && a.sha256 === row.sha256);
    if (existing) return clone(existing);
    const asset: FilmAsset = { id: randomUUID(), created_at: now(), ...row };
    s.db.film_assets.push(asset);
    audit(s, session, "put_film_asset", "studio.film_assets", asset.id, asset.title_id, null, { kind: asset.kind, sha256: asset.sha256, storage_path: asset.storage_path, origin: asset.origin });
    return clone(asset);
  },

  // ---- the gate ----

  async submitVersion(session, versionId) {
    requireStaff(session);
    const s = store();
    const { db } = s;
    const v = findVersion(db, versionId);
    if (v.status !== "draft") throw frozen(`version is ${v.status}, expected draft`);
    const scenes = episodeScenes(db, v.episode_id);
    if (!scenes.length) throw invalid("the episode has no scenes");
    const unapproved = scenes.filter((sc) => sc.status !== "approved").length;
    if (unapproved > 0) throw invalid(`${unapproved} scene(s) not yet approved by staff`);
    const sceneIds = new Set(scenes.map((scene) => scene.id));
    const sourceLines = db.lines.filter((line) => sceneIds.has(line.scene_id) && line.merged_into_id === null);
    const adaptedByLine = new Map(
      db.adapted_lines
        .filter((row) => row.version_id === v.id && row.line_id)
        .map((row) => [row.line_id as string, row])
    );
    const missing = sourceLines.filter((line) => !adaptedByLine.has(line.id)).length;
    if (missing > 0) throw invalid(`${missing} source line(s) still need an English adaptation`);
    const empty = sourceLines.filter((line) => {
      const row = adaptedByLine.get(line.id);
      return row?.change_type !== "cut" && blank(row?.text_en);
    }).length;
    if (empty > 0) throw invalid(`${empty} adapted line(s) are empty`);
    const lacking = db.adapted_lines.filter(
      (r) =>
        r.version_id === v.id &&
        r.change_type !== "keep" &&
        (blank(r.rationale_zh) || (r.change_type !== "cut" && blank(r.back_translation_zh)))
    ).length;
    if (lacking > 0) throw invalid(`${lacking} changed line(s) lack rationale_zh or back_translation_zh`);
    if (v.parent_version_id) {
      const unanswered = db.scene_decisions.filter(
        (decision) =>
          decision.version_id === v.parent_version_id &&
          decision.decision === "needs_alternative" &&
          !decision.resolution_disposition
      ).length;
      if (unanswered > 0) throw invalid(`${unanswered} producer request(s) still need a Pulsar response`);
    }

    const snapshot = snapshotOf(db, v);
    const sha = snapshotSha256(snapshot);
    const at = now();
    v.status = "in_review";
    v.submitted_at = at;
    v.submitted_by = session.userId;
    v.snapshot = snapshot;
    v.snapshot_sha256 = sha;
    v.updated_at = at;
    audit(s, session, "submit_version", "studio.versions", v.id, v.title_id, { status: "draft" }, { status: "in_review", snapshot_sha256: sha });
    return clone(v);
  },

  async approveVersion(session, versionId, opts) {
    const s = store();
    const { db } = s;
    const v = findVersion(db, versionId);
    const title = findTitle(db, v.title_id);
    if (session.kind === "producer" && !canReadTitle(session, title.producer_id)) throw notFound("version", versionId);
    if (v.status !== "in_review") throw frozen(`version is ${v.status}, expected in_review`);
    const scenes = episodeScenes(db, v.episode_id);
    const at = now();
    const channel: AuditChannel = opts.channel ?? "in_app";

    if (opts.mode === "producer") {
      if (!isProducerApprover(session, title)) throw forbidden("producer approver of this title only");
      // Producer-first (2026-09-03 evening): approving the episode IS the
      // per-scene sign-off — there is no separate request-changes loop, so
      // undecided scenes are filled in as approved by the producer here.
      for (const sc of scenes) {
        const d = db.scene_decisions.find((x) => x.version_id === v.id && x.scene_id === sc.id);
        if (d?.decision === "approved") continue;
        const fields = {
          decision: "approved" as const,
          line_id: null,
          timestamp_ms: null,
          note: null,
          resolution_disposition: null,
          resolution_note: null,
          responded_by: null,
          responded_at: null,
          decided_by: session.userId,
          decided_at: at,
          decided_kind: "producer" as const,
        };
        if (d) Object.assign(d, fields);
        else db.scene_decisions.push({ version_id: v.id, scene_id: sc.id, title_id: v.title_id, created_at: at, ...fields });
      }
    } else {
      requireStaffAdmin(session);
      if (blank(opts.evidenceNote)) throw invalid("on_behalf requires an evidence note");
      // Complete the record: every scene without an approved decision gets one, as staff_on_behalf.
      for (const sc of scenes) {
        const d = db.scene_decisions.find((x) => x.version_id === v.id && x.scene_id === sc.id);
        if (d?.decision === "approved") continue;
        if (d) {
          Object.assign(d, {
            decision: "approved",
            line_id: null,
            timestamp_ms: null,
            note: opts.evidenceNote,
            resolution_disposition: null,
            resolution_note: null,
            responded_by: null,
            responded_at: null,
            decided_by: session.userId,
            decided_at: at,
            decided_kind: "staff_on_behalf",
          });
        } else {
          db.scene_decisions.push({
            version_id: v.id,
            scene_id: sc.id,
            title_id: v.title_id,
            decision: "approved",
            line_id: null,
            timestamp_ms: null,
            note: opts.evidenceNote as string,
            resolution_disposition: null,
            resolution_note: null,
            responded_by: null,
            responded_at: null,
            decided_by: session.userId,
            decided_at: at,
            decided_kind: "staff_on_behalf",
            created_at: at,
          });
        }
      }
    }

    const prev = db.versions.find(
      (x) => x.adaptation_id === v.adaptation_id && x.episode_id === v.episode_id && x.status === "approved" && x.id !== v.id
    );
    if (prev) {
      prev.status = "superseded";
      prev.updated_at = at;
      audit(s, session, "supersede_version", "studio.versions", prev.id, v.title_id, { status: "approved" }, { status: "superseded", superseded_by: v.id }, null, channel);
    }
    v.status = "approved";
    v.approved_at = at;
    v.approved_by = session.userId;
    v.approval_mode = opts.mode === "producer" ? "in_app" : "on_behalf";
    v.approval_evidence = opts.mode === "on_behalf" ? (opts.evidenceNote as string) : null;
    v.approval_note = opts.note ?? null;
    v.updated_at = at;
    audit(
      s,
      session,
      "approve_version",
      "studio.versions",
      v.id,
      v.title_id,
      { status: "in_review" },
      { status: "approved", approval_mode: v.approval_mode },
      opts.note ?? opts.evidenceNote ?? null,
      channel
    );
    title.updated_at = at;
    return clone(v);
  },

  async forkVersion(session, versionId) {
    const s = store();
    const { db } = s;
    const v = findVersion(db, versionId);
    requireTitleEditor(db, session, v.title_id);
    if (v.status !== "in_review" && v.status !== "approved") throw invalid(`version is ${v.status}, expected in_review or approved`);
    // No undecided-scenes guard any more: "I'll change it myself" (the
    // producer forking a submitted version to edit directly) is the normal
    // path now, not an exception. The superseded version keeps whatever
    // decisions existed for the audit trail.
    const siblings = db.versions.filter((x) => x.adaptation_id === v.adaptation_id && x.episode_id === v.episode_id);
    if (siblings.some((x) => x.status === "draft")) throw conflict("an open draft already exists for this episode");
    const at = now();
    const next = siblings.reduce((m, x) => Math.max(m, x.number), 0) + 1;
    const draft: Version = {
      id: randomUUID(),
      external_id: extId("ver"),
      title_id: v.title_id,
      adaptation_id: v.adaptation_id,
      episode_id: v.episode_id,
      number: next,
      parent_version_id: v.id,
      status: "draft",
      submitted_at: null,
      submitted_by: null,
      approved_at: null,
      approved_by: null,
      approval_mode: null,
      approval_evidence: null,
      approval_note: null,
      snapshot: null,
      snapshot_sha256: null,
      created_at: at,
      updated_at: at,
    };
    db.versions.push(draft);
    // Adapted lines carry over with provenance; alternatives and decisions do not.
    const copies: AdaptedLine[] = db.adapted_lines
      .filter((r) => r.version_id === v.id)
      .map((r) => ({
        ...clone(r),
        id: randomUUID(),
        external_id: extId("rw"),
        version_id: draft.id,
        created_at: at,
        updated_at: at,
      }));
    db.adapted_lines.push(...copies);
    // Only the scenes the partner sent back drop to draft.
    for (const sc of episodeScenes(db, v.episode_id)) {
      const sentBack = db.scene_decisions.some((d) => d.version_id === v.id && d.scene_id === sc.id && d.decision === "needs_alternative");
      if (sentBack && sc.status !== "draft") {
        sc.status = "draft";
        sc.status_by = session.userId;
        sc.status_at = at;
      }
    }
    if (v.status === "in_review") {
      v.status = "superseded";
      v.updated_at = at;
    }
    audit(s, session, "fork_version", "studio.versions", draft.id, v.title_id, { parent_version_id: v.id, parent_status: v.status }, { status: "draft", number: next });
    return clone(draft);
  },

  async finalizeVersion(session, versionId) {
    // The self-serve gate (docs/decisions.md, 2026-09-03 producer-first
    // pivot): the title's own producer finishes editing, marks every scene
    // ready, and one action freezes the snapshot AND approves it — there is
    // no separate reviewer when the rights holder did the work themselves.
    // Staff use submit + approve-on-behalf instead; finalize is refused so
    // an approval is never silently attributed to the wrong side.
    const s = store();
    const { db } = s;
    const v = findVersion(db, versionId);
    const title = requireTitleEditor(db, session, v.title_id);
    if (session.kind !== "producer") {
      throw forbidden("finalize is the producer's action; staff submit for review instead");
    }
    if (session.producerRole !== "approver") throw forbidden("finalizing needs the approver role");
    if (v.status !== "draft") throw frozen(`version is ${v.status}, expected draft`);

    const scenes = episodeScenes(db, v.episode_id);
    if (!scenes.length) throw invalid("the episode has no scenes");
    // V2 (2026-09-04, subtitles-not-dubbing rework): no per-scene confirm
    // step — the per-line confirm is the review. Content readiness is still
    // the gate: every line adapted, non-cut lines non-empty, AI-changed lines
    // carrying their Chinese rationale and back-translation. Lines the
    // producer (or any human editor) wrote themselves are exempt from the
    // explanation rule — the portal's editor sends text only, and this is
    // the producer approving their own words (views.ts adaptedLineIssue).
    for (const sc of scenes) {
      const issue = sceneReadinessIssue(db, sc, { forFinalize: true });
      if (issue) throw invalid(`lines ${sc.number > 1 ? `around ${timecodeHint(sc.start_ms)}` : "at the start"} are not ready: ${issue}`);
    }

    const snapshot = snapshotOf(db, v);
    const sha = snapshotSha256(snapshot);
    const at = now();
    // The frozen record carries the producer's per-scene sign-off.
    for (const sc of scenes) {
      db.scene_decisions.push({
        version_id: v.id,
        scene_id: sc.id,
        title_id: v.title_id,
        decision: "approved",
        line_id: null,
        timestamp_ms: null,
        note: null,
        resolution_disposition: null,
        resolution_note: null,
        responded_by: null,
        responded_at: null,
        decided_by: session.userId,
        decided_at: at,
        decided_kind: "producer",
        created_at: at,
      });
    }
    const prev = db.versions.find(
      (x) => x.adaptation_id === v.adaptation_id && x.episode_id === v.episode_id && x.status === "approved" && x.id !== v.id
    );
    if (prev) {
      prev.status = "superseded";
      prev.updated_at = at;
    }
    v.status = "approved";
    v.submitted_at = at;
    v.submitted_by = session.userId;
    v.approved_at = at;
    v.approved_by = session.userId;
    v.approval_mode = "in_app";
    v.approval_note = null;
    v.snapshot = snapshot;
    v.snapshot_sha256 = sha;
    v.updated_at = at;
    title.updated_at = at;
    audit(s, session, "finalize_version", "studio.versions", v.id, v.title_id, { status: "draft" }, { status: "approved", snapshot_sha256: sha });
    return clone(v);
  },

  async decideScene(session, versionId, sceneId, decision, note, lineId) {
    const s = store();
    const { db } = s;
    const v = findVersion(db, versionId);
    const title = findTitle(db, v.title_id);
    // A producer never learns a draft or another producer's version exists.
    if (session.kind === "producer" && (!canReadTitle(session, title.producer_id) || v.status === "draft" || v.status === "superseded")) {
      throw notFound("version", versionId);
    }
    if (v.status !== "in_review") throw frozen(`version is ${v.status}; decisions need in_review`);
    const scene = findScene(db, sceneId);
    if (scene.episode_id !== v.episode_id) throw invalid("scene is not in this version's episode");
    const line = lineId ? db.lines.find((item) => item.id === lineId) ?? null : null;
    if (line && line.scene_id !== scene.id) throw invalid("feedback line is not in this scene");

    let decided_kind: SceneDecision["decided_kind"];
    if (isProducerReviewer(session, title)) {
      decided_kind = "producer";
    } else if (isStaffAdmin(session)) {
      if (blank(note)) throw invalid("an evidence note is required to decide on the producer's behalf");
      decided_kind = "staff_on_behalf";
    } else {
      throw forbidden("producer approver/reviewer of this title or staff admin only");
    }
    if (decision === "needs_alternative" && blank(note)) throw invalid("needs_alternative requires a one-line reason");
    if (decision === "needs_alternative" && !line) throw invalid("needs_alternative requires a timestamped line");

    const at = now();
    const cleanNote = blank(note) ? null : (note as string).trim();
    let row = db.scene_decisions.find((d) => d.version_id === v.id && d.scene_id === scene.id);
    const before: Json | null = row ? (clone(row) as unknown as Json) : null;
    if (row) {
      Object.assign(row, {
        decision,
        line_id: decision === "needs_alternative" ? line!.id : null,
        timestamp_ms: decision === "needs_alternative" ? line!.start_ms : null,
        note: cleanNote,
        resolution_disposition: null,
        resolution_note: null,
        responded_by: null,
        responded_at: null,
        decided_by: session.userId,
        decided_at: at,
        decided_kind,
      });
    } else {
      row = {
        version_id: v.id,
        scene_id: scene.id,
        title_id: v.title_id,
        decision,
        line_id: decision === "needs_alternative" ? line!.id : null,
        timestamp_ms: decision === "needs_alternative" ? line!.start_ms : null,
        note: cleanNote,
        resolution_disposition: null,
        resolution_note: null,
        responded_by: null,
        responded_at: null,
        decided_by: session.userId,
        decided_at: at,
        decided_kind,
        created_at: at,
      };
      db.scene_decisions.push(row);
    }
    audit(s, session, "decide_scene", "studio.scene_decisions", scene.id, v.title_id, before, clone(row) as unknown as Json, cleanNote);
    return clone(row);
  },

  async respondToFeedback(session, versionId, sceneId, disposition, note) {
    const s = store();
    const { db } = s;
    if (session.kind !== "staff") throw forbidden("staff only");
    if (blank(note)) throw invalid("a response explaining Pulsar's decision is required");
    const version = findVersion(db, versionId);
    const row = db.scene_decisions.find(
      (item) => item.version_id === version.id && item.scene_id === sceneId && item.decision === "needs_alternative"
    );
    if (!row) throw notFound("timestamped feedback", sceneId);
    const before = clone(row) as unknown as Json;
    const at = now();
    row.resolution_disposition = disposition;
    row.resolution_note = note.trim();
    row.responded_by = session.userId;
    row.responded_at = at;
    audit(s, session, "respond_to_feedback", "studio.scene_decisions", sceneId, version.title_id, before, clone(row) as unknown as Json, row.resolution_note);
    return clone(row);
  },

  // ---- creative pack ----

  async listVariants(session, titleId) {
    requireStaff(session);
    const { db } = store();
    findTitle(db, titleId);
    return clone(db.variants.filter((v) => v.title_id === titleId));
  },

  async upsertVariants(session, titleId, variants) {
    requireStaff(session);
    const { db } = store();
    findTitle(db, titleId);
    const adaptation = findAdaptation(db, titleId);
    const at = now();
    const rows: Variant[] = variants.map((v) => ({
      id: randomUUID(),
      external_id: extId("var"),
      title_id: titleId,
      adaptation_id: adaptation.id,
      kind: v.kind,
      text_en: v.text_en,
      text_zh: v.text_zh ?? null,
      rationale_en: v.rationale_en ?? null,
      rationale_zh: v.rationale_zh ?? null,
      tags: v.tags ?? [],
      selected: false,
      status: "candidate",
      model: v.model ?? null,
      prompt_version: v.prompt_version ?? null,
      job_id: v.job_id ?? null,
      created_by: v.model ? null : session.userId,
      created_at: at,
      updated_at: at,
    }));
    db.variants.push(...rows);
    return clone(db.variants.filter((v) => v.title_id === titleId));
  },

  async selectVariant(session, variantId) {
    requireStaff(session);
    const s = store();
    const { db } = s;
    const v = db.variants.find((x) => x.id === variantId);
    if (!v) throw notFound("variant", variantId);
    if (v.kind !== "title" && v.kind !== "hook") throw invalid(`only title and hook variants can be selected, not ${v.kind}`);
    if (v.status !== "candidate") throw invalid(`a ${v.status} variant cannot be selected`);
    const at = now();
    let prev: string | null = null;
    for (const other of db.variants) {
      if (other.title_id === v.title_id && other.kind === v.kind && other.selected && other.id !== v.id) {
        other.selected = false;
        other.updated_at = at;
        prev = other.id;
      }
    }
    v.selected = true;
    v.updated_at = at;
    if (v.kind === "title") findAdaptation(db, v.title_id).display_title_en = v.text_en;
    audit(s, session, "select_variant", "studio.variants", v.id, v.title_id, { previous_selected_id: prev }, { kind: v.kind, selected: true });
    return clone(v);
  },

  async dismissVariant(session, variantId, dismissed = true) {
    requireStaff(session);
    const { db } = store();
    const v = db.variants.find((x) => x.id === variantId);
    if (!v) throw notFound("variant", variantId);
    v.status = dismissed ? "dismissed" : "candidate";
    if (dismissed) v.selected = false; // a dismissed row cannot stay the platform pick (check constraint)
    v.updated_at = now();
    return clone(v);
  },

  async listClips(session, titleId, episodeNumber) {
    requireStaff(session);
    const { db } = store();
    findTitle(db, titleId);
    const number = new Map(db.episodes.map((e) => [e.id, e.number]));
    const episodeId = episodeNumber !== undefined ? findEpisode(db, titleId, episodeNumber).id : null;
    return clone(
      db.clips
        .filter((c) => c.title_id === titleId && (episodeId === null || c.episode_id === episodeId))
        .sort((a, b) => (number.get(a.episode_id) ?? 0) - (number.get(b.episode_id) ?? 0) || a.rank - b.rank)
    );
  },

  async upsertClips(session, episodeId, clips) {
    requireStaff(session);
    const { db } = store();
    const episode = findEpisodeById(db, episodeId);
    // Script clips need cue timecodes; footage clips (decision 2026-09-14) only need the video.
    if (!episode.has_timecodes && !episode.video_path) throw invalid("clips need a timed episode or an episode with video");
    const adaptation = findAdaptation(db, episode.title_id);
    // A re-run replaces 'suggested' rows only; shortlisted / dismissed keep their rank.
    // Rendered files of replaced rows stay in storage: an approved creative may still point at one.
    db.clips = db.clips.filter((c) => !(c.episode_id === episodeId && c.status === "suggested"));
    const taken = new Set(db.clips.filter((c) => c.episode_id === episodeId).map((c) => c.rank));
    const at = now();
    let cursor = 1;
    const nextFree = (preferred?: number): number => {
      if (preferred !== undefined && preferred > 0 && !taken.has(preferred)) return preferred;
      while (taken.has(cursor)) cursor++;
      return cursor;
    };
    const rows: Clip[] = clips.map((c) => {
      const rank = nextFree(c.rank);
      taken.add(rank);
      return {
        id: randomUUID(),
        external_id: extId("clip"),
        title_id: episode.title_id,
        episode_id: episodeId,
        adaptation_id: adaptation.id,
        rank,
        start_ms: c.start_ms,
        end_ms: c.end_ms,
        scene_ids: c.scene_ids,
        hook_en: c.hook_en,
        why_en: c.why_en,
        why_zh: c.why_zh,
        opening_text_en: c.opening_text_en ?? null,
        cut_length_s: c.cut_length_s ?? null,
        angle: c.angle ?? null,
        status: "suggested",
        model: c.model ?? null,
        prompt_version: c.prompt_version ?? null,
        job_id: c.job_id ?? null,
        source: c.source ?? "script",
        moment: c.moment ?? "peak",
        render_path: null,
        render_sha256: null,
        render_status: "pending",
        render_note: null,
        duration_ms: null,
        width: null,
        height: null,
        created_at: at,
      };
    });
    db.clips.push(...rows);
    return clone(db.clips.filter((c) => c.episode_id === episodeId).sort((a, b) => a.rank - b.rank));
  },

  async addUploadedClip(session, episodeId, input) {
    requireStaff(session);
    const { db } = store();
    const episode = findEpisodeById(db, episodeId);
    // No timecode/video requirement: the uploaded file IS the ad (migration
    // 0020 widens the SQL trigger the same way).
    const adaptation = findAdaptation(db, episode.title_id);
    const taken = new Set(db.clips.filter((c) => c.episode_id === episodeId).map((c) => c.rank));
    let rank = 1;
    while (taken.has(rank)) rank++;
    const at = now();
    const row: Clip = {
      id: randomUUID(),
      external_id: extId("clip"),
      title_id: episode.title_id,
      episode_id: episodeId,
      adaptation_id: adaptation.id,
      rank,
      start_ms: 0,
      end_ms: input.duration_ms && input.duration_ms > 0 ? input.duration_ms : 0,
      scene_ids: [],
      hook_en: input.hook_en,
      why_en: "Uploaded by the partner as a finished ad.",
      why_zh: "合作方上传的成片广告。",
      opening_text_en: null,
      cut_length_s: input.duration_ms && input.duration_ms > 0 ? Math.round(input.duration_ms / 1000) : null,
      angle: null,
      // Shortlisted, never 'suggested': upsertClips replaces suggested rows on
      // a re-cut and must never delete a file a person supplied.
      status: "shortlisted",
      model: null,
      prompt_version: null,
      job_id: null,
      source: "upload",
      moment: "peak",
      render_path: input.render_path,
      render_sha256: input.render_sha256,
      render_status: "rendered",
      render_note: null,
      duration_ms: input.duration_ms ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      created_at: at,
    };
    db.clips.push(row);
    return clone(row);
  },

  async setClipStatus(session, clipId, status) {
    requireStaff(session);
    const clip = store().db.clips.find((c) => c.id === clipId);
    if (!clip) throw notFound("clip", clipId);
    clip.status = status;
    return clone(clip);
  },

  async listEpisodeClips(session, titleId, episodeNumber) {
    const { db } = store();
    readableTitle(db, session, titleId); // a foreign title is not found, never forbidden
    const episodeId = episodeNumber !== undefined ? findEpisode(db, titleId, episodeNumber).id : null;
    const number = new Map(db.episodes.map((e) => [e.id, e.number]));
    return clone(
      db.clips
        .filter((c) => c.title_id === titleId && (episodeId === null || c.episode_id === episodeId))
        .sort((a, b) => (number.get(a.episode_id) ?? 0) - (number.get(b.episode_id) ?? 0) || a.rank - b.rank)
    );
  },

  async setClipRender(session, clipId, render) {
    const { db } = store();
    const clip = db.clips.find((c) => c.id === clipId);
    if (!clip) throw notFound("clip", clipId);
    if (!isSystemSession(session) && session.kind !== "staff") requireTitleEditor(db, session, clip.title_id);
    if (render.render_status === "rendered") {
      if (!render.render_path) throw invalid("a rendered clip needs its file path");
      if (!/^[0-9a-f]{64}$/.test(render.render_sha256 ?? "")) throw invalid("render checksum must be a sha256");
    }
    clip.render_status = render.render_status;
    if (render.render_path !== undefined) clip.render_path = render.render_path;
    if (render.render_sha256 !== undefined) clip.render_sha256 = render.render_sha256;
    if (render.render_note !== undefined) clip.render_note = render.render_note;
    if (render.duration_ms !== undefined) clip.duration_ms = render.duration_ms;
    if (render.width !== undefined) clip.width = render.width;
    if (render.height !== undefined) clip.height = render.height;
    return clone(clip);
  },

  async addMontageClip(session, input) {
    requireSystemOrStaff(session); // the build runs as the system after the route's edit check
    const { db } = store();
    const title = findTitle(db, input.title_id);
    const check = montageClipProblem(input, (id) => db.episodes.find((e) => e.id === id)?.title_id ?? null);
    if (check) throw invalid(check);
    const hook = input.pieces[0];
    const taken = new Set(db.clips.filter((c) => c.episode_id === hook.episode_id).map((c) => c.rank));
    let rank = MONTAGE_RANK_BASE;
    while (taken.has(rank)) rank++;
    const row: Clip = {
      id: randomUUID(),
      external_id: extId("clip"),
      title_id: title.id,
      episode_id: hook.episode_id,
      adaptation_id: findAdaptation(db, title.id).id,
      rank,
      start_ms: hook.start_ms,
      end_ms: hook.end_ms,
      scene_ids: [],
      hook_en: input.hook_en,
      why_en: input.why_en,
      why_zh: input.why_zh,
      opening_text_en: null,
      cut_length_s: Math.max(1, Math.round(input.duration_ms / 1000)),
      angle: null,
      status: "shortlisted",
      model: null,
      prompt_version: null,
      job_id: input.job_id,
      source: input.source,
      moment: "montage",
      render_path: input.render_path,
      render_sha256: input.render_sha256,
      render_status: "rendered",
      render_note: input.render_note ?? null,
      duration_ms: input.duration_ms,
      width: input.width,
      height: input.height,
      pieces: clone(input.pieces),
      created_at: now(),
    };
    db.clips.push(row);
    return clone(row);
  },

  // ---- jobs and cost ----

  async recordJob(session, job) {
    const { db } = store();
    // A producer's own generate-button presses record jobs on their titles;
    // anything not tied to a title (nothing today) stays staff.
    if (job.title_id) requireTitleEditor(db, session, job.title_id);
    else requireStaff(session);
    const at = now();
    const existing = db.jobs.find((j) => j.idempotency_key === job.idempotency_key);
    if (existing?.status === "done") return clone(existing);
    if (existing) {
      // A failed / stale-running row is retried in place, keeping its id for provenance.
      Object.assign(existing, { status: "running", error: null, started_at: at, heartbeat_at: at, finished_at: null });
      return clone(existing);
    }
    const row: Job = {
      id: randomUUID(),
      title_id: job.title_id,
      episode_id: job.episode_id ?? null,
      version_id: job.version_id ?? null,
      kind: job.kind,
      target_type: job.target_type,
      target_id: job.target_id,
      idempotency_key: job.idempotency_key,
      status: "running",
      provider: job.provider ?? null,
      model: job.model ?? null,
      input: job.input ?? null,
      output: null,
      error: null,
      usage: null,
      cost_cents: null,
      heartbeat_at: at,
      started_at: at,
      finished_at: null,
      created_at: at,
    };
    db.jobs.push(row);
    return clone(row);
  },

  async finishJob(session, jobId, result) {
    const { db } = store();
    const job = db.jobs.find((j) => j.id === jobId);
    if (!job) throw notFound("job", jobId);
    // The same rule as recordJob (producer_update_jobs in 0002: can_edit_title).
    if (job.title_id) requireTitleEditor(db, session, job.title_id);
    else requireStaff(session);
    const at = now();
    job.status = result.status;
    if (result.usage !== undefined) job.usage = result.usage;
    if (result.cost_cents !== undefined) job.cost_cents = result.cost_cents;
    if (result.output !== undefined) job.output = result.output;
    if (result.error !== undefined) job.error = result.error;
    job.heartbeat_at = at;
    job.finished_at = at;
    return clone(job);
  },

  async latestEpisodeJob(session, titleId, episodeNumber, kind) {
    const { db } = store();
    readableTitle(db, session, titleId);
    const episode = findEpisode(db, titleId, episodeNumber);
    // Two rows made in the same millisecond tie on both stamps, and a stable sort would then put the OLDER one first: the later insertion is the later row.
    const jobs = db.jobs
      .map((j, index) => ({ j, index }))
      .filter(({ j }) => j.episode_id === episode.id && j.kind === kind)
      .sort((a, b) => b.j.created_at.localeCompare(a.j.created_at) || b.j.started_at!.localeCompare(a.j.started_at!) || b.index - a.index);
    return jobs.length ? clone(jobs[0].j) : null;
  },

  async heartbeatJob(session, jobId) {
    const { db } = store();
    const job = db.jobs.find((j) => j.id === jobId);
    if (!job) throw notFound("job", jobId);
    if (job.title_id) requireTitleEditor(db, session, job.title_id);
    else requireStaff(session);
    job.heartbeat_at = now();
  },

  async latestJobByTarget(session, targetType, targetId, kind) {
    const { db } = store();
    requireSystemOrStaff(session); // a job row is Pulsar's spend record; a producer session never reads one by target
    const jobs = db.jobs
      .filter((j) => j.target_type === targetType && j.target_id === targetId && (kind === undefined || j.kind === kind))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || (b.started_at ?? "").localeCompare(a.started_at ?? ""));
    return jobs.length ? clone(jobs[0]) : null;
  },

  async sumCostCents(titleId) {
    return costOf(store().db, titleId);
  },

  // ---- film runs (decision 2026-09-23; migration 0016) ----

  async createFilmRun(session, input) {
    const s = store();
    requireSystemOrStaff(session); // staff-gated for now: a producer session creates nothing
    const row = filmRunRow(input);
    findProducer(s.db, row.producer_id); // not_found for a company that does not exist, as the FK would be
    const at = now();
    const run: FilmRun = { id: randomUUID(), created_at: at, updated_at: at, ...row, created_by: isSystemSession(session) ? null : session.userId };
    s.db.film_runs.push(run);
    audit(s, session, "create_film_run", "studio.film_runs", run.id, null, null, { producer_id: run.producer_id, bucket: run.bucket, slug: run.slug, mode: run.mode, stage: run.stage });
    return clone(run);
  },

  async getFilmRun(session, runId) {
    return clone(readableFilmRun(store().db, session, runId));
  },

  async listFilmRuns(session, opts = {}) {
    const { db } = store();
    requireMemberSession(session);
    // A producer sees only their own company's runs; another company's producerId reads empty, never forbidden (RLS would answer the same).
    const producerId = session.kind === "producer" ? session.producerId ?? null : opts.producerId ?? null;
    if (session.kind === "producer" && opts.producerId && opts.producerId !== producerId) return [];
    const rows = db.film_runs.filter((r) => !producerId || r.producer_id === producerId).slice().reverse();
    return clone(rows.sort((a, b) => b.created_at.localeCompare(a.created_at)).map(normalizeFilmRun));
  },

  async claimFilmRun(session, runId, input) {
    const s = store();
    requireSystemOrStaff(session);
    const run = readableFilmRun(s.db, session, runId);
    const fields = claimFields(run, input);
    if (!fields) return null;
    Object.assign(run, fields);
    return clone(run);
  },

  async renewFilmRunLease(session, runId, input) {
    const s = store();
    requireSystemOrStaff(session);
    const run = readableFilmRun(s.db, session, runId);
    Object.assign(run, renewFields(run, input));
    return clone(run);
  },

  async setFilmRunStage(session, runId, input) {
    const s = store();
    requireSystemOrStaff(session);
    const run = readableFilmRun(s.db, session, runId);
    const was = { stage: run.stage, revision: run.revision, error_text: run.error_text, title_id: run.title_id };
    Object.assign(run, stageFields(run, input));
    // Audited only when the stage, the refusal or the title moved (as the Supabase layer does): progress writes are not events.
    if (filmRunStageAudited(was, run)) audit(s, session, "set_film_run_stage", "studio.film_runs", run.id, run.title_id, was as Json, { stage: run.stage, revision: run.revision, error_text: run.error_text, title_id: run.title_id });
    return clone(run);
  },

  async appendFilmRunDecision(session, runId, decision) {
    const s = store();
    requireSystemOrStaff(session);
    const run = readableFilmRun(s.db, session, runId);
    const row = decisionRow(decision, isSystemSession(session) ? "system" : session.userId);
    run.decisions = [...(run.decisions ?? []), row];
    run.revision += 1;
    run.updated_at = now();
    audit(s, session, "film_run_decision", "studio.film_runs", run.id, run.title_id, null, row as unknown as Json);
    return clone(run);
  },

  async releaseFilmRun(session, runId, input) {
    const s = store();
    requireSystemOrStaff(session);
    const run = readableFilmRun(s.db, session, runId);
    Object.assign(run, releaseFields(run, input));
    return clone(run);
  },

  // ---- narrated episodes (decision 2026-09-23 "Narrated mode in Studio"; migration 0018) ----

  async createRunEpisodes(session, runId, input) {
    const s = store();
    requireSystemOrStaff(session);
    const run = readableFilmRun(s.db, session, runId);
    const rows = runEpisodeRows(run, input);
    const table = episodeTable(s.db).film_run_episodes;
    if (table.some((e) => e.run_id === run.id)) throw conflict(`run ${run.id} already has its episode rows: a plan is written once`);
    const others = table.filter((e) => e.series_key === rows[0].series_key && e.run_id !== run.id);
    const held = heldNumbersConflict(rows.map((r) => r.n), others, (id) => s.db.film_runs.find((r) => r.id === id)?.stage ?? null);
    if (held) throw conflict(held);
    const out = rows.map((r) => ({ id: randomUUID(), ...r }) as FilmRunEpisode);
    table.push(...out);
    audit(s, session, "create_run_episodes", "studio.film_run_episodes", run.id, run.title_id, null, { run_id: run.id, series_key: rows[0].series_key, episodes: out.map((e) => ({ n: e.n, src_in: e.src_in, src_out: e.src_out })) } as unknown as Json);
    return clone(out.map(normalizeRunEpisode));
  },

  async listRunEpisodes(session, runId) {
    const s = store();
    readableFilmRun(s.db, session, runId); // a foreign run is not found
    if (!(isSystemSession(session) || session.kind === "staff")) return []; // staff only, as 0018's RLS: a producer reads no rows
    const rows = episodeTable(s.db).film_run_episodes.filter((e) => e.run_id === runId).sort((a, b) => a.n - b.n);
    return clone(rows.map(normalizeRunEpisode));
  },

  async getRunEpisode(session, episodeId) {
    return clone(normalizeRunEpisode(readableRunEpisode(store().db, session, episodeId)));
  },

  async claimRunEpisode(session, episodeId, input) {
    const s = store();
    requireSystemOrStaff(session);
    const ep = readableRunEpisode(s.db, session, episodeId);
    const fields = episodeClaimFields(ep, input);
    if (!fields) return null;
    Object.assign(ep, fields);
    return clone(normalizeRunEpisode(ep));
  },

  async renewRunEpisodeLease(session, episodeId, input) {
    const s = store();
    requireSystemOrStaff(session);
    const ep = readableRunEpisode(s.db, session, episodeId);
    Object.assign(ep, episodeRenewFields(ep, input));
    return clone(normalizeRunEpisode(ep));
  },

  async setRunEpisodeStage(session, episodeId, input) {
    const s = store();
    requireSystemOrStaff(session);
    const ep = readableRunEpisode(s.db, session, episodeId);
    const was = { words_stage: ep.words_stage, picture_stage: ep.picture_stage, stage: ep.stage, error_text: ep.error_text, variant: ep.variant, approved_at: ep.approved_at, revision: ep.revision };
    Object.assign(ep, episodeStageFields(ep, input, isSystemSession(session) ? "system" : session.userId));
    if (runEpisodeAudited(was, ep)) {
      audit(s, session, "set_run_episode_stage", "studio.film_run_episodes", ep.id, null, was as Json, { n: ep.n, words_stage: ep.words_stage, picture_stage: ep.picture_stage, stage: ep.stage, error_text: ep.error_text, variant: ep.variant, approved_at: ep.approved_at, revision: ep.revision });
    }
    return clone(normalizeRunEpisode(ep));
  },

  async releaseRunEpisode(session, episodeId, input) {
    const s = store();
    requireSystemOrStaff(session);
    const ep = readableRunEpisode(s.db, session, episodeId);
    Object.assign(ep, episodeReleaseFields(ep, input));
    return clone(normalizeRunEpisode(ep));
  },

  // ---- platform links and snapshots (decision 2026-09-23; migration 0017) ----

  async getPlatformLink(session, titleId, platform) {
    const { db } = store();
    requirePlatform(platform);
    readableTitle(db, session, titleId); // a foreign title is not found, never forbidden
    const row = platformTables(db).platform_links.find((l) => l.title_id === titleId && l.platform === platform);
    return row ? clone(row) : null;
  },

  async listPlatformLinks(session, platform) {
    const { db } = store();
    requirePlatform(platform);
    requireMemberSession(session);
    const rows = platformTables(db).platform_links.filter((l) => {
      if (l.platform !== platform) return false;
      const title = db.titles.find((t) => t.id === l.title_id);
      return !!title && canReadTitle(session, title.producer_id);
    });
    return clone(rows.sort((a, b) => a.linked_at.localeCompare(b.linked_at)));
  },

  async upsertPlatformLink(session, input) {
    const s = store();
    const row = platformLinkRow(input);
    readableTitle(s.db, session, row.title_id); // not_found before forbidden, like RLS
    requireSystemOrStaff(session);
    const { platform_links } = platformTables(s.db);
    const holder = platform_links.find((l) => l.platform === row.platform && l.cd_drama_id === row.cd_drama_id && l.title_id !== row.title_id);
    if (holder) throw conflict(`drama ${row.cd_drama_id} is already linked to another title`);
    const existing = platform_links.find((l) => l.platform === row.platform && l.title_id === row.title_id);
    const linkedBy = isSystemSession(session) ? null : session.userId;
    if (existing) {
      const before: Json = { slug: existing.slug, title_slug: existing.title_slug, cd_drama_id: existing.cd_drama_id };
      // Who manages the series (migration 0019) is a fact the reads and Studio's own create keep current; it moves nothing.
      if (row.managed_by !== undefined && (existing.managed_by ?? null) !== row.managed_by) {
        audit(s, session, "set_platform_link_managed_by", "core.platform_links", existing.id, existing.title_id, { managed_by: existing.managed_by ?? null }, { managed_by: row.managed_by });
        existing.managed_by = row.managed_by;
      }
      if (existing.slug === row.slug && existing.title_slug === row.title_slug && existing.cd_drama_id === row.cd_drama_id) return clone(existing);
      Object.assign(existing, { slug: row.slug, title_slug: row.title_slug, cd_drama_id: row.cd_drama_id, linked_at: now(), linked_by: linkedBy });
      audit(s, session, "move_platform_link", "core.platform_links", existing.id, existing.title_id, before, { slug: existing.slug, title_slug: existing.title_slug, cd_drama_id: existing.cd_drama_id });
      return clone(existing);
    }
    const link: PlatformLink = { id: randomUUID(), managed_by: null, ...row, linked_at: now(), linked_by: linkedBy };
    platform_links.push(link);
    audit(s, session, "create_platform_link", "core.platform_links", link.id, link.title_id, null, { platform: link.platform, slug: link.slug, title_slug: link.title_slug, cd_drama_id: link.cd_drama_id });
    return clone(link);
  },

  async recordPlatformSnapshot(session, input) {
    const s = store();
    requireSystemOrStaff(session);
    const row = platformSnapshotRow(input);
    if (row.title_id) findTitle(s.db, row.title_id); // a snapshot names a title that exists, or none
    const snapshot: PlatformSnapshot = { id: randomUUID(), ...row };
    platformTables(s.db).platform_snapshots.push(snapshot);
    return clone(snapshot);
  },

  async listPlatformSnapshots(session, platform, slug, opts = {}) {
    const { db } = store();
    requirePlatform(platform);
    requireMemberSession(session);
    const limit = Math.max(1, Math.min(opts.limit ?? PLATFORM_SNAPSHOTS_KEEP, 200));
    // Newest first; two rows written in the same millisecond keep the later write first (the list is in write order).
    const rows = platformTables(db)
      .platform_snapshots.map((r, i) => ({ r, i }))
      .filter(({ r }) => r.platform === platform && r.slug === slug && canReadSnapshot(db, session, r))
      .sort((a, b) => b.r.read_at.localeCompare(a.r.read_at) || b.i - a.i)
      .slice(0, limit)
      .map(({ r }) => r);
    return clone(rows.map(normalizePlatformSnapshot));
  },

  async listLatestPlatformSnapshots(session, platform) {
    const { db } = store();
    requirePlatform(platform);
    requireMemberSession(session);
    const newest = new Map<string, PlatformSnapshot>();
    for (const r of platformTables(db).platform_snapshots) {
      if (r.platform !== platform) continue;
      const have = newest.get(r.slug);
      if (!have || r.read_at >= have.read_at) newest.set(r.slug, r); // the later write wins a tie
    }
    // The newest row per slug decides who may see the slug: a series linked since its unmatched days is the title's now.
    const rows = [...newest.values()].filter((r) => canReadSnapshot(db, session, r)).sort((a, b) => a.slug.localeCompare(b.slug));
    return clone(rows.map(normalizePlatformSnapshot));
  },

  async prunePlatformSnapshots(session, platform, keep = PLATFORM_SNAPSHOTS_KEEP) {
    const s = store();
    requirePlatform(platform);
    requireSystemOrStaff(session);
    if (!Number.isInteger(keep) || keep < 1) throw invalid("keep must be a positive integer");
    const tables = platformTables(s.db);
    const bySlug = new Map<string, PlatformSnapshot[]>();
    for (const r of tables.platform_snapshots) if (r.platform === platform) (bySlug.get(r.slug) ?? bySlug.set(r.slug, []).get(r.slug)!).push(r);
    const gone = new Set<string>();
    for (const rows of bySlug.values()) {
      // Rows arrive in write order; a stable sort keeps a same-millisecond pair in it, so the reverse is newest first.
      rows.reverse().sort((a, b) => b.read_at.localeCompare(a.read_at));
      for (const r of rows.slice(keep)) gone.add(r.id);
    }
    tables.platform_snapshots = tables.platform_snapshots.filter((r) => !gone.has(r.id));
    return gone.size;
  },

  async listTitlesWithPlatformSlug(session, platform) {
    const { db } = store();
    requirePlatform(platform);
    requireMemberSession(session);
    return clone(db.titles.filter((t) => !!t.crazydramas_slug?.trim() && canReadTitle(session, t.producer_id)).sort((a, b) => a.created_at.localeCompare(b.created_at)));
  },

  async listImportedTitles(session) {
    const { db } = store();
    requireMemberSession(session);
    return clone(db.titles.filter((t) => !!t.source_ref && canReadTitle(session, t.producer_id)).sort((a, b) => a.created_at.localeCompare(b.created_at)));
  },

  async listTitleEpisodes(session, titleId) {
    const { db } = store();
    readableTitle(db, session, titleId);
    return clone(db.episodes.filter((e) => e.title_id === titleId).sort((a, b) => a.number - b.number));
  },

  // ---- the crazydramas ledger (phase 5; migration 0019) ----

  async getCdPublications(session, titleId) {
    const { db } = store();
    requireMemberSession(session);
    readableTitle(db, session, titleId); // a foreign title is not found
    const rows = cdTable(db)
      .cd_publications.map((r, i) => ({ r, i }))
      .filter(({ r }) => r.title_id === titleId)
      .sort((a, b) => a.r.episode_number - b.r.episode_number || a.r.created_at.localeCompare(b.r.created_at) || a.i - b.i)
      .map(({ r }) => normalizeCdPublication(r));
    return clone(rows);
  },

  async getCdPublication(session, id) {
    const { db } = store();
    return clone(normalizeCdPublication(readableCdRow(db, session, id)));
  },

  async listActiveCdPublications(session) {
    const { db } = store();
    requireSystemOrStaff(session);
    return clone(cdTable(db).cd_publications.filter((r) => isActiveStep(r.step)).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(normalizeCdPublication));
  },

  async createCdPublication(session, input) {
    const s = store();
    const row = cdPublicationRow(input);
    readableTitle(s.db, session, row.title_id); // not_found before forbidden, like RLS
    requireSystemOrStaff(session);
    if (row.episode_id) {
      const ep = s.db.episodes.find((e) => e.id === row.episode_id);
      if (!ep || ep.title_id !== row.title_id || ep.number !== row.episode_number) throw invalid("episode_id must be this title's episode with that number");
    }
    const table = cdTable(s.db).cd_publications;
    const clash = newRowConflict(row, table.filter((r) => r.title_id === row.title_id));
    if (clash) throw conflict(clash);
    if (table.some((r) => r.idempotency_key === row.idempotency_key && r.step !== "superseded")) throw conflict(`${row.idempotency_key} is already in the ledger`);
    const at = now();
    const created: CdPublication = { id: randomUUID(), ...row, created_at: at, updated_at: at };
    table.push(created);
    audit(s, session, "cd_publication_planned", "studio.cd_publications", created.id, created.title_id, null, { episode_number: created.episode_number, sha256: created.sha256, replace: created.replace, slug: created.slug });
    return clone(normalizeCdPublication(created));
  },

  async updateCdPublication(session, id, input) {
    const s = store();
    const row = readableCdRow(s.db, session, id);
    requireSystemOrStaff(session);
    const before = { step: row.step, revision: row.revision, error_code: row.error_code };
    const fields = cdUpdateFields(row, input);
    const nextStep = fields.step ?? row.step;
    if (isActiveStep(nextStep) && !isActiveStep(row.step)) {
      // A Retry brings a row back: still one active row per title × episode.
      const other = cdTable(s.db).cd_publications.find((r) => r.id !== row.id && r.title_id === row.title_id && r.episode_number === row.episode_number && isActiveStep(r.step));
      if (other) throw conflict(`episode ${row.episode_number} already has an upload in the ledger (${other.step})`);
    }
    Object.assign(row, fields);
    if (cdStepAudited(before, row)) audit(s, session, `cd_publication_${row.step}`, "studio.cd_publications", row.id, row.title_id, before, { step: row.step, revision: row.revision, error_code: row.error_code, upload_id: row.upload_id, asset_id: row.asset_id });
    return clone(normalizeCdPublication(row));
  },

  async claimCdPublication(session, id, input) {
    const s = store();
    const row = readableCdRow(s.db, session, id);
    requireSystemOrStaff(session);
    const fields = cdClaimFields(row, input);
    if (!fields) return null;
    Object.assign(row, fields);
    return clone(normalizeCdPublication(row));
  },

  async renewCdPublicationLease(session, id, input) {
    const s = store();
    const row = readableCdRow(s.db, session, id);
    requireSystemOrStaff(session);
    Object.assign(row, cdRenewFields(row, input));
    return clone(normalizeCdPublication(row));
  },

  async releaseCdPublication(session, id, input) {
    const s = store();
    const row = readableCdRow(s.db, session, id);
    requireSystemOrStaff(session);
    const fields = cdReleaseFields(row, input);
    if (fields) Object.assign(row, fields);
    return clone(normalizeCdPublication(row));
  },

  async requestCdPublicationCancel(session, id) {
    const s = store();
    const row = readableCdRow(s.db, session, id);
    requireSystemOrStaff(session);
    const before = { step: row.step, revision: row.revision, error_code: row.error_code };
    const fields = cdCancelFields(row);
    if (!fields) return clone(normalizeCdPublication(row));
    Object.assign(row, fields);
    audit(s, session, row.step === "failed" ? "cd_publication_failed" : "cd_publication_cancel_requested", "studio.cd_publications", row.id, row.title_id, before, { step: row.step, revision: row.revision, error_code: row.error_code, cancel_requested: true });
    return clone(normalizeCdPublication(row));
  },

  // ---- partner portal ----

  async getProducerTitles(session) {
    const { db } = store();
    const titles = db.titles.filter((t) => canReadTitle(session, t.producer_id));
    return titles
      .map((title): ProducerTitleSummary => {
        const episodes = db.episodes
          .filter((e) => e.title_id === title.id)
          .sort((a, b) => a.number - b.number)
          .flatMap((episode) => {
            const version = pickProducerVersion(episodeVersions(db, episode.id));
            if (!version) return [];
            return [
              buildProducerEpisodeSummary({
                episode,
                version,
                scenes_total: episodeScenes(db, episode.id).length,
                decisions: db.scene_decisions,
              }),
            ];
          });
        return {
          id: title.id,
          external_id: title.external_id,
          name_zh: title.name_zh,
          name_en: title.name_en,
          genre: title.genre,
          episode_count: Math.max(title.episode_count ?? 0, db.episodes.filter((e) => e.title_id === title.id).length),
          episodes,
          updated_at: title.updated_at,
        };
      })
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  },

  async getProducerReview(session, titleId, episodeNumber) {
    const { db } = store();
    const title = readableTitle(db, session, titleId);
    const episode = findEpisode(db, titleId, episodeNumber);
    const version = pickProducerVersion(episodeVersions(db, episode.id));
    if (!version || !version.snapshot) throw notFound("submitted version for episode", `${episodeNumber}`);
    const previousVersion = version.parent_version_id ? db.versions.find((item) => item.id === version.parent_version_id) ?? null : null;
    return clone(
      buildProducerReview({
        version,
        snapshot: version.snapshot,
        decisions: db.scene_decisions.filter((d) => d.version_id === version.id),
        previous: previousVersion?.snapshot
          ? {
              version: previousVersion,
              snapshot: previousVersion.snapshot,
              decisions: db.scene_decisions.filter((d) => d.version_id === previousVersion.id),
            }
          : null,
        can_decide: isProducerReviewer(session, title) || isStaffAdmin(session),
        can_approve: isProducerApprover(session, title) || isStaffAdmin(session),
        video_url: mediaUrl(episode.video_path),
      })
    );
  },

  // ---- Promote ----

  async listPromoCampaigns(session) {
    const { db } = store();
    return clone(
      db.promo_campaigns
        .filter((campaign) => {
          const title = db.titles.find((t) => t.id === campaign.title_id);
          return !!title && canReadTitle(session, title.producer_id);
        })
        .map((campaign): PromoCampaignSummary => {
          const title = findTitle(db, campaign.title_id);
          const producer = db.producers.find((p) => p.id === campaign.producer_id);
          const creatives = db.promo_creatives.filter((c) => c.campaign_id === campaign.id && c.status !== "superseded");
          return {
            ...campaign,
            title_name_zh: title.name_zh,
            title_name_en: title.name_en,
            producer_name_zh: producer?.name_zh ?? "",
            producer_name_en: producer?.name_en ?? null,
            creative_count: creatives.length,
            approved_count: creatives.filter((c) => c.status === "approved").length,
            pending_count: creatives.filter((c) => c.status === "ready").length,
            change_count: creatives.filter((c) => c.status === "rejected").length,
          };
        })
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    );
  },

  async getPromoCampaign(session, campaignId) {
    const { db } = store();
    return promoDetail(db, readablePromoCampaign(db, session, campaignId));
  },

  async createPromoCampaign(session, input) {
    legacyCampaignRetired();
    const { db } = store();
    const title = requireTitleEditor(db, session, input.title_id);
    if (blank(input.name)) throw invalid("campaign name is required");
    if (blank(input.target_market)) throw invalid("target market is required");
    if (input.destination_url) {
      try { new URL(input.destination_url); } catch { throw invalid("destination URL is invalid"); }
    }
    const at = now();
    const campaign: PromoCampaign = {
      id: randomUUID(),
      external_id: extId("pb"),
      title_id: title.id,
      producer_id: title.producer_id,
      name: input.name.trim(),
      target_market: input.target_market.trim(),
      destination_url: input.destination_url?.trim() || null,
      objective: input.objective,
      spoiler_level: input.spoiler_level,
      creative_direction: input.creative_direction?.trim() || null,
      exclusions: input.exclusions?.trim() || null,
      experiment: input.experiment ? { ...input.experiment, currency: "USD", approved_by: null, approved_at: null, version: 1, updated_at: at } : null,
      status: "draft",
      grow_campaign_id: null,
      advertiser_id: null,
      tiktok_adgroup_id: null,
      status_note: null,
      launched_at: null,
      launch_settings: null,
      created_by: session.userId,
      created_at: at,
      updated_at: at,
    };
    db.promo_campaigns.push(campaign);
    audit(store(), session, "create_promo_campaign", "promote.campaigns", campaign.id, title.id, null, campaign);
    return clone(campaign);
  },

  async generatePromoDrafts(session, campaignId) {
    legacyCampaignRetired();
    const { db } = store();
    const campaign = readablePromoCampaign(db, session, campaignId);
    requireTitleEditor(db, session, campaign.title_id);
    if (campaign.status !== "draft" && campaign.status !== "review" && campaign.status !== "generating") throw conflict("this campaign is already approved");
    const episodes = db.episodes.filter((e) => e.title_id === campaign.title_id && e.video_path).sort((a, b) => a.number - b.number);
    if (!episodes.length) throw invalid("upload at least one drama episode video before generating creatives");
    if (db.promo_creatives.some((c) => c.campaign_id === campaign.id && c.status !== "superseded")) {
      return clone(db.promo_creatives.filter((c) => c.campaign_id === campaign.id && c.status !== "superseded"));
    }
    const title = findTitle(db, campaign.title_id);
    // Ads are the title's finished auto-cut clips, every one of them (decision 2026-09-14, no placeholders).
    const rendered = pickClipsForRound(db.clips.filter((c) => c.title_id === title.id), episodes);
    if (!rendered.length) throw conflict(NO_CLIPS_MESSAGE);
    const at = now();
    const rows: PromoCreative[] = creativesFromClips(rendered, title).map((d) => ({
      id: randomUUID(), external_id: extId("pc"), campaign_id: campaign.id, title_id: title.id,
      parent_creative_id: null, version: 1, ...d, rejection_note: null, revision_note: null, created_at: at, updated_at: at,
    }));
    db.promo_creatives.push(...rows);
    campaign.status = "review"; // nothing to render: every ad already has its file
    campaign.status_note = null;
    campaign.updated_at = at;
    audit(store(), session, "generate_promo_drafts", "promote.campaigns", campaign.id, title.id, null, { creative_count: rows.length, source: "auto_clip" });
    return clone(rows);
  },

  async appendPromoDraftsFromClips(session, campaignId) {
    legacyCampaignRetired();
    const { db } = store();
    const campaign = readablePromoCampaign(db, session, campaignId);
    const title = requireTitleEditor(db, session, campaign.title_id);
    if (campaign.status !== "review") throw conflict("new clips can only be added while the round is in review");
    const active = db.promo_creatives.filter((c) => c.campaign_id === campaign.id && c.status !== "superseded");
    const used = new Set(active.map((c) => clipIdOf(c)).filter(Boolean));
    const episodes = db.episodes.filter((e) => e.title_id === title.id);
    const fresh = pickClipsForRound(db.clips.filter((c) => c.title_id === title.id), episodes).filter((c) => !used.has(c.id));
    if (!fresh.length) return [];
    const at = now();
    const rows: PromoCreative[] = creativesFromClips(fresh, title).map((d) => ({
      id: randomUUID(), external_id: extId("pc"), campaign_id: campaign.id, title_id: title.id,
      parent_creative_id: null, version: 1, ...d, rejection_note: null, revision_note: null, created_at: at, updated_at: at,
    }));
    db.promo_creatives.push(...rows);
    campaign.updated_at = at;
    audit(store(), session, "append_promo_drafts", "promote.campaigns", campaign.id, title.id, null, { creative_count: rows.length });
    return clone(rows);
  },

  async setPromoCreativeText(session, creativeId, hook) {
    legacyCampaignRetired();
    const { db } = store();
    const creative = db.promo_creatives.find((c) => c.id === creativeId);
    if (!creative) throw notFound("promotion creative", creativeId);
    const campaign = readablePromoCampaign(db, session, creative.campaign_id);
    requireTitleEditor(db, session, campaign.title_id);
    if (campaign.status !== "review") throw conflict("the ad text can be edited while the round is in review");
    if (creative.status === "superseded" || creative.status === "not_selected") throw conflict("this creative is no longer in the round");
    const text = hook.replace(/\s+/g, " ").trim();
    if (!text) throw invalid("write the ad text first");
    if (text.length > AD_TEXT_MAX) throw invalid(`the ad text is what TikTok shows: at most ${AD_TEXT_MAX} characters`);
    creative.hook = text;
    creative.updated_at = now();
    audit(store(), session, "set_promo_creative_text", "promote.creatives", creative.id, campaign.title_id, null, { length: text.length });
    return clone(creative);
  },

  async reviewPromoCreative(session, creativeId, input) {
    legacyCampaignRetired();
    const { db } = store();
    const creative = db.promo_creatives.find((c) => c.id === creativeId);
    if (!creative) throw notFound("promotion creative", creativeId);
    const campaign = readablePromoCampaign(db, session, creative.campaign_id);
    requireTitleEditor(db, session, campaign.title_id);
    if (campaign.status !== "review") throw conflict("creative review is closed");
    if (input.status === "rejected" && blank(input.rejection_note)) throw invalid("tell us what to change when rejecting a creative");
    // Unselect only walks back a pick; a change request stays a change request.
    if (input.status === "ready" && creative.status !== "approved") throw conflict("only a chosen ad can be unselected");
    creative.status = input.status;
    creative.rejection_note = input.status === "rejected" ? input.rejection_note?.trim() || null : null;
    creative.updated_at = now();
    return clone(creative);
  },

  async approveAllPromoCreatives(session, campaignId) {
    legacyCampaignRetired();
    const { db } = store();
    const campaign = readablePromoCampaign(db, session, campaignId);
    const title = requireTitleEditor(db, session, campaign.title_id);
    if (campaign.status !== "review") throw conflict("creative review is closed");
    const at = now();
    let kept = 0;
    for (const creative of db.promo_creatives) {
      if (creative.campaign_id === campaign.id && creative.status === "ready") {
        creative.status = "approved";
        creative.updated_at = at;
        kept += 1;
      }
    }
    audit(store(), session, "approve_all_promo_creatives", "promote.campaigns", campaign.id, title.id, null, { kept });
    return promoDetail(db, campaign);
  },

  async approvePromoCampaign(session, campaignId) {
    legacyCampaignRetired();
    const { db } = store();
    const campaign = readablePromoCampaign(db, session, campaignId);
    const title = requireTitleEditor(db, session, campaign.title_id);
    if (!isProducerApprover(session, title)) throw forbidden("submitting creatives needs the approver role");
    if (campaign.status !== "review") throw conflict("campaign is not ready for approval");
    const creatives = db.promo_creatives.filter((c) => c.campaign_id === campaign.id && c.status === "approved");
    if (!creatives.length) throw invalid("approve at least one creative first");
    if (creatives.some((c) => !c.render_sha256 && c.render_path)) throw invalid("every rendered creative needs a checksum");
    // Each chosen ad reserves its angle's minimum; the pick must fit the experiment budget (lib/angles.ts).
    const budget = budgetCheck(creatives, campaign.experiment?.budget_usd);
    if (!budget.ok) throw invalid(overBudgetMessage(budget, campaign.experiment?.budget_usd ?? 0));
    // Live modes approve finished files only; the source episode stands in for a file in the fake demo alone.
    if (launchMode() !== "fake" && creatives.some((c) => !c.render_path || !c.render_sha256)) throw invalid("every chosen ad needs its finished file before approval; wait for the clips to finish or unselect the ad");
    const manifest = { schema: 1, campaign_external_id: campaign.external_id, creatives: creatives.map((c) => ({ external_id: c.external_id, version: c.version, render_path: c.render_path, render_sha256: c.render_sha256, hook: c.hook, caption: c.caption, ad_description: c.ad_description })) };
    const manifest_sha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    const approval: PromoApproval = { id: randomUUID(), campaign_id: campaign.id, producer_id: campaign.producer_id, approved_by: session.userId, manifest, manifest_sha256, created_at: now() };
    db.promo_approvals.push(approval);
    for (const creative of db.promo_creatives) {
      if (creative.campaign_id === campaign.id && creative.status !== "approved" && creative.status !== "superseded") {
        creative.status = "not_selected";
        creative.updated_at = approval.created_at;
      }
    }
    campaign.status = "approved";
    campaign.updated_at = approval.created_at;
    audit(store(), session, "approve_promo_campaign", "promote.campaigns", campaign.id, title.id, { status: "review" }, { status: "approved", manifest_sha256 });
    return promoDetail(db, campaign);
  },

  async submitPromoCampaign(session, campaignId, resolved) {
    legacyCampaignRetired();
    const { db } = store();
    const campaign = readablePromoCampaign(db, session, campaignId);
    const title = requireTitleEditor(db, session, campaign.title_id);
    if (!isProducerApprover(session, title)) throw forbidden("launch needs the approver role");
    // Already on its way or out: a second press changes nothing (the launch row is the idempotency).
    if (["launching", "submitted", "live", "paused", "ended"].includes(campaign.status)) return promoDetail(db, campaign);
    const approval = db.promo_approvals.find((a) => a.campaign_id === campaign.id) ?? null;
    const creatives = db.promo_creatives.filter((c) => c.campaign_id === campaign.id && c.status !== "superseded");
    const explicit = launchAccountOf(db, campaign.producer_id);
    const bc = launchBcOf(db, campaign.producer_id);
    const mode = launchMode();
    const readiness = launchReadiness({ campaign, approval, creatives, account: explicit, businessCenter: bc, mode });
    if (!readiness.ready) throw conflict(blockerMessage(readiness.blockers[0]));
    // The account the launch goes into: the explicit assignment, or the route's pick inside the assigned BC.
    // A pick may never name an account outside the vendor's assignment.
    const account = explicit
      ? { external_ref: explicit.external_ref!, identity_id: explicit.identity_id, identity_type: explicit.identity_type }
      : resolved && resolved.bc_id && bc && resolved.bc_id === bc.external_ref
        ? { external_ref: resolved.advertiser_id, identity_id: resolved.identity_id, identity_type: resolved.identity_type }
        : null;
    if (!account) throw conflict("no ready ad account could be picked inside the assigned Business Center");
    // The launch's shape travels with it (decision 2026-09-16): validated against the signed budget here, so a bad shape never reaches TikTok.
    const settings = launchSettingsFor(campaign);
    const idempotency_key = `studio:${campaign.external_id}:${approval!.manifest_sha256}`;
    const at = now();
    let launch = db.promo_launches.find((l) => l.idempotency_key === idempotency_key);
    if (launch) {
      // A failed attempt of the same manifest resumes from its recorded steps; it never becomes a second campaign.
      if (launch.status === "failed") Object.assign(launch, { status: "pending", error: null, finished_at: null });
    } else {
      launch = {
        id: randomUUID(), campaign_id: campaign.id, idempotency_key, manifest_sha256: approval!.manifest_sha256, status: "pending", mode,
        advertiser_id: account.external_ref, identity_id: account.identity_id, identity_type: account.identity_type,
        budget_usd: campaign.experiment!.budget_usd, destination_url: campaign.destination_url!,
        uploaded_videos: {}, covers: {}, tiktok_campaign_id: null, tiktok_adgroup_id: null, ad_ids: {},
        settings, paused: settings.start_paused, duplicates: {}, retired_adgroups: [], duplicated_at: null, activated_at: null, bid_usd: null, schedule_end: null,
        error: null, attempts: 0,
        created_by: session.userId, created_at: at, started_at: null, heartbeat_at: null, finished_at: null,
      };
      db.promo_launches.push(launch);
    }
    // The append-only submission record, one per manifest.
    if (!db.promo_handoffs.some((h) => h.idempotency_key === idempotency_key)) {
      db.promo_handoffs.push({ id: randomUUID(), campaign_id: campaign.id, idempotency_key, request_sha256: approval!.manifest_sha256, status: "accepted", grow_campaign_id: null, response: { mode, launch_id: launch.id, advertiser_id: launch.advertiser_id, budget_usd: launch.budget_usd }, error: null, attempted_at: at });
    }
    campaign.status = "launching";
    campaign.status_note = null;
    campaign.advertiser_id = launch.advertiser_id;
    campaign.updated_at = at;
    audit(store(), session, "submit_promo_campaign", "promote.launches", launch.id, title.id, null, { mode, advertiser_id: launch.advertiser_id, budget_usd: launch.budget_usd, manifest_sha256: launch.manifest_sha256 });
    return promoDetail(db, campaign);
  },

  // ---- Pulsar's Promote desk (staff) ----

  async revisePromoCreative(session, creativeId, input) {
    legacyCampaignRetired();
    const { db } = store();
    if (session.kind !== "staff") throw forbidden("Pulsar staff only");
    const parent = db.promo_creatives.find((c) => c.id === creativeId);
    if (!parent) throw notFound("promotion creative", creativeId);
    const campaign = readablePromoCampaign(db, session, parent.campaign_id);
    if (campaign.status !== "review") throw conflict("approved promotion is frozen; revisions need a new round");
    if (parent.status !== "rejected" && parent.status !== "ready") throw conflict("only a creative awaiting review or change can be revised");
    if (blank(input.hook) || blank(input.caption) || blank(input.ad_description)) throw invalid("hook, caption and description are required");
    const start = input.source_start_ms ?? parent.source_start_ms;
    const end = input.source_end_ms ?? parent.source_end_ms;
    if (start !== null && end !== null && end <= start) throw invalid("source end must come after source start");
    // Clean cuts (decision 2026-09-14): the hook and copy are ad text, not
    // pixels — a revision that keeps the parent's window keeps its finished
    // file. Only a moved window invalidates the render; the revise route
    // re-cuts it in the background so the answer to a change request never
    // parks at the launch gate unrendered.
    const windowChanged = start !== parent.source_start_ms || end !== parent.source_end_ms;
    const at = now();
    const revision: PromoCreative = {
      ...parent,
      id: randomUUID(),
      external_id: extId("pc"),
      parent_creative_id: parent.id,
      version: parent.version + 1,
      status: "ready",
      hypothesis: blank(input.hypothesis) ? parent.hypothesis : input.hypothesis!.trim(),
      hook: input.hook.trim(),
      caption: input.caption.trim(),
      ad_description: input.ad_description.trim(),
      source_start_ms: start,
      source_end_ms: end,
      duration_ms: start !== null && end !== null ? end - start : parent.duration_ms,
      render_path: windowChanged ? null : parent.render_path,
      render_sha256: windowChanged ? null : parent.render_sha256,
      rejection_note: null,
      revision_note: input.revision_note?.trim() || null,
      created_at: at,
      updated_at: at,
    };
    parent.status = "superseded";
    parent.updated_at = at;
    db.promo_creatives.push(revision);
    audit(store(), session, "revise_promo_creative", "promote.creatives", revision.id, campaign.title_id, { parent: parent.external_id, note: parent.rejection_note }, { version: revision.version });
    return clone(revision);
  },

  async advancePromoCampaign(session, campaignId, input) {
    legacyCampaignRetired();
    const { db } = store();
    if (session.kind !== "staff") throw forbidden("Pulsar staff only");
    const campaign = readablePromoCampaign(db, session, campaignId);
    const allowed: Record<string, PromoCampaign["status"][]> = {
      submitted: ["launching", "live", "failed"],
      launching: ["live", "failed"],
      paused: ["live", "failed"],
      failed: ["launching"],
    };
    if (!allowed[campaign.status]?.includes(input.status)) throw conflict(`a ${campaign.status} campaign cannot move to ${input.status}`);
    const before = { status: campaign.status, grow_campaign_id: campaign.grow_campaign_id };
    campaign.status = input.status;
    if (input.grow_campaign_id !== undefined) campaign.grow_campaign_id = input.grow_campaign_id?.trim() || null;
    campaign.status_note = input.note?.trim() ? `Staff override: ${input.note.trim()}` : campaign.status_note;
    campaign.updated_at = now();
    audit(store(), session, "advance_promo_campaign", "promote.campaigns", campaign.id, campaign.title_id, before, { status: campaign.status, grow_campaign_id: campaign.grow_campaign_id }, input.note?.trim() || null);
    return promoDetail(db, campaign);
  },

  // ---- TikTok launch, review and read-back (decision 2026-09-09) ----

  async getPromoLaunch(session, launchId) {
    const { db } = store();
    const launch = db.promo_launches.find((l) => l.id === launchId);
    if (!launch) throw notFound("launch", launchId);
    readablePromoCampaign(db, session, launch.campaign_id);
    return clone(launch);
  },

  async listOpenPromoLaunches(session) {
    requireSystemOrStaff(session);
    return clone(store().db.promo_launches.filter((l) => l.status === "pending" || l.status === "running"));
  },

  async updatePromoLaunch(session, launchId, patch) {
    if (!isSystemSession(session)) throw forbidden("only the launch engine writes launch steps");
    const { db } = store();
    const launch = db.promo_launches.find((l) => l.id === launchId);
    if (!launch) throw notFound("launch", launchId);
    // Recorded TikTok ids are write-once: the idempotency of the engine rests on them.
    for (const key of ["tiktok_campaign_id", "tiktok_adgroup_id"] as const) {
      if (patch[key] && launch[key] && patch[key] !== launch[key]) throw frozen(`launch ${key} is already recorded`);
    }
    Object.assign(launch, patch);
    return clone(launch);
  },

  async listLaunchedPromoCampaigns(session, opts) {
    requireMemberSession(session);
    const { db } = store();
    const statuses = opts?.all ? ["launching", "submitted", "live", "paused", "ended", "failed"] : ["submitted", "live", "paused", "ended"];
    const out: { campaign: PromoCampaign; launch: PromoLaunch; creatives: PromoCreative[] }[] = [];
    for (const campaign of db.promo_campaigns) {
      if (session.kind === "producer" && campaign.producer_id !== session.producerId) continue;
      if (!statuses.includes(campaign.status)) continue;
      const row = launchedRow(db, campaign, !!opts?.all);
      if (row) out.push(row);
    }
    return out;
  },

  async getLaunchedCampaign(session, campaignId) {
    const { db } = store();
    const campaign = readablePromoCampaign(db, session, campaignId);
    return launchedRow(db, campaign, true);
  },

  async recordLaunchChange(session, campaignId, input) {
    const { db } = store();
    const campaign = readablePromoCampaign(db, session, campaignId);
    if (!isSystemSession(session) && session.kind !== "staff") {
      const title = findTitle(db, campaign.title_id);
      if (!isProducerApprover(session, title)) throw forbidden("managing a launched campaign needs the approver role");
    }
    const launch = latestLaunch(db, campaign.id);
    if (!launch) throw conflict("this campaign has no launch record");
    const at = now();
    const before = { budget_usd: launch.budget_usd, bid_usd: launch.bid_usd, schedule_end: launch.schedule_end, paused: launch.paused, experiment_version: campaign.experiment?.version ?? null };
    if (input.budget_usd !== undefined) {
      if (!campaign.experiment) throw invalid("the campaign has no experiment to re-sign");
      // A new signed number: the approver signs it; staff record an audited override without pretending to be the approver.
      const signer = session.kind === "producer" ? { approved_by: session.userId, approved_at: at } : { approved_by: campaign.experiment.approved_by, approved_at: campaign.experiment.approved_at };
      campaign.experiment = { ...campaign.experiment, budget_usd: input.budget_usd, version: campaign.experiment.version + 1, updated_at: at, ...signer };
      launch.budget_usd = input.budget_usd;
      if (session.kind === "staff") campaign.status_note = `Staff override: budget changed to $${input.budget_usd}${input.note ? ` — ${input.note}` : ""}`;
    }
    if (input.daily_budget_usd !== undefined) launch.settings = { ...launch.settings, daily_budget_usd: input.daily_budget_usd };
    if (input.bid_usd !== undefined) {
      launch.bid_usd = input.bid_usd;
      launch.settings = { ...launch.settings, bid_strategy: input.bid_usd ? "COST_CAP" : "LOWEST_COST", bid_usd: input.bid_usd };
    }
    if (input.schedule_end !== undefined) launch.schedule_end = input.schedule_end;
    if (input.duplicates !== undefined) launch.duplicates = input.duplicates;
    if (input.retired_adgroups !== undefined) launch.retired_adgroups = input.retired_adgroups;
    if (input.duplicated_at !== undefined) launch.duplicated_at = input.duplicated_at;
    if (input.activated_at !== undefined) launch.activated_at = input.activated_at;
    if (input.paused !== undefined) launch.paused = input.paused;
    campaign.updated_at = at;
    audit(store(), session, "launch_control", "promote.launches", launch.id, campaign.title_id, before, { budget_usd: launch.budget_usd, bid_usd: launch.bid_usd, schedule_end: launch.schedule_end, paused: launch.paused, duplicates: Object.keys(launch.duplicates).length, retired: launch.retired_adgroups.length }, input.note ?? null);
    return clone(launch);
  },

  async setLaunchSettings(session, campaignId, settings) {
    legacyCampaignRetired();
    const { db } = store();
    const campaign = readablePromoCampaign(db, session, campaignId);
    requireTitleEditor(db, session, campaign.title_id);
    if (["launching", "submitted", "live", "paused", "ended"].includes(campaign.status)) throw frozen("the launch settings are frozen once the campaign launches; manage it from the delivery panel");
    const parsed = launchSettingsSchema.safeParse(settings);
    if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "invalid launch settings");
    const before = campaign.launch_settings;
    campaign.launch_settings = parsed.data;
    campaign.updated_at = now();
    audit(store(), session, "set_launch_settings", "promote.campaigns", campaign.id, campaign.title_id, before, parsed.data);
    return clone(campaign);
  },

  async listLaunchPresets(session) {
    requireMemberSession(session);
    return clone([...store().db.launch_presets].sort((a, b) => a.name.localeCompare(b.name)));
  },

  async saveLaunchPreset(session, input) {
    requireStaffAdmin(session);
    const { db } = store();
    if (blank(input.name) || input.name.trim().length > 60) throw invalid("a preset needs a name of at most 60 characters");
    const parsed = launchSettingsSchema.safeParse(input.settings);
    if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "invalid launch settings");
    const at = now();
    const existing = input.id ? db.launch_presets.find((p) => p.id === input.id) : null;
    if (input.id && !existing) throw notFound("launch preset", input.id);
    if (existing) {
      Object.assign(existing, { name: input.name.trim(), settings: parsed.data, note: input.note?.trim() || null, updated_at: at });
      audit(store(), session, "save_launch_preset", "promote.launch_presets", existing.id, null, null, { name: existing.name });
      return clone(existing);
    }
    const row: LaunchPreset = { id: randomUUID(), name: input.name.trim(), settings: parsed.data, note: input.note?.trim() || null, created_by: session.userId, created_at: at, updated_at: at };
    db.launch_presets.push(row);
    audit(store(), session, "save_launch_preset", "promote.launch_presets", row.id, null, null, { name: row.name });
    return clone(row);
  },

  async deleteLaunchPreset(session, presetId) {
    requireStaffAdmin(session);
    const { db } = store();
    const i = db.launch_presets.findIndex((p) => p.id === presetId);
    if (i < 0) throw notFound("launch preset", presetId);
    const [row] = db.launch_presets.splice(i, 1);
    audit(store(), session, "delete_launch_preset", "promote.launch_presets", row.id, null, { name: row.name }, null);
  },

  async listInstantPageTemplates(session) {
    requireMemberSession(session);
    return clone([...store().db.instant_page_templates].sort((a, b) => a.name.localeCompare(b.name)));
  },

  async saveInstantPageTemplate(session, input) {
    requireStaffAdmin(session);
    if (!input.name.trim() || input.name.trim().length > 60 || !input.button_text.trim() || input.button_text.trim().length > 40) throw invalid("Template name or button text is invalid.");
    const rows = store().db.instant_page_templates;
    const existing = input.id ? rows.find(row => row.id === input.id) : null;
    if (input.id && !existing) throw notFound("Instant Page template", input.id);
    const at = now();
    if (existing) {
      Object.assign(existing, { name: input.name.trim(), button_text: input.button_text.trim(), background: input.background, hand_cursor: input.hand_cursor, updated_at: at });
      audit(store(), session, "save_instant_page_template", "promote.instant_page_templates", existing.id, null, null, { name: existing.name });
      return clone(existing);
    }
    const row: InstantPageTemplate = { id: randomUUID(), name: input.name.trim(), button_text: input.button_text.trim(), background: input.background, hand_cursor: input.hand_cursor, created_by: session.userId, created_at: at, updated_at: at };
    rows.push(row);
    audit(store(), session, "save_instant_page_template", "promote.instant_page_templates", row.id, null, null, { name: row.name });
    return clone(row);
  },

  async deleteInstantPageTemplate(session, id) {
    requireStaffAdmin(session);
    const rows = store().db.instant_page_templates;
    const index = rows.findIndex(row => row.id === id);
    if (index < 0) throw notFound("Instant Page template", id);
    const [row] = rows.splice(index, 1);
    audit(store(), session, "delete_instant_page_template", "promote.instant_page_templates", id, null, { name: row.name }, null);
  },

  async setPreferredLaunchAccount(session, advertiserId) {
    requireProducerEditor(session);
    const { db } = store();
    const bc = launchBcOf(db, session.producerId!);
    if (!bc) throw conflict("no Business Center is assigned to this company yet");
    if (advertiserId !== null && !/^\d{5,}$/.test(advertiserId)) throw invalid("advertiser id must be TikTok's numeric ad account id");
    const before = bc.preferred_advertiser_id;
    bc.preferred_advertiser_id = advertiserId;
    bc.updated_at = now();
    audit(store(), session, "set_preferred_launch_account", "core.company_accounts", bc.id, null, { preferred: before }, { preferred: advertiserId });
    return clone(bc);
  },

  async relaunchOnAccount(session, campaignId, resolved, note) {
    legacyCampaignRetired();
    requireStaff(session);
    const { db } = store();
    const campaign = readablePromoCampaign(db, session, campaignId);
    if (!["ended", "failed"].includes(campaign.status)) throw conflict("only an ended or failed campaign can be relaunched on another account; end it first");
    const previous = latestLaunch(db, campaign.id);
    if (!previous) throw conflict("this campaign was never launched");
    const bc = launchBcOf(db, campaign.producer_id);
    if (!resolved.bc_id || !bc || resolved.bc_id !== bc.external_ref) throw conflict("the new account must be inside the company's assigned Business Center");
    if (resolved.advertiser_id === previous.advertiser_id && previous.status === "failed") throw conflict("same account: retry the launch instead");
    const n = db.promo_launches.filter((l) => l.campaign_id === campaign.id).length;
    const at = now();
    const launch: PromoLaunch = {
      id: randomUUID(), campaign_id: campaign.id, idempotency_key: `${previous.idempotency_key.replace(/:relaunch\d+$/, "")}:relaunch${n}`, manifest_sha256: previous.manifest_sha256, status: "pending", mode: launchMode(),
      advertiser_id: resolved.advertiser_id, identity_id: resolved.identity_id, identity_type: resolved.identity_type,
      budget_usd: campaign.experiment?.budget_usd ?? previous.budget_usd, destination_url: previous.destination_url,
      uploaded_videos: {}, covers: {}, tiktok_campaign_id: null, tiktok_adgroup_id: null, ad_ids: {},
      settings: launchSettingsFor(campaign, previous.settings), paused: false, duplicates: {}, retired_adgroups: [], duplicated_at: null, activated_at: null, bid_usd: null, schedule_end: null,
      error: null, attempts: 0, created_by: session.userId, created_at: at, started_at: null, heartbeat_at: null, finished_at: null,
    };
    db.promo_launches.push(launch);
    // The campaign goes back to launching; ended is otherwise terminal, so this is the one explicit, audited door out of it.
    const before = { status: campaign.status, advertiser_id: campaign.advertiser_id, grow_campaign_id: campaign.grow_campaign_id };
    Object.assign(campaign, { status: "launching", status_note: `Relaunched by ${session.displayName} on ad account ${resolved.advertiser_id}${note?.trim() ? `: ${note.trim()}` : ""}`, advertiser_id: resolved.advertiser_id, grow_campaign_id: null, tiktok_adgroup_id: null, launched_at: null, updated_at: at });
    audit(store(), session, "relaunch_on_account", "promote.launches", launch.id, campaign.title_id, before, { advertiser_id: resolved.advertiser_id, previous_launch: previous.id }, note?.trim() || null);
    return clone(launch);
  },

  async setPromoCampaignDelivery(session, campaignId, input) {
    const { db } = store();
    const campaign = db.promo_campaigns.find((c) => c.id === campaignId);
    if (!campaign) throw notFound("promotion campaign", campaignId);
    // The engine, the scheduler, staff — and, since the controls are theirs (decision 2026-09-16), the company's approver.
    if (!isSystemSession(session) && session.kind !== "staff" && !isProducerApprover(session, findTitle(db, campaign.title_id))) throw forbidden("Pulsar staff or the company's approver only");
    // Only a launched or launching campaign has a delivery state; an ended campaign is closed for good.
    if (!["approved", "launching", "submitted", "live", "paused", "ended", "failed"].includes(campaign.status)) throw conflict(`a ${campaign.status} campaign has no TikTok delivery state`);
    if (campaign.status === "ended" && input.status !== "ended") throw conflict("an ended campaign stays ended; launch a new round");
    const before = { status: campaign.status, status_note: campaign.status_note };
    campaign.status = input.status;
    if (input.status_note !== undefined) campaign.status_note = input.status_note;
    if (input.grow_campaign_id !== undefined) campaign.grow_campaign_id = input.grow_campaign_id;
    if (input.tiktok_adgroup_id !== undefined) campaign.tiktok_adgroup_id = input.tiktok_adgroup_id;
    if (input.advertiser_id !== undefined) campaign.advertiser_id = input.advertiser_id;
    if (input.launched_at !== undefined) campaign.launched_at = input.launched_at;
    campaign.updated_at = now();
    if (before.status !== campaign.status) audit(store(), session, "set_promo_delivery", "promote.campaigns", campaign.id, campaign.title_id, before, { status: campaign.status, status_note: campaign.status_note });
    return clone(campaign);
  },

  async retryPromoLaunch(session, campaignId) {
    legacyCampaignRetired();
    requireStaff(session);
    const { db } = store();
    const campaign = db.promo_campaigns.find((c) => c.id === campaignId);
    if (!campaign) throw notFound("promotion campaign", campaignId);
    const launch = latestLaunch(db, campaign.id);
    if (!launch) throw conflict("this campaign was never submitted");
    if (campaign.status !== "failed" || launch.status !== "failed") throw conflict("only a failed launch can be retried");
    Object.assign(launch, { status: "pending", error: null, finished_at: null });
    campaign.status = "launching";
    campaign.status_note = null;
    campaign.updated_at = now();
    audit(store(), session, "retry_promo_launch", "promote.launches", launch.id, campaign.title_id, null, { attempts: launch.attempts });
    return clone(launch);
  },

  async upsertCreativeResults(session, rows) {
    if (!isSystemSession(session)) throw forbidden("only the read-back writes results");
    const { db } = store();
    let written = 0;
    for (const r of rows) {
      const existing = db.promo_results.find((x) => x.creative_id === r.creative_id && x.window_start === r.window_start && x.window_end === r.window_end && x.source === r.source);
      if (existing) Object.assign(existing, r);
      else db.promo_results.push({ id: randomUUID(), ...r });
      written += 1;
    }
    return written;
  },

  async setCreativeRender(session, creativeId, render) {
    const { db } = store();
    const creative = db.promo_creatives.find((c) => c.id === creativeId);
    if (!creative) throw notFound("promotion creative", creativeId);
    const campaign = readablePromoCampaign(db, session, creative.campaign_id);
    if (!isSystemSession(session)) requireTitleEditor(db, session, campaign.title_id);
    if (creative.status === "superseded" || !["draft", "generating", "review"].includes(campaign.status)) throw frozen("a reviewed creative's file is frozen; a new version carries a new render");
    if (!/^[0-9a-f]{64}$/.test(render.render_sha256)) throw invalid("render checksum must be a sha256");
    Object.assign(creative, { render_path: render.render_path, render_sha256: render.render_sha256, duration_ms: render.duration_ms, width: render.width, height: render.height, render_settings: render.render_settings ?? creative.render_settings, updated_at: now() });
    return clone(creative);
  },

  async finishPromoGeneration(session, campaignId, note) {
    const { db } = store();
    const campaign = readablePromoCampaign(db, session, campaignId);
    if (!isSystemSession(session)) requireTitleEditor(db, session, campaign.title_id);
    if (campaign.status !== "generating") return clone(campaign);
    campaign.status = "review";
    campaign.status_note = note ?? null;
    campaign.updated_at = now();
    audit(store(), session, "finish_promo_generation", "promote.campaigns", campaign.id, campaign.title_id, null, { note: note ?? null });
    return clone(campaign);
  },

  async getLaunchAccount(session, producerId) {
    requireMemberSession(session);
    if (session.kind === "producer" && session.producerId !== producerId) return null;
    return clone(launchAccountOf(store().db, producerId));
  },

  async getLaunchBusinessCenter(session, producerId) {
    requireMemberSession(session);
    if (session.kind === "producer" && session.producerId !== producerId) return null;
    return clone(launchBcOf(store().db, producerId));
  },

  async assignBusinessCenter(session, producerId, input) {
    requireStaffAdmin(session);
    const { db } = store();
    if (!db.producers.some((p) => p.id === producerId)) throw notFound("producer", producerId);
    if (!/^\d{5,}$/.test(input.bc_id.trim())) throw invalid("Business Center id must be TikTok's numeric bc_id");
    if (blank(input.name)) throw invalid("Business Center name is required");
    const at = now();
    const fields = { name: input.name.trim(), external_ref: input.bc_id.trim(), state: "connected" as const, access: "partner" as const, note: input.note?.trim() || null, identity_id: null, identity_type: null, assigned_by: session.userId, assigned_at: at, updated_at: at };
    const existing = db.company_accounts.find((a) => a.producer_id === producerId && a.provider === "tiktok" && a.kind === "business_center");
    let row: CompanyAccount;
    if (existing) {
      Object.assign(existing, fields);
      row = existing;
    } else {
      row = { id: randomUUID(), producer_id: producerId, provider: "tiktok", kind: "business_center", preferred_advertiser_id: null, ...fields };
      db.company_accounts.push(row);
    }
    if (input.request_id) {
      const request = db.account_requests.find((r) => r.id === input.request_id && r.producer_id === producerId);
      if (request) Object.assign(request, { status: "assigned", account_id: row.id, resolved_by: session.userId, resolved_at: at });
    }
    audit(store(), session, "assign_business_center", "core.company_accounts", row.id, null, null, { producer_id: producerId, bc_id: row.external_ref });
    return clone(row);
  },

  async assignLaunchAccount(session, producerId, input) {
    requireStaffAdmin(session);
    const { db } = store();
    if (!db.producers.some((p) => p.id === producerId)) throw notFound("producer", producerId);
    if (!/^\d{5,}$/.test(input.advertiser_id.trim())) throw invalid("advertiser id must be TikTok's numeric ad account id");
    if (blank(input.name)) throw invalid("account name is required");
    const at = now();
    const existing = db.company_accounts.find((a) => a.producer_id === producerId && a.provider === "tiktok" && a.kind === "ad_account");
    const fields = { name: input.name.trim(), external_ref: input.advertiser_id.trim(), state: "connected" as const, access: "partner" as const, note: input.note?.trim() || null, identity_id: input.identity_id?.trim() || null, identity_type: input.identity_type ?? null, assigned_by: session.userId, assigned_at: at, updated_at: at };
    let row: CompanyAccount;
    if (existing) {
      Object.assign(existing, fields);
      row = existing;
    } else {
      row = { id: randomUUID(), producer_id: producerId, provider: "tiktok", kind: "ad_account", preferred_advertiser_id: null, ...fields };
      db.company_accounts.push(row);
    }
    if (input.request_id) {
      const request = db.account_requests.find((r) => r.id === input.request_id && r.producer_id === producerId);
      if (request) Object.assign(request, { status: "assigned", account_id: row.id, resolved_by: session.userId, resolved_at: at });
    }
    audit(store(), session, "assign_launch_account", "core.company_accounts", row.id, null, null, { producer_id: producerId, advertiser_id: row.external_ref, identity_id: row.identity_id });
    return clone(row);
  },

  async listAccountRequests(session) {
    requireMemberSession(session);
    const { db } = store();
    const rows = session.kind === "staff" ? db.account_requests : db.account_requests.filter((r) => r.producer_id === session.producerId);
    return clone([...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)));
  },

  async createAccountRequest(session, input) {
    requireProducerEditor(session);
    const { db } = store();
    if (blank(input.contact_name) || blank(input.contact_email)) throw invalid("contact name and email are required");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.contact_email.trim())) throw invalid("contact email is invalid");
    if (db.account_requests.some((r) => r.producer_id === session.producerId && (r.status === "requested" || r.status === "provisioning"))) throw conflict("a request is already open for this company");
    if (launchAccountOf(db, session.producerId!)) throw conflict("this company already has a TikTok ad account assigned");
    const at = now();
    let payment: AccountRequest["payment"] = null;
    if (input.payment) {
      if (!/^\d{4}$/.test(input.payment.last4) || blank(input.payment.brand) || blank(input.payment.holder)) throw invalid("payment opt-in needs a card brand, holder and last four digits");
      payment = { method: "card", brand: input.payment.brand.trim(), last4: input.payment.last4, holder: input.payment.holder.trim(), opted_in_at: at };
    }
    const row: AccountRequest = { id: randomUUID(), producer_id: session.producerId!, status: "requested", contact_name: input.contact_name.trim(), contact_email: input.contact_email.trim(), payment, note: input.note?.trim() || null, staff_note: null, account_id: null, requested_by: session.userId, created_at: at, resolved_by: null, resolved_at: null };
    db.account_requests.push(row);
    audit(store(), session, "create_account_request", "core.account_requests", row.id, null, null, { payment: payment ? { brand: payment.brand, last4: payment.last4 } : null });
    return clone(row);
  },

  async resolveAccountRequest(session, requestId, input) {
    requireStaff(session);
    const { db } = store();
    const row = db.account_requests.find((r) => r.id === requestId);
    if (!row) throw notFound("account request", requestId);
    if (row.status === "assigned") throw conflict("this request is already fulfilled");
    const before = { status: row.status };
    row.status = input.status;
    row.staff_note = input.staff_note?.trim() || row.staff_note;
    if (input.status === "declined") Object.assign(row, { resolved_by: session.userId, resolved_at: now() });
    audit(store(), session, "resolve_account_request", "core.account_requests", row.id, null, before, { status: row.status });
    return clone(row);
  },

  // ---- exports and audit ----

  async getExportSnapshot(session, titleId, episodeNumber) {
    const { db } = store();
    readableTitle(db, session, titleId);
    const episode = findEpisode(db, titleId, episodeNumber);
    const versions = episodeVersions(db, episode.id);
    const approved = versions.find((v) => v.status === "approved");
    const inReview = versions.find((v) => v.status === "in_review");
    const draft = versions.find((v) => v.status === "draft");
    let out: ExportSnapshot;
    if (approved?.snapshot) {
      out = { version: approved, snapshot: approved.snapshot, source: "approved", sha256: approved.snapshot_sha256 };
    } else if (inReview?.snapshot) {
      out = { version: inReview, snapshot: inReview.snapshot, source: "in_review", sha256: inReview.snapshot_sha256 };
    } else if (draft) {
      out = { version: draft, snapshot: snapshotOf(db, draft), source: "draft", sha256: null };
    } else {
      throw notFound("version for episode", `${episodeNumber}`);
    }
    return clone(out);
  },

  async listAuditEvents(session, titleId) {
    const { db } = store();
    const title = readableTitle(db, session, titleId);
    return clone(
      db.audit_events
        .filter((e) => e.title_id === title.id && (session.kind === "staff" || e.producer_id === session.producerId))
        .sort((a, b) => b.id - a.id)
    );
  },
  // ---- experiments, results, company accounts (decision 2026-09-08) ---------------------

  async setExperiment(session, campaignId, input) {
    legacyCampaignRetired();
    const { db } = store();
    const campaign = readablePromoCampaign(db, session, campaignId);
    requireTitleEditor(db, session, campaign.title_id);
    if (["submitted", "launching", "live", "paused", "ended"].includes(campaign.status)) throw frozen("a submitted experiment cannot be edited; start a new round");
    const at = now();
    const prev = campaign.experiment;
    campaign.experiment = { ...input, currency: "USD", approved_by: null, approved_at: null, version: (prev?.version ?? 0) + 1, updated_at: at };
    campaign.updated_at = at;
    audit(store(), session, "set_experiment", "promote.campaigns", campaign.id, campaign.title_id, prev, campaign.experiment);
    return clone(campaign);
  },

  async approveExperiment(session, campaignId) {
    legacyCampaignRetired();
    const { db } = store();
    const campaign = readablePromoCampaign(db, session, campaignId);
    const title = requireTitleEditor(db, session, campaign.title_id);
    if (!isProducerApprover(session, title)) throw forbidden("budget approval needs the approver role");
    if (!campaign.experiment) throw invalid("set the experiment (budget, hypothesis, audience) before approving it");
    if (campaign.experiment.approved_at) return clone(campaign);
    const at = now();
    campaign.experiment = { ...campaign.experiment, approved_by: session.userId, approved_at: at, updated_at: at };
    campaign.updated_at = at;
    audit(store(), session, "approve_experiment", "promote.campaigns", campaign.id, campaign.title_id, null, { budget_usd: campaign.experiment.budget_usd });
    return clone(campaign);
  },

  async simulateDemoResults(session, campaignId) {
    legacyCampaignRetired();
    // Fixture mode only: produce demo-labelled results for a submitted
    // campaign so the results-to-decision loop can be exercised. The
    // Supabase layer refuses; real results come from Grow.
    const { db } = store();
    const campaign = readablePromoCampaign(db, session, campaignId);
    if (session.kind !== "producer") throw forbidden("the producer's editors simulate demo results; staff preview cannot act");
    requireTitleEditor(db, session, campaign.title_id);
    if (!["submitted", "live", "paused", "ended"].includes(campaign.status)) throw conflict("results follow a submitted campaign");
    const selected = db.promo_creatives.filter((c) => c.campaign_id === campaign.id && c.status === "approved");
    if (!selected.length) throw invalid("no approved creatives to report on");
    if ((db.promo_results ?? []).some((r) => r.campaign_id === campaign.id)) return promoDetail(db, campaign);
    const at = now();
    const budget = campaign.experiment?.budget_usd ?? 100;
    selected.forEach((c, i) => {
      // Deterministic per creative: the first selected concept does better, so the decision is legible.
      const seed = (parseInt(c.id.replace(/-/g, "").slice(0, 6), 16) % 1000) / 1000;
      const impressions = Math.round(30_000 + seed * 12_000);
      const hold = Math.round((0.22 + (i === 0 ? 0.16 : 0.04) + seed * 0.06) * 100) / 100;
      const views = Math.round(impressions * (0.45 + seed * 0.15));
      const clicks = Math.round(impressions * (0.008 + (i === 0 ? 0.008 : 0.002) + seed * 0.004));
      db.promo_results.push({ id: randomUUID(), campaign_id: campaign.id, creative_id: c.id, source: "demo", window_start: at.slice(0, 10), window_end: at.slice(0, 10), impressions, video_views: views, hook_hold_rate: hold, clicks, spend_usd: Math.round((budget / selected.length) * (0.9 + seed * 0.1) * 100) / 100, landing_actions: Math.round(clicks * (0.1 + seed * 0.1)), observed_at: at });
    });
    campaign.status = "live";
    campaign.updated_at = at;
    audit(store(), session, "simulate_demo_results", "promote.results", campaign.id, campaign.title_id, null, { creatives: selected.length, source: "demo" });
    return promoDetail(db, campaign);
  },

  async listCreativeResults(session, opts) {
    requireMemberSession(session);
    if (session.kind !== "producer" || !session.producerId) return [];
    const { db } = store();
    const mine = new Set(db.promo_campaigns.filter((c) => c.producer_id === session.producerId && (!opts?.titleId || c.title_id === opts.titleId)).map((c) => c.id));
    return clone((db.promo_results ?? []).filter((r) => mine.has(r.campaign_id)));
  },

  async listCompanyAccounts(session) {
    requireMemberSession(session);
    if (session.kind !== "producer" || !session.producerId) return [];
    return clone((store().db.company_accounts ?? []).filter((a) => a.producer_id === session.producerId));
  },

  async upsertCompanyAccount(session, input) {
    requireProducerEditor(session);
    const s = store();
    if (blank(input.name)) throw invalid("account name is required");
    const at = now();
    const existing = input.id ? s.db.company_accounts.find((a) => a.id === input.id && a.producer_id === session.producerId) : null;
    if (input.id && !existing) throw notFound("company account", input.id);
    if (existing?.assigned_by) throw frozen("this ad account was assigned by Pulsar; ask Pulsar to change it");
    if (existing) {
      Object.assign(existing, { provider: input.provider, kind: input.kind, name: input.name.trim(), external_ref: input.external_ref?.trim() || null, state: input.state, access: input.access, note: input.note?.trim() || null, updated_at: at });
      return clone(existing);
    }
    const row: CompanyAccount = { id: randomUUID(), producer_id: session.producerId!, provider: input.provider, kind: input.kind, name: input.name.trim(), external_ref: input.external_ref?.trim() || null, state: input.state, access: input.access, note: input.note?.trim() || null, identity_id: null, identity_type: null, assigned_by: null, assigned_at: null, preferred_advertiser_id: null, updated_at: at };
    s.db.company_accounts.push(row);
    return clone(row);
  },

  // ---- the market desk ----------------------------------------------------------------

  async getMarket(session) {
    requireMemberSession(session);
    return marketView();
  },

  async getCompanyIdentity(session) {
    requireMemberSession(session);
    if (session.kind !== 'producer' || !session.producerId) return null;
    const p = store().db.producers.find(x => x.id === session.producerId);
    return p ? {id:p.id, external_id:p.external_id, name_zh:p.name_zh, name_en:p.name_en} : null;
  },
  async getResearchProfile(session) {
    requireMemberSession(session);
    if (session.kind !== "producer" || !session.producerId) return null;
    const producer = store().db.producers.find((p) => p.id === session.producerId);
    return producer?.research_profile ? clone(producer.research_profile) : null;
  },

  async saveResearchProfile(session, input) {
    if (session.kind !== "producer" || !session.producerId) throw forbidden("producer editors only");
    if (session.producerRole !== "approver" && session.producerRole !== "reviewer") throw forbidden("producer editors only");
    const producer = store().db.producers.find((p) => p.id === session.producerId);
    if (!producer) throw notFound("producer", session.producerId);
    producer.research_profile = { ...input, updated_at: now() };
    return clone(producer.research_profile);
  },

  async listCatalogForMatching(session, opts) {
    requireMemberSession(session);
    if (session.kind !== "producer" || !session.producerId) return { rows: [], total: 0, truncated: false };
    const limit = Math.max(1, Math.min(opts?.limit ?? 500, 2000));
    const own = store().db.titles.filter((t) => canReadTitle(session, t.producer_id));
    const rows = own.slice(0, limit).map((t) => ({
      id: t.id,
      name_zh: t.name_zh,
      name_en: t.name_en,
      genre: t.genre,
      synopsis_zh: t.synopsis_zh,
      synopsis_en: t.synopsis_en,
    }));
    return { rows, total: own.length, truncated: own.length > limit };
  },

  // ---- watchlist and report imports ---------------------------------------------------

  async listWatchlist(session) {
    requireMemberSession(session);
    if (session.kind !== "producer" || !session.producerId) return [];
    return clone(store().db.research_watchlist.filter((w) => w.producer_id === session.producerId));
  },

  async addWatch(session, listingKey) {
    requireProducerEditor(session);
    if (!/^(reelshort|dramabox)-[A-Za-z0-9]+$/.test(listingKey)) throw invalid("listing key");
    const s = store();
    const existing = s.db.research_watchlist.find((w) => w.producer_id === session.producerId && w.listing_key === listingKey);
    if (existing) return clone(existing);
    const row: WatchRow = { producer_id: session.producerId!, listing_key: listingKey, created_by: session.userId, created_at: now() };
    s.db.research_watchlist.push(row);
    return clone(row);
  },

  async removeWatch(session, listingKey) {
    requireProducerEditor(session);
    const s = store();
    s.db.research_watchlist = s.db.research_watchlist.filter((w) => !(w.producer_id === session.producerId && w.listing_key === listingKey));
  },

  async listReportBatches(session) {
    requireMemberSession(session);
    if (session.kind !== "producer" || !session.producerId) return [];
    return clone(store().db.report_batches.filter((b) => b.producer_id === session.producerId).sort((a, b) => (a.imported_at < b.imported_at ? 1 : -1)));
  },

  async listReportRows(session, opts) {
    requireMemberSession(session);
    if (session.kind !== "producer" || !session.producerId) return [];
    const { db } = store();
    const active = new Set(db.report_batches.filter((b) => b.producer_id === session.producerId && !b.reverted_at).map((b) => b.id));
    return clone(db.report_rows.filter((r) => r.producer_id === session.producerId && active.has(r.batch_id) && (!opts?.titleId || r.title_id === opts.titleId)));
  },

  async commitReportBatch(session, input) {
    requireProducerEditor(session);
    if (!input.rows.length) throw invalid("no rows to import");
    const s = store();
    const own = new Set(s.db.titles.filter((t) => t.producer_id === session.producerId).map((t) => t.id));
    const batch: ReportBatch = {
      id: randomUUID(),
      producer_id: session.producerId!,
      filename: input.filename.slice(0, 200),
      imported_at: now(),
      imported_by: session.userId,
      row_count: input.rows.length,
      skipped_count: input.skipped_count,
      column_map: input.column_map,
      reverted_at: null,
    };
    s.db.report_batches.push(batch);
    for (const r of input.rows) {
      // A row can only link to the caller's own title; anything else is stored unlinked.
      s.db.report_rows.push({ ...r, id: randomUUID(), batch_id: batch.id, producer_id: session.producerId!, title_id: r.title_id && own.has(r.title_id) ? r.title_id : null });
    }
    return clone(batch);
  },

  async revertReportBatch(session, batchId) {
    requireProducerEditor(session);
    const batch = store().db.report_batches.find((b) => b.id === batchId && b.producer_id === session.producerId);
    if (!batch) throw notFound("report batch", batchId);
    if (!batch.reverted_at) batch.reverted_at = now();
    return clone(batch);
  },

  // ---- title analytics (lib/analytics) ----------------------------------------------
  // Demo listings and daily series live in data/fixture/demo-analytics.ts and
  // are labelled demo everywhere; only the title->listing links are store
  // rows (db.analytics_links, migration 0007). The demo clock (DEMO_TODAY)
  // is "today" so the numbers are the same on every refresh.

  async listTitlePerformance(session, opts) {
    requireMemberSession(session);
    if (session.kind !== "producer" || !session.producerId) return [];
    const { db } = store();
    const range = parseRange(opts?.range);
    const today = opts?.today ?? DEMO_TODAY;
    return db.titles
      .filter((t) => t.producer_id === session.producerId)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .map((t) => performanceRow(analyticsRecord(db, session, t, range, today)));
  },

  async getTitleAnalytics(session, titleId, opts) {
    const { db } = store();
    const title = readableTitle(db, session, titleId);
    return clone(analyticsRecord(db, session, title, opts?.window ? "custom" : parseRange(opts?.range), opts?.today ?? DEMO_TODAY, opts?.window ?? null));
  },

  async listAnalyticsListings(session) {
    requireMemberSession(session);
    if (session.kind !== "producer" || !session.producerId) return [];
    const { db } = store();
    const links = analyticsLinks(db);
    return clone(
      buildDemoAnalytics().listings
        .filter((l) => l.producer_id === session.producerId)
        .map((l) => {
          const link = links.find((x) => x.listing_id === l.id);
          const title = link ? db.titles.find((t) => t.id === link.title_id) : null;
          return { ...l, linked_title_id: link?.title_id ?? null, linked_title_name: title ? title.name_en || title.name_zh : null };
        })
    );
  },

  async linkAnalyticsListing(session, titleId, listingId) {
    const s = store();
    const title = readableTitle(s.db, session, titleId); // not_found before forbidden, like RLS
    if (session.kind !== "producer") throw forbidden("the producer's editors link listings; staff preview cannot act");
    requireTitleEditor(s.db, session, titleId);
    const listing = buildDemoAnalytics().listings.find((l) => l.id === listingId && l.producer_id === session.producerId);
    if (!listing) throw notFound("platform listing", listingId);
    const links = analyticsLinks(s.db);
    const taken = links.find((x) => x.listing_id === listingId && x.title_id !== titleId);
    if (taken) {
      const other = s.db.titles.find((t) => t.id === taken.title_id);
      throw conflict(`listing ${listingId} is already linked to ${other ? other.name_en || other.name_zh : "another title"}; unlink it there first`);
    }
    const existing = links.find((x) => x.title_id === titleId);
    if (existing && existing.listing_id === listingId) return clone(existing);
    const at = now();
    const row: AnalyticsLink = { id: randomUUID(), producer_id: title.producer_id, title_id: titleId, listing_id: listingId, linked_by: session.userId, linked_at: at };
    s.db.analytics_links = links.filter((x) => x.title_id !== titleId).concat(row);
    audit(s, session, "link_analytics_listing", "core.analytics_links", row.id, titleId, existing ?? null, { listing_id: listingId, source: "demo" });
    return clone(row);
  },

  async unlinkAnalyticsListing(session, titleId) {
    const s = store();
    readableTitle(s.db, session, titleId);
    if (session.kind !== "producer") throw forbidden("the producer's editors unlink listings; staff preview cannot act");
    requireTitleEditor(s.db, session, titleId);
    const links = analyticsLinks(s.db);
    const existing = links.find((x) => x.title_id === titleId);
    if (!existing) return;
    s.db.analytics_links = links.filter((x) => x.title_id !== titleId);
    audit(s, session, "unlink_analytics_listing", "core.analytics_links", existing.id, titleId, existing, null);
  },

};

/** A store parked before this table existed (dev hot reload) gets it defaulted here. */
function analyticsLinks(db: FixtureDb): AnalyticsLink[] {
  db.analytics_links ??= [];
  return db.analytics_links;
}

function analyticsRecord(db: FixtureDb, session: Session, title: Title, range: AnalyticsRange, today: string, window: AnalyticsWindow | null = null) {
  const demo = buildDemoAnalytics(today);
  const link = analyticsLinks(db).find((x) => x.title_id === title.id) ?? null;
  const listing = link ? demo.listings.find((l) => l.id === link.listing_id) ?? null : null;
  const dataset = link ? demo.datasets.get(link.listing_id) ?? null : null;
  const campaigns = db.promo_campaigns.filter((c) => c.title_id === title.id && canReadTitle(session, title.producer_id));
  const ids = new Set(campaigns.map((c) => c.id));
  return computeTitleAnalytics({
    title: { id: title.id, producer_id: title.producer_id, name_zh: title.name_zh, name_en: title.name_en, episode_count: Math.max(title.episode_count ?? 0, db.episodes.filter((e) => e.title_id === title.id).length) },
    episodes: db.episodes.filter((e) => e.title_id === title.id).map((e) => ({ id: e.id, number: e.number })),
    listing,
    link,
    dataset,
    campaigns,
    results: (db.promo_results ?? []).filter((r) => ids.has(r.campaign_id)),
    range,
    today,
    window,
  });
}
