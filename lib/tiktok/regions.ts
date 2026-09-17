// TikTok's location catalogue, so nobody has to know that the United States
// is 6252001 — overlord's lib/tiktok-regions.ts, on Studio's transport
// (decision 2026-09-16). /tool/region/ returns ~13,500 entries and REQUIRES
// an advertiser_id, objective and placements; the list barely changes, so
// it is fetched once through the first ad account a connection reaches and
// cached on disk (.regions-cache.json, gitignored). The browser only ever
// receives a search result or the names for a handful of ids.
//
// Fake mode answers from the fake's own short list.

import fs from "node:fs";
import path from "node:path";
import { FAKE_REGIONS } from "./fake";
import { accessTokenFor, launchMode, tiktokTransport } from "./index";
import { reachableAdvertiserIds } from "./tokens";

export type Region = { id: string; name: string; level: string; regionCode: string };

const CACHE_FILE = path.join(process.cwd(), ".regions-cache.json");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A restricted account answers with a short catalogue; keep that only briefly and keep asking for the full one. */
const RESTRICTED_TTL_MS = 60 * 60 * 1000;
/** A fully enabled account may target this many countries (overlord, measured). */
export const FULL_COUNTRY_COUNT = 65;

type Cache = { fetchedAt: string; regions: Region[] };
const mem = globalThis as unknown as { __studioRegions?: Cache | null };

function fromFake(): Region[] {
  return FAKE_REGIONS.map((r) => ({ id: r.location_id, name: r.name, level: r.level, regionCode: r.region_code }));
}

function readCache(): Cache | null {
  if (mem.__studioRegions) return fresh(mem.__studioRegions) ? mem.__studioRegions : null;
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Cache;
    if (!Array.isArray(c.regions) || !c.regions.length) return null;
    mem.__studioRegions = c;
    return fresh(c) ? c : null;
  } catch {
    return null;
  }
}

function fresh(c: Cache): boolean {
  const full = c.regions.filter((r) => r.level === "COUNTRY").length >= FULL_COUNTRY_COUNT;
  return Date.now() - new Date(c.fetchedAt).getTime() < (full ? CACHE_TTL_MS : RESTRICTED_TTL_MS);
}

/** Pull one account's catalogue. */
export async function fetchRegionsFor(advertiserId: string): Promise<{ regions: Region[]; error?: string }> {
  const token = accessTokenFor(advertiserId);
  if (!token) return { regions: [], error: "No TikTok authorization covers this ad account" };
  const res = await tiktokTransport().get("/tool/region/", token, { advertiser_id: advertiserId, objective_type: "TRAFFIC", placements: JSON.stringify(["PLACEMENT_TIKTOK"]) });
  if (res.code !== 0) return { regions: [], error: res.message || "TikTok returned an error listing regions" };
  const raw = ((res.data?.region_info ?? res.data?.list ?? []) as Array<Record<string, unknown>>);
  return { regions: raw.filter((r) => r.location_id && r.name).map((r) => ({ id: String(r.location_id), name: String(r.name), level: String(r.level ?? ""), regionCode: String(r.region_code ?? "") })) };
}

/** The catalogue, cached; the fullest answer among a few reachable accounts. */
export async function loadRegions(): Promise<{ regions: Region[]; error?: string }> {
  if (launchMode() === "fake") return { regions: fromFake() };
  const cached = readCache();
  if (cached) return { regions: cached.regions };
  let best: Region[] = [];
  let error: string | undefined;
  const candidates = [...reachableAdvertiserIds()].slice(0, 3);
  for (const id of candidates) {
    const got = await fetchRegionsFor(id);
    if (got.error) error = got.error;
    if (got.regions.length > best.length) best = got.regions;
    if (best.filter((r) => r.level === "COUNTRY").length >= FULL_COUNTRY_COUNT) break;
  }
  if (!best.length) return { regions: [], error: error ?? "No ad account is reachable to read the region catalogue" };
  const c: Cache = { fetchedAt: new Date().toISOString(), regions: best };
  mem.__studioRegions = c;
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
  } catch {
    /* a cache that cannot be written is re-fetched later */
  }
  return { regions: best };
}

/** Search by name (countries first, then provinces, then cities), at most `limit` hits. */
export async function searchRegions(q: string, limit = 20): Promise<{ hits: Region[]; error?: string }> {
  const { regions, error } = await loadRegions();
  const needle = q.trim().toLowerCase();
  const rank = (r: Region) => (r.level === "COUNTRY" ? 0 : r.level === "PROVINCE" ? 1 : 2);
  const hits = (needle ? regions.filter((r) => r.name.toLowerCase().includes(needle) || r.id === needle) : regions.filter((r) => r.level === "COUNTRY"))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .slice(0, limit);
  return { hits, error };
}

/** Names for ids the UI already holds; unknown ids map to themselves. */
export async function regionNames(ids: string[]): Promise<Record<string, string>> {
  const { regions } = await loadRegions();
  const byId = new Map(regions.map((r) => [r.id, r.name]));
  return Object.fromEntries(ids.map((id) => [id, byId.get(id) ?? (id === "6252001" ? "United States" : id)]));
}

/** How many countries one account may target — the geo fingerprint. */
export async function countryCountFor(advertiserId: string): Promise<number> {
  const got = await fetchRegionsFor(advertiserId);
  return got.regions.filter((r) => r.level === "COUNTRY").length;
}
