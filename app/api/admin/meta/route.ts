import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { invalid } from "@/lib/data/errors";
import { currentMetaInventory } from "@/lib/meta/discovery";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: NextRequest) { return handle(req, async () => {
  const g = await requireStaff({ role: "admin" }); if (g.response) return g.response;
  return NextResponse.json({ inventory: await currentMetaInventory(), producers: await getData().listProducers(g.session) }, { headers: { "Cache-Control": "no-store" } });
}); }
export function POST(req: NextRequest) { return handle(req, async () => {
  const g = await requireStaff({ role: "admin" }); if (g.response) return g.response;
  const b = await parseJson(req, z.object({ producer_id: z.string().uuid(), advertiser_id: z.string().regex(/^(act_)?\d+$/), page_id: z.string().regex(/^\d+$/), instagram_id: z.string().regex(/^\d+$/).nullish() }));
  if (b.response) return b.response;
  const id = `act_${b.data.advertiser_id.replace(/^act_/, "")}`, inventory = await currentMetaInventory(true);
  const account = inventory.accounts.find(a => a.id === id && a.account_status === 1);
  if (!account || account.currency !== "USD") throw invalid("Choose an accessible, active USD advertising account.");
  if (!inventory.pages.some(p => p.id === b.data.page_id)) throw invalid("Facebook Page is not accessible to this integration.");
  if (b.data.instagram_id && !inventory.instagram.some(i => i.id === b.data.instagram_id && i.account_id === id))
    throw invalid("Choose an Instagram account accessible to this ad account.");
  const connection = await getData().assignLaunchConnection(g.session, { producer_id: b.data.producer_id, provider: "meta", advertiser_id: id, name: account.name, currency: account.currency, timezone: account.timezone_name, page_id: b.data.page_id, instagram_id: b.data.instagram_id || null, business_id: account.business?.id || null, enabled: true });
  return NextResponse.json({ connection });
}); }
