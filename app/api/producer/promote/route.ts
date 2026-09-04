import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

const createSchema = z.object({
  title_id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  target_market: z.string().trim().min(2).max(40),
  destination_url: z.string().trim().url().nullable().optional(),
  objective: z.enum(["installs", "subscriptions", "views"]),
  spoiler_level: z.enum(["low", "medium", "high"]),
  creative_direction: z.string().trim().max(1000).nullable().optional(),
  exclusions: z.string().trim().max(1000).nullable().optional(),
});

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer();
    if (g.response) return g.response;
    return NextResponse.json({ campaigns: await getData().listPromoCampaigns(g.session) });
  });
}

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, createSchema);
    if (parsed.response) return parsed.response;
    return NextResponse.json({ campaign: await getData().createPromoCampaign(g.session, parsed.data) }, { status: 201 });
  });
}
