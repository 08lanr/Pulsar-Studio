// Creator accounts (decision 2026-10-12): a thin route; the work is lib/creators/routes.ts.
import type { NextRequest } from "next/server";
import { actOnPost, editBody, editPost, parse, postActionBody, staffOnly } from "@/lib/creators/routes";
import { handle } from "@/app/api/titles/_lib/handler";

export const dynamic = "force-dynamic";
type Ctx = { params: { id: string; postId: string } };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const g = await staffOnly();
    if (g.response) return g.response;
    const p = await parse(req, editBody);
    if (p.response) return p.response;
    return editPost(g.session, params.id, params.postId, p.data);
  });
}

/** { action: now | retry | cancel, revision } */
export async function POST(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const g = await staffOnly();
    if (g.response) return g.response;
    const p = await parse(req, postActionBody);
    if (p.response) return p.response;
    return actOnPost(g.session, params.id, params.postId, p.data);
  });
}
