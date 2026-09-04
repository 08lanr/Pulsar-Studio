// Shortlist or dismiss a clip suggestion (or put it back to suggested). A
// re-run of the finder replaces only `suggested` rows, so a shortlist
// survives it.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle, parseJson } from "../../../../_lib/handler";

const Body = z.object({ status: z.enum(["suggested", "shortlisted", "dismissed"]) });

export async function POST(req: NextRequest, { params }: { params: { id: string; clipId: string } }) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const p = await parseJson(req, Body);
    if (p.response) return p.response;
    const clip = await getData().setClipStatus(g.session, params.clipId, p.data.status);
    return NextResponse.json({ clip });
  });
}
