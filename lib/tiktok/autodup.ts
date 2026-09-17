// The auto-duplicate pass — overlord's lib/auto-duplicate-pass.ts on
// Studio's launches (decision 2026-09-16). A launch that asked for N copies
// waits for its ads to clear review, then N copies of its ad group are
// created so they spend their own budgets (the lifetime share each, or the
// daily amount each under the campaign cap).
//
// Decided exactly once per launch, recorded in `duplicated_at`:
//   some ad approved            -> duplicate now, record the copies
//   every ad ruled, none passed -> record "decided", never look again
//   anything still pending      -> leave undecided, check next tick
//
// Copies are created ENABLED; a launch that started paused never triggers
// (its ads sit unreviewed until it is turned on, and a copy that appears
// while the owner thinks nothing is running would be a surprise). A copy
// that fails is retried on the next tick because only recorded copies count.

import { systemSession } from "@/lib/auth";
import { getData, type LaunchedCampaign } from "@/lib/data";
import { activeAdGroupIds } from "./controls";
import { createAdGroupCopy } from "./duplicate";
import { accessTokenFor, tiktokTransport } from "./index";
import { launchNames } from "./launch";
import { fetchCampaignReviews } from "./review";
import { normalizeLaunchSettings, planAdGroup } from "./settings";

export type AutoDupResult = { created: string[]; decided: boolean; error?: string };

export async function autoDuplicatePass(row: LaunchedCampaign): Promise<AutoDupResult> {
  const { campaign, launch } = row;
  const settings = normalizeLaunchSettings(launch.settings);
  const wanted = settings.duplicate_copies;
  if (!wanted || launch.duplicated_at || !launch.tiktok_adgroup_id) return { created: [], decided: !!launch.duplicated_at };
  if (["failed", "ended"].includes(campaign.status)) {
    // Over before any copy was due (every ad rejected, or ended): decided, no copies, never looked at again.
    await getData().recordLaunchChange(systemSession(), campaign.id, { duplicated_at: new Date().toISOString(), note: `auto-duplicate: campaign ${campaign.status}; no copies made` });
    return { created: [], decided: true };
  }
  if (!["submitted", "live"].includes(campaign.status)) return { created: [], decided: false };
  const token = accessTokenFor(launch.advertiser_id);
  if (!token) return { created: [], decided: false, error: "no TikTok connection covers this ad account" };
  const { reviews, campaignOn, error } = await fetchCampaignReviews(row);
  if (!reviews.length) return { created: [], decided: false, error };
  const data = getData();
  const session = systemSession();
  const passed = reviews.some((r) => r.state === "approved" || r.state === "limited");
  const allRuled = reviews.every((r) => ["approved", "limited", "rejected"].includes(r.state));
  if (!passed) {
    if (allRuled) {
      await data.recordLaunchChange(session, campaign.id, { duplicated_at: new Date().toISOString(), note: "auto-duplicate: no ad passed review; no copies made" });
      return { created: [], decided: true };
    }
    return { created: [], decided: false, error };
  }
  if (campaignOn === false) return { created: [], decided: false }; // switched off: nobody ordered copies of a paused campaign right now
  const have = Object.keys(launch.duplicates ?? {}).length;
  const missing = wanted - have;
  if (missing <= 0) {
    await data.recordLaunchChange(session, campaign.id, { duplicated_at: new Date().toISOString(), note: "auto-duplicate: copies complete" });
    return { created: [], decided: true };
  }
  const tt = tiktokTransport();
  // The share is the CURRENT signed budget over wanted+1 groups. The groups that
  // already exist are re-shared to it first: a budget change made while the
  // copies were still pending must not leave the original holding the whole
  // total on top of the copies' shares (review finding 1).
  const plan = planAdGroup(settings, launch.budget_usd);
  if (plan.budget_mode === "BUDGET_MODE_TOTAL") {
    for (const id of activeAdGroupIds(row)) {
      const res = await tt.post("/adgroup/update/", token, { advertiser_id: launch.advertiser_id, adgroup_id: id, budget: plan.budget });
      if (res.code !== 0) return { created: [], decided: false, error: `could not re-share the budget on ad group ${id} before duplicating: ${res.message}` };
    }
  }
  const names = launchNames(campaign.external_id, settings.campaign_name_prefix, campaign.target_market);
  const duplicates: Record<string, string[]> = { ...(launch.duplicates ?? {}) };
  const created: string[] = [];
  let firstError: string | undefined;
  for (let i = 0; i < missing; i++) {
    const n = have + i + 1;
    try {
      const copy = await createAdGroupCopy(tt, token, row, settings, plan, names.copy(n), (ext, k) => `${names.copy(n)}-${ext}-${k}`.slice(0, 100));
      duplicates[copy.adgroupId] = copy.adIds;
      created.push(copy.adgroupId);
      await data.recordLaunchChange(session, campaign.id, { duplicates, note: `auto-duplicate: copy ${n} of ${wanted} created (${copy.adgroupId})` });
    } catch (e) {
      firstError = firstError ?? (e as Error).message;
    }
  }
  const done = Object.keys(duplicates).length >= wanted;
  if (done) await data.recordLaunchChange(session, campaign.id, { duplicated_at: new Date().toISOString(), note: `auto-duplicate: ${wanted} copies live` });
  return { created, decided: done, error: firstError };
}
