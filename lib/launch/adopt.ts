// Adopt a TikTok campaign (decision 2026-10-04). A campaign made in TikTok
// Ads Manager by copying one Studio launched plays videos Studio uploaded and
// sends people to crazydramas, yet Studio has no record of it: the Monitor
// cannot show its spend and crazydramas' stats cannot name its ads. Adoption
// writes that record from what TikTok says the campaign is and what Studio's
// own launch records say its videos are. Nothing is written to TikTok.
//
// This module is the pure half: given TikTok's reading of the campaign
// (lib/tiktok/adopt.ts) and the company's launches on the same ad account, it
// decides whether the campaign can be adopted and builds the draft, the
// campaign row and the driver state the record needs. The data layer
// (lib/data/launch.ts `adoptLaunchRun`) authorizes, signs and stores it.
//
//   - Every ad must play a video (or a post) one of the company's own launches
//     put on this ad account: `state.uploads` names the video a Studio clip
//     became, `state.posts` the post a Spark code or an account post is. An ad
//     Studio cannot name is a refusal that lists it, never a guess.
//   - The ad's content item is the approved one from that launch (its title,
//     its link, the file's hash), so the adopted record promotes what was
//     approved and nothing else.
//   - The budget is TikTok's: the ad groups' lifetime budgets, summed. That sum
//     is the ceiling the record is signed with; raising it later is a new
//     decision, as on a launch.
//   - The settings are the source launch's, corrected by what TikTok says of
//     the ad groups Studio can read back (ages, audiences), with no automatic
//     copies: an adopted campaign is monitored and controlled, never grown.

import type { TikTokCampaignRead } from "@/lib/tiktok/adopt";
import { AGE_OPTIONS } from "@/lib/tiktok/options";
import type { LaunchSettings } from "@/lib/tiktok/settings";
import type { LaunchConnection, LaunchContent, LaunchDraft, LaunchPlanRow, LaunchRun } from "./types";

type StoredPost = { code: string; item_id?: string; video_id?: string } & Record<string, unknown>;
type StoredUpload = { video_id: string; image_id?: string };

export type Adoption =
  | { ok: false; reason: string }
  | {
      ok: true; draft: LaunchDraft; row: LaunchPlanRow; state: Record<string, unknown>;
      budget_cents: number; created_at: string | null; source_run_ids: string[];
    };

const AGES = new Set<string>(AGE_OPTIONS.map((o) => o.value));
const known = (c: LaunchContent) => c.value.trim();

/** What Studio's launches on this ad account say a TikTok video or post is. */
function recorded(runs: LaunchRun[], advertiserId: string) {
  const byVideo = new Map<string, { run: LaunchRun; content: LaunchContent; post?: StoredPost; upload?: StoredUpload }>();
  const byItem = new Map<string, { run: LaunchRun; content: LaunchContent; post?: StoredPost; upload?: StoredUpload }>();
  // Newest first: when two launches carry the same video, the latest approval speaks for it.
  for (const run of [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    if (run.draft.provider !== "tiktok" || run.status === "draft") continue;
    for (const campaign of run.campaigns) {
      if (campaign.advertiser_id !== advertiserId) continue;
      const contentOf = (code: string) => campaign.content.find((c) => known(c) === code.trim()) ?? run.draft.content.find((c) => known(c) === code.trim());
      const posts = (campaign.state.posts as StoredPost[] | undefined) ?? [];
      const uploads = (campaign.state.uploads as Record<string, StoredUpload> | undefined) ?? {};
      for (const [code, upload] of Object.entries(uploads)) {
        const content = contentOf(code);
        if (content && upload?.video_id && !byVideo.has(upload.video_id)) byVideo.set(upload.video_id, { run, content, upload, post: posts.find((p) => p.code === code) });
      }
      for (const post of posts) {
        const content = contentOf(post.code);
        if (!content) continue;
        if (post.item_id && !byItem.has(post.item_id)) byItem.set(post.item_id, { run, content, post });
        if (post.video_id && !byVideo.has(post.video_id)) byVideo.set(post.video_id, { run, content, post, upload: uploads[post.code] });
      }
    }
  }
  return { byVideo, byItem };
}

export function buildAdoption(read: TikTokCampaignRead, runs: LaunchRun[], connection: LaunchConnection, opts: { name?: string } = {}): Adoption {
  if (!read.groups.length) return { ok: false, reason: "This TikTok campaign has no ad group yet, so there is nothing to monitor. Adopt it once it has ads." };
  if (!read.ads.length) return { ok: false, reason: "This TikTok campaign has no ads yet, so there is nothing to monitor. Adopt it once it has ads." };
  const notLifetime = read.groups.filter((g) => g.budget_mode !== "BUDGET_MODE_TOTAL" || !g.budget_cents || g.budget_cents < 1);
  if (notLifetime.length) {
    return { ok: false, reason: `Studio adopts campaigns whose ad groups have a lifetime budget. ${notLifetime.length === 1 ? "One ad group" : `${notLifetime.length} ad groups`} of this campaign ${notLifetime.length === 1 ? "has" : "have"} a daily budget or none (${notLifetime.map((g) => g.name || g.id).join(", ")}).` };
  }
  const { byVideo, byItem } = recorded(runs, connection.advertiser_id);
  const groupIds = new Set(read.groups.map((g) => g.id));
  const unknown: string[] = [];
  const content: LaunchContent[] = [];
  const posts: StoredPost[] = [];
  const uploads: Record<string, StoredUpload> = {};
  const sources = new Map<string, LaunchRun>();
  const adsByGroup = new Map<string, Record<string, string>>();
  for (const ad of read.ads) {
    if (!groupIds.has(ad.group_id)) return { ok: false, reason: `TikTok lists ad ${ad.id} under an ad group it did not return. Try again in a moment.` };
    const hit = (ad.item_id ? byItem.get(ad.item_id) : undefined) ?? (ad.video_id ? byVideo.get(ad.video_id) : undefined);
    if (!hit) { unknown.push(ad.name || ad.id); continue; }
    const code = known(hit.content);
    const inGroup = adsByGroup.get(ad.group_id) ?? {};
    if (inGroup[code]) return { ok: false, reason: `Two ads in one ad group of this campaign play the same video (${ad.name || ad.id}). Studio records one ad per video in an ad group; remove the extra ad in TikTok and adopt again.` };
    inGroup[code] = ad.id;
    adsByGroup.set(ad.group_id, inGroup);
    sources.set(hit.run.id, hit.run);
    if (!content.some((c) => known(c) === code)) {
      content.push(structuredClone(hit.content));
      if (hit.post) posts.push(structuredClone(hit.post));
      if (hit.upload) uploads[code] = structuredClone(hit.upload);
    }
  }
  if (unknown.length) {
    return { ok: false, reason: `Studio has no record of the video in ${unknown.length === 1 ? "one ad" : `${unknown.length} ads`} of this campaign (${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ", …" : ""}). Only a copy of a campaign Studio launched on this ad account can be adopted.` };
  }
  // The launch that speaks for most of the ads lends its settings.
  const counts = new Map<string, number>();
  for (const ad of read.ads) {
    const hit = (ad.item_id ? byItem.get(ad.item_id) : undefined) ?? (ad.video_id ? byVideo.get(ad.video_id) : undefined);
    if (hit) counts.set(hit.run.id, (counts.get(hit.run.id) ?? 0) + 1);
  }
  const source = [...sources.values()].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || b.created_at.localeCompare(a.created_at))[0];
  const sourceCampaign = source.campaigns.find((c) => c.advertiser_id === connection.advertiser_id) ?? source.campaigns[0];
  const first = read.groups[0];
  const ages = first.age_groups.filter((a) => AGES.has(a)) as LaunchSettings["age_groups"];
  const audience = (ids: string[]) => ids.map((id) => {
    const named = [...(source.draft.tiktok_settings.audiences?.include ?? []), ...(source.draft.tiktok_settings.audiences?.exclude ?? [])].find((a) => a.id === id);
    return { id, name: named?.name ?? id };
  });
  const settings: LaunchSettings = {
    ...structuredClone(source.draft.tiktok_settings),
    duplicate_copies: 0, start_paused: false, budget_mode: "BUDGET_MODE_TOTAL", daily_budget_usd: null,
    ...(first.age_groups.length ? { age_groups: ages } : {}),
  };
  if (first.audience_ids.length || first.excluded_audience_ids.length) settings.audiences = { include: audience(first.audience_ids), exclude: audience(first.excluded_audience_ids) };
  else delete settings.audiences;
  const budgets = read.groups.map((g) => g.budget_cents!);
  const budget = budgets.reduce((sum, value) => sum + value, 0);
  const draft: LaunchDraft = {
    ...structuredClone(source.draft),
    name: (opts.name?.trim() || read.campaign.name || `TikTok campaign ${read.campaign.id}`).slice(0, 80),
    account_ids: [connection.id], campaigns_per_account: 1, content_per_campaign: content.length, allocation: "unique",
    content, destination_url: "", title_id: null, campid_start: null,
    total_budget_cents: budget, daily_budget_cents: null, start_paused: false, tiktok_settings: settings,
  };
  const row: LaunchPlanRow = {
    index: 1, connection_id: connection.id, advertiser_id: connection.advertiser_id,
    name: read.campaign.name || `TikTok campaign ${read.campaign.id}`,
    content: structuredClone(content), budget_cents: budget, daily_budget_cents: null,
  };
  const lent = sourceCampaign?.state ?? {};
  const state: Record<string, unknown> = {
    campaign_id: read.campaign.id, tiktok_mode: read.mode, settings: structuredClone(settings),
    groups: read.groups.map((g, i) => ({ id: g.id, key: i === 0 ? "primary" : `adopted-${i + 1}`, ads: adsByGroup.get(g.id) ?? {}, ready: true })),
    posts, uploads, skipped: [],
    ...(lent.identity ? { identity: structuredClone(lent.identity) } : {}),
    ...(lent.pixel ? { pixel: structuredClone(lent.pixel) } : {}),
    budget_cents: budget, daily_budget_cents: null, planned_budgets: budgets,
    activated: true, launch_complete: true, prepare_while_paused: false,
    adopted: { source_run_ids: [...sources.keys()] },
  };
  return { ok: true, draft, row, state, budget_cents: budget, created_at: read.campaign.created_at, source_run_ids: [...sources.keys()] };
}
