import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// The structured experiment record on a campaign. PUT (reviewer+) saves the
// brief and clears any budget approval; POST (approver only) signs the
// budget. Neither spends money: a provider connection enforces budgets.

const experimentSchema = z.object({
  budget_usd: z.number().finite().min(1).max(100_000),
  hypothesis: z.string().trim().min(10).max(400),
  audience: z.string().trim().min(3).max(200),
  first_batch: z.number().int().min(1).max(10),
  signal: z.enum(["views", "clicks", "landing"]),
});

export async function PUT(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, experimentSchema);
    if (parsed.response) return parsed.response;
    return NextResponse.json({ campaign: await getData().setExperiment(g.session, params.campaignId, parsed.data) });
  });
}

export async function POST(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "approver" });
    if (g.response) return g.response;
    return NextResponse.json({ campaign: await getData().approveExperiment(g.session, params.campaignId) });
  });
}
