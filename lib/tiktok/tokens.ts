// Where TikTok authorizations live — the way Pulsar Grow keeps them
// (decision 2026-09-09): operator-level, one file on the server,
// `.tokens.json` at the repo root (gitignored), written by the admin OAuth
// callback and read by the transport. Sandbox mode takes a token pasted into
// .env.local instead (sandbox has no consent screen).
//
// Deliberately the ONLY module that knows where tokens live; moving them to
// an encrypted database row later means editing this file and nothing else.
// Tokens never enter the data layer, a fixture seed, a producer session or a
// JSON response — routes describe a connection (advertiser ids, saved time,
// the token's last four characters), never the token.

import fs from "node:fs";
import path from "node:path";
import { tiktokMode } from "./transport";

const TOKEN_FILE = path.join(process.cwd(), ".tokens.json");

export type StoredToken = {
  access_token: string;
  advertiser_ids?: string[];
  scope?: number[];
  savedAt: string;
};

export type StoredConnection = StoredToken & { label?: string };

type TokenFile = StoredToken & { connections?: StoredConnection[] };

function readTokenFile(): TokenFile | null {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")) as TokenFile;
  } catch {
    return null;
  }
}

// Cached because tokenFor() consults it on EVERY api call. On globalThis, not
// module-level: Next bundles this module separately into every route.
const connStore = globalThis as unknown as { __studioTtConnCache?: { at: number; list: StoredConnection[] } | null };
const CONN_CACHE_TTL_MS = 30_000;

/** Every authorization we hold, newest first. */
export function loadConnections(): StoredConnection[] {
  if (tiktokMode() !== "production") {
    const t = loadToken();
    return t ? [t] : [];
  }
  const hit = connStore.__studioTtConnCache;
  if (hit && Date.now() - hit.at < CONN_CACHE_TTL_MS) return hit.list;
  const file = readTokenFile();
  let out: StoredConnection[] = [];
  if (file) {
    if (Array.isArray(file.connections) && file.connections.length) out = file.connections.filter((c) => c?.access_token);
    else if (file.access_token) out = [file];
  }
  connStore.__studioTtConnCache = { at: Date.now(), list: out };
  return out;
}

/**
 * Add an authorization without discarding the others. A repeat authorization
 * of the same assets replaces its predecessor rather than stacking
 * duplicates — matched by the advertiser id set (overlord lesson:
 * re-authorizing used to silently drop the prior Business Center's accounts).
 */
export function saveToken(data: StoredToken) {
  const existing = loadConnections();
  const key = (c: StoredToken) => JSON.stringify([...(c.advertiser_ids ?? [])].sort());
  const incoming = key(data);
  const kept = existing.filter((c) => key(c) !== incoming);
  const connections: StoredConnection[] = [{ ...data }, ...kept];
  const file: TokenFile = { ...data, connections };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(file, null, 2));
  connStore.__studioTtConnCache = null;
}

export function loadToken(): StoredToken | null {
  if (tiktokMode() === "production") {
    try {
      const parsed = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      return parsed?.access_token ? parsed : null;
    } catch {
      return null;
    }
  }
  // Sandbox: token pasted straight into .env.local — skip the OAuth flow.
  if (process.env.TIKTOK_ACCESS_TOKEN) {
    return {
      access_token: process.env.TIKTOK_ACCESS_TOKEN,
      advertiser_ids: process.env.TIKTOK_ADVERTISER_ID ? [process.env.TIKTOK_ADVERTISER_ID] : [],
      savedAt: "env",
    };
  }
  return null;
}

/** Every advertiser id some stored authorization can reach. */
export function reachableAdvertiserIds(): Set<string> {
  return new Set(loadConnections().flatMap((c) => (c.advertiser_ids ?? []).map(String)));
}

/** The token that owns an advertiser, or the newest token (the transport re-routes per call anyway). */
export function tokenForAdvertiser(advertiserId: string): StoredToken | null {
  const connections = loadConnections();
  return connections.find((c) => (c.advertiser_ids ?? []).map(String).includes(advertiserId)) ?? connections[0] ?? null;
}

/** App credentials present — the OAuth flow can run at all. */
export function appConfigured(): boolean {
  return Boolean(process.env.TIKTOK_APP_ID && process.env.TIKTOK_APP_SECRET);
}
