// The partner's home: their own titles, each with the episodes that have a
// version in_review (awaiting their decision) or approved. Drafts never
// appear; the data layer scopes to session.producerId (RLS in supabase
// mode, canReadTitle in fixture mode).

import { NextResponse, type NextRequest } from "next/server";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle } from "../../titles/_lib/handler";

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer();
    if (g.response) return g.response;
    const titles = await getData().getProducerTitles(g.session);
    return NextResponse.json({ titles });
  });
}
