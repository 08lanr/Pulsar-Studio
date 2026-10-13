// Creator accounts (decision 2026-10-12): a thin route; the work is lib/creators/routes.ts.
import type { NextRequest } from "next/server";
import { listAccounts, staffOnly } from "@/lib/creators/routes";
import { handle } from "@/app/api/titles/_lib/handler";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await staffOnly();
    if (g.response) return g.response;
    return listAccounts(g.session);
  });
}
