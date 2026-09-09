// Staff intervention on a launched campaign: the on/off switch — Pulsar
// Grow's monitor status route. One TikTok campaign, one flip, READ BACK:
// TikTok answers code 0 to a status update on a suspended ad account and
// then does not apply it (measured live in Pulsar, 2026-08-29), so the
// campaign is re-read and the answer is what TikTok now says, not what we
// asked for.

import type { Session } from "@/lib/auth";
import { getData, type LaunchedCampaign } from "@/lib/data";
import { DataError } from "@/lib/data/errors";
import { accessTokenFor, tiktokTransport } from "./index";

export async function switchCampaign(session: Session, campaignId: string, on: boolean): Promise<{ applied: boolean; status: string; note: string | null }> {
  const data = getData();
  const rows = await data.listLaunchedPromoCampaigns(session);
  const row: LaunchedCampaign | undefined = rows.find((r) => r.campaign.id === campaignId);
  if (!row) throw new DataError("conflict", "this campaign has no TikTok launch to switch");
  const { campaign, launch } = row;
  if (on && campaign.status === "ended") throw new DataError("conflict", "an ended campaign is not switched back on — launch a new round");
  const token = accessTokenFor(launch.advertiser_id);
  if (!token) throw new DataError("conflict", "no TikTok connection covers this ad account");
  const tt = tiktokTransport();
  const res = await tt.post("/campaign/status/update/", token, { advertiser_id: launch.advertiser_id, campaign_ids: [campaign.grow_campaign_id], operation_status: on ? "ENABLE" : "DISABLE" });
  if (res.code !== 0) throw new DataError("invalid", `TikTok refused the status change: ${res.message}`);
  const check = await tt.get("/campaign/get/", token, { advertiser_id: launch.advertiser_id, filtering: JSON.stringify({ campaign_ids: [campaign.grow_campaign_id] }), page: 1, page_size: 1 });
  const live = ((check.data?.list ?? []) as Record<string, unknown>[])[0];
  const applied = check.code === 0 && !!live && (live.operation_status === "DISABLE") === !on;
  if (!applied) {
    return { applied: false, status: campaign.status, note: "TikTok accepted the request but the campaign did not change state; the next sweep will settle it (a suspended ad account behaves this way)." };
  }
  const note = on ? null : `Paused by ${session.displayName}`;
  const status = on ? (campaign.status === "paused" ? "submitted" : campaign.status) : "paused";
  // Switching back on returns the campaign to "submitted" until the review poll sees delivery again.
  await data.setPromoCampaignDelivery(session, campaign.id, { status: status as "paused" | "submitted" | "live", status_note: note });
  return { applied: true, status, note };
}
