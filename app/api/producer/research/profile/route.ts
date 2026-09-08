import { normalizeMarkets } from '@/lib/research/navigation';
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { TROPES } from "@/lib/research/taxonomy";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// The onboarding answers that personalize the market desk. Reviewer or
// approver only (viewers read the desk, they do not describe the company);
// staff previewing the portal are refused by requireProducer, matching the
// data layer's own guard.

const tropeIds = TROPES.map((t) => t.id) as [string, ...string[]];

const profileSchema = z.object({
  tropes: z.array(z.enum(tropeIds)).max(12),
  audience: z.enum(["female", "male", "both"]).nullable(),
  titles_per_year: z.number().int().min(0).max(1000).nullable(),
  distribution: z.array(z.enum(["licensed", "self", "youtube", "none"])).max(4).refine(v => !v.includes("none") || v.length === 1, "Choose either Not yet or your distribution methods"),
  target_markets: z.array(z.string().trim().min(2).max(24)).max(8),
});

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer();
    if (g.response) return g.response;
    return NextResponse.json({ profile: await getData().getResearchProfile(g.session) });
  });
}

export async function PUT(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, profileSchema);
    if (parsed.response) return parsed.response;
    const profile = await getData().saveResearchProfile(g.session, {
      ...parsed.data,
      target_markets: normalizeMarkets(parsed.data.target_markets),
      tropes: parsed.data.tropes as typeof TROPES[number]["id"][],
    });
    return NextResponse.json({ profile });
  });
}
