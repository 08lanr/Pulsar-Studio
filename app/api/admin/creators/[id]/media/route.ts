// Creator accounts (decision 2026-10-12): a thin route; the work is lib/creators/routes.ts.
import type { NextRequest } from "next/server";
import { listMedia, staffOnly, uploadMedia } from "@/lib/creators/routes";
import { handle } from "@/app/api/titles/_lib/handler";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: { id: string } };

export async function GET(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const g = await staffOnly();
    if (g.response) return g.response;
    return listMedia(g.session, params.id);
  });
}

/** Any staff member may add to the library; nothing is posted. */
export async function POST(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const g = await staffOnly();
    if (g.response) return g.response;
    return uploadMedia(g.session, params.id, req);
  });
}
