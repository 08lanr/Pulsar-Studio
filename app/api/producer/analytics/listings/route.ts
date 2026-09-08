import { NextResponse, type NextRequest } from "next/server";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { dataSource } from "@/lib/data-source";
import { handle } from "@/app/api/titles/_lib/handler";

// GET /api/producer/analytics/listings — the platform listings the caller's
// company may link a title to. Fixture mode returns the demo listings
// (labelled demo); supabase mode returns none with `requires_connection`
// until a provider is connected. Any producer role may read.

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer();
    if (g.response) return g.response;
    const listings = await getData().listAnalyticsListings(g.session);
    return NextResponse.json({ listings, source: dataSource() === "fixture" ? "demo" : null, state: listings.length ? "available" : "requires_connection" });
  });
}
