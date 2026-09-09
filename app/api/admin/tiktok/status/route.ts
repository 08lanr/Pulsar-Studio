import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { connectionStatus, describeAdvertisers, probeAdvertiser } from "@/lib/tiktok/preflight";
import { reachableAdvertiserIds } from "@/lib/tiktok/tokens";
import { launchMode } from "@/lib/tiktok";
import { schedulerStatus } from "@/lib/tiktok/scheduler";
import { handle } from "@/app/api/titles/_lib/handler";
import { DEMO_ADVERTISER_ID } from "@/data/fixture/demo-catalog";

// Everything the TikTok setup page renders: the operator connection
// (described, never the tokens), the ad accounts it reaches, one account's
// probe on demand (?advertiser=), the open account requests and the
// scheduler. Live TikTok calls happen here, so the page fetches on demand.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const connection = connectionStatus();
    const ids = launchMode() === "fake" ? [DEMO_ADVERTISER_ID] : [...reachableAdvertiserIds()];
    const accounts = ids.length && connection.connected ? await describeAdvertisers(ids.slice(0, 60)) : ids.map((advertiserId) => ({ advertiserId }));
    const probeId = req.nextUrl.searchParams.get("advertiser");
    const probe = probeId && /^\d{5,}$/.test(probeId) && connection.connected ? await probeAdvertiser(probeId) : null;
    const [requests, producers] = await Promise.all([getData().listAccountRequests(g.session), getData().listProducers(g.session)]);
    return NextResponse.json({ connection, accounts, accountsOmitted: Math.max(0, ids.length - 60), probe, requests, producers: producers.map((p) => ({ id: p.id, name_zh: p.name_zh, name_en: p.name_en })), scheduler: schedulerStatus() });
  });
}
