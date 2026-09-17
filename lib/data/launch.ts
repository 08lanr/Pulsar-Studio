// Launch jobs use one atomic document per run: allocation, approval and every
// campaign checkpoint commit together. Browser sessions have read-only RLS;
// all writes pass these role-checked job services and server-only service role.
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FIXTURE_PRODUCER_ID, isSystemSession, type Session } from "@/lib/auth";
import { dataSource } from "@/lib/data-source";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import { buildLaunchPlan, draftSchema, nextCampidStart } from "@/lib/launch/plan";
import { launchEnvironment } from "@/lib/launch/environment";
import { eligibleMetaAssignment, eligibleTikTokBcAccount } from "@/lib/launch/account-authority";
import type { ClipLibraryFilter, ClipLibraryRow, ClipPost, ClipPostPlatform, ClipPostStatus, ClipPostStep } from "@/lib/launch/clip-posts";
import type { ClipPostPatch, LaunchConnection, LaunchDataLayer, LaunchDraft, LaunchLibraryItem, LaunchRun, LaunchProvider, LaunchPlanRow } from "@/lib/launch/types";
import type { DataLayer } from "./index";
import { conflict, forbidden, invalid, notFound } from "./errors";
import { mediaUrl } from "./storage";

/**
 * The campaign names already on the chosen Meta accounts, so a typed campid
 * that collides is a "Fix these first" line at preview rather than a failed
 * campaign after approval. Only a typed campid can collide (the derived id
 * embeds the run's external id), and a listing that fails is not fatal here:
 * the driver refuses the same collision again before it creates anything.
 */
async function takenCampaignNames(draft: LaunchDraft, own: LaunchConnection[]): Promise<string[]> {
  if (draft.provider !== "meta" || !draft.campid_start) return [];
  const [{ listMetaCampaignNames }, { metaTransport }] = await Promise.all([import("@/lib/meta/driver"), import("@/lib/meta")]);
  const chosen = own.filter(c => draft.account_ids.includes(c.id));
  const names = await Promise.all(chosen.map(c => listMetaCampaignNames(metaTransport(), c.advertiser_id).catch(() => [] as string[])));
  return [...new Set(names.flat())];
}

type Store = { runs: LaunchRun[]; connections: LaunchConnection[]; sparks: Record<string, { code: string; url: string }>; defaults: Record<string, string>; clipPosts: ClipPost[] };
const globalStore = globalThis as unknown as { __studioLaunchV2?: Store };
const file = () => path.join(process.cwd(), ".uploads", "launch-state.json");
const persistOn = () => process.env.FIXTURE_PERSIST !== "off" && process.env.NODE_ENV !== "test";
const now = () => new Date().toISOString();
const copy = <T>(value: T): T => structuredClone(value);
function store(): Store {
  if (!globalStore.__studioLaunchV2) {
    let saved: Store | undefined;
    if (persistOn() && existsSync(file())) { try { saved = JSON.parse(readFileSync(file(), "utf8")); } catch { /* recover a corrupt fixture file without live calls */ } }
    globalStore.__studioLaunchV2 = saved?.runs && saved.connections ? saved : { runs: [], connections: [], sparks: {}, defaults: {}, clipPosts: [] };
    // A state file written before organic posting existed has no clip posts.
    if (!globalStore.__studioLaunchV2.clipPosts) globalStore.__studioLaunchV2.clipPosts = [];
  }
  return globalStore.__studioLaunchV2;
}
function persist() {
  if (!persistOn()) return;
  mkdirSync(path.dirname(file()), { recursive: true });
  const temp = `${file()}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(store())); renameSync(temp, file());
}
export function resetLaunchFixture() { globalStore.__studioLaunchV2 = { runs: [], connections: [], sparks: {}, defaults: {}, clipPosts: [] }; persist(); }
/** Demo replay removes only one company's launch records, clip Spark notes and organic posts. */
export function resetLaunchFixtureForProducer(producerId: string, clipIds: readonly string[] = []): { runs: LaunchRun[]; clipPosts: ClipPost[] } {
  const s = store();
  const removed = s.runs.filter(r => r.producer_id === producerId);
  const removedPosts = s.clipPosts.filter(p => p.producer_id === producerId);
  s.runs = s.runs.filter(r => r.producer_id !== producerId);
  s.clipPosts = s.clipPosts.filter(p => p.producer_id !== producerId);
  s.connections = s.connections.filter(c => c.producer_id !== producerId);
  delete s.defaults[producerId];
  for (const clipId of clipIds) delete s.sparks[clipId];
  persist();
  return { runs: copy(removed), clipPosts: copy(removedPosts) };
}
function authorize(s: Session, producerId: string, mode: "read" | "edit" | "launch" = "read") {
  if (s.kind === "staff") {
    if (mode === "launch" && s.staffRole !== "admin") throw forbidden("A staff administrator must authorize an on-behalf launch.");
    return;
  }
  if (s.producerId !== producerId) throw notFound("Launch");
  if (mode !== "read" && !["reviewer", "approver"].includes(s.producerRole || "")) throw forbidden("Requires the reviewer role.");
  if (mode === "launch" && s.producerRole !== "approver") throw forbidden("Requires the approver role.");
}
function worker(s: Session) { if (!isSystemSession(s)) throw forbidden("Launch worker only."); }
/**
 * Who may publish a clip organically: a staff administrator, or the company's
 * approver — the same rule as launching, because a public post is
 * money-adjacent. One function, so the data layer and the publishing engine
 * can never drift apart.
 */
export function assertMayPublishClip(s: Session, producerId: string) {
  if (s.kind === "staff") {
    if (s.staffRole !== "admin") throw forbidden("A staff administrator must authorize publishing.");
    return;
  }
  if (s.producerId !== producerId) throw notFound("Clip");
  if (s.producerRole !== "approver") throw forbidden("Requires the approver role.");
}
export function launchHash(draft: LaunchDraft, connections: LaunchConnection[], campaignRows?: LaunchPlanRow[]) {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  const intent = campaignRows?.map(row => ({ index: row.index, connection_id: row.connection_id,
    advertiser_id: row.advertiser_id, name: row.name, campid: row.campid, tracking_url: row.tracking_url }));
  return createHash("sha256").update(JSON.stringify(canonical({ draft, connections, ...(intent ? { campaign_intent: intent } : {}) }))).digest("hex");
}
function audit(run: LaunchRun, s: Session, action: string, note?: string, detail?: unknown) {
  run.audit = [...(run.audit ?? []), { at: now(), actor: s.userId, action, ...(note ? { note } : {}), ...(detail !== undefined ? { detail } : {}) }];
}
function connectionSignature(values: LaunchConnection[]) {
  return launchHash({} as LaunchDraft, values.map(a => ({ ...a, verified_at: "", name: "", business_name: "" })).sort((a, b) => a.id.localeCompare(b.id)));
}
function dbFor(s: Session) { return isSystemSession(s) ? createServiceSupabase() : createServerSupabase(); }
async function readRuns(s: Session): Promise<LaunchRun[]> {
  if (dataSource() === "fixture") return copy(store().runs.filter(r => s.kind === "staff" || r.producer_id === s.producerId));
  const { data, error } = await dbFor(s).schema("promote").from("launch_runs").select("payload").order("created_at", { ascending: false });
  if (error) throw invalid(`Launch storage unavailable. Apply 0013_launch_runs.sql. ${error.code}`);
  return (data ?? []).map(r => r.payload as LaunchRun);
}
async function save(run: LaunchRun, expected: number | null): Promise<LaunchRun> {
  const next = copy(run); next.revision = (expected ?? 0) + 1; next.updated_at = now();
  if (dataSource() === "fixture") {
    const s = store(), index = s.runs.findIndex(r => r.id === run.id);
    if ((expected === null && index !== -1) || (expected !== null && (index === -1 || s.runs[index].revision !== expected))) throw conflict("Launch changed. Reload and try again.");
    if (index === -1) s.runs.push(next); else s.runs[index] = next;
    s.defaults[run.producer_id] = run.draft.destination_url; persist(); return copy(next);
  }
  const db = createServiceSupabase().schema("promote");
  const row = { id: next.id, producer_id: next.producer_id, status: next.status, revision: next.revision, payload: next };
  const query = expected === null ? db.from("launch_runs").insert(row) : db.from("launch_runs").update(row).eq("id", next.id).eq("revision", expected);
  const { data, error } = await query.select("payload").maybeSingle();
  if (error) throw invalid(`Launch storage write failed (${error.code}).`);
  if (!data) throw conflict("Launch changed. Reload and try again.");
  return data.payload as LaunchRun;
}
async function readConnections(s: Session, producerId: string): Promise<LaunchConnection[]> {
  if (dataSource() === "fixture") return copy(store().connections.filter(c => c.producer_id === producerId));
  const { data, error } = await dbFor(s).schema("promote").from("launch_connections").select("payload").eq("producer_id", producerId);
  if (error) throw invalid(`Launch account storage unavailable (${error.code}).`);
  return (data ?? []).map(r => r.payload as LaunchConnection);
}

// ---- organic clip posts (promote.clip_posts, docs/meta-organic-plan.md) ------
// One code path; dataSource() branches at storage only, as everywhere else in
// this file. No column ever carries credential material.

const CLIP_POST_FIRST_STEP: Record<ClipPostPlatform, ClipPostStep> = { facebook: "uploading", instagram: "container" };

function toClipPost(row: Record<string, unknown>): ClipPost {
  const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const stamp = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);
  return {
    id: String(row.id), producer_id: String(row.producer_id), clip_id: String(row.clip_id),
    connection_id: String(row.connection_id), platform: row.platform as ClipPostPlatform,
    status: row.status as ClipPostStatus, step: row.step as ClipPostStep,
    external_video_id: text(row.external_video_id), external_post_id: text(row.external_post_id),
    permalink: text(row.permalink), caption: String(row.caption ?? ""), sha256: String(row.sha256 ?? ""),
    error: text(row.error), attempted_at: stamp(row.attempted_at), superseded_by: text(row.superseded_by),
    lease_owner: text(row.lease_owner), leased_until: stamp(row.leased_until),
    created_by: String(row.created_by),
    created_at: stamp(row.created_at) ?? now(), updated_at: stamp(row.updated_at) ?? now(),
    published_at: stamp(row.published_at), revision: Number(row.revision),
  };
}
/** The audit copy is fixture-only bookkeeping; Supabase writes core.audit_events. */
function clipPostRow(post: ClipPost) { const { audit: _audit, ...row } = post; return row; }

async function readClipPosts(s: Session): Promise<ClipPost[]> {
  if (dataSource() === "fixture") return copy(store().clipPosts.filter(p => s.kind === "staff" || p.producer_id === s.producerId));
  const { data, error } = await dbFor(s).schema("promote").from("clip_posts").select("*").order("created_at", { ascending: false });
  if (error) throw invalid(`Clip post storage unavailable. Apply 0014_clip_posts.sql. ${error.code}`);
  return (data ?? []).map(row => toClipPost(row as Record<string, unknown>));
}

const DUPLICATE_POST = "This clip is already published to that account. Use Post again to publish a second time.";
async function writeClipPost(post: ClipPost, expected: number | null): Promise<ClipPost> {
  const next = copy(post);
  if (expected !== null) { next.revision = expected + 1; next.updated_at = now(); }
  if (dataSource() === "fixture") {
    const list = store().clipPosts, index = list.findIndex(p => p.id === next.id);
    if (expected === null && index !== -1) throw conflict("This post already exists.");
    if (expected !== null && (index === -1 || list[index].revision !== expected)) throw conflict("This post changed. Reload and try again.");
    // Mirrors the partial unique index of 0014_clip_posts.sql: the write is
    // refused before it lands, so no row is ever rolled back. A superseded row
    // has stepped aside for its replacement and no longer holds the slot.
    if (next.status === "published" && !next.superseded_by && list.some(p => p.id !== next.id && p.status === "published"
      && !p.superseded_by && p.clip_id === next.clip_id && p.platform === next.platform && p.connection_id === next.connection_id)) throw conflict(DUPLICATE_POST);
    if (index === -1) list.push(next); else list[index] = next;
    persist(); return copy(next);
  }
  const table = createServiceSupabase().schema("promote").from("clip_posts");
  const query = expected === null ? table.insert(clipPostRow(next)) : table.update(clipPostRow(next)).eq("id", next.id).eq("revision", expected);
  const { data, error } = await query.select("*").maybeSingle();
  if (error) throw error.code === "23505" ? conflict(DUPLICATE_POST) : invalid(`Clip post storage write failed (${error.code}).`);
  if (!data) throw conflict("This post changed. Reload and try again.");
  return toClipPost(data as Record<string, unknown>);
}

/** Appends the audit entry to the row (fixture) or to core.audit_events (Supabase). Call before writing. */
async function auditClipPost(s: Session, post: ClipPost, action: string, note?: string): Promise<void> {
  if (dataSource() === "fixture") {
    post.audit = [...(post.audit ?? []), { at: now(), actor: isSystemSession(s) ? null : s.userId, action, ...(note ? { note } : {}) }];
    return;
  }
  const { auditEvent } = await import("./supabase");
  await auditEvent(s, action, "promote.clip_posts", post.id, null, post.producer_id,
    null, { platform: post.platform, clip_id: post.clip_id, connection_id: post.connection_id, status: post.status, step: post.step }, note ?? null);
}

/**
 * Rename a launch — the name people read on the monitor and nothing else.
 * Provider objects keep the names they were created with (the Meta campaign is
 * its campid), so this never reaches Meta or TikTok.
 *
 * One code path for both backends: `readRuns` and `save` branch at storage, as
 * everywhere else in this file. Authorization is the launch authorization —
 * the company's approver or a staff administrator — and a run that is still
 * being created is refused, because its campaigns are being written by the
 * worker at that moment.
 *
 * The approval hash covers the whole draft, so the name has to be re-signed or
 * every later control would read as a changed approval. That is only ever done
 * when the approval still verifies exactly as it stands — a drifted approval is
 * refused rather than quietly re-signed — and the audit row records both names,
 * so the record still says who changed what and when.
 *
 * Exposed on the data layer as `renameLaunchRun`; routes reach it through
 * `getData()` like every other launch write. The standalone export is the same
 * function, for the tests that exercise it without a data object.
 */
export async function renameLaunchRun(s: Session, id: string, name: string): Promise<LaunchRun> {
  const trimmed = name.trim();
  if (!trimmed) throw invalid("Give the launch a name.");
  if (trimmed.length > 80) throw invalid("A launch name may be at most 80 characters.");
  const run = (await readRuns(s)).find(r => r.id === id || r.external_id === id);
  if (!run) throw notFound("Launch");
  authorize(s, run.producer_id, "launch");
  if (run.status === "running" || run.status === "pending") throw conflict("This launch is still being created. Rename it once it finishes.");
  if (run.lease_owner && Date.parse(run.lease_until || "") > Date.now()) throw conflict("This launch is being updated. Try again shortly.");
  if (run.draft.name === trimmed) return run;
  const rows = run.campaigns.some(c => c.campid) ? run.campaigns : undefined;
  if (run.snapshot_hash && launchHash(run.draft, run.connections || [], rows) !== run.snapshot_hash) {
    throw conflict("Launch approval is missing or changed. Create and approve a new round.");
  }
  const previous = run.draft.name;
  run.draft = { ...run.draft, name: trimmed };
  if (run.snapshot_hash) run.snapshot_hash = launchHash(run.draft, run.connections || [], rows);
  audit(run, s, "renamed", undefined, { from: previous, to: trimmed });
  return save(run, run.revision);
}

function demoMeta(producerId: string, existing: LaunchConnection[]): LaunchConnection[] {
  if (dataSource() !== "fixture" || producerId !== FIXTURE_PRODUCER_ID || process.env.FIXTURE_SEED === "empty") return [];
  return [1, 2].filter(i => !existing.some(a => a.advertiser_id === `act_900000000000000${i}`)).map(i => ({ id: `demo-meta-${i}`, producer_id: producerId, provider: "meta", advertiser_id: `act_900000000000000${i}`, name: `Demo Meta ${i}`, currency: "USD", timezone: "America/Los_Angeles", page_id: "9000000000000010", instagram_id: "9000000000000020", business_id: "9000000000000000", assigned_by: "fixture-seed", verified_at: now(), enabled: true }));
}

export function createLaunchData(base: DataLayer): LaunchDataLayer {
  async function connections(s: Session, producerId: string, provider?: LaunchProvider, fresh = true) {
    authorize(s, producerId);
    const items = await readConnections(s, producerId);
    if (dataSource() !== "fixture") {
      const current: LaunchConnection[] = [];
      if (provider !== "tiktok" && items.some(c => c.provider === "meta" && c.enabled)) {
        const { currentMetaInventory } = await import("@/lib/meta/discovery");
        const inventory = await currentMetaInventory(fresh);
        for (const saved of items.filter(c => c.provider === "meta" && c.enabled && c.assigned_by)) {
          if (!eligibleMetaAssignment(saved, inventory)) continue;
          const account = inventory.accounts.find(a => a.id === saved.advertiser_id)!;
          current.push({ ...saved, name: account.name, currency: account.currency, timezone: account.timezone_name, business_id: account.business?.id ?? null, business_name: account.business?.name });
        }
      }
      if (provider === "meta") return current;
      const bc = await base.getLaunchBusinessCenter(s, producerId);
      const single = await base.getLaunchAccount(s, producerId);
      const { listBcAccounts, listBusinessCenters } = await import("@/lib/tiktok/business-centers");
      const { accessTokenFor } = await import("@/lib/tiktok");
      if (bc?.assigned_by && bc.state === "connected" && bc.external_ref) {
        const listed = await listBusinessCenters();
        if (listed.businessCenters.some(b => b.bcId === bc.external_ref)) {
          const result = await listBcAccounts(bc.external_ref);
          if (result.error) throw invalid(result.error);
          for (const a of result.accounts) if (eligibleTikTokBcAccount(bc.external_ref, listed.businessCenters.map(b => b.bcId), a, !!accessTokenFor(a.id))) current.push({
            id: `tiktok:${producerId}:${a.id}`, producer_id: producerId, provider: "tiktok", advertiser_id: a.id,
            name: a.name || a.id, currency: "USD", timezone: "", page_id: null, instagram_id: null,
            business_id: bc.external_ref, assigned_by: bc.assigned_by, verified_at: now(), enabled: true,
          });
        }
      }
      if (single?.assigned_by && single.state === "connected" && single.external_ref && accessTokenFor(single.external_ref) &&
        !current.some(a => a.provider === "tiktok" && a.advertiser_id === single.external_ref)) current.push({
          id: `tiktok:${producerId}:${single.external_ref}`, producer_id: producerId, provider: "tiktok", advertiser_id: single.external_ref,
          name: single.name, currency: "USD", timezone: "", page_id: null, instagram_id: null,
          business_id: null, assigned_by: single.assigned_by, verified_at: now(), enabled: true,
        });
      return current;
    }
    if (provider === "meta") return items.filter(c => c.provider === "meta").concat(demoMeta(producerId, items));
    // Existing staff-assigned TikTok BCs stay authoritative; no publishing handle needed for Sparks.
    const bc = await base.getLaunchBusinessCenter(s, producerId);
    const single = await base.getLaunchAccount(s, producerId);
    const add = (id: string, name: string, businessId: string | null, assignedBy: string, currency = "USD") => {
      if (!items.some(a => a.provider === "tiktok" && a.advertiser_id === id)) items.push({ id: `tiktok:${producerId}:${id}`, producer_id: producerId, provider: "tiktok", advertiser_id: id, name, currency, timezone: "", page_id: null, instagram_id: null, business_id: businessId, assigned_by: assignedBy, verified_at: now(), enabled: true });
    };
    if (single?.assigned_by && single.state === "connected" && single.external_ref) add(single.external_ref, single.name, null, single.assigned_by);
    if (dataSource() === "fixture" && producerId === FIXTURE_PRODUCER_ID && process.env.FIXTURE_SEED !== "empty") {
      ["7000000000000000001", "7000000000000000002"].forEach((id, i) => add(id, `Demo TikTok ${i + 1}`, "7000000000000000000", "fixture-seed"));
      items.push(...demoMeta(producerId, items));
    }
    return provider ? items.filter(c => c.provider === provider) : items;
  }
  /** Episode id → the episode's number, for the Clips tab's episode column and filter. */
  async function episodeNumbers(s: Session, titleId: string): Promise<Map<string, string>> {
    try { return new Map((await base.getTitle(s, titleId)).episodes.map(e => [e.id, String(e.number)])); }
    catch { return new Map(); } // A title whose detail is unreadable still lists its clips.
  }
  function postedMatches(row: ClipLibraryRow, posted: ClipLibraryFilter["posted"]): boolean {
    if (!posted || posted === "any") return true;
    if (posted === "posted") return row.posts.some(p => p.status === "published");
    if (posted === "failed") return row.posts.some(p => p.status === "failed");
    return !row.posts.some(p => p.status === "published");
  }
  /**
   * Every rendered, non-dismissed clip with a stored SHA-256, joined with its
   * posts. Staff with no `producer_id` see every company; a producer session is
   * always scoped to its own, and the filter's `producer_id` is ignored.
   */
  async function clipLibrary(s: Session, filter: ClipLibraryFilter, withEpisodes = true): Promise<ClipLibraryRow[]> {
    const scoped = s.kind === "producer" ? s.producerId! : (filter.producer_id || "");
    if (scoped) authorize(s, scoped);
    const titles = (await base.listTitles(s)).filter(t => (!scoped || t.producer_id === scoped) && (!filter.title_id || t.id === filter.title_id));
    const posts = await readClipPosts(s);
    const search = filter.search?.trim().toLowerCase() || "";
    const out: ClipLibraryRow[] = [];
    for (const title of titles) {
      const clips = (await base.listEpisodeClips(s, title.id))
        .filter(c => c.render_status === "rendered" && c.render_path && c.render_sha256 && c.status !== "dismissed")
        .filter(c => !filter.episode_id || c.episode_id === filter.episode_id);
      if (!clips.length) continue;
      const episodes = withEpisodes ? await episodeNumbers(s, title.id) : new Map<string, string>();
      const name = title.name_en || title.name_zh;
      for (const clip of clips) {
        const saved = dataSource() === "fixture" ? store().sparks[clip.id] : undefined;
        out.push({
          id: clip.id, external_id: clip.external_id, kind: "video", value: clip.id, creative_id: clip.id, clip_id: clip.id,
          producer_id: title.producer_id, producer_name: title.producer_name_en || title.producer_name_zh,
          title_id: title.id, title_name: name, episode_id: clip.episode_id ?? null,
          episode_label: episodes.get(clip.episode_id) ?? null, label: clip.hook_en || clip.external_id,
          duration_ms: clip.duration_ms ?? null, rendered_at: clip.created_at ?? null,
          file_path: clip.render_path!, sha256: clip.render_sha256!, text: clip.hook_en, headline: name,
          media_url: mediaUrl(clip.render_path), thumbnail_url: null,
          spark_code: saved?.code ?? null, post_url: saved?.url ?? null,
          posts: posts.filter(p => p.clip_id === clip.id).sort((a, b) => b.created_at.localeCompare(a.created_at)),
        });
      }
    }
    return out.filter(row => postedMatches(row, filter.posted))
      .filter(row => !search || `${row.label} ${row.title_name}`.toLowerCase().includes(search));
  }
  /** The launch workspace's view of the same rows; episode labels are not needed to resolve a draft. */
  async function library(s: Session, producerId: string): Promise<LaunchLibraryItem[]> {
    return clipLibrary(s, { producer_id: producerId }, false);
  }
  async function find(s: Session, id: string) {
    const run = (await readRuns(s)).find(r => r.id === id || r.external_id === id);
    if (!run) throw notFound("Launch"); authorize(s, run.producer_id); return run;
  }
  async function resolved(s: Session, draft: LaunchDraft, producerId: string): Promise<LaunchDraft> {
    const parsed = draftSchema.safeParse(draft);
    if (!parsed.success) throw invalid(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
    const safe = parsed.data;
    const own = safe.content.some(c => c.kind === "video" || c.clip_id) ? await library(s, producerId) : [];
    return { ...safe, content: safe.content.map(c => {
      // Clip provenance is display only, so an unknown one is dropped rather
      // than refused; it never reaches the provider payload.
      const known = c.clip_id && own.some(a => a.id === c.clip_id) ? c.clip_id : undefined;
      const provenance = { ...c, clip_id: known, post_id: known ? c.post_id : undefined };
      if (c.kind !== "video") return provenance;
      const asset = own.find(a => a.id === c.value);
      if (!asset) throw notFound("Finished clip");
      return { ...provenance, creative_id: asset.id, clip_id: asset.id, title_id: asset.title_id, file_path: asset.file_path, sha256: asset.sha256,
        text: c.text ?? asset.text, headline: c.headline ?? asset.headline };
    }) };
  }
  const api: LaunchDataLayer = {
    getLaunchConnections: connections,
    async getLaunchWorkspace(s, requested) {
      const producerId = s.kind === "producer" ? s.producerId! : requested || "";
      if (producerId) authorize(s, producerId);
      const runs = (await readRuns(s)).filter(r => !producerId || r.producer_id === producerId).sort((a, b) => b.created_at.localeCompare(a.created_at));
      const producers = s.kind === "staff" ? (await base.listProducers(s)).map(p => ({ id: p.id, name_zh: p.name_zh, name_en: p.name_en })) : undefined;
      if (producerId && producers && !producers.some(p => p.id === producerId)) throw notFound("Company");
      const results = producerId ? await Promise.allSettled([connections(s, producerId, "tiktok", false), connections(s, producerId, "meta", false)]) : [];
      const available = results.flatMap(result => result.status === "fulfilled" ? result.value : []);
      const accountWarnings = results.flatMap((result, i) => result.status === "rejected" ? [`${i === 0 ? "TikTok" : "Meta"} account discovery is unavailable: ${result.reason instanceof Error ? result.reason.message : "provider read failed"}`] : []);
      const businessCenters: { provider: LaunchProvider; business_id: string; name: string; account_ids: string[] }[] = [];
      if (producerId && available.some(c => c.provider === "tiktok" && c.business_id)) {
        const bc = await base.getLaunchBusinessCenter(s, producerId);
        const ids = [...new Set(available.filter(c => c.provider === "tiktok" && c.business_id).map(c => c.business_id!))];
        for (const id of ids) businessCenters.push({ provider: "tiktok", business_id: id, name: bc?.external_ref === id ? bc.name : id, account_ids: available.filter(c => c.provider === "tiktok" && c.business_id === id).map(c => c.id) });
      }
      const metaIds = [...new Set(available.filter(c => c.provider === "meta" && c.business_id).map(c => c.business_id!))];
      for (const id of metaIds) businessCenters.push({ provider: "meta", business_id: id, name: available.find(c => c.provider === "meta" && c.business_id === id)?.business_name || id, account_ids: available.filter(c => c.provider === "meta" && c.business_id === id).map(c => c.id) });
      return { producer_id: producerId, runs, connections: available, business_centers: businessCenters, account_warnings: accountWarnings,
        library: producerId ? await clipLibrary(s, { producer_id: producerId }) : [],
        default_destination_url: runs.find(r => r.draft.destination_url)?.draft.destination_url || "", can_edit: s.kind === "staff" || ["reviewer", "approver"].includes(s.producerRole || ""),
        can_launch: s.kind === "staff" ? s.staffRole === "admin" : s.producerRole === "approver", producers };
    },
    async listLaunchRuns(s) { return (await readRuns(s)).sort((a, b) => b.created_at.localeCompare(a.created_at)); },
    getLaunchRun: find,
    async saveLaunchDraft(s, input, opts = {}) {
      const existing = opts.id ? await find(s, opts.id) : null;
      const producerId = existing?.producer_id || (s.kind === "producer" ? s.producerId : opts.producerId);
      if (!producerId) throw invalid("Choose a company."); authorize(s, producerId, "edit");
      if (s.kind === "staff" && !(await base.listProducers(s)).some(p => p.id === producerId)) throw notFound("Company");
      if (existing && existing.status !== "draft") throw conflict("Submitted launches are frozen. Create a new round.");
      if (existing && opts.expectedRevision !== existing.revision) throw conflict("Draft changed. Reload before saving.");
      const draft = await resolved(s, input, producerId);
      const own = await connections(s, producerId, draft.provider);
      if (draft.account_ids.some(id => !own.some(c => c.id === id && c.enabled && c.provider === draft.provider))) throw invalid("Choose assigned accounts from this company.");
      const run: LaunchRun = existing ? { ...existing, draft } : { id: randomUUID(), external_id: `lr_${randomUUID().replace(/-/g, "").slice(0, 12)}`, producer_id: producerId,
        draft, round: 1, parent_run_id: null, status: "draft", revision: 0, snapshot_hash: null, approved_by: null, approved_at: null, approval_note: null,
        created_by: s.userId, created_at: now(), updated_at: now(), mode: launchEnvironment(draft.provider), error: null, campaigns: [], lease_owner: null, lease_until: null };
      run.connections = own.filter(a => draft.account_ids.includes(a.id));
      audit(run, s, existing ? "draft_updated" : "draft_created"); return save(run, existing?.revision ?? null);
    },
    async previewLaunchRun(s, id) {
      const r = await find(s, id); const own = await connections(s, r.producer_id, r.draft.provider);
      return buildLaunchPlan(r.draft, own, r.external_id, await takenCampaignNames(r.draft, own));
    },
    async submitLaunchRun(s, id, revision, note) {
      const r = await find(s, id); authorize(s, r.producer_id, "launch");
      if (r.status !== "draft") return r; // one immutable run ID, concurrent submissions never create another run
      if (r.revision !== revision) throw conflict("The preview is stale. Preview the current draft.");
      if (r.mode !== launchEnvironment(r.draft.provider)) throw conflict("Launch environment changed. Create a new draft in the intended environment.");
      if (s.kind === "staff" && !note?.trim()) throw invalid("Explain the on-behalf authorization.");
      const currentDraft = await resolved(s, r.draft, r.producer_id);
      if (launchHash(currentDraft, []) !== launchHash(r.draft, [])) throw conflict("A selected clip changed. Save and preview the draft again.");
      const own = await connections(s, r.producer_id, r.draft.provider), plan = buildLaunchPlan(r.draft, own, r.external_id, await takenCampaignNames(r.draft, own));
      if (r.connections && connectionSignature(r.connections) !== connectionSignature(own.filter(a => r.draft.account_ids.includes(a.id)))) throw conflict("Account assignment changed. Save and preview the draft again.");
      r.connections = own.filter(a => r.draft.account_ids.includes(a.id));
      r.snapshot_hash = launchHash(r.draft, r.connections, plan.rows); r.approved_by = s.userId; r.approved_at = now(); r.approval_note = note?.trim() || null;
      r.campaigns = plan.rows.map(p => ({ ...p, id: randomUUID(), run_id: r.id, status: "pending", state: {}, error: null, snapshot: null }));
      r.status = "pending"; audit(r, s, "launch_approved", note, { total_budget_cents: plan.total_budget_cents, hash: r.snapshot_hash });
      try { return await save(r, revision); } catch (e) {
        const current = await find(s, id); if (current.status !== "draft") return current; throw e;
      }
    },
    async newLaunchRound(s, id) {
      const original = await find(s, id); authorize(s, original.producer_id, "edit");
      const nextDraft = copy(original.draft);
      // A round is fresh provider objects, so it needs fresh campids: the parent
      // already holds rlapple01…, and the driver refuses a campaign name that
      // exists on the account. Count on from where the parent actually stopped —
      // its own campaigns once it is approved, its planned count before that —
      // or round 2 would preview and approve cleanly and only fail at launch.
      const used = original.campaigns.length || original.draft.account_ids.length * original.draft.campaigns_per_account;
      nextDraft.campid_start = nextCampidStart(nextDraft.campid_start, Math.max(1, used));
      const duration = Math.max(86400000, Date.parse(nextDraft.meta_settings.end_time) - Date.parse(nextDraft.meta_settings.start_time));
      nextDraft.meta_settings.start_time = new Date(Date.now() + 3600000).toISOString();
      nextDraft.meta_settings.end_time = new Date(Date.now() + 3600000 + duration).toISOString();
      const created = await api.saveLaunchDraft(s, nextDraft, { producerId: original.producer_id });
      created.parent_run_id = original.id; created.round = original.round + 1;
      created.draft.name = original.draft.name.replace(/-r\d+$/, "") + `-r${created.round}`;
      audit(created, s, "new_round", undefined, { parent_run_id: original.id }); return save(created, created.revision);
    },
    async retryLaunchRun(s, id) {
      const r = await find(s, id); authorize(s, r.producer_id, "launch");
      if (r.status !== "failed") return r;
      if (r.lease_owner && Date.parse(r.lease_until || "") > Date.now()) throw conflict("Launch is still being updated.");
      for (const c of r.campaigns) if (c.status === "failed" && c.state.desired_status !== "ended") {
        c.status = "pending"; c.error = null; delete c.state.provider_retries;
        if (c.state.desired_status === "paused") c.state.prepare_while_paused = true;
      }
      if (!r.campaigns.some(c => c.status === "pending")) throw conflict("No failed campaigns are eligible for retry. Create a new round for stopped campaigns.");
      r.status = "pending"; r.error = null; r.lease_owner = null; r.lease_until = null; audit(r, s, "retry"); return save(r, r.revision);
    },
    renameLaunchRun,
    async recordClipSpark(s, creativeId, code, postUrl = "") {
      // Manual Spark entry is the primary launch flow. Retained only as a fixture library convenience.
      if (dataSource() !== "fixture") throw invalid("Paste Spark codes directly in Launch.");
      const workspace = await api.getLaunchWorkspace(s); authorize(s, workspace.producer_id, "edit");
      if (!workspace.library.some(c => c.id === creativeId)) throw notFound("Clip");
      store().sparks[creativeId] = { code: code.trim(), url: postUrl }; persist();
    },
    async assignLaunchConnection(s, input) {
      if (s.kind !== "staff" || s.staffRole !== "admin") throw forbidden("Staff administrator only.");
      if (!(await base.listProducers(s)).some(p => p.id === input.producer_id)) throw notFound("Company");
      const all = await readConnections(s, input.producer_id);
      const old = all.find(c => c.provider === input.provider && c.advertiser_id === input.advertiser_id);
      const connection = { ...input, id: old?.id || randomUUID(), assigned_by: s.userId, verified_at: now() };
      if (dataSource() === "fixture") { const list = store().connections; const i = list.findIndex(c => c.id === connection.id); if (i < 0) list.push(connection); else list[i] = connection; persist(); }
      else { const { error } = await createServiceSupabase().schema("promote").from("launch_connections").upsert({ id: connection.id, producer_id: connection.producer_id, provider: connection.provider, advertiser_id: connection.advertiser_id, payload: connection }); if (error) throw invalid(`Assignment failed (${error.code}).`); }
      return copy(connection);
    },
    async claimLaunchRun(s, id, owner) {
      worker(s); const r = await find(s, id);
      if (r.lease_owner && r.lease_owner !== owner && Date.parse(r.lease_until || "") > Date.now()) return null;
      r.lease_owner = owner; r.lease_until = new Date(Date.now() + 10 * 60000).toISOString();
      try { return await save(r, r.revision); } catch { return null; }
    },
    async updateLaunchRun(s, r, owner) {
      worker(s); const current = await find(s, r.id);
      if (current.lease_owner !== owner || Date.parse(current.lease_until || "") <= Date.now()) throw conflict("Launch worker lease lost.");
      if (current.revision !== r.revision) throw conflict("Launch state changed during execution.");
      if (r.lease_owner !== null) r.lease_until = new Date(Date.now() + 10 * 60000).toISOString();
      return save(r, r.revision);
    },
    async listPendingLaunchRuns(s) { worker(s); return (await readRuns(s)).filter(r => r.status !== "draft"); },
    async requestLaunchStop(s, id, campaignId, end) {
      const r = await find(s, id); authorize(s, r.producer_id, "launch");
      const c = r.campaigns.find(c => c.id === campaignId); if (!c) throw notFound("Campaign");
      if (c.state.desired_status === "ended" && !end) throw conflict("This campaign is ended. Create a new round.");
      c.state.desired_status = end ? "ended" : "paused";
      c.state.stop_request_id = randomUUID();
      audit(r, s, end ? "end_requested" : "pause_requested", undefined, { campaign_id: campaignId });
      return save(r, r.revision);
    },

    listClipLibrary: (s, filter) => clipLibrary(s, filter),
    async createClipPost(s, input) {
      // Scoped read first: a foreign clip is not found before any role is discussed.
      const clip = (await clipLibrary(s, {}, false)).find(row => row.id === input.clip_id);
      if (!clip) throw notFound("Clip");
      assertMayPublishClip(s, clip.producer_id);
      if (input.sha256 !== clip.sha256) throw invalid("This clip changed after it was rendered. Render it again before posting.");
      const connection = (await connections(s, clip.producer_id, "meta")).find(c => c.id === input.connection_id);
      if (!connection) throw notFound("Meta account");
      if (!connection.enabled || connection.provider !== "meta") throw invalid("Choose an enabled Meta account for this company.");
      if (!connection.page_id) throw invalid("Assign a Facebook Page to this account before posting.");
      if (input.platform === "instagram" && !connection.instagram_id) throw invalid("Assign an Instagram account to this Page before posting a Reel.");
      const caption = input.caption.trim();
      if (!caption) throw invalid("Write a caption.");
      // A clip's internal reference is not a caption anybody wants published.
      if (caption === clip.external_id) throw invalid("Write a caption: a clip reference is not one.");
      if (caption.length > 2200) throw invalid("A caption may be at most 2,200 characters.");
      const siblings = (await readClipPosts(s)).filter(p => p.clip_id === clip.id && p.platform === input.platform && p.connection_id === input.connection_id);
      if (siblings.some(p => p.status === "publishing")) throw conflict("This clip is already being published to that account.");
      if (!input.again && siblings.some(p => p.status === "published" && !p.superseded_by)) throw conflict(DUPLICATE_POST);
      const post: ClipPost = {
        id: randomUUID(), producer_id: clip.producer_id, clip_id: clip.id, connection_id: connection.id,
        platform: input.platform, status: "publishing", step: CLIP_POST_FIRST_STEP[input.platform],
        external_video_id: null, external_post_id: null, permalink: null, caption, sha256: clip.sha256,
        error: null, attempted_at: null, superseded_by: null, lease_owner: null, leased_until: null,
        created_by: s.userId, created_at: now(), updated_at: now(), published_at: null, revision: 1,
      };
      await auditClipPost(s, post, "clip_post_created");
      return writeClipPost(post, null);
    },
    async getClipPost(s, id) {
      const post = (await readClipPosts(s)).find(p => p.id === id);
      if (!post) throw notFound("Clip post");
      return post;
    },
    async listClipPosts(s, filter = {}) {
      return (await readClipPosts(s))
        .filter(p => (!filter.producer_id || p.producer_id === filter.producer_id) && (!filter.clip_id || p.clip_id === filter.clip_id))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    async updateClipPost(s, id, expectedRevision, patch: ClipPostPatch, opts = {}) {
      worker(s);
      const current = (await readClipPosts(s)).find(p => p.id === id);
      if (!current) throw notFound("Clip post");
      if (current.revision !== expectedRevision) throw conflict("This post changed. Reload and try again.");
      if (current.status === "published" && patch.status && patch.status !== "published") throw conflict("A published post cannot be reopened. Use Post again instead.");
      const next: ClipPost = { ...current, ...patch };
      const action = opts.action ?? (next.status === current.status ? null
        : next.status === "published" ? "clip_post_published" : next.status === "failed" ? "clip_post_failed" : null);
      if (action) await auditClipPost(opts.actor ?? s, next, action, next.error ?? undefined);
      return writeClipPost(next, expectedRevision);
    },
  };
  return api;
}
