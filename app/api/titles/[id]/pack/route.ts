// The creative pack page's payload: every variant of the title (all kinds,
// dismissed included so the UI can show them struck) and every clip
// suggestion across its episodes.

import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle } from "../../_lib/handler";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const data = getData();
    const [variants, clips] = await Promise.all([
      data.listVariants(g.session, params.id),
      data.listClips(g.session, params.id),
    ]);
    return NextResponse.json({ variants, clips });
  });
}
