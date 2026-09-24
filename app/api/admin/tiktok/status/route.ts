import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { accountHealth, accountStatusLabel } from "@/lib/tiktok/account-health";
import { listBcAccounts, listBusinessCenters } from "@/lib/tiktok/business-centers";
import { connectionStatus, describeAdvertisers, probeAdvertiser, probePixel } from "@/lib/tiktok/preflight";
import { tiktokDefaultAdvertiserId } from "@/lib/tiktok/defaults";
import { tiktokPixelCode, type PixelResolution } from "@/lib/tiktok/pixel";
import { schedulerStatus } from "@/lib/tiktok/scheduler";
import { handle } from "@/app/api/titles/_lib/handler";

// Everything the TikTok setup page renders, Pulsar Grow's shape: the
// operator connection (described, never the tokens), the Business Centers
// every authorization reaches (cheap, names only), one BC's accounts with
// their health on demand (?bc=), one account's probe on demand
// (?advertiser=), the open account requests, and the scheduler. Live TikTok
// calls happen here, so the page fetches on demand; ?force=1 refreshes the
// 30-minute caches. The launch defaults (decision 2026-09-23): the one ad
// account launches start on (TIKTOK_DEFAULT_ADVERTISER_ID), which companies'
// assignments reach it, and the pixel read on it (/pixel/list/, read-only;
// TIKTOK_PIXEL_ID, unverified, while TikTok refuses that read for want of the
// permission, with the owner /bc/pixel/get/ names, since 2026-09-24).

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const q = req.nextUrl.searchParams;
    const force = q.get("force") === "1";
    const connection = connectionStatus();
    const bcs = connection.connected ? await listBusinessCenters({ force }) : { businessCenters: [], errors: [] };
    const bcId = q.get("bc");
    const bcAccounts = bcId && /^\d{5,}$/.test(bcId) && connection.connected ? await listBcAccounts(bcId, { force }) : null;
    const accounts = bcAccounts ? bcAccounts.accounts.map((a) => ({ ...a, health: accountHealth(a.status), statusLabel: accountStatusLabel(a.status) })) : [];
    const probeId = q.get("advertiser");
    const probe = probeId && /^\d{5,}$/.test(probeId) && connection.connected ? await probeAdvertiser(probeId) : null;
    const data = getData();
    const [requests, producers] = await Promise.all([data.listAccountRequests(g.session), data.listProducers(g.session)]);
    // Which producer each Business Center / account is assigned to, so the page can say so.
    const assignments: Record<string, { producerId: string; kind: "business_center" | "ad_account" }> = {};
    for (const p of producers) {
      const [bc, account] = await Promise.all([data.getLaunchBusinessCenter(g.session, p.id), data.getLaunchAccount(g.session, p.id)]);
      if (bc?.external_ref) assignments[bc.external_ref] = { producerId: p.id, kind: "business_center" };
      if (account?.external_ref) assignments[account.external_ref] = { producerId: p.id, kind: "ad_account" };
    }
    // The launch defaults: read-only, and only when a default account is set.
    const defaultId = tiktokDefaultAdvertiserId();
    const pixelCode = tiktokPixelCode();
    let launchDefaults: { advertiserId: string | null; name: string | null; status: string | null; reachedBy: string[]; pixelCode: string; pixel: PixelResolution | null } = { advertiserId: defaultId, name: null, status: null, reachedBy: [], pixelCode, pixel: null };
    if (defaultId && connection.connected) {
      const [described] = await describeAdvertisers([defaultId]);
      const reachedBy: string[] = [];
      for (const p of producers) {
        const [bc, account] = await Promise.all([data.getLaunchBusinessCenter(g.session, p.id), data.getLaunchAccount(g.session, p.id)]);
        const inBc = bc?.assigned_by && bc.external_ref ? (await listBcAccounts(bc.external_ref)).accounts.some((a) => a.id === defaultId) : false;
        if (inBc || (account?.assigned_by && account.external_ref === defaultId)) reachedBy.push(p.id);
      }
      // The Business Center holding the account (cached listings), so a pixel ID set by hand can name the pixel's owner.
      let bcOfDefault: string | null = null;
      for (const b of bcs.businessCenters) if (!bcOfDefault && (await listBcAccounts(b.bcId)).accounts.some((a) => a.id === defaultId)) bcOfDefault = b.bcId;
      launchDefaults = { advertiserId: defaultId, name: described?.name ?? null, status: described?.status ?? null, reachedBy, pixelCode, pixel: await probePixel(defaultId, pixelCode, bcOfDefault) };
    }
    return NextResponse.json({
      connection,
      launchDefaults,
      businessCenters: bcs.businessCenters,
      bcErrors: bcs.errors,
      bc: bcId ? { bcId, accounts, error: bcAccounts?.error ?? null } : null,
      probe,
      requests,
      producers: producers.map((p) => ({ id: p.id, name_zh: p.name_zh, name_en: p.name_en })),
      assignments,
      scheduler: schedulerStatus(),
    });
  });
}
