import { NextResponse, type NextRequest } from "next/server";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { launchSettingsSchema, LaunchSettingsError, validateLaunchSettings } from "@/lib/tiktok/settings";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// The shape of the launch (decision 2026-09-16): targeting, budget shape,
// schedule, bidding, pacing, CTA, live or paused, auto-duplicate copies.
// Editors set it before launch; it is validated against the signed budget
// the moment it is saved so the Launch button never meets a surprise.

export async function PUT(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, launchSettingsSchema);
    if (parsed.response) return parsed.response;
    const data = getData();
    const current = await data.getPromoCampaign(g.session, params.campaignId);
    const budget = current.campaign.experiment?.budget_usd ?? 0;
    let warning: string | null = null;
    try {
      validateLaunchSettings(parsed.data, budget);
    } catch (e) {
      if (!(e instanceof LaunchSettingsError)) throw e;
      // Saved anyway (the budget may still change); the page shows the problem until it is fixed.
      warning = e.message;
    }
    const campaign = await data.setLaunchSettings(g.session, params.campaignId, parsed.data);
    return NextResponse.json({ campaign, warning });
  });
}
