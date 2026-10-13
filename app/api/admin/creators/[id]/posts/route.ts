// Creator accounts (decision 2026-10-12): a thin route; the work is lib/creators/routes.ts.
import type { NextRequest } from "next/server";
import { createPost, listPosts, parse, scheduleBody, staffOnly } from "@/lib/creators/routes";
import { handle } from "@/app/api/titles/_lib/handler";

export const dynamic = "force-dynamic";
type Ctx = { params: { id: string } };

export async function GET(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const g = await staffOnly();
    if (g.response) return g.response;
    return listPosts(g.session, params.id);
  });
}

/** A draft, a scheduled post, or one published now (in the background; the Queue polls). */
export async function POST(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const g = await staffOnly();
    if (g.response) return g.response;
    const p = await parse(req, scheduleBody);
    if (p.response) return p.response;
    return createPost(g.session, params.id, p.data);
  });
}
