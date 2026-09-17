// What a person may do to a launched campaign — overlord's monitor and
// bid/budget routes on Studio's records (decision 2026-09-16, "launch
// settings, controls and the monitor"; hardened after the 2026-09-16
// review). Every control:
//
//   1. loads the launch record (the account and the ids come from OUR row,
//      never from the request — authorization is the lookup);
//   2. writes to TikTok;
//   3. READS BACK where TikTok is known to lie: a status update on a
//      suspended ad account answers code 0 and is not applied (measured
//      live in Pulsar, 2026-08-29), so the switch re-reads and reports what
//      TikTok now says, not what we asked for;
//   4. records the change on the launch row through the data layer, which
//      decides who may (staff, or the company's approver — decision
//      2026-09-16: producers manage their own campaigns).
//
// The signed budget stays the ceiling, across every group that exists AND
// every copy still planned: a budget change shares the new total across
// the larger of the two counts, and the auto-duplicate pass re-shares the
// existing groups before it creates copies. Bidding: a cost cap on a
// cost-cap group is edited in place; a lowest-cost group cannot be given a
// bid (TikTok refuses, probed), so it is REPLACED — a copy with the cap and
// only what the old group has NOT yet spent, in the old group's own switch
// state, recorded before the old group is switched off and retired.

import type { Session } from "@/lib/auth";
import { getData, type LaunchedCampaign, type ResolvedLaunchAccount } from "@/lib/data";
import { DataError, legacyCampaignRetired } from "@/lib/data/errors";
import type { PromoLaunch } from "@/lib/types";
import { createAdGroupCopy } from "./duplicate";
import { accessTokenFor, tiktokTransport, type TikTokTransport } from "./index";
import { launchNames } from "./launch";
import { goalOption, MIN_ADGROUP_BUDGET_USD, MIN_CAMPAIGN_BUDGET_USD, MAX_DUPLICATE_COPIES } from "./options";
import { normalizeLaunchSettings, planAdGroup, tiktokTime, type LaunchSettings } from "./settings";

type Loaded = { row: LaunchedCampaign; tt: TikTokTransport; token: string };

async function load(session: Session, campaignId: string, opts: { allowEnded?: boolean } = {}): Promise<Loaded> {
  const row = await getData().getLaunchedCampaign(session, campaignId);
  if (!row) throw new DataError("conflict", "this campaign has no TikTok launch to manage");
  if (!opts.allowEnded && row.campaign.status === "ended") throw new DataError("conflict", "an ended campaign is closed; launch a new round");
  const token = accessTokenFor(row.launch.advertiser_id);
  if (!token) throw new DataError("conflict", "no TikTok connection covers this ad account");
  return { row, tt: tiktokTransport(), token };
}

/** The ad groups still counted as delivering: the original plus copies, minus retired ones. */
export function activeAdGroupIds(row: LaunchedCampaign): string[] {
  const { launch } = row;
  const retired = new Set(launch.retired_adgroups ?? []);
  const ids = [launch.tiktok_adgroup_id, ...Object.keys(launch.duplicates ?? {})].filter((id): id is string => !!id);
  return ids.filter((id) => !retired.has(id));
}

/**
 * How many ad groups the signed budget is shared across: the groups that
 * exist, or the groups the launch still plans to have once the auto-duplicate
 * pass has run — whichever is larger. A budget change before duplication
 * must not hand the original the whole new total and the copies a share of
 * it on top (review finding 1).
 */
export function plannedGroupCount(launch: PromoLaunch, settings: LaunchSettings, active: number): number {
  const planned = launch.duplicated_at ? 0 : settings.duplicate_copies + 1;
  return Math.max(1, active, planned);
}

async function readCampaignOn(tt: TikTokTransport, token: string, advertiserId: string, campaignId: string): Promise<{ on: boolean | null; secondary: string | null }> {
  const check = await tt.get("/campaign/get/", token, { advertiser_id: advertiserId, filtering: JSON.stringify({ campaign_ids: [campaignId] }), page: 1, page_size: 1 });
  const live = ((check.data?.list ?? []) as Record<string, unknown>[])[0];
  if (check.code !== 0 || !live) return { on: null, secondary: null };
  return { on: live.operation_status !== "DISABLE", secondary: live.secondary_status ? String(live.secondary_status) : null };
}

async function liveAdGroups(tt: TikTokTransport, token: string, launch: PromoLaunch): Promise<Map<string, Record<string, unknown>>> {
  const got = await tt.get("/adgroup/get/", token, { advertiser_id: launch.advertiser_id, filtering: JSON.stringify({ campaign_ids: [launch.tiktok_campaign_id] }), page: 1, page_size: 100 });
  if (got.code !== 0) throw new DataError("invalid", `could not read the ad groups: ${got.message}`);
  return new Map(((got.data?.list ?? []) as Record<string, unknown>[]).map((g) => [String(g.adgroup_id), g]));
}

/** Lifetime spend of one ad group, from the reporting API (null when TikTok did not answer). */
export async function adGroupSpend(tt: TikTokTransport, token: string, launch: LaunchedCampaign["launch"], since: string, adgroupId: string): Promise<number | null> {
  const rep = await tt.get("/report/integrated/get/", token, {
    advertiser_id: launch.advertiser_id, report_type: "BASIC", data_level: "AUCTION_ADGROUP", dimensions: JSON.stringify(["adgroup_id"]),
    metrics: JSON.stringify(["spend"]), start_date: since.slice(0, 10), end_date: new Date().toISOString().slice(0, 10),
    filtering: JSON.stringify([{ field_name: "adgroup_ids", filter_type: "IN", filter_value: JSON.stringify([adgroupId]) }]), page_size: 200,
  });
  if (rep.code !== 0) return null;
  let spend = 0;
  for (const r of (rep.data?.list ?? []) as Array<{ metrics?: Record<string, unknown> }>) spend += Number(r.metrics?.spend) || 0;
  return Math.round(spend * 100) / 100;
}

const NOT_APPLIED = "TikTok accepted the request but the campaign did not change state; the next sweep will settle it (a suspended ad account behaves this way).";

/**
 * The campaign's on/off switch, read back. The first switch-on of a launch
 * created paused also enables the ad groups that creation switched off
 * (review finding 5); a group someone paused on purpose later stays paused.
 */
export async function switchCampaign(session: Session, campaignId: string, on: boolean): Promise<{ applied: boolean; status: string; note: string | null; groups_enabled?: number }> {
  const { row, tt, token } = await load(session, campaignId);
  const { campaign, launch } = row;
  const res = await tt.post("/campaign/status/update/", token, { advertiser_id: launch.advertiser_id, campaign_ids: [campaign.grow_campaign_id], operation_status: on ? "ENABLE" : "DISABLE" });
  if (res.code !== 0) throw new DataError("invalid", `TikTok refused the status change: ${res.message}`);
  const back = await readCampaignOn(tt, token, launch.advertiser_id, campaign.grow_campaign_id!);
  const applied = back.on === on;
  if (!applied) {
    return { applied: false, status: campaign.status, note: back.secondary?.includes("PUNISH") ? "TikTok has suspended this ad account; the campaign cannot be switched until the account is restored." : NOT_APPLIED };
  }
  const data = getData();
  let groupsEnabled = 0;
  const settings = normalizeLaunchSettings(launch.settings);
  if (on && settings.start_paused && !launch.activated_at) {
    // First activation: the groups creation switched off come on with the campaign, or "on" delivers nothing.
    const ids = activeAdGroupIds(row);
    if (ids.length) {
      const up = await tt.post("/adgroup/status/update/", token, { advertiser_id: launch.advertiser_id, adgroup_ids: ids, operation_status: "ENABLE" });
      if (up.code !== 0) throw new DataError("invalid", `the campaign is on but TikTok refused to enable its ad groups: ${up.message}`);
      groupsEnabled = ids.length;
    }
  }
  const note = on ? null : `Paused by ${session.displayName}`;
  // Switching back on returns the campaign to "submitted" until the review poll sees delivery again.
  const status = on ? (campaign.status === "paused" ? "submitted" : campaign.status) : "paused";
  await data.setPromoCampaignDelivery(session, campaign.id, { status: status as "paused" | "submitted" | "live", status_note: note });
  await data.recordLaunchChange(session, campaign.id, { paused: !on, ...(groupsEnabled ? { activated_at: new Date().toISOString() } : {}), note: on ? (groupsEnabled ? `switched on; ${groupsEnabled} ad group(s) activated` : "switched on") : "switched off" });
  return { applied: true, status, note, ...(groupsEnabled ? { groups_enabled: groupsEnabled } : {}) };
}

/** One ad group's switch (a copy, or the original), verified to live under this campaign. */
export async function switchAdGroup(session: Session, campaignId: string, adgroupId: string, on: boolean): Promise<{ applied: boolean }> {
  const { row, tt, token } = await load(session, campaignId);
  const known = [row.launch.tiktok_adgroup_id, ...Object.keys(row.launch.duplicates ?? {})];
  if (!known.includes(adgroupId)) throw new DataError("not_found", "that ad group does not belong to this campaign");
  const res = await tt.post("/adgroup/status/update/", token, { advertiser_id: row.launch.advertiser_id, adgroup_ids: [adgroupId], operation_status: on ? "ENABLE" : "DISABLE" });
  if (res.code !== 0) throw new DataError("invalid", `TikTok refused the status change: ${res.message}`);
  const check = await tt.get("/adgroup/get/", token, { advertiser_id: row.launch.advertiser_id, filtering: JSON.stringify({ adgroup_ids: [adgroupId] }), page: 1, page_size: 1 });
  const live = ((check.data?.list ?? []) as Record<string, unknown>[])[0];
  const applied = check.code === 0 && !!live && (live.operation_status !== "DISABLE") === on;
  await getData().recordLaunchChange(session, row.campaign.id, { note: `ad group ${adgroupId} switched ${on ? "on" : "off"}` });
  return { applied };
}

/**
 * End for good: switched off on TikTok and closed here. Ended is terminal;
 * a suspended account that ignores the switch still ends here — nothing
 * delivers there anyway, and the note says so.
 */
export async function endCampaign(session: Session, campaignId: string, note?: string | null): Promise<{ applied: boolean }> {
  const { row, tt, token } = await load(session, campaignId);
  const { campaign, launch } = row;
  const res = await tt.post("/campaign/status/update/", token, { advertiser_id: launch.advertiser_id, campaign_ids: [campaign.grow_campaign_id], operation_status: "DISABLE" });
  if (res.code !== 0) throw new DataError("invalid", `TikTok refused the status change: ${res.message}`);
  const back = await readCampaignOn(tt, token, launch.advertiser_id, campaign.grow_campaign_id!);
  const applied = back.on === false;
  const data = getData();
  await data.setPromoCampaignDelivery(session, campaign.id, { status: "ended", status_note: `Ended by ${session.displayName}${note?.trim() ? `: ${note.trim()}` : ""}${applied ? "" : " (TikTok did not confirm the switch-off; the account may be suspended)"}` });
  await data.recordLaunchChange(session, campaign.id, { paused: true, note: `ended${note?.trim() ? `: ${note.trim()}` : ""}` });
  return { applied };
}

/**
 * A new total: the approver signs a new budget (or staff override it), and
 * TikTok is told — every active group's lifetime share in the lifetime
 * shape (shared across the planned copies too, while duplication is still
 * pending), the campaign's lifetime cap in the daily shape.
 */
export async function changeBudget(session: Session, campaignId: string, budgetUsd: number, note?: string | null): Promise<{ budget_usd: number; groups: number }> {
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new DataError("invalid", "the budget must be above 0");
  const { row, tt, token } = await load(session, campaignId);
  const { launch } = row;
  const settings = normalizeLaunchSettings(launch.settings);
  const groups = activeAdGroupIds(row);
  const shareCount = plannedGroupCount(launch, settings, groups.length);
  if (settings.budget_mode === "BUDGET_MODE_TOTAL") {
    const share = Math.floor((budgetUsd / shareCount) * 100) / 100;
    if (share < MIN_ADGROUP_BUDGET_USD) throw new DataError("invalid", `$${budgetUsd} across ${shareCount} ad group(s) is $${share} each, below TikTok's minimum of $${MIN_ADGROUP_BUDGET_USD}`);
    for (const id of groups) {
      const res = await tt.post("/adgroup/update/", token, { advertiser_id: launch.advertiser_id, adgroup_id: id, budget: share });
      if (res.code !== 0) throw new DataError("invalid", `TikTok refused the budget on ad group ${id}: ${res.message}`);
    }
  } else {
    if (budgetUsd < MIN_CAMPAIGN_BUDGET_USD) throw new DataError("invalid", `the campaign cap must be at least $${MIN_CAMPAIGN_BUDGET_USD}`);
    const res = await tt.post("/campaign/update/", token, { advertiser_id: launch.advertiser_id, campaign_id: launch.tiktok_campaign_id, budget_mode: "BUDGET_MODE_TOTAL", budget: budgetUsd });
    if (res.code !== 0) throw new DataError("invalid", `TikTok refused the campaign budget: ${res.message}`);
  }
  await getData().recordLaunchChange(session, row.campaign.id, { budget_usd: budgetUsd, note: note?.trim() || `budget changed to $${budgetUsd}${shareCount > groups.length ? ` (shared across ${shareCount} planned ad groups)` : ""}` });
  return { budget_usd: budgetUsd, groups: groups.length };
}

/** Daily shape only: what each active ad group spends per day. */
export async function changeDailyBudget(session: Session, campaignId: string, dailyUsd: number): Promise<{ daily_budget_usd: number; groups: number }> {
  if (!Number.isFinite(dailyUsd) || dailyUsd < MIN_ADGROUP_BUDGET_USD) throw new DataError("invalid", `the daily budget must be at least $${MIN_ADGROUP_BUDGET_USD}`);
  const { row, tt, token } = await load(session, campaignId);
  const settings = normalizeLaunchSettings(row.launch.settings);
  if (settings.budget_mode !== "BUDGET_MODE_DAY") throw new DataError("conflict", "this launch runs a lifetime budget; change the total instead");
  if (dailyUsd > row.launch.budget_usd) throw new DataError("invalid", `the daily budget ($${dailyUsd}) exceeds the approved total ($${row.launch.budget_usd}) that caps the campaign`);
  const groups = activeAdGroupIds(row);
  for (const id of groups) {
    const res = await tt.post("/adgroup/update/", token, { advertiser_id: row.launch.advertiser_id, adgroup_id: id, budget: dailyUsd });
    if (res.code !== 0) throw new DataError("invalid", `TikTok refused the daily budget on ad group ${id}: ${res.message}`);
  }
  await getData().recordLaunchChange(session, row.campaign.id, { daily_budget_usd: dailyUsd, note: `daily budget changed to $${dailyUsd} per ad group` });
  return { daily_budget_usd: dailyUsd, groups: groups.length };
}

/**
 * The cost cap. A cost-cap group takes the new number in the field its
 * billing event keeps it in; a lowest-cost group is replaced by a capped
 * copy, because TikTok will not add a bid to a no-bid group. The copy gets
 * ONLY what the old group has not spent yet (a lifetime budget is a ceiling
 * on the pair, not a fresh allowance — review finding 3), keeps the old
 * group's switch state (finding 4), and is recorded before the old group is
 * switched off, so a crash between the two leaves no orphan the row does
 * not know about.
 */
export async function changeBid(session: Session, campaignId: string, bidUsd: number): Promise<{ bid_usd: number; edited: string[]; replaced: Array<{ from: string; to: string; budget: number }> }> {
  if (!Number.isFinite(bidUsd) || bidUsd <= 0) throw new DataError("invalid", "the bid must be above 0");
  const { row, tt, token } = await load(session, campaignId);
  const { launch, campaign } = row;
  const settings = normalizeLaunchSettings(launch.settings);
  const goal = goalOption(settings.optimization_goal);
  const field = goal.billing === "CPC" ? "bid_price" : "conversion_bid_price";
  const live = await liveAdGroups(tt, token, launch);
  const edited: string[] = [];
  const replaced: Array<{ from: string; to: string; budget: number }> = [];
  const duplicates: Record<string, string[]> = { ...(launch.duplicates ?? {}) };
  const retired = [...(launch.retired_adgroups ?? [])];
  const plan = planAdGroup({ ...settings, duplicate_copies: Math.max(0, activeAdGroupIds(row).length - 1) }, launch.budget_usd);
  const names = launchNames(campaign.external_id, settings.campaign_name_prefix, campaign.target_market);
  const since = campaign.launched_at ?? launch.created_at;
  let copyNo = Object.keys(duplicates).length;
  for (const id of activeAdGroupIds(row)) {
    const g = live.get(id);
    if (g && String(g.bid_type ?? "") === "BID_TYPE_CUSTOM") {
      const res = await tt.post("/adgroup/update/", token, { advertiser_id: launch.advertiser_id, adgroup_id: id, [field]: bidUsd });
      if (res.code !== 0) throw new DataError("invalid", `TikTok refused the bid on ad group ${id}: ${res.message}`);
      edited.push(id);
      continue;
    }
    // Lowest cost: replace with a capped copy of the remaining budget, in the same switch state.
    const oldBudget = g ? Number(g.budget) || plan.budget : plan.budget;
    let budget = oldBudget;
    if (String(g?.budget_mode ?? plan.budget_mode) !== "BUDGET_MODE_DAY") {
      const spent = await adGroupSpend(tt, token, launch, since, id);
      if (spent === null) throw new DataError("invalid", `could not read what ad group ${id} has spent, so its remaining budget is unknown; try again`);
      budget = Math.floor((oldBudget - spent) * 100) / 100;
      if (budget < MIN_ADGROUP_BUDGET_USD) throw new DataError("conflict", `ad group ${id} has $${budget} of its $${oldBudget} left, below TikTok's $${MIN_ADGROUP_BUDGET_USD} minimum for a capped copy; raise the budget first or end the round`);
    }
    const wasOn = g ? g.operation_status !== "DISABLE" : true;
    copyNo += 1;
    const copy = await createAdGroupCopy(tt, token, row, { ...settings, bid_strategy: "COST_CAP", bid_usd: bidUsd }, { ...plan, budget }, names.copy(copyNo), (ext, n) => `${names.copy(copyNo)}-${ext}-${n}`.slice(0, 100), {
      bid_type: "BID_TYPE_CUSTOM",
      [field]: bidUsd,
      operation_status: wasOn ? "ENABLE" : "DISABLE",
    });
    duplicates[copy.adgroupId] = copy.adIds;
    // Recorded FIRST: if the switch-off below fails, the copy is known and the old group is not yet retired.
    await getData().recordLaunchChange(session, campaign.id, { duplicates, note: `capped copy ${copy.adgroupId} ($${budget}) created for ad group ${id}` });
    const off = await tt.post("/adgroup/status/update/", token, { advertiser_id: launch.advertiser_id, adgroup_ids: [id], operation_status: "DISABLE" });
    if (off.code !== 0) throw new DataError("invalid", `the capped copy ${copy.adgroupId} exists but TikTok refused to switch off ${id}: ${off.message}`);
    retired.push(id);
    replaced.push({ from: id, to: copy.adgroupId, budget });
    await getData().recordLaunchChange(session, campaign.id, { retired_adgroups: retired, note: `ad group ${id} switched off and retired; ${copy.adgroupId} carries its remaining $${budget}` });
  }
  await getData().recordLaunchChange(session, campaign.id, { bid_usd: bidUsd, duplicates, retired_adgroups: retired, note: `cost cap set to $${bidUsd}` });
  return { bid_usd: bidUsd, edited, replaced };
}

/** Move the schedule end (YYYY-MM-DD, end of that day UTC) on every active ad group. */
export async function changeScheduleEnd(session: Session, campaignId: string, endDay: string): Promise<{ schedule_end: string; groups: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDay)) throw new DataError("invalid", "the end date must be YYYY-MM-DD");
  const end = new Date(`${endDay}T23:59:59Z`);
  if (Number.isNaN(end.getTime()) || end.getTime() < Date.now()) throw new DataError("invalid", "the end date must be in the future");
  const { row, tt, token } = await load(session, campaignId);
  const groups = activeAdGroupIds(row);
  const when = tiktokTime(end);
  for (const id of groups) {
    const res = await tt.post("/adgroup/update/", token, { advertiser_id: row.launch.advertiser_id, adgroup_id: id, schedule_type: "SCHEDULE_START_END", schedule_end_time: when });
    if (res.code !== 0) throw new DataError("invalid", `TikTok refused the schedule on ad group ${id}: ${res.message}`);
  }
  await getData().recordLaunchChange(session, row.campaign.id, { schedule_end: when, note: `schedule end moved to ${endDay}` });
  return { schedule_end: when, groups: groups.length };
}

/**
 * N more ad groups now, each with the launch's ads. Lifetime shape: the
 * signed number is re-shared across every active group first (TikTok refuses
 * a lifetime budget below what a group already spent, and that failure is
 * the right one to surface). Daily shape: each copy carries the daily
 * amount; the campaign cap bounds the sum.
 */
export async function duplicateAdGroups(session: Session, campaignId: string, copies: number): Promise<{ created: string[]; errors: string[] }> {
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_DUPLICATE_COPIES) throw new DataError("invalid", `copies must be 1–${MAX_DUPLICATE_COPIES}`);
  const { row, tt, token } = await load(session, campaignId);
  const { launch, campaign } = row;
  const settings = normalizeLaunchSettings(launch.settings);
  const active = activeAdGroupIds(row);
  const total = active.length + copies;
  const plan = planAdGroup({ ...settings, duplicate_copies: total - 1 }, launch.budget_usd);
  if (settings.budget_mode === "BUDGET_MODE_TOTAL") {
    if (plan.budget < MIN_ADGROUP_BUDGET_USD) throw new DataError("invalid", `$${launch.budget_usd} across ${total} ad groups is $${plan.budget} each, below TikTok's minimum of $${MIN_ADGROUP_BUDGET_USD}`);
    for (const id of active) {
      const res = await tt.post("/adgroup/update/", token, { advertiser_id: launch.advertiser_id, adgroup_id: id, budget: plan.budget });
      if (res.code !== 0) throw new DataError("invalid", `TikTok refused re-sharing the budget on ad group ${id}: ${res.message}`);
    }
  }
  const names = launchNames(campaign.external_id, settings.campaign_name_prefix, campaign.target_market);
  const duplicates: Record<string, string[]> = { ...(launch.duplicates ?? {}) };
  const created: string[] = [];
  const errors: string[] = [];
  let copyNo = Object.keys(duplicates).length;
  for (let i = 0; i < copies; i++) {
    copyNo += 1;
    try {
      const copy = await createAdGroupCopy(tt, token, row, settings, plan, names.copy(copyNo), (ext, n) => `${names.copy(copyNo)}-${ext}-${n}`.slice(0, 100));
      duplicates[copy.adgroupId] = copy.adIds;
      created.push(copy.adgroupId);
      await getData().recordLaunchChange(session, campaign.id, { duplicates, note: `ad group copy ${copy.adgroupId} created` });
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  // Manual copies settle the auto-duplicate question: the person chose the count themselves.
  if (!launch.duplicated_at) await getData().recordLaunchChange(session, campaign.id, { duplicated_at: new Date().toISOString(), note: "manual duplication; auto-duplicate settled" });
  return { created, errors };
}

/**
 * Relaunch on another ad account (staff; the suspended-account escape
 * hatch). A failed launch may still hold a live campaign with the ads that
 * did make it (review finding 2), so the previous TikTok campaign is
 * switched off and READ BACK first; without TikTok's confirmation there is
 * no relaunch. The data layer then writes the new launch row and the note
 * names the campaign that was retired.
 */
export async function relaunchOnAnotherAccount(session: Session, campaignId: string, resolved: ResolvedLaunchAccount, note?: string | null): Promise<{ launch: PromoLaunch; previous_campaign_id: string | null; switched_off: boolean }> {
  legacyCampaignRetired();
  const data = getData();
  const previous = await data.getLaunchedCampaign(session, campaignId);
  let previousCampaignId: string | null = null;
  let switchedOff = false;
  if (previous?.launch.tiktok_campaign_id) {
    previousCampaignId = previous.launch.tiktok_campaign_id;
    const token = accessTokenFor(previous.launch.advertiser_id);
    if (!token) throw new DataError("conflict", `no TikTok connection covers the previous ad account ${previous.launch.advertiser_id}; its campaign ${previousCampaignId} cannot be switched off`);
    const tt = tiktokTransport();
    const res = await tt.post("/campaign/status/update/", token, { advertiser_id: previous.launch.advertiser_id, campaign_ids: [previousCampaignId], operation_status: "DISABLE" });
    if (res.code !== 0) throw new DataError("conflict", `TikTok refused to switch off the previous campaign ${previousCampaignId}: ${res.message}`);
    const back = await readCampaignOn(tt, token, previous.launch.advertiser_id, previousCampaignId);
    if (back.on !== false) throw new DataError("conflict", `the previous campaign ${previousCampaignId} is still on according to TikTok${back.secondary?.includes("PUNISH") ? " (the account is suspended: it delivers nothing, but TikTok will not confirm the switch)" : ""}; no relaunch until it is confirmed off`);
    switchedOff = true;
    if (previous.campaign.status !== "ended") await data.setPromoCampaignDelivery(session, campaignId, { status: previous.campaign.status as "failed" | "paused" | "live" | "submitted", status_note: `Previous campaign ${previousCampaignId} switched off before relaunch` });
  }
  const launch = await data.relaunchOnAccount(session, campaignId, resolved, [previousCampaignId ? `previous campaign ${previousCampaignId} switched off` : null, note?.trim() || null].filter(Boolean).join("; ") || null);
  return { launch, previous_campaign_id: previousCampaignId, switched_off: switchedOff };
}
