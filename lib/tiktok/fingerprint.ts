// What has each ad account been used for? — overlord's account
// fingerprint (decision 2026-09-16). One paced, UNFILTERED /campaign/get/
// per account returns every campaign it holds, which answers the filters
// the staff account picker offers in one call:
//
//   campaigns   non-deleted campaigns of any kind; 0 = never launched on
//   active      campaigns switched ON right now (the account is spending, or
//               will the moment its ads approve)
//   traffic     TRAFFIC campaigns — the kind Studio launches
//   geo         how many countries the account may target (65 = fully
//               enabled; a young account typically answers 33 until it has
//               delivered — delivery history opens countries, not reviews)
//
// Results are cached per account for 30 minutes; a scan of a whole Business
// Center is a loop of these, so the route caps the batch.

import { accessTokenFor, tiktokTransport } from "./index";
import { countryCountFor, FULL_COUNTRY_COUNT } from "./regions";

export type AccountFingerprint = {
  accountId: string;
  campaigns: number;
  active: number;
  traffic: number;
  reach: number;
  sales: number;
  leadgen: number;
  /** 0 = unknown (the lookup failed), else the country count. */
  geoCountries: number;
  /** The newest campaign name that looks like one of ours, if any. */
  lastStudioCampaign: string | null;
  scannedAt: string;
  error?: string;
};

const CACHE_TTL_MS = 30 * 60_000;
const store = globalThis as unknown as { __studioFingerprints?: Map<string, AccountFingerprint> };

export function cachedFingerprint(accountId: string): AccountFingerprint | null {
  const hit = store.__studioFingerprints?.get(accountId);
  return hit && Date.now() - new Date(hit.scannedAt).getTime() < CACHE_TTL_MS ? hit : null;
}

export async function fingerprintAccount(accountId: string, opts: { force?: boolean } = {}): Promise<AccountFingerprint> {
  if (!opts.force) {
    const hit = cachedFingerprint(accountId);
    if (hit) return hit;
  }
  const fp: AccountFingerprint = { accountId, campaigns: 0, active: 0, traffic: 0, reach: 0, sales: 0, leadgen: 0, geoCountries: 0, lastStudioCampaign: null, scannedAt: new Date().toISOString() };
  const token = accessTokenFor(accountId);
  if (!token) {
    fp.error = "No TikTok authorization covers this ad account";
    return fp;
  }
  const tt = tiktokTransport();
  for (let page = 1; page <= 5; page++) {
    const res = await tt.get("/campaign/get/", token, { advertiser_id: accountId, page, page_size: 100 });
    if (res.code !== 0) {
      fp.error = res.message || "campaign lookup failed";
      break;
    }
    const list = (res.data?.list ?? []) as Record<string, unknown>[];
    for (const c of list) {
      if (c.secondary_status === "CAMPAIGN_STATUS_DELETE") continue;
      fp.campaigns += 1;
      if (c.operation_status === "ENABLE") fp.active += 1;
      if (String(c.objective_type ?? "") === "TRAFFIC") fp.traffic += 1;
      if (c.objective_type === "REACH") fp.reach += 1;
      if (c.objective_type === "WEB_CONVERSIONS" || c.objective_type === "TRAFFIC") fp.sales += 1;
      if (c.objective_type === "LEAD_GENERATION") fp.leadgen += 1;
      const name = String(c.campaign_name ?? "");
      if (/(^|-)studio-pb_/.test(name) || name.startsWith("studio-")) fp.lastStudioCampaign = fp.lastStudioCampaign ?? name;
    }
    if (list.length < 100) break;
  }
  if (!fp.error) {
    try {
      fp.geoCountries = await countryCountFor(accountId);
    } catch {
      /* unknown, not wrong */
    }
  }
  if (!store.__studioFingerprints) store.__studioFingerprints = new Map();
  store.__studioFingerprints.set(accountId, fp);
  return fp;
}

export { FULL_COUNTRY_COUNT };
