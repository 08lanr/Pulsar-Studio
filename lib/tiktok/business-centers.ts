// Business Centers and the accounts inside them — Pulsar Grow's model
// (lib/bc-map.ts, the bc-accounts route), ported to Studio (decision
// 2026-09-09, "assign a BC, not an ad account").
//
// A Business Center is NOT an ad account: an authorization grants one or
// more BCs, each BC holds many ad accounts, and a vendor's ads run from an
// account inside the BC assigned to them. Two reads, both cached on
// globalThis (30 min; Next bundles lib/ per route):
//   listBusinessCenters   one /bc/get/ per authorization, names only (cheap)
//   listBcAccounts        one BC's accounts (/bc/asset/get/, pages of 50) with
//                         their status (/advertiser/info/, 100 per call)
// and the pick the launch uses:
//   pickLaunchAccount     the vendor's explicit account when staff set one,
//                         otherwise the first READY account with a linked
//                         handle inside the vendor's Business Center.

import { getData } from "@/lib/data";
import type { Session } from "@/lib/auth";
import type { CompanyAccount } from "@/lib/types";
import { accountHealth } from "./account-health";
import { accessTokenFor, launchMode, tiktokTransport } from "./index";
import { fetchIdentities, type LinkedIdentity } from "./preflight";
import { loadConnections } from "./tokens";

const CACHE_TTL_MS = 30 * 60_000;

export type BcSummary = { bcId: string; bcName: string; company?: string; verified?: boolean };
export type BcAccount = { id: string; name?: string; status?: string; bcId: string };

const store = globalThis as unknown as {
  __studioBcList?: { at: number; list: BcSummary[]; errors: string[] };
  __studioBcAccounts?: Map<string, { at: number; accounts: BcAccount[]; token: string; error?: string }>;
};

export function invalidateBusinessCenters(): void {
  delete store.__studioBcList;
  delete store.__studioBcAccounts;
}

/** The Business Centers every authorization can reach. Fake mode: one demo BC. */
export async function listBusinessCenters(opts: { force?: boolean } = {}): Promise<{ businessCenters: BcSummary[]; errors: string[] }> {
  const hit = store.__studioBcList;
  if (!opts.force && hit && Date.now() - hit.at < CACHE_TTL_MS) return { businessCenters: hit.list, errors: hit.errors };
  const tt = tiktokTransport();
  const tokens = launchMode() === "fake" ? ["fake-token"] : loadConnections().map((c) => c.access_token);
  const errors: string[] = [];
  const byId = new Map<string, BcSummary>();
  // EVERY authorization is asked: /bc/get/ carries no advertiser_id, so a
  // token only sees the Business Centers its own consent screen granted.
  for (const token of tokens) {
    for (let page = 1; page <= 10; page++) {
      const res = await tt.get("/bc/get/", token, { page, page_size: 50 });
      if (res.code !== 0) {
        errors.push(res.message || "could not list Business Centers");
        break;
      }
      const list = (res.data?.list ?? []) as Array<{ bc_info?: Record<string, unknown> }>;
      for (const b of list) {
        const info = b.bc_info ?? {};
        const bcId = String(info.bc_id ?? "");
        if (!bcId || byId.has(bcId)) continue;
        byId.set(bcId, { bcId, bcName: String(info.name ?? info.bc_name ?? ""), ...(typeof info.company === "string" ? { company: info.company } : {}), verified: info.verification_status === "VERIFIED" });
      }
      const pi = res.data?.page_info as { total_page?: number } | undefined;
      if (page >= (pi?.total_page ?? 1) || list.length < 50) break;
    }
  }
  const out = [...byId.values()].sort((a, b) => (a.bcName || a.bcId).localeCompare(b.bcName || b.bcId));
  store.__studioBcList = { at: Date.now(), list: out, errors };
  return { businessCenters: out, errors };
}

/** The ad accounts inside ONE Business Center, with status. Cached per BC. */
export async function listBcAccounts(bcId: string, opts: { force?: boolean } = {}): Promise<{ accounts: BcAccount[]; error?: string }> {
  if (!store.__studioBcAccounts) store.__studioBcAccounts = new Map();
  const hit = store.__studioBcAccounts.get(bcId);
  if (!opts.force && hit && Date.now() - hit.at < CACHE_TTL_MS) return { accounts: hit.accounts, error: hit.error };
  const tt = tiktokTransport();
  const tokens = launchMode() === "fake" ? ["fake-token"] : loadConnections().map((c) => c.access_token);
  if (!tokens.length) return { accounts: [], error: "No TikTok authorization" };
  // Which authorization can see this BC? A token is scoped to the assets its
  // consent screen granted — ask each until one answers.
  let token = tokens[0];
  for (const t of tokens) {
    const probe = await tt.get("/bc/asset/get/", t, { bc_id: bcId, asset_type: "ADVERTISER", page: 1, page_size: 1 });
    if (probe.code === 0) {
      token = t;
      break;
    }
  }
  const accounts: BcAccount[] = [];
  for (let page = 1; page <= 40; page++) {
    const res = await tt.get("/bc/asset/get/", token, { bc_id: bcId, asset_type: "ADVERTISER", page, page_size: 50 });
    if (res.code !== 0) return { accounts: [], error: res.message || "could not list this Business Center's ad accounts" };
    const list = (res.data?.list ?? []) as Array<{ asset_id?: unknown; asset_name?: unknown }>;
    for (const a of list) {
      if (!a.asset_id) continue;
      accounts.push({ id: String(a.asset_id), name: a.asset_name ? String(a.asset_name) : undefined, bcId });
    }
    const pi = res.data?.page_info as { total_page?: number } | undefined;
    if (page >= (pi?.total_page ?? 1) || list.length < 50) break;
  }
  // Status per account, 100 ids per call. A failed lookup degrades to
  // accounts without status — reported, never silent.
  let error: string | undefined;
  for (let i = 0; i < accounts.length; i += 100) {
    const ids = accounts.slice(i, i + 100).map((a) => a.id);
    const info = await tt.get("/advertiser/info/", token, { advertiser_ids: JSON.stringify(ids), fields: JSON.stringify(["advertiser_id", "name", "status"]) });
    if (info.code !== 0) {
      error = info.message || "could not look up account statuses";
      break;
    }
    const byId = new Map<string, { status?: string; name?: string }>();
    for (const row of (info.data?.list ?? []) as Array<Record<string, unknown>>) {
      if (row.advertiser_id) byId.set(String(row.advertiser_id), { status: typeof row.status === "string" ? row.status : undefined, name: typeof row.name === "string" ? row.name : undefined });
    }
    for (const a of accounts) {
      const r = byId.get(a.id);
      if (r?.status) a.status = r.status;
      if (!a.name && r?.name) a.name = r.name;
    }
  }
  accounts.sort((a, b) => a.id.localeCompare(b.id));
  store.__studioBcAccounts.set(bcId, { at: Date.now(), accounts, token, error });
  return { accounts, error };
}

export type LaunchPick = {
  advertiser_id: string;
  name: string | null;
  identity_id: string;
  identity_type: LinkedIdentity["type"];
  /** Where the account came from: the vendor's explicit account or a pick inside their BC. */
  source: "account" | "business_center";
  bc_id: string | null;
};

export type LaunchPickResult = { ok: true; pick: LaunchPick } | { ok: false; reason: string; blocker: "no_launch_account" | "no_identity" | "no_ready_account" };

/**
 * The account a vendor's launch goes into. An explicit staff-assigned
 * account wins (it is the override); otherwise the assigned Business Center
 * is walked: READY accounts, in id order, the first with a linked handle.
 * Never picks outside the vendor's assignment.
 */
export async function pickLaunchAccount(session: Session, producerId: string): Promise<LaunchPickResult> {
  const data = getData();
  const [account, bc] = await Promise.all([data.getLaunchAccount(session, producerId), data.getLaunchBusinessCenter(session, producerId)]);
  if (account?.external_ref) {
    let identity: { id: string; type: LinkedIdentity["type"] } | null = account.identity_id && account.identity_type ? { id: account.identity_id, type: account.identity_type } : null;
    if (!identity) {
      const found = await fetchIdentities(account.external_ref);
      identity = found[0] ?? null;
    }
    if (!identity) return { ok: false, blocker: "no_identity", reason: `Ad account ${account.external_ref} has no TikTok handle linked; link one in Business Center → this ad account → Identities.` };
    return { ok: true, pick: { advertiser_id: account.external_ref, name: account.name, identity_id: identity.id, identity_type: identity.type, source: "account", bc_id: bc?.external_ref ?? null } };
  }
  if (!bc?.external_ref) return { ok: false, blocker: "no_launch_account", reason: "No TikTok Business Center or ad account is assigned to this company yet." };
  const { accounts, error } = await listBcAccounts(bc.external_ref);
  const ready = accounts.filter((a) => accountHealth(a.status) === "ready");
  if (!ready.length) return { ok: false, blocker: "no_ready_account", reason: error ? `Could not read the Business Center's accounts: ${error}` : `Business Center ${bc.name} (${bc.external_ref}) has no ad account TikTok reports as ready (${accounts.length} account(s) listed).` };
  for (const a of ready) {
    if (!accessTokenFor(a.id)) continue;
    const identities = await fetchIdentities(a.id);
    const identity = identities.find((i) => i.type === "BC_AUTH_TT") ?? identities[0];
    if (identity) return { ok: true, pick: { advertiser_id: a.id, name: a.name ?? null, identity_id: identity.id, identity_type: identity.type, source: "business_center", bc_id: bc.external_ref } };
  }
  return { ok: false, blocker: "no_identity", reason: `Business Center ${bc.name} has ${ready.length} ready account(s) but none has a TikTok handle linked; link one in Business Center → ad account → Identities.` };
}

export type { CompanyAccount };
