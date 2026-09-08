import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// POST /api/producer/analytics/titles/[id]/link { listing_id } — map the
// title to a platform listing; DELETE removes the mapping. Reviewer+ only;
// the data layer's per-title check (requireTitleEditor / RLS) decides the
// title, a listing linked elsewhere is a 409 conflict, a foreign title 404.

const Body = z.object({ listing_id: z.string().regex(/^lst_[a-z0-9_]{3,80}$/) });

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, Body);
    if (parsed.response) return parsed.response;
    const link = await getData().linkAnalyticsListing(g.session, params.id, parsed.data.listing_id);
    return NextResponse.json({ link });
  });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    await getData().unlinkAnalyticsListing(g.session, params.id);
    return NextResponse.json({ ok: true });
  });
}
