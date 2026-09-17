// Copies of a launch's ad group — overlord's lib/adgroup-duplicate.ts, on
// Studio's own records (decision 2026-09-16). TikTok has no copy endpoint
// (probed live: /adgroup/copy/ 404s), so a copy is REBUILT from what the
// launch recorded: the settings snapshot gives the ad group body, the
// uploaded video ids, covers, identity and ad text give the ads. Nothing is
// read back from TikTok to build a copy, so a copy is exactly what the
// launch sent, never a forwarded echo of ~90 read-only fields.
//
// Three callers, one shape:
//   the auto-duplicate pass   N copies once an ad clears review
//   the manual Duplicate      N copies now
//   the cost-cap replacement  one copy with a bid, the original switched off
//
// Money: in the lifetime shape every group's budget is a share of the signed
// number (the caller re-shares before adding groups); in the daily shape a
// copy carries the daily amount and the campaign's lifetime cap bounds them
// all. A copy never widens what the approver signed.

import { adTextOf } from "@/lib/clips/creatives";
import type { LaunchedCampaign } from "@/lib/data";
import type { TikTokTransport } from "./index";
import { adGroupBody, type AdGroupPlan, type LaunchSettings } from "./settings";

export type CopyResult = { adgroupId: string; adIds: string[]; skipped: string[] };

/** The creatives the launch turned into ads, in ad order, with the upload ids the copy reuses. */
function adPayloads(row: LaunchedCampaign, adNames: (creativeExternalId: string, n: number) => string): Array<{ creativeId: string; payload: Record<string, unknown> }> {
  const { launch, campaign, creatives } = row;
  const out: Array<{ creativeId: string; payload: Record<string, unknown> }> = [];
  creatives.forEach((c, i) => {
    const videoId = launch.uploaded_videos[c.id];
    const cover = videoId ? launch.covers[videoId] : undefined;
    if (!videoId || !cover || !launch.ad_ids[c.id]) return; // only ads that made it the first time
    out.push({
      creativeId: c.id,
      payload: {
        ad_name: adNames(c.external_id, i + 1),
        identity_id: launch.identity_id,
        identity_type: launch.identity_type,
        ad_format: "SINGLE_VIDEO",
        video_id: videoId,
        image_ids: [cover],
        ad_text: adTextOf(c, campaign.name),
        call_to_action: launch.settings.call_to_action,
        landing_page_url: launch.destination_url,
      },
    });
  });
  return out;
}

/**
 * One copy: an ad group under the launch's campaign with the launch's own
 * settings (plus any override, e.g. a cost cap), then its ads. Copies are
 * created ENABLED: their trigger is a delivering group, and a copy that
 * arrives paused would silently not do the one thing it was made for.
 * Throws when the ad group cannot be created; a failed ad is reported as
 * skipped, and a copy with zero ads is an error (an empty group must not read
 * as a finished copy). Copies are created enabled unless `override` carries
 * an `operation_status`.
 */
export async function createAdGroupCopy(
  tt: TikTokTransport,
  token: string,
  row: LaunchedCampaign,
  settings: LaunchSettings,
  plan: AdGroupPlan,
  name: string,
  adNames: (creativeExternalId: string, n: number) => string,
  override: Record<string, unknown> = {}
): Promise<CopyResult> {
  const { launch } = row;
  // Enabled unless the caller says otherwise (a cost-cap replacement keeps its source's switch state).
  const body = { ...adGroupBody(settings, plan), operation_status: "ENABLE", ...override };
  const created = await tt.post("/adgroup/create/", token, { advertiser_id: launch.advertiser_id, campaign_id: launch.tiktok_campaign_id, adgroup_name: name, ...body });
  let adgroupId = (created.data as { adgroup_id?: string } | undefined)?.adgroup_id ? String((created.data as { adgroup_id?: string }).adgroup_id) : null;
  if (!adgroupId && /name already exists/i.test(created.message || "")) {
    // The crash gap: made last time, not recorded. Ours by name.
    const got = await tt.get("/adgroup/get/", token, { advertiser_id: launch.advertiser_id, filtering: JSON.stringify({ campaign_ids: [launch.tiktok_campaign_id] }), page: 1, page_size: 100 });
    const hit = ((got.data?.list ?? []) as Record<string, unknown>[]).find((g) => String(g.adgroup_name ?? "") === name);
    adgroupId = hit?.adgroup_id ? String(hit.adgroup_id) : null;
  }
  if (!adgroupId) throw new Error(created.message || "TikTok refused the ad group copy");

  const payloads = adPayloads(row, adNames);
  if (!payloads.length) throw new Error("the launch recorded no ads to copy");
  // Ads already under this group (a previous attempt) are adopted by name, the rest created.
  const existing = await tt.get("/ad/get/", token, { advertiser_id: launch.advertiser_id, filtering: JSON.stringify({ adgroup_ids: [adgroupId] }), page: 1, page_size: 100 });
  const byName = new Map<string, string>();
  if (existing.code === 0) for (const a of (existing.data?.list ?? []) as Record<string, unknown>[]) if (a.ad_name && a.ad_id) byName.set(String(a.ad_name), String(a.ad_id));
  const adIds: string[] = [];
  const skipped: string[] = [];
  const still = payloads.filter((p) => {
    const found = byName.get(String(p.payload.ad_name));
    if (found) adIds.push(found);
    return !found;
  });
  if (still.length) {
    const res = await tt.post("/ad/create/", token, { advertiser_id: launch.advertiser_id, adgroup_id: adgroupId, creatives: still.map((s) => s.payload) });
    const ids = (res.data as { ad_ids?: string[] } | undefined)?.ad_ids ?? [];
    if (res.code !== 0 || !ids.length) {
      // TikTok's batch is all-or-nothing: fall back to one call per ad so one bad ad does not empty the copy.
      for (const s of still) {
        const one = await tt.post("/ad/create/", token, { advertiser_id: launch.advertiser_id, adgroup_id: adgroupId, creatives: [s.payload] });
        const id = (one.data as { ad_ids?: string[] } | undefined)?.ad_ids?.[0];
        if (one.code === 0 && id) adIds.push(String(id));
        else skipped.push(`${s.creativeId}: ${one.message || res.message || "refused"}`);
      }
    } else {
      for (const id of ids) adIds.push(String(id));
    }
  }
  if (!adIds.length) throw new Error(`the copy ${adgroupId} holds no ad (${skipped.join("; ") || "TikTok refused every ad"})`);
  return { adgroupId, adIds, skipped };
}
