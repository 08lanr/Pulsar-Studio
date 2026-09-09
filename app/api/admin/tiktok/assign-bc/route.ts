import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// Staff admin assign a Business Center to a producer company (decision
// 2026-09-09: "assign a BC, not an ad account"). Launches pick a ready ad
// account with a linked handle inside it (lib/tiktok/business-centers.ts).

const schema = z.object({
  producer_id: z.string().uuid(),
  bc_id: z.string().trim().regex(/^\d{5,}$/, "TikTok's numeric Business Center id"),
  name: z.string().trim().min(1).max(120),
  note: z.string().trim().max(400).nullable().optional(),
  request_id: z.string().uuid().nullable().optional(),
});

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff({ role: "admin" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, schema);
    if (parsed.response) return parsed.response;
    const { producer_id, ...input } = parsed.data;
    return NextResponse.json({ account: await getData().assignBusinessCenter(g.session, producer_id, input) });
  });
}
