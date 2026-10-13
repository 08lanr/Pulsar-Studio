// Creator accounts (decision 2026-10-12): a thin route; the work is lib/creators/routes.ts.
import type { NextRequest } from "next/server";
import { captionBody, captions, parse, staffOnly } from "@/lib/creators/routes";
import { handle } from "@/app/api/titles/_lib/handler";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: { id: string } };

/** Three caption options (a model call with its job row; canned in demo mode). Publishes nothing. */
export async function POST(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const g = await staffOnly();
    if (g.response) return g.response;
    const p = await parse(req, captionBody);
    if (p.response) return p.response;
    return captions(g.session, params.id, p.data);
  });
}
