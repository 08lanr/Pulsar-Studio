// Creator accounts (decision 2026-10-12): a thin route; the work is lib/creators/routes.ts.
import type { NextRequest } from "next/server";
import { getOverview, parse, patchAccount, settingsBody, staffOnly } from "@/lib/creators/routes";
import { handle } from "@/app/api/titles/_lib/handler";

export const dynamic = "force-dynamic";
type Ctx = { params: { id: string } };

export async function GET(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const g = await staffOnly();
    if (g.response) return g.response;
    return getOverview(g.session, params.id);
  });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const g = await staffOnly();
    if (g.response) return g.response;
    const p = await parse(req, settingsBody);
    if (p.response) return p.response;
    return patchAccount(g.session, params.id, p.data);
  });
}
