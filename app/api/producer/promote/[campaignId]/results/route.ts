import { NextResponse, type NextRequest } from "next/server";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { dataSource } from "@/lib/data-source";
import { handle } from "@/app/api/titles/_lib/handler";

// GET lists a campaign's results. POST (fixture mode only) simulates
// demo-labelled results for a submitted campaign so the decision loop can
// be exercised; in Supabase mode results come from Grow and POST is 409.

export async function GET(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return handle(req, async () => {
    const g = await requireProducer();
    if (g.response) return g.response;
    const detail = await getData().getPromoCampaign(g.session, params.campaignId);
    return NextResponse.json({ results: detail.results });
  });
}

export async function POST(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    if (dataSource() !== "fixture") return NextResponse.json({ error: "demo results exist only in fixture mode", code: "conflict" }, { status: 409 });
    return NextResponse.json({ detail: await getData().simulateDemoResults(g.session, params.campaignId) });
  });
}
