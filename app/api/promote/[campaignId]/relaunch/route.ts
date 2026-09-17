import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { listBcAccounts } from "@/lib/tiktok/business-centers";
import { accountHealth } from "@/lib/tiktok/account-health";
import { relaunchOnAnotherAccount } from "@/lib/tiktok/controls";
import { runLaunch } from "@/lib/tiktok/launch";
import { invalidateMonitor } from "@/lib/tiktok/monitor";
import { fetchIdentities } from "@/lib/tiktok/preflight";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// Staff relaunch an ended or failed campaign on another ad account inside
// the company's Business Center (the suspended-account escape hatch;
// decision 2026-09-16). The previous TikTok campaign is switched off and
// read back FIRST (a failed launch can still hold a live campaign with the
// ads that made it; review finding 2), then a NEW launch row with the same
// approved manifest and budget. Never while the first launch is alive.

export const maxDuration = 300;

const schema = z.object({ advertiser_id: z.string().regex(/^\d{5,}$/), note: z.string().trim().max(400).nullable().optional() });

export async function POST(req: NextRequest, { params }: { params: { campaignId: string } }) {
  return NextResponse.json({"error": "This earlier campaign workflow is retired. Start a new launch from Clips → Launch.", "code": "conflict"}, { status: 409 });
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const parsed = await parseJson(req, schema);
    if (parsed.response) return parsed.response;
    const data = getData();
    const current = await data.getPromoCampaign(g.session, params.campaignId);
    const bc = await data.getLaunchBusinessCenter(g.session, current.campaign.producer_id);
    if (!bc?.external_ref) return NextResponse.json({ error: "the company has no Business Center assigned", code: "conflict" }, { status: 409 });
    const { accounts } = await listBcAccounts(bc.external_ref);
    const account = accounts.find((a) => a.id === parsed.data.advertiser_id);
    if (!account) return NextResponse.json({ error: "that ad account is not inside the company's Business Center", code: "conflict" }, { status: 409 });
    if (accountHealth(account.status) !== "ready") return NextResponse.json({ error: `ad account ${account.id} is not ready (${account.status ?? "unknown status"})`, code: "conflict" }, { status: 409 });
    const identities = await fetchIdentities(account.id);
    const identity = identities.find((i) => i.type === "BC_AUTH_TT") ?? identities[0];
    if (!identity) return NextResponse.json({ error: `ad account ${account.id} has no TikTok handle linked`, code: "conflict" }, { status: 409 });
    const { launch, previous_campaign_id, switched_off } = await relaunchOnAnotherAccount(g.session, params.campaignId, { advertiser_id: account.id, identity_id: identity.id, identity_type: identity.type, source: "business_center", bc_id: bc.external_ref }, parsed.data.note ?? null);
    const outcome = await runLaunch(launch.id);
    invalidateMonitor();
    return NextResponse.json({ launch: await data.getPromoLaunch(g.session, launch.id), outcome, previous_campaign_id, switched_off });
  });
}
