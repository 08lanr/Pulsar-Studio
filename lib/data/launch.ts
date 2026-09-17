// Launch jobs use one atomic document per run: allocation, approval and every
// campaign checkpoint commit together. Browser sessions have read-only RLS;
// all writes pass these role-checked job services and server-only service role.
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FIXTURE_PRODUCER_ID, isSystemSession, type Session } from "@/lib/auth";
import { dataSource } from "@/lib/data-source";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase/server";
import { buildLaunchPlan, draftSchema } from "@/lib/launch/plan";
import { launchEnvironment } from "@/lib/launch/environment";
import { eligibleMetaAssignment, eligibleTikTokBcAccount } from "@/lib/launch/account-authority";
import type { LaunchConnection, LaunchDataLayer, LaunchDraft, LaunchLibraryItem, LaunchRun, LaunchProvider, LaunchPlanRow } from "@/lib/launch/types";
import type { DataLayer } from "./index";
import { conflict, forbidden, invalid, notFound } from "./errors";
import { mediaUrl } from "./storage";

type Store = { runs: LaunchRun[]; connections: LaunchConnection[]; sparks: Record<string, { code: string; url: string }>; defaults: Record<string, string> };
const globalStore = globalThis as unknown as { __studioLaunchV2?: Store };
const file = () => path.join(process.cwd(), ".uploads", "launch-state.json");
const persistOn = () => process.env.FIXTURE_PERSIST !== "off" && process.env.NODE_ENV !== "test";
const now = () => new Date().toISOString();
const copy = <T>(value: T): T => structuredClone(value);
function store(): Store {
  if (!globalStore.__studioLaunchV2) {
    let saved: Store | undefined;
    if (persistOn() && existsSync(file())) { try { saved = JSON.parse(readFileSync(file(), "utf8")); } catch { /* recover a corrupt fixture file without live calls */ } }
    globalStore.__studioLaunchV2 = saved?.runs && saved.connections ? saved : { runs: [], connections: [], sparks: {}, defaults: {} };
  }
  return globalStore.__studioLaunchV2;
}
function persist() {
  if (!persistOn()) return;
  mkdirSync(path.dirname(file()), { recursive: true });
  const temp = `${file()}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(store())); renameSync(temp, file());
}
export function resetLaunchFixture() { globalStore.__studioLaunchV2 = { runs: [], connections: [], sparks: {}, defaults: {} }; persist(); }
/** Demo replay removes only one company's launch records and clip Spark notes. */
export function resetLaunchFixtureForProducer(producerId: string, clipIds: readonly string[] = []): LaunchRun[] {
  const s = store();
  const removed = s.runs.filter(r => r.producer_id === producerId);
  s.runs = s.runs.filter(r => r.producer_id !== producerId);
  s.connections = s.connections.filter(c => c.producer_id !== producerId);
  delete s.defaults[producerId];
  for (const clipId of clipIds) delete s.sparks[clipId];
  persist();
  return copy(removed);
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
  async function library(s: Session, producerId: string): Promise<LaunchLibraryItem[]> {
    const titles = (await base.listTitles(s)).filter(t => t.producer_id === producerId);
    const out: LaunchLibraryItem[] = [];
    for (const title of titles) {
      const clips = await base.listEpisodeClips(s, title.id);
      for (const clip of clips.filter(c => c.render_status === "rendered" && c.render_path && c.render_sha256 && c.status !== "dismissed")) {
        const saved = dataSource() === "fixture" ? store().sparks[clip.id] : undefined;
        out.push({ id: clip.id, kind: "video", value: clip.id, creative_id: clip.id, title_id: title.id, title_name: title.name_en || title.name_zh, label: clip.hook_en || clip.external_id,
          file_path: clip.render_path!, sha256: clip.render_sha256!, text: clip.hook_en, headline: title.name_en || title.name_zh,
          media_url: mediaUrl(clip.render_path), spark_code: saved?.code ?? null, post_url: saved?.url ?? null });
      }
    }
    return out;
  }
  async function find(s: Session, id: string) {
    const run = (await readRuns(s)).find(r => r.id === id || r.external_id === id);
    if (!run) throw notFound("Launch"); authorize(s, run.producer_id); return run;
  }
  async function resolved(s: Session, draft: LaunchDraft, producerId: string): Promise<LaunchDraft> {
    const parsed = draftSchema.safeParse(draft);
    if (!parsed.success) throw invalid(parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
    const safe = parsed.data;
    const own = safe.content.some(c => c.kind === "video") ? await library(s, producerId) : [];
    return { ...safe, content: safe.content.map(c => {
      if (c.kind !== "video") return c;
      const asset = own.find(a => a.id === c.value);
      if (!asset) throw notFound("Finished clip");
      return { ...c, creative_id: asset.id, title_id: asset.title_id, file_path: asset.file_path, sha256: asset.sha256,
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
      return { producer_id: producerId, runs, connections: available, business_centers: businessCenters, account_warnings: accountWarnings, library: producerId ? await library(s, producerId) : [],
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
      const r = await find(s, id); return buildLaunchPlan(r.draft, await connections(s, r.producer_id, r.draft.provider), r.external_id);
    },
    async submitLaunchRun(s, id, revision, note) {
      const r = await find(s, id); authorize(s, r.producer_id, "launch");
      if (r.status !== "draft") return r; // one immutable run ID, concurrent submissions never create another run
      if (r.revision !== revision) throw conflict("The preview is stale. Preview the current draft.");
      if (r.mode !== launchEnvironment(r.draft.provider)) throw conflict("Launch environment changed. Create a new draft in the intended environment.");
      if (s.kind === "staff" && !note?.trim()) throw invalid("Explain the on-behalf authorization.");
      const currentDraft = await resolved(s, r.draft, r.producer_id);
      if (launchHash(currentDraft, []) !== launchHash(r.draft, [])) throw conflict("A selected clip changed. Save and preview the draft again.");
      const own = await connections(s, r.producer_id, r.draft.provider), plan = buildLaunchPlan(r.draft, own, r.external_id);
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
        c.status = "pending"; c.error = null;
        if (c.state.desired_status === "paused") c.state.prepare_while_paused = true;
      }
      if (!r.campaigns.some(c => c.status === "pending")) throw conflict("No failed campaigns are eligible for retry. Create a new round for stopped campaigns.");
      r.status = "pending"; r.error = null; r.lease_owner = null; r.lease_until = null; audit(r, s, "retry"); return save(r, r.revision);
    },
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
  };
  return api;
}
