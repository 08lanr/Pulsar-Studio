// Creator accounts (decision 2026-10-12): a thin route; the work is lib/creators/routes.ts.
import type { NextRequest } from "next/server";
import { actOnCommentRoute, commentBody, parse, staffOnly } from "@/lib/creators/routes";
import { handle } from "@/app/api/titles/_lib/handler";

export const dynamic = "force-dynamic";
type Ctx = { params: { id: string; commentId: string } };

/** { action: send | edit | skip, revision, reply_text? }: send posts a public reply on Instagram. */
export async function POST(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const g = await staffOnly();
    if (g.response) return g.response;
    const p = await parse(req, commentBody);
    if (p.response) return p.response;
    return actOnCommentRoute(g.session, params.id, params.commentId, p.data);
  });
}
