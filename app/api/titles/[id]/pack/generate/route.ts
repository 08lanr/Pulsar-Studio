// A new batch of the creative pack (5 titles, 10 hooks, 3 descriptions,
// 3-5 thumbnail concepts, ad angles) from the current script and the bible.
// Each call appends a batch; existing picks are kept and shown to the model
// so it does not repeat them.

import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { runCreativePack } from "@/lib/jobs";
import { handle } from "../../../_lib/handler";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const r = await runCreativePack(g.session, params.id);
    return NextResponse.json({ variants: r.variants, added: r.added, job: r.job });
  });
}
