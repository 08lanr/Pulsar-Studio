// The team's own accounts left out of the CrazyDramas stats (decision
// 2026-09-24, "CrazyDramas stats: ads, the team, why viewers leave"). Staff
// read the list; a staff administrator replaces it. Emails only, kept in
// Studio's own storage (lib/crazydramas/stats-team.ts), sent to crazydramas in
// the stats request's body and nowhere else.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { apiError } from "@/lib/api-guard";
import { MAX_TEAM_EMAILS, normalizeTeamEmails, readTeamList, saveTeamList } from "@/lib/crazydramas/stats-team";
import { handle, parseJson } from "../../../titles/_lib/handler";

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    return NextResponse.json(await readTeamList());
  });
}

const Body = z.object({ emails: z.array(z.string().max(254)).max(MAX_TEAM_EMAILS * 2) }).strict();

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff({ role: "admin" });
    if (g.response) return g.response;
    const p = await parseJson(req, Body);
    if (p.response) return p.response;
    const normalized = normalizeTeamEmails(p.data.emails);
    if (!normalized.ok) return apiError(`Not an email: ${normalized.bad.join(", ")}`, { bad: normalized.bad }, 400);
    return NextResponse.json(await saveTeamList(normalized.emails, g.session.displayName || null));
  });
}
