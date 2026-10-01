// The Campaigns tab's "Audience by age" (2026-10-01, Ruobin: "I just want to see that age range breakdown for each
// campaign, as well as an aggregate"): TikTok's own age split of each campaign's spend, impressions, clicks and
// checkouts (lib/tiktok/audience.ts), and all campaigns together. Pure.
//
//   - Shares are of spend (where the money went); a campaign with no spend in the period is left out.
//   - A campaign TikTok did not answer for is unknown, never zero: it shows "–" and stays out of the total, which
//     says how many it left out.
//   - Age groups in TikTok's order, its "NONE" (age not known) shown as "Unknown" last.

import type { AgeCell, AudienceRead } from "@/lib/tiktok/audience";

export const AGE_GROUPS = ["AGE_13_17", "AGE_18_24", "AGE_25_34", "AGE_35_44", "AGE_45_54", "AGE_55_100", "NONE"] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

/** "13–17", "55+", "Unknown". */
export function ageLabel(group: AgeGroup, unknown: string): string {
  if (group === "NONE") return unknown;
  const [, a, b] = group.split("_");
  return b === "100" ? `${a}+` : `${a}–${b}`;
}

export type AgeShare = { spend_cents: number; share: number | null; impressions: number; clicks: number; checkouts: number };
export type AudienceRow = {
  key: string;
  campaign_id: string | null;
  name: string;
  /** false: TikTok did not answer for its ad account (every cell "–"). */
  known: boolean;
  spend_cents: number;
  ages: Record<AgeGroup, AgeShare>;
};
export type AudienceTable = { total: AudienceRow; rows: AudienceRow[]; unknown: number; groups: AgeGroup[] };

const cents = (dollars: number) => Math.round(dollars * 100);
const groupOf = (age: string): AgeGroup => ((AGE_GROUPS as readonly string[]).includes(age) ? (age as AgeGroup) : "NONE");

function rowOf(key: string, campaignId: string | null, name: string, known: boolean, cells: Record<string, AgeCell>[]): AudienceRow {
  const sums = Object.fromEntries(AGE_GROUPS.map((g) => [g, { spend_cents: 0, share: null, impressions: 0, clicks: 0, checkouts: 0 }])) as Record<AgeGroup, AgeShare>;
  for (const byAge of cells)
    for (const [age, c] of Object.entries(byAge)) {
      const s = sums[groupOf(age)];
      s.spend_cents += cents(c.spend);
      s.impressions += c.impressions;
      s.clicks += c.clicks;
      s.checkouts += c.conversion;
    }
  const spend = AGE_GROUPS.reduce((n, g) => n + sums[g].spend_cents, 0);
  for (const g of AGE_GROUPS) sums[g].share = known && spend > 0 ? sums[g].spend_cents / spend : null;
  return { key, campaign_id: campaignId, name, known, spend_cents: spend, ages: sums };
}

/**
 * One row per campaign (in the order given, those that spent in the period, or TikTok did not answer for) and
 * the total over the campaigns TikTok answered for. `groups`: the age groups shown, "Unknown" only when any
 * campaign has some.
 */
export function audienceTable(read: AudienceRead, campaigns: readonly { key: string; campaign_id: string | null; name: string }[], total: string): AudienceTable {
  const covered = new Set(read.covered);
  const rows: AudienceRow[] = [];
  let unknown = 0;
  for (const c of campaigns) {
    if (!c.campaign_id) continue;
    if (!covered.has(c.campaign_id)) {
      unknown++;
      rows.push(rowOf(c.key, c.campaign_id, c.name, false, []));
      continue;
    }
    const row = rowOf(c.key, c.campaign_id, c.name, true, [read.campaigns[c.campaign_id] ?? {}]);
    if (row.spend_cents > 0) rows.push(row);
  }
  const answered = campaigns.filter((c) => c.campaign_id && covered.has(c.campaign_id)).map((c) => read.campaigns[c.campaign_id!] ?? {});
  const sum = rowOf("total", null, total, true, answered);
  const groups = AGE_GROUPS.filter((g) => g !== "NONE" || [sum, ...rows].some((r) => r.ages.NONE.spend_cents > 0));
  return { total: sum, rows, unknown, groups };
}
