import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// Staff admin assign an ad account from Pulsar's Business Center to a
// producer company: advertiser id + the TikTok handle the ads run under.
// This is what makes a company launch-ready (lib/promote/launch-gate.ts).

const schema = z.object({
  producer_id: z.string().uuid(),
  advertiser_id: z.string().trim().regex(/^\d{5,}$/, "TikTok's numeric ad account id"),
  name: z.string().trim().min(1).max(120),
  identity_id: z.string().trim().max(40).nullable().optional(),
  identity_type: z.enum(["BC_AUTH_TT", "TT_USER"]).nullable().optional(),
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
    const account = await getData().assignLaunchAccount(g.session, producer_id, { ...input, identity_id: input.identity_id ?? null, identity_type: input.identity_type ?? null });
    return NextResponse.json({ account });
  });
}
