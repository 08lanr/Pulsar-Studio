// The team's own accounts, left out of the CrazyDramas stats (decision
// 2026-09-24, "CrazyDramas stats: ads, the team, why viewers leave"): the
// emails the team buys and watches with on crazydramas.com. Kept as one small
// JSON file in Studio's own storage (the private studio-media bucket in live
// mode, .uploads/ in fixture mode), so a staff administrator changes it on the
// stats page and nobody runs SQL. crazydramas gets the list in the stats
// request's body and leaves those accounts' browsers and payments out.

import { z } from "zod";
import { putStoredBytes, readStoredBytes } from "@/lib/data/storage";

export const TEAM_FILE = "settings/crazydramas-stats-team.json";
export const MAX_TEAM_EMAILS = 100;

const Email = z.string().trim().toLowerCase().email().max(254);
const TeamFile = z.object({ emails: z.array(Email).max(MAX_TEAM_EMAILS), updated_at: z.string().nullable().optional(), updated_by: z.string().nullable().optional() });

export type TeamList = { emails: string[]; updated_at: string | null; updated_by: string | null };

/** Trimmed, lower-cased, de-duplicated, sorted; anything that is not an email is refused (the whole list, with the bad ones named). */
export function normalizeTeamEmails(raw: string[]): { ok: true; emails: string[] } | { ok: false; bad: string[] } {
  const bad: string[] = [];
  const out = new Set<string>();
  for (const r of raw) {
    const v = r.trim();
    if (!v) continue;
    const parsed = Email.safeParse(v);
    if (parsed.success) out.add(parsed.data);
    else bad.push(v);
  }
  if (bad.length) return { ok: false, bad };
  if (out.size > MAX_TEAM_EMAILS) return { ok: false, bad: [`more than ${MAX_TEAM_EMAILS} emails`] };
  return { ok: true, emails: [...out].sort() };
}

/** The saved list; empty when nothing was saved yet or the file cannot be read (the stats then leave nobody out). */
export async function readTeamList(): Promise<TeamList> {
  try {
    const parsed = TeamFile.safeParse(JSON.parse((await readStoredBytes(TEAM_FILE)).toString("utf8")));
    if (!parsed.success) return { emails: [], updated_at: null, updated_by: null };
    return { emails: parsed.data.emails, updated_at: parsed.data.updated_at ?? null, updated_by: parsed.data.updated_by ?? null };
  } catch {
    return { emails: [], updated_at: null, updated_by: null };
  }
}

/** Replaces the list (already normalized). The kept stats are keyed by the list, so the next read leaves the new list out. */
export async function saveTeamList(emails: string[], by: string | null): Promise<TeamList> {
  const list: TeamList = { emails, updated_at: new Date().toISOString(), updated_by: by };
  await putStoredBytes(TEAM_FILE, new TextEncoder().encode(`${JSON.stringify(list, null, 2)}\n`), "application/json");
  return list;
}
