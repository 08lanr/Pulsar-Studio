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
import { canReadTitle, type Session } from "@/lib/auth";
import { LAST_CUE_MS, liftStamp, MAX_DERIVED_CUE_MS, SAMPLE_LATENCY_MS, type IngestResult } from "@/lib/ingest";
import { applyGlobalOffset, assertValidCue } from "@/lib/subtitle-timing";
import { splitSpeaker } from "@/lib/ingest/text";
import { isLlmAvailable } from "@/lib/llm";
import { examplesFromApprovedVersions } from "@/lib/translation-memory";
import { cloneFixtureDb, type FixtureDb } from "@/data/fixture";
import { buildVersionSnapshot, snapshotSha256 } from "@/data/fixture/snapshot";
import type {
  AdaptedLine,
  Adaptation,
  AuditChannel,
  AuditEvent,
  Character,
  Clip,
  Episode,
  Job,
  Json,
  Line,
  LineAlternative,
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
import { conflict, forbidden, frozen, invalid, notFound } from "./errors";
import type {
  ApproveOptions,
  DataLayer,
  ExportSnapshot,
  FirstPassLine,
  NewJob,
} from "./index";
import { mediaUrl } from "./storage";
import {
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
};

const STORE_KEY = "__pulsarStudioFixtureStore";

function store(): Store {
  const g = globalThis as unknown as Record<string, Store | undefined>;
  let s = g[STORE_KEY];
  if (!s) {
    const db = cloneFixtureDb();
    s = { db, auditSeq: db.audit_events.reduce((m, e) => Math.max(m, e.id), 0) };
    g[STORE_KEY] = s;
  }
  return s;
}

/** Tests only: drop the process-wide store so the next call reseeds from data/fixture. */
export function resetFixtureStore(): void {
  delete (globalThis as unknown as Record<string, unknown>)[STORE_KEY];
}

const clone = <T>(v: T): T => structuredClone(v);
const now = () => new Date().toISOString();

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
  };
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
 * frozen snapshot to a producer. */
function sceneReadinessIssue(db: FixtureDb, scene: Scene): string | null {
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
  const unexplained = adapted.filter(
    (row) =>
      row.change_type !== "keep" &&
      (blank(row.rationale_zh) || (row.change_type !== "cut" && blank(row.back_translation_zh)))
  ).length;
  return unexplained ? `${unexplained} changed line(s) need a Chinese rationale and back-translation` : null;
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
      source_locale: "zh-CN",
      status: "selected",
      china_metrics: {},
      localization_effort: null,
      deliverables: clone(producer.deliverables),
      notes: null,
      license_start: null,
      license_end: null,
      created_at: at,
      updated_at: at,
    };
    // One adaptation per title in V1, created with the title (docs/data-model.md, studio.adaptations).
    const adaptation: Adaptation = {
      id: randomUUID(),
      external_id: extId("ad"),
      title_id: title.id,
      target_locale: "en-US",
      label: "U.S. general",
      display_title_en: title.name_en,
      created_by: session.userId,
      created_at: at,
    };
    s.db.titles.push(title);
    s.db.adaptations.push(adaptation);
    audit(s, session, "create_title", "core.titles", title.id, title.id, null, { name_zh: title.name_zh });
    return clone(title);
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

  async addVideoOnlyEpisode(session, titleId, episodeNumber, videoPath) {
    const s = store();
    const title = requireTitleEditor(s.db, session, titleId);
    if (!Number.isInteger(episodeNumber) || episodeNumber < 1) throw invalid("episode_number must be a positive integer");
    if (s.db.episodes.some((e) => e.title_id === titleId && e.number === episodeNumber)) throw conflict(`episode ${episodeNumber} already exists for this title`);
    const episode: Episode = { id: randomUUID(), external_id: extId("ep"), title_id: titleId, number: episodeNumber, name_zh: null, name_en: null, duration_ms: null, source_script_path: null, script_format: null, has_timecodes: false, video_path: videoPath, created_at: now() };
    s.db.episodes.push(episode);
    title.status = "ingesting";
    title.updated_at = now();
    audit(s, session, "add_video_only_episode", "core.episodes", episode.id, title.id, null, { number: episodeNumber, video_path: videoPath });
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
    const before = episode.video_path;
    episode.video_path = storedPath;
    audit(s, session, "set_episode_video", "core.episodes", episode.id, titleId, { video_path: before }, { video_path: storedPath });
    return clone(episode);
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
    // the gate: every line adapted, non-cut lines non-empty, changed lines
    // carrying their Chinese rationale.
    for (const sc of scenes) {
      const issue = sceneReadinessIssue(db, sc);
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
    if (!episode.has_timecodes) throw invalid("clips need a timed episode");
    const adaptation = findAdaptation(db, episode.title_id);
    // A re-run replaces 'suggested' rows only; shortlisted / dismissed keep their rank.
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
        created_at: at,
      };
    });
    db.clips.push(...rows);
    return clone(db.clips.filter((c) => c.episode_id === episodeId).sort((a, b) => a.rank - b.rank));
  },

  async setClipStatus(session, clipId, status) {
    requireStaff(session);
    const clip = store().db.clips.find((c) => c.id === clipId);
    if (!clip) throw notFound("clip", clipId);
    clip.status = status;
    return clone(clip);
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

  async finishJob(jobId, result) {
    const job = store().db.jobs.find((j) => j.id === jobId);
    if (!job) throw notFound("job", jobId);
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

  async sumCostCents(titleId) {
    return costOf(store().db, titleId);
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
          const creatives = db.promo_creatives.filter((c) => c.campaign_id === campaign.id && c.status !== "superseded");
          return {
            ...campaign,
            title_name_zh: title.name_zh,
            title_name_en: title.name_en,
            creative_count: creatives.length,
            approved_count: creatives.filter((c) => c.status === "approved").length,
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
      status: "draft",
      grow_campaign_id: null,
      created_by: session.userId,
      created_at: at,
      updated_at: at,
    };
    db.promo_campaigns.push(campaign);
    audit(store(), session, "create_promo_campaign", "promote.campaigns", campaign.id, title.id, null, campaign);
    return clone(campaign);
  },

  async generatePromoDrafts(session, campaignId) {
    const { db } = store();
    const campaign = readablePromoCampaign(db, session, campaignId);
    requireTitleEditor(db, session, campaign.title_id);
    if (campaign.status !== "draft" && campaign.status !== "review") throw conflict("this campaign is already approved");
    const episodes = db.episodes.filter((e) => e.title_id === campaign.title_id && e.video_path).sort((a, b) => a.number - b.number);
    if (!episodes.length) throw invalid("upload at least one drama episode video before generating creatives");
    if (db.promo_creatives.some((c) => c.campaign_id === campaign.id && c.status !== "superseded")) {
      return clone(db.promo_creatives.filter((c) => c.campaign_id === campaign.id && c.status !== "superseded"));
    }
    const title = findTitle(db, campaign.title_id);
    const kinds: PromoCreative["kind"][] = ["direct_clip", "ugc_story", "direct_clip", "ugc_reaction", "direct_clip", "ugc_story"];
    const hypotheses = [
      "Open on the reversal before revealing how the characters got there.",
      "Frame the central conflict like a viewer telling a friend what they just watched.",
      "Lead with the highest-stakes confrontation and stop before the answer.",
      "Use a disbelief reaction to make the plot twist feel socially shareable.",
      "Build escalating cuts around the relationship power shift.",
      "Set up the protagonist's impossible choice in first-person language.",
    ];
    const at = now();
    const rows = kinds.map((kind, index): PromoCreative => {
      const episode = episodes[index % episodes.length];
      const available = Math.max(15_000, episode.duration_ms ?? 45_000);
      const start = Math.min(index * 4_000, Math.max(0, available - 15_000));
      const end = Math.min(available, start + (kind === "direct_clip" ? 18_000 : 24_000));
      return {
        id: randomUUID(), external_id: extId("pc"), campaign_id: campaign.id, title_id: title.id,
        parent_creative_id: null, version: 1, kind, status: "ready", hypothesis: hypotheses[index],
        source_episode_id: episode.id, source_start_ms: start, source_end_ms: end,
        hook: kind === "direct_clip" ? "Wait for the moment everything changes." : "I thought this was a love story—then this happened.",
        caption: `${title.name_en || title.name_zh}: one choice changes everything.`,
        ad_description: `Watch ${title.name_en || title.name_zh} and see what happens next.`,
        render_path: null, render_sha256: null, duration_ms: end - start, width: 1080, height: 1920,
        render_settings: { schema: 1, format: "9:16", source: "concept_preview", captions: true },
        rejection_note: null, created_at: at, updated_at: at,
      };
    });
    db.promo_creatives.push(...rows);
    campaign.status = "review";
    campaign.updated_at = at;
    audit(store(), session, "generate_promo_drafts", "promote.campaigns", campaign.id, title.id, null, { creative_count: rows.length });
    return clone(rows);
  },

  async reviewPromoCreative(session, creativeId, input) {
    const { db } = store();
    const creative = db.promo_creatives.find((c) => c.id === creativeId);
    if (!creative) throw notFound("promotion creative", creativeId);
    const campaign = readablePromoCampaign(db, session, creative.campaign_id);
    requireTitleEditor(db, session, campaign.title_id);
    if (campaign.status !== "review") throw conflict("creative review is closed");
    if (input.status === "rejected" && blank(input.rejection_note)) throw invalid("tell us what to change when rejecting a creative");
    creative.status = input.status;
    creative.rejection_note = input.status === "rejected" ? input.rejection_note?.trim() || null : null;
    creative.updated_at = now();
    return clone(creative);
  },

  async approvePromoCampaign(session, campaignId) {
    const { db } = store();
    const campaign = readablePromoCampaign(db, session, campaignId);
    const title = requireTitleEditor(db, session, campaign.title_id);
    if (!isProducerApprover(session, title)) throw forbidden("submitting creatives needs the approver role");
    if (campaign.status !== "review") throw conflict("campaign is not ready for approval");
    const creatives = db.promo_creatives.filter((c) => c.campaign_id === campaign.id && c.status === "approved");
    if (!creatives.length) throw invalid("approve at least one creative first");
    if (creatives.some((c) => !c.render_sha256 && c.render_path)) throw invalid("every rendered creative needs a checksum");
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

  async submitPromoCampaignMock(session, campaignId) {
    const { db } = store();
    const campaign = readablePromoCampaign(db, session, campaignId);
    const title = requireTitleEditor(db, session, campaign.title_id);
    if (!isProducerApprover(session, title)) throw forbidden("launch submission needs the approver role");
    const approval = db.promo_approvals.find((a) => a.campaign_id === campaign.id);
    if (campaign.status === "submitted") return promoDetail(db, campaign);
    if (campaign.status !== "approved" || !approval) throw conflict("approve the campaign before launch submission");
    const idempotency_key = `studio:${campaign.external_id}:${approval.manifest_sha256}`;
    const growId = `cmp_mock_${campaign.external_id.slice(3)}`;
    const handoff: PromoHandoff = { id: randomUUID(), campaign_id: campaign.id, idempotency_key, request_sha256: approval.manifest_sha256, status: "accepted", grow_campaign_id: growId, response: { mock: true, grow_campaign_id: growId }, error: null, attempted_at: now() };
    db.promo_handoffs.push(handoff);
    campaign.status = "submitted";
    campaign.grow_campaign_id = growId;
    campaign.updated_at = handoff.attempted_at;
    audit(store(), session, "submit_promo_campaign", "promote.handoffs", handoff.id, title.id, null, { status: "accepted", grow_campaign_id: growId });
    return promoDetail(db, campaign);
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
};
