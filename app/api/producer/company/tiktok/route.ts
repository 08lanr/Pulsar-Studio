import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireProducer, requireSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { accountStatusLabel } from "@/lib/tiktok/account-health";
import { describeProducerBusinessCenter } from "@/lib/tiktok/business-centers";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// The producer's own TikTok setup (decision 2026-09-16): the Business Center
// Pulsar linked to the company, every ad account inside it with its health
// and linked handles, which one the next launch would use, and the one
// they prefer. Tokens never appear; the ids are the company's own assets.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireSession();
    if (g.response) return g.response;
    // Staff previewing the producer portal have no company: an empty answer, not a refusal.
    if (!g.session.producerId) return NextResponse.json({ bc: null, accounts: [], error: null, pick: null });
    const d = await describeProducerBusinessCenter(g.session, g.session.producerId, { force: req.nextUrl.searchParams.get("force") === "1" });
    return NextResponse.json({
      bc: d.bc,
      accounts: d.accounts.map((a) => ({ ...a, statusLabel: accountStatusLabel(a.status) })),
      error: d.error ?? null,
      pick: d.pick ? (d.pick.ok ? { ok: true, advertiser_id: d.pick.pick.advertiser_id, identity_id: d.pick.pick.identity_id } : { ok: false, blocker: d.pick.blocker, reason: d.pick.reason }) : null,
    });
  });
}

const schema = z.object({ advertiser_id: z.string().regex(/^\d{5,}$/).nullable() });

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, schema);
    if (parsed.response) return parsed.response;
    return NextResponse.json({ account: await getData().setPreferredLaunchAccount(g.session, parsed.data.advertiser_id) });
  });
}
