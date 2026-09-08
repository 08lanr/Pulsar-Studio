import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// The customer-owned accounts Studio records (never creates): provider,
// kind, the state the customer reported, and what access Studio has.

const accountSchema = z.object({
  id: z.string().uuid().optional(),
  provider: z.enum(["tiktok", "meta", "youtube"]),
  kind: z.enum(["business_center", "ad_account", "channel", "pixel"]),
  name: z.string().trim().min(1).max(120),
  external_ref: z.string().trim().max(120).nullable().optional(),
  state: z.enum(["unconnected", "invited", "connected", "revoked"]),
  access: z.enum(["none", "partner", "owner_operated"]),
  note: z.string().trim().max(400).nullable().optional(),
});

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer();
    if (g.response) return g.response;
    return NextResponse.json({ accounts: await getData().listCompanyAccounts(g.session) });
  });
}

export async function PUT(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, accountSchema);
    if (parsed.response) return parsed.response;
    return NextResponse.json({ account: await getData().upsertCompanyAccount(g.session, parsed.data) });
  });
}
