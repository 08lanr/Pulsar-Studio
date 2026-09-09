// "Can this ad account actually run ads?" — ported from Pulsar Grow
// (lib/tiktok-preflight.ts), trimmed to what Studio asks: the state of the
// operator connection, the accounts it reaches, one account's status and
// balance, and the TikTok handles (identities) linked to it. Read-only.
//
// Every TikTok ad is published under a TikTok handle — the identity. TikTok
// retired the synthetic kind in early 2026, so an uploaded video can only
// run under a real account linked to THAT ad account in Business Center.
// Studio records the chosen identity on the producer's launch account row
// (decision 2026-09-09) and refuses to launch without one.

import { accessTokenFor, launchMode, tiktokTransport } from "./index";
import { appConfigured, loadConnections, reachableAdvertiserIds } from "./tokens";

export type PreflightState = "READY" | "ACTION_REQUIRED" | "BLOCKED";

export type LinkedIdentity = { id: string; type: "BC_AUTH_TT" | "TT_USER"; name?: string };

export type AdvertiserProbe = {
  advertiserId: string;
  name?: string;
  status?: string;
  currency?: string;
  balance?: number;
  state: PreflightState;
  reasons: string[];
  identities: LinkedIdentity[];
};

export type ConnectionStatus = {
  mode: "fake" | "sandbox" | "production";
  appConfigured: boolean;
  connected: boolean;
  /** Described, never the tokens. */
  connections: Array<{ label?: string; advertiserIds: string[]; scopes: number; savedAt: string; tokenTail: string }>;
  reachableAccounts: number;
  state: PreflightState;
  reasons: string[];
};

const IDENTITY_TYPES: LinkedIdentity["type"][] = ["BC_AUTH_TT", "TT_USER"];

export async function fetchIdentities(advertiserId: string): Promise<LinkedIdentity[]> {
  const token = accessTokenFor(advertiserId);
  if (!token) return [];
  const tt = tiktokTransport();
  const out: LinkedIdentity[] = [];
  for (const type of IDENTITY_TYPES) {
    const res = await tt.get("/identity/get/", token, { advertiser_id: advertiserId, identity_type: type });
    if (res.code !== 0) continue; // degraded lookup — absence is reported, not fatal
    const rows = (res.data?.identity_list ?? []) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const id = row.identity_id ? String(row.identity_id) : "";
      if (!id) continue;
      out.push({ id, type, name: typeof row.display_name === "string" ? row.display_name : undefined });
    }
  }
  return out;
}

// STATUS_ENABLE is the only status TikTok delivers ads under.
function stateForStatus(status: string | undefined): { state: PreflightState; reason?: string } {
  if (!status) return { state: "READY" };
  if (status === "STATUS_ENABLE") return { state: "READY" };
  if (status.includes("PENDING") || status.includes("CONFIRM")) return { state: "ACTION_REQUIRED", reason: `Account is ${status} — verification pending on TikTok's side` };
  return { state: "BLOCKED", reason: `Account status is ${status}` };
}

/** One ad account: status, balance and linked handles. */
export async function probeAdvertiser(advertiserId: string): Promise<AdvertiserProbe> {
  const token = accessTokenFor(advertiserId);
  const probe: AdvertiserProbe = { advertiserId, state: "READY", reasons: [], identities: [] };
  if (!token) {
    probe.state = "ACTION_REQUIRED";
    probe.reasons.push("No TikTok authorization covers this ad account");
    return probe;
  }
  const tt = tiktokTransport();
  const res = await tt.get("/advertiser/info/", token, {
    advertiser_ids: JSON.stringify([advertiserId]),
    fields: JSON.stringify(["advertiser_id", "name", "status", "currency", "balance"]),
  });
  const row = ((res.data?.list ?? []) as Array<Record<string, unknown>>)[0];
  if (res.code !== 0 || !row) {
    probe.state = "ACTION_REQUIRED";
    probe.reasons.push(res.code !== 0 ? `Could not read account status from TikTok: ${res.message}` : "TikTok returned no info for this account");
  } else {
    probe.name = typeof row.name === "string" ? row.name : undefined;
    probe.status = typeof row.status === "string" ? row.status : undefined;
    probe.currency = typeof row.currency === "string" ? row.currency : undefined;
    probe.balance = typeof row.balance === "number" ? row.balance : typeof row.balance === "string" ? Number(row.balance) : undefined;
    const s = stateForStatus(probe.status);
    probe.state = s.state;
    if (s.reason) probe.reasons.push(s.reason);
    if (probe.state === "READY" && probe.balance !== undefined && probe.balance <= 0 && launchMode() === "production") {
      probe.state = "ACTION_REQUIRED";
      probe.reasons.push("No balance — configure billing or top up before launching");
    }
  }
  probe.identities = await fetchIdentities(advertiserId);
  if (!probe.identities.length && probe.state === "READY") {
    probe.state = "ACTION_REQUIRED";
    probe.reasons.push("No TikTok handle is linked to this ad account — every ad is published by a TikTok account. Link one in Business Center → this ad account → Identities.");
  }
  return probe;
}

/** The operator connection, described. */
export function connectionStatus(): ConnectionStatus {
  const mode = launchMode();
  const connections = loadConnections();
  const out: ConnectionStatus = {
    mode,
    appConfigured: appConfigured(),
    connected: mode === "fake" || connections.length > 0,
    connections: connections.map((c) => ({ label: c.label, advertiserIds: (c.advertiser_ids ?? []).map(String), scopes: c.scope?.length ?? 0, savedAt: c.savedAt, tokenTail: c.access_token.slice(-4) })),
    reachableAccounts: mode === "fake" ? 1 : reachableAdvertiserIds().size,
    state: "READY",
    reasons: [],
  };
  if (mode === "fake") {
    out.reasons.push("Fixture mode: launches go to the fake TikTok inside this process and spend nothing.");
    return out;
  }
  if (!out.appConfigured && mode === "production") {
    out.state = "ACTION_REQUIRED";
    out.reasons.push("TIKTOK_APP_ID / TIKTOK_APP_SECRET are not set — the developer app's credentials go in .env.local.");
  }
  if (!out.connected) {
    out.state = "ACTION_REQUIRED";
    out.reasons.push(mode === "production" ? "No TikTok authorization — run Connect TikTok." : "No sandbox token — set TIKTOK_ACCESS_TOKEN and TIKTOK_ADVERTISER_ID in .env.local.");
  }
  return out;
}

/** Names for a set of ad accounts, chunked; degraded lookups leave the name empty. */
export async function describeAdvertisers(ids: string[]): Promise<Array<{ advertiserId: string; name?: string; status?: string; currency?: string; balance?: number }>> {
  const out: Array<{ advertiserId: string; name?: string; status?: string; currency?: string; balance?: number }> = [];
  const tt = tiktokTransport();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const token = accessTokenFor(chunk[0]);
    if (!token) {
      out.push(...chunk.map((advertiserId) => ({ advertiserId })));
      continue;
    }
    const res = await tt.get("/advertiser/info/", token, { advertiser_ids: JSON.stringify(chunk), fields: JSON.stringify(["advertiser_id", "name", "status", "currency", "balance"]) });
    const byId = new Map<string, Record<string, unknown>>();
    if (res.code === 0) for (const row of (res.data?.list ?? []) as Array<Record<string, unknown>>) byId.set(String(row.advertiser_id), row);
    for (const advertiserId of chunk) {
      const row = byId.get(advertiserId);
      out.push({
        advertiserId,
        name: typeof row?.name === "string" ? row.name : undefined,
        status: typeof row?.status === "string" ? row.status : undefined,
        currency: typeof row?.currency === "string" ? row.currency : undefined,
        balance: typeof row?.balance === "number" ? row.balance : typeof row?.balance === "string" ? Number(row.balance) : undefined,
      });
    }
  }
  return out;
}
