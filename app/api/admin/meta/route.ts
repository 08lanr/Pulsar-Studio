import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { invalid, notFound } from "@/lib/data/errors";
import { currentMetaInventory } from "@/lib/meta/discovery";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: NextRequest) { return handle(req, async () => {
  const g = await requireStaff({ role: "admin" }); if (g.response) return g.response;
  const producers = await getData().listProducers(g.session);
  // What each company already holds, so a second Page is added knowingly (decision 2026-10-25).
  const assigned = (await Promise.all(producers.map(p => getData().getLaunchConnections(g.session, p.id, "meta")))).flat();
  return NextResponse.json({ inventory: await currentMetaInventory(), producers, assigned }, { headers: { "Cache-Control": "no-store" } });
}); }
export function POST(req: NextRequest) { return handle(req, async () => {
  const g = await requireStaff({ role: "admin" }); if (g.response) return g.response;
  const b = await parseJson(req, z.object({
    producer_id: z.string().uuid(), advertiser_id: z.string().regex(/^(act_)?\d+$/), page_id: z.string().regex(/^\d+$/), instagram_id: z.string().regex(/^\d+$/).nullish(),
    auto_post: z.boolean().optional(), enabled: z.boolean().optional(),
  }));
  if (b.response) return b.response;
  const id = `act_${b.data.advertiser_id.replace(/^act_/, "")}`;
  if (b.data.enabled === false) {
    // Switching a connection off needs no fresh Meta read: it only stops Studio using it.
    const existing = (await getData().getLaunchConnections(g.session, b.data.producer_id, "meta")).find(c => c.advertiser_id === id && c.page_id === b.data.page_id);
    if (!existing) throw notFound("Meta account");
    const connection = await getData().assignLaunchConnection(g.session, { ...existing, enabled: false, auto_post: false });
    return NextResponse.json({ connection });
  }
  const inventory = await currentMetaInventory(true);
  const account = inventory.accounts.find(a => a.id === id && a.account_status === 1);
  if (!account || account.currency !== "USD") throw invalid("Choose an accessible, active USD advertising account.");
  if (!inventory.pages.some(p => p.id === b.data.page_id)) throw invalid("Facebook Page is not accessible to this integration.");
  if (b.data.instagram_id && !inventory.instagram.some(i => i.id === b.data.instagram_id && i.account_id === id))
    throw invalid("Choose an Instagram account accessible to this ad account.");
  // Studio publishes Reels through the Page, and a Page can only post to its own
  // Instagram account: a Page that has one may not be paired with another.
  const linked = inventory.pages.find(p => p.id === b.data.page_id)?.instagram_business_account?.id;
  if (b.data.instagram_id && linked && b.data.instagram_id !== linked)
    throw invalid("Choose the Instagram account linked to this Page; organic posts are published through the Page and reach only its own Instagram account.");
  const connection = await getData().assignLaunchConnection(g.session, {
    producer_id: b.data.producer_id, provider: "meta", advertiser_id: id, name: account.name, currency: account.currency, timezone: account.timezone_name,
    page_id: b.data.page_id, instagram_id: b.data.instagram_id || null, business_id: account.business?.id || null, enabled: true,
    ...(b.data.auto_post !== undefined ? { auto_post: b.data.auto_post } : {}),
  });
  return NextResponse.json({ connection });
}); }
