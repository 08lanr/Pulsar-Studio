import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { renderCampaignInBackground } from "@/lib/promote/generate";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// Pulsar answers a producer's change request with a new creative version.
// A revision that kept its window keeps the parent's finished file (clean
// cuts: copy is ad text, not pixels); one that moved it starts unrendered
// and is re-cut in the background here.
const schema = z.object({
  hypothesis: z.string().trim().max(500).nullable().optional(),
  hook: z.string().trim().min(1).max(300),
  caption: z.string().trim().min(1).max(1000),
  ad_description: z.string().trim().min(1).max(1000),
  source_start_ms: z.number().int().min(0).nullable().optional(),
  source_end_ms: z.number().int().min(0).nullable().optional(),
  revision_note: z.string().trim().max(1000).nullable().optional(),
});

export async function POST(req: NextRequest, { params }: { params: { creativeId: string } }) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const parsed = await parseJson(req, schema);
    if (parsed.response) return parsed.response;
    const creative = await getData().revisePromoCreative(g.session, params.creativeId, parsed.data);
    const rendering = !creative.render_path && (await renderCampaignInBackground(creative.campaign_id));
    return NextResponse.json({ creative, rendering });
  });
}
