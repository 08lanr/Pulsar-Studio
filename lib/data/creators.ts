// Creator accounts in the data layer (decision 2026-10-12, docs/creator-accounts.md;
// migration 0024_creator_accounts.sql). One code path for both backends, as in
// lib/data/launch.ts: authorization, validation and every state rule live here
// once, and `rows()` branches at storage only — an in-memory store persisted to
// .uploads/creators-state.json in fixture mode, the promote.creator_* tables in
// Supabase mode. Every update is revision-conditional (CAS) in both: a write
// against a revision that moved is a conflict, never a silent overwrite.
//
// Who: Pulsar staff read; any staff member may add media and describe it; a
// staff administrator (or the system actor that runs the sweeps) does
// everything that schedules, publishes, sends or changes an account. Producers
// never see a creator account: every read answers "not found" to them. The
// engine's own fields (step, containers, lease, the Instagram ids) are written
// by the system actor only, as on promote.clip_posts.

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isSystemSession, type Session } from "@/lib/auth";
import { dataSource } from "@/lib/data-source";
import {
  DEFAULT_CREATOR_SETTINGS, EMPTY_PERSONA,
  type CreatorAccount, type CreatorAccountInput, type CreatorAccountPatch, type CreatorComment, type CreatorCommentPatch,
  type CreatorMedia, type CreatorPost, type CreatorPostPatch, type CreatorStat, type NewCreatorComment, type NewCreatorMedia,
  type NewCreatorPost, type NewCreatorStat,
} from "@/lib/creators/types";
import { conflict, forbidden, invalid, notFound } from "./errors";

export interface CreatorDataLayer {
  listCreatorAccounts(session: Session): Promise<CreatorAccount[]>;
  /** By uuid, `cr_` external id or handle (with or without the @). */
  getCreatorAccount(session: Session, ref: string): Promise<CreatorAccount>;
  /** Staff administrator: a new account, or the existing one with the same handle brought up to date (the import script). */
  upsertCreatorAccount(session: Session, input: CreatorAccountInput): Promise<{ account: CreatorAccount; created: boolean }>;
  updateCreatorAccount(session: Session, id: string, expectedRevision: number, patch: CreatorAccountPatch): Promise<CreatorAccount>;

  listCreatorMedia(session: Session, accountId: string): Promise<CreatorMedia[]>;
  getCreatorMedia(session: Session, ref: string): Promise<CreatorMedia>;
  /** Any staff member. The same file (by SHA-256) imported twice into one account is the existing row: `created` false. */
  createCreatorMedia(session: Session, input: NewCreatorMedia): Promise<{ media: CreatorMedia; created: boolean }>;
  updateCreatorMedia(session: Session, id: string, expectedRevision: number, patch: { description?: string; tags?: string[] }): Promise<CreatorMedia>;

  listCreatorPosts(session: Session, filter?: { account_id?: string; status?: CreatorPost["status"][] }): Promise<CreatorPost[]>;
  getCreatorPost(session: Session, ref: string): Promise<CreatorPost>;
  createCreatorPost(session: Session, input: NewCreatorPost): Promise<CreatorPost>;
  updateCreatorPost(session: Session, id: string, expectedRevision: number, patch: CreatorPostPatch, opts?: { action?: string; actor?: Session }): Promise<CreatorPost>;

  listCreatorComments(session: Session, filter?: { account_id?: string; status?: CreatorComment["status"][] }): Promise<CreatorComment[]>;
  getCreatorComment(session: Session, id: string): Promise<CreatorComment>;
  /** The sweep: the comment as read, unless its Instagram id is already recorded (then the existing row, `created` false). */
  recordCreatorComment(session: Session, input: NewCreatorComment): Promise<{ comment: CreatorComment; created: boolean }>;
  updateCreatorComment(session: Session, id: string, expectedRevision: number, patch: CreatorCommentPatch, opts?: { action?: string; actor?: Session }): Promise<CreatorComment>;

  listCreatorStats(session: Session, accountId: string, opts?: { since?: string }): Promise<CreatorStat[]>;
  /** The sweep: one row per (account, scope, day); a second read the same day replaces the first, metric by metric (null keeps the earlier value). */
  recordCreatorStat(session: Session, input: NewCreatorStat): Promise<CreatorStat>;
}

// ---- who ---------------------------------------------------------------------

function staff(s: Session, what = "Creator account") {
  if (s.kind !== "staff") throw notFound(what);
}
function admin(s: Session, what?: string) {
  staff(s, what);
  if (s.staffRole !== "admin") throw forbidden("A staff administrator must do this.");
}
function worker(s: Session) {
  if (!isSystemSession(s)) throw forbidden("Creator publishing worker only.");
}

// ---- storage -----------------------------------------------------------------

type Table = "creator_accounts" | "creator_media" | "creator_posts" | "creator_comments" | "creator_stats";
type Row = Record<string, unknown> & { id: string };
type AuditEntry = { at: string; actor: string | null; action: string; table: string; row_id: string; note?: string };
type Store = Record<Table, Row[]> & { audit: AuditEntry[] };

const now = () => new Date().toISOString();
const copy = <T>(v: T): T => structuredClone(v);
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** prefix + 13 base32 characters: the shape core.ext_id() gives in Supabase mode. */
function extId(prefix: string): string {
  const bytes = randomBytes(9);
  let out = "";
  for (let i = 0; out.length < 13; i++) out += BASE32[bytes[i % bytes.length] & 31];
  return `${prefix}_${out}`;
}

const g = globalThis as unknown as { __studioCreators?: Store };
const stateFile = () => path.join(process.cwd(), ".uploads", "creators-state.json");
const persistOn = () => process.env.FIXTURE_PERSIST !== "off" && process.env.NODE_ENV !== "test";
const emptyStore = (): Store => ({ creator_accounts: [], creator_media: [], creator_posts: [], creator_comments: [], creator_stats: [], audit: [] });
function store(): Store {
  if (!g.__studioCreators) {
    let saved: Store | undefined;
    if (persistOn() && existsSync(stateFile())) { try { saved = JSON.parse(readFileSync(stateFile(), "utf8")); } catch { /* a corrupt fixture file starts empty */ } }
    g.__studioCreators = { ...emptyStore(), ...(saved ?? {}) };
    if (!saved) seedDemo(g.__studioCreators);
  }
  return g.__studioCreators;
}
function persist() {
  if (!persistOn()) return;
  mkdirSync(path.dirname(stateFile()), { recursive: true });
  const temp = `${stateFile()}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(store())); renameSync(temp, stateFile());
}
/** Tests and the demo reset start from an empty (or demo) creator store. */
export function resetCreatorFixture(): void { const fresh = emptyStore(); seedDemo(fresh); g.__studioCreators = fresh; persist(); }
/** The in-memory audit trail of fixture mode (Supabase writes core.audit_events). */
export function creatorFixtureAudit(): AuditEntry[] { return copy(store().audit); }

/** The demo creator in fixture mode (never in tests: FIXTURE_SEED=empty). An account only; its library is imported. */
function seedDemo(s: Store) {
  if (process.env.FIXTURE_SEED === "empty") return;
  const at = now();
  s.creator_accounts.push({
    id: "00000000-0000-4000-8000-0000000c0001", external_id: "cr_demochloe00000", handle: "demo.creator", display_name: "Demo Creator",
    instagram_id: "17841400000000001", page_id: null,
    persona: { ...EMPTY_PERSONA, summary: "A demo lifestyle creator in San Francisco: coffee, walks, small everyday moments.", age: 25, city: "San Francisco",
      interests: ["coffee", "walks", "fitness"], voice: "lowercase, warm, short; one emoji at most", do: ["sound like a real person texting a friend"],
      dont: ["promote anything", "claim a job or credentials"], banned_topics: ["politics", "medical advice"] },
    settings: { ...DEFAULT_CREATOR_SETTINGS }, status: "active", revision: 1, created_at: at, updated_at: at,
  });
}

/** Tests only: a Supabase client standing in for the service and session clients. */
let testDb: SupabaseClient | null = null;
export function setCreatorDbForTests(client: SupabaseClient | null): void { testDb = client; }
type AuditWriter = (s: Session, action: string, table: string, rowId: string, after: unknown, note: string | null) => Promise<void>;
let testAudit: AuditWriter | null = null;
export function setCreatorAuditForTests(writer: AuditWriter | null): void { testAudit = writer; }

async function client(s: Session, write: boolean): Promise<SupabaseClient> {
  if (testDb) return testDb;
  const { createServerSupabase, createServiceSupabase } = await import("@/lib/supabase/server");
  // Reads run as the caller (RLS: staff only) unless it is the sweep; writes always as the service role, after the checks above.
  return write || isSystemSession(s) ? createServiceSupabase() : createServerSupabase();
}
const MIGRATION = "Apply 0024_creator_accounts.sql.";

async function list(s: Session, table: Table, eq: Record<string, string> = {}): Promise<Row[]> {
  if (dataSource() === "fixture") return copy(store()[table].filter(r => Object.entries(eq).every(([k, v]) => r[k] === v)));
  let query = (await client(s, false)).schema("promote").from(table).select("*");
  for (const [k, v] of Object.entries(eq)) query = query.eq(k, v);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw invalid(`Creator storage unavailable (${error.code}). ${MIGRATION}`);
  return (data ?? []) as Row[];
}

/** 0024's unique constraints, mirrored in fixture mode so both backends refuse the same writes. */
const UNIQUE: Record<Table, string[][]> = {
  creator_accounts: [["handle"], ["instagram_id"]],
  creator_media: [["account_id", "sha256"]],
  creator_posts: [["ig_media_id"]],
  creator_comments: [["ig_comment_id"], ["reply_ig_id"]],
  creator_stats: [["account_id", "scope", "day"]],
};
function clashes(table: Table, row: Row): boolean {
  return UNIQUE[table].some(cols => store()[table].some(r => r.id !== row.id && cols.every(c => r[c] !== null && r[c] !== undefined && r[c] === row[c])));
}

/** Insert; a unique clash answers null so the caller can read the existing row. */
async function insert(s: Session, table: Table, row: Row): Promise<Row | null> {
  if (dataSource() === "fixture") {
    const rows = store()[table];
    if (rows.some(r => r.id === row.id) || clashes(table, row)) return null;
    rows.push(copy(row)); persist(); return copy(row);
  }
  const db = (await client(s, true)).schema("promote").from(table);
  const { external_id: _ext, ...rest } = row as Row & { external_id?: string };
  const { data, error } = await db.insert(row.external_id === undefined ? rest : row).select("*").maybeSingle();
  if (error) { if (error.code === "23505") return null; throw invalid(`Creator storage write failed (${error.code}). ${MIGRATION}`); }
  return data as Row;
}

/** The revision-conditional write: answers null when the row moved (or is gone). */
async function update(s: Session, table: Table, next: Row, expected: number): Promise<Row | null> {
  if (dataSource() === "fixture") {
    const rows = store()[table], i = rows.findIndex(r => r.id === next.id);
    if (i < 0 || rows[i].revision !== expected) return null;
    if (clashes(table, next)) throw conflict("Another row already records that Instagram object.");
    rows[i] = copy(next); persist(); return copy(next);
  }
  const { data, error } = await (await client(s, true)).schema("promote").from(table).update(next).eq("id", next.id).eq("revision", expected).select("*").maybeSingle();
  if (error) throw error.code === "23505" ? conflict("Another row already records that Instagram object.") : invalid(`Creator storage write failed (${error.code}).`);
  return (data as Row | null) ?? null;
}

async function audit(s: Session, action: string, table: Table, rowId: string, after: unknown, note: string | null = null): Promise<void> {
  if (testAudit) return testAudit(s, action, table, rowId, after, note);
  if (dataSource() === "fixture") {
    store().audit.push({ at: now(), actor: isSystemSession(s) ? null : s.userId, action, table, row_id: rowId, ...(note ? { note } : {}) });
    persist(); return;
  }
  const { auditEvent } = await import("./supabase");
  await auditEvent(s, action, `promote.${table}`, rowId, null, null, null, after, note);
}

// ---- row shapes ----------------------------------------------------------------

const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
const stamp = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

function toAccount(r: Row): CreatorAccount {
  return {
    id: r.id, external_id: String(r.external_id), handle: String(r.handle), display_name: String(r.display_name),
    instagram_id: String(r.instagram_id), page_id: text(r.page_id),
    persona: { ...EMPTY_PERSONA, ...((r.persona as object) ?? {}) }, settings: { ...DEFAULT_CREATOR_SETTINGS, ...((r.settings as object) ?? {}) },
    status: r.status === "paused" ? "paused" : "active", revision: Number(r.revision),
    created_at: stamp(r.created_at) ?? now(), updated_at: stamp(r.updated_at) ?? now(),
  };
}
function toMedia(r: Row): CreatorMedia {
  return {
    id: r.id, external_id: String(r.external_id), account_id: String(r.account_id), kind: r.kind === "video" ? "video" : "image",
    path: String(r.path), sha256: String(r.sha256), stored_sha256: String(r.stored_sha256),
    width: num(r.width), height: num(r.height), duration_s: num(r.duration_s), mime: String(r.mime), bytes: Number(r.bytes ?? 0),
    description: String(r.description ?? ""), tags: strings(r.tags), filename: String(r.filename ?? ""),
    created_by: String(r.created_by), created_at: stamp(r.created_at) ?? now(), revision: Number(r.revision ?? 1),
  };
}
function toPost(r: Row): CreatorPost {
  return {
    id: r.id, external_id: String(r.external_id), account_id: String(r.account_id), kind: r.kind as CreatorPost["kind"],
    media_ids: strings(r.media_ids), caption: String(r.caption ?? ""), scheduled_at: stamp(r.scheduled_at),
    status: r.status as CreatorPost["status"], step: (r.step ?? "container") as CreatorPost["step"],
    containers: (r.containers as CreatorPost["containers"]) ?? {}, ig_media_id: text(r.ig_media_id), permalink: text(r.permalink),
    attempted_at: stamp(r.attempted_at), lease_owner: text(r.lease_owner), leased_until: stamp(r.leased_until), error: text(r.error),
    source: (r.source ?? "human") as CreatorPost["source"], created_by: String(r.created_by),
    created_at: stamp(r.created_at) ?? now(), updated_at: stamp(r.updated_at) ?? now(), published_at: stamp(r.published_at), revision: Number(r.revision),
  };
}
function toComment(r: Row): CreatorComment {
  return {
    id: r.id, account_id: String(r.account_id), post_id: text(r.post_id), ig_media_id: String(r.ig_media_id), ig_comment_id: String(r.ig_comment_id),
    parent_ig_id: text(r.parent_ig_id), username: String(r.username ?? ""), text: String(r.text ?? ""), commented_at: stamp(r.commented_at) ?? now(),
    decision: (r.decision ?? "pending") as CreatorComment["decision"], reason: text(r.reason), reply_text: text(r.reply_text),
    reply_due_at: stamp(r.reply_due_at), reply_ig_id: text(r.reply_ig_id), attempted_at: stamp(r.attempted_at), replied_at: stamp(r.replied_at),
    status: (r.status ?? "new") as CreatorComment["status"], error: text(r.error),
    created_at: stamp(r.created_at) ?? now(), updated_at: stamp(r.updated_at) ?? now(), revision: Number(r.revision),
  };
}
function toStat(r: Row): CreatorStat {
  const n = (k: string) => num(r[k]);
  return {
    id: r.id, account_id: String(r.account_id), scope: String(r.scope), ig_media_id: text(r.ig_media_id), post_id: text(r.post_id),
    day: String(r.day).slice(0, 10), followers_count: n("followers_count"), follows_count: n("follows_count"), media_count: n("media_count"),
    reach: n("reach"), profile_views: n("profile_views"), follows_gained: n("follows_gained"), likes: n("likes"), comments: n("comments"),
    saved: n("saved"), shares: n("shares"), views: n("views"), total_interactions: n("total_interactions"), read_at: stamp(r.read_at) ?? now(),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE = /^[a-z0-9._]{1,30}$/;
const DIGITS = /^[0-9]{5,25}$/;
/** The account handle as Instagram spells it: lowercase, no @. */
export function normalizeHandle(raw: string): string { return raw.trim().replace(/^@/, "").toLowerCase(); }

function validSettings(next: CreatorAccount["settings"]) {
  const { reply_delay_min: lo, reply_delay_max: hi } = next;
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo || hi > 24 * 60) throw invalid("Reply delays are whole minutes, the minimum not above the maximum, at most a day.");
  if (!Number.isInteger(next.max_replies_per_hour) || next.max_replies_per_hour < 0 || next.max_replies_per_hour > 60) throw invalid("At most 60 replies an hour.");
  if (!Number.isInteger(next.reply_window_days) || next.reply_window_days < 1 || next.reply_window_days > 90) throw invalid("The reply window is 1 to 90 days.");
  try { new Intl.DateTimeFormat("en-US", { timeZone: next.timezone }); } catch { throw invalid(`Unknown time zone: ${next.timezone}`); }
}

/** Engine-owned fields: only the system actor writes them. */
const ENGINE_FIELDS: (keyof CreatorPostPatch)[] = ["step", "containers", "ig_media_id", "permalink", "attempted_at", "lease_owner", "leased_until", "published_at"];

// ---- the layer -------------------------------------------------------------------

export function createCreatorData(): CreatorDataLayer {
  const accounts = async (s: Session) => (await list(s, "creator_accounts")).map(toAccount);
  const findAccount = async (s: Session, ref: string) => {
    staff(s);
    const key = ref.trim();
    const handle = normalizeHandle(key);
    const found = (await accounts(s)).find(a => a.id === key || a.external_id === key || a.handle === handle);
    if (!found) throw notFound("Creator account");
    return found;
  };
  const posts = async (s: Session, accountId?: string) => (await list(s, "creator_posts", accountId ? { account_id: accountId } : {})).map(toPost);
  const comments = async (s: Session, accountId?: string) => (await list(s, "creator_comments", accountId ? { account_id: accountId } : {})).map(toComment);

  const api: CreatorDataLayer = {
    async listCreatorAccounts(s) {
      staff(s);
      return (await accounts(s)).sort((a, b) => a.handle.localeCompare(b.handle));
    },
    getCreatorAccount: findAccount,
    async upsertCreatorAccount(s, input) {
      admin(s);
      const handle = normalizeHandle(input.handle);
      if (!HANDLE.test(handle)) throw invalid("An Instagram handle is up to 30 lowercase letters, digits, dots and underscores.");
      if (!DIGITS.test(input.instagram_id)) throw invalid("The Instagram account id is the numeric id Meta gives (17841…).");
      if (input.page_id && !DIGITS.test(input.page_id)) throw invalid("A Facebook Page id is numeric.");
      if (!input.display_name.trim()) throw invalid("Name the account.");
      const settings = { ...DEFAULT_CREATOR_SETTINGS, ...(input.settings ?? {}) };
      validSettings(settings);
      const existing = (await accounts(s)).find(a => a.handle === handle);
      if (existing) {
        if (existing.instagram_id !== input.instagram_id) throw conflict(`@${handle} is recorded with Instagram id ${existing.instagram_id}, not ${input.instagram_id}.`);
        const account = await api.updateCreatorAccount(s, existing.id, existing.revision, {
          display_name: input.display_name, page_id: input.page_id ?? null, persona: input.persona, settings,
          ...(input.status ? { status: input.status } : {}),
        });
        return { account, created: false };
      }
      const at = now();
      const row = {
        id: randomUUID(), external_id: dataSource() === "fixture" ? extId("cr") : undefined, handle, display_name: input.display_name.trim(),
        instagram_id: input.instagram_id, page_id: input.page_id ?? null, persona: { ...EMPTY_PERSONA, ...input.persona }, settings,
        status: input.status ?? "active", revision: 1, created_at: at, updated_at: at,
      } as Row;
      const saved = await insert(s, "creator_accounts", row);
      if (!saved) throw conflict("Another creator account already uses that handle or Instagram id.");
      await audit(s, "creator_account_created", "creator_accounts", saved.id, { handle });
      return { account: toAccount(saved), created: true };
    },
    async updateCreatorAccount(s, id, expected, patch) {
      admin(s);
      const current = await findAccount(s, id);
      if (current.revision !== expected) throw conflict("This account changed. Reload and try again.");
      const next: CreatorAccount = {
        ...current,
        ...(patch.display_name !== undefined ? { display_name: patch.display_name.trim() || current.display_name } : {}),
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.page_id !== undefined ? { page_id: patch.page_id } : {}),
        persona: { ...current.persona, ...(patch.persona ?? {}) },
        settings: { ...current.settings, ...(patch.settings ?? {}) },
        revision: expected + 1, updated_at: now(),
      };
      if (next.page_id && !DIGITS.test(next.page_id)) throw invalid("A Facebook Page id is numeric.");
      validSettings(next.settings);
      const saved = await update(s, "creator_accounts", next as unknown as Row, expected);
      if (!saved) throw conflict("This account changed. Reload and try again.");
      await audit(s, "creator_account_updated", "creator_accounts", id, { status: next.status, settings: next.settings });
      return toAccount(saved);
    },

    async listCreatorMedia(s, accountId) {
      const account = await findAccount(s, accountId);
      return (await list(s, "creator_media", { account_id: account.id })).map(toMedia).sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    async getCreatorMedia(s, ref) {
      staff(s, "Media");
      const all = (await list(s, "creator_media")).map(toMedia);
      const found = all.find(m => m.id === ref || m.external_id === ref);
      if (!found) throw notFound("Media");
      return found;
    },
    async createCreatorMedia(s, input) {
      staff(s, "Media");
      const account = await findAccount(s, input.account_id);
      if (!/^[0-9a-f]{64}$/.test(input.sha256) || !/^[0-9a-f]{64}$/.test(input.stored_sha256)) throw invalid("A media row needs both SHA-256 hashes.");
      if (!input.path.startsWith(`creators/${account.id}/`)) throw invalid("Creator media is stored under creators/<account>/.");
      const existing = (await list(s, "creator_media", { account_id: account.id })).map(toMedia).find(m => m.sha256 === input.sha256);
      if (existing) return { media: existing, created: false };
      const row = {
        ...input, id: randomUUID(), external_id: dataSource() === "fixture" ? extId("cm") : undefined, account_id: account.id,
        description: input.description.trim().slice(0, 1000), tags: [...new Set(input.tags.map(t => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20),
        created_by: s.userId, created_at: now(), revision: 1,
      } as unknown as Row;
      const saved = await insert(s, "creator_media", row);
      if (!saved) {
        const again = (await list(s, "creator_media", { account_id: account.id })).map(toMedia).find(m => m.sha256 === input.sha256);
        if (again) return { media: again, created: false };
        throw conflict("This media could not be recorded. Try again.");
      }
      return { media: toMedia(saved), created: true };
    },
    async updateCreatorMedia(s, id, expected, patch) {
      staff(s, "Media");
      const current = await api.getCreatorMedia(s, id);
      if (current.revision !== expected) throw conflict("This media changed. Reload and try again.");
      const next: CreatorMedia = {
        ...current,
        ...(patch.description !== undefined ? { description: patch.description.trim().slice(0, 1000) } : {}),
        ...(patch.tags !== undefined ? { tags: [...new Set(patch.tags.map(t => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20) } : {}),
        revision: expected + 1,
      };
      const saved = await update(s, "creator_media", next as unknown as Row, expected);
      if (!saved) throw conflict("This media changed. Reload and try again.");
      return toMedia(saved);
    },

    async listCreatorPosts(s, filter = {}) {
      staff(s);
      const rows = await posts(s, filter.account_id ? (await findAccount(s, filter.account_id)).id : undefined);
      return rows.filter(p => !filter.status || filter.status.includes(p.status)).sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    async getCreatorPost(s, ref) {
      staff(s, "Post");
      const found = (await posts(s)).find(p => p.id === ref || p.external_id === ref);
      if (!found) throw notFound("Post");
      return found;
    },
    async createCreatorPost(s, input) {
      admin(s);
      const account = await findAccount(s, input.account_id);
      if (!input.media_ids.length) throw invalid("Pick the media to post.");
      const at = now();
      const row = {
        id: randomUUID(), external_id: dataSource() === "fixture" ? extId("cp") : undefined, account_id: account.id, kind: input.kind,
        media_ids: [...input.media_ids], caption: input.caption, scheduled_at: input.scheduled_at, status: input.status, step: "container",
        containers: {}, ig_media_id: null, permalink: null, attempted_at: null, lease_owner: null, leased_until: null, error: null,
        source: input.source, created_by: s.userId, created_at: at, updated_at: at, published_at: null, revision: 1,
      } as unknown as Row;
      const saved = await insert(s, "creator_posts", row);
      if (!saved) throw conflict("This post already exists.");
      await audit(s, "creator_post_created", "creator_posts", saved.id, { kind: input.kind, status: input.status, source: input.source });
      return toPost(saved);
    },
    async updateCreatorPost(s, id, expected, patch, opts = {}) {
      admin(s);
      if (ENGINE_FIELDS.some(k => k in patch)) worker(s);
      const current = await api.getCreatorPost(s, id);
      if (current.revision !== expected) throw conflict("This post changed. Reload and try again.");
      if (current.status === "published" && patch.status && patch.status !== "published") throw conflict("A published post cannot be reopened.");
      if (current.status === "published" && !isSystemSession(s)) throw conflict("A published post cannot be edited.");
      const next: CreatorPost = { ...current, ...patch, revision: expected + 1, updated_at: now() };
      const saved = await update(s, "creator_posts", next as unknown as Row, expected);
      if (!saved) throw conflict("This post changed. Reload and try again.");
      const action = opts.action ?? (next.status === current.status ? null : `creator_post_${next.status}`);
      if (action) await audit(opts.actor ?? s, action, "creator_posts", id, { status: next.status, step: next.step, ig_media_id: next.ig_media_id }, next.error);
      return toPost(saved);
    },

    async listCreatorComments(s, filter = {}) {
      staff(s);
      const rows = await comments(s, filter.account_id ? (await findAccount(s, filter.account_id)).id : undefined);
      return rows.filter(c => !filter.status || filter.status.includes(c.status)).sort((a, b) => b.commented_at.localeCompare(a.commented_at));
    },
    async getCreatorComment(s, id) {
      staff(s, "Comment");
      const found = (await comments(s)).find(c => c.id === id || c.ig_comment_id === id);
      if (!found) throw notFound("Comment");
      return found;
    },
    async recordCreatorComment(s, input) {
      worker(s);
      const existing = (await comments(s, input.account_id)).find(c => c.ig_comment_id === input.ig_comment_id);
      if (existing) return { comment: existing, created: false };
      const at = now();
      const row = {
        id: randomUUID(), account_id: input.account_id, post_id: input.post_id, ig_media_id: input.ig_media_id, ig_comment_id: input.ig_comment_id,
        parent_ig_id: input.parent_ig_id, username: input.username.slice(0, 100), text: input.text.slice(0, 2200), commented_at: input.commented_at,
        decision: input.decision ?? "pending", reason: input.reason ?? null, reply_text: null, reply_due_at: null, reply_ig_id: input.reply_ig_id ?? null,
        attempted_at: null, replied_at: null, status: input.status ?? "new", error: null, created_at: at, updated_at: at, revision: 1,
      } as Row;
      const saved = await insert(s, "creator_comments", row);
      if (!saved) {
        const again = (await comments(s, input.account_id)).find(c => c.ig_comment_id === input.ig_comment_id);
        if (again) return { comment: again, created: false };
        throw conflict("This comment could not be recorded.");
      }
      return { comment: toComment(saved), created: true };
    },
    async updateCreatorComment(s, id, expected, patch, opts = {}) {
      admin(s);
      const current = await api.getCreatorComment(s, id);
      if (current.revision !== expected) throw conflict("This comment changed. Reload and try again.");
      if (current.reply_ig_id && patch.reply_ig_id !== undefined && patch.reply_ig_id !== current.reply_ig_id) throw conflict("This comment already has a reply.");
      if (current.status === "sent" && patch.status && patch.status !== "sent") throw conflict("This comment was already answered.");
      if (patch.reply_text != null && patch.reply_text.length > 300) throw invalid("A reply is at most 300 characters.");
      const next: CreatorComment = { ...current, ...patch, revision: expected + 1, updated_at: now() };
      const saved = await update(s, "creator_comments", next as unknown as Row, expected);
      if (!saved) throw conflict("This comment changed. Reload and try again.");
      const action = opts.action ?? (next.status === current.status ? null : `creator_comment_${next.status}`);
      if (action) await audit(opts.actor ?? s, action, "creator_comments", id, { decision: next.decision, status: next.status, reply_ig_id: next.reply_ig_id }, next.reason);
      return toComment(saved);
    },

    async listCreatorStats(s, accountId, opts = {}) {
      const account = await findAccount(s, accountId);
      return (await list(s, "creator_stats", { account_id: account.id })).map(toStat)
        .filter(r => !opts.since || r.day >= opts.since).sort((a, b) => a.day.localeCompare(b.day) || a.scope.localeCompare(b.scope));
    },
    async recordCreatorStat(s, input) {
      worker(s);
      if ((input.scope === "account") !== (input.ig_media_id === null)) throw invalid("An account row has no media id; a media row names its media.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) throw invalid("A stats day is YYYY-MM-DD.");
      const existing = (await list(s, "creator_stats", { account_id: input.account_id })).map(toStat).find(r => r.scope === input.scope && r.day === input.day);
      // A second read the same day replaces the first metric by metric: what it could not read keeps the earlier value.
      if (existing) {
        const keep = input as Record<string, unknown>;
        for (const [k, v] of Object.entries(existing)) if (k in keep && keep[k] === null && v !== null) keep[k] = v;
      }
      if (dataSource() === "fixture") {
        const row = { ...input, id: existing?.id ?? randomUUID(), created_at: input.read_at } as unknown as Row;
        const rows = store().creator_stats;
        const i = rows.findIndex(r => r.id === row.id);
        if (i < 0) rows.push(row); else rows[i] = row;
        persist(); return toStat(row);
      }
      const { data, error } = await (await client(s, true)).schema("promote").from("creator_stats")
        .upsert({ ...input, ...(existing ? { id: existing.id } : {}) }, { onConflict: "account_id,scope,day" }).select("*").maybeSingle();
      if (error || !data) throw invalid(`Creator stats write failed (${error?.code ?? "no row"}). ${MIGRATION}`);
      return toStat(data as Row);
    },
  };
  return api;
}

export const isUuid = (v: string) => UUID.test(v);
