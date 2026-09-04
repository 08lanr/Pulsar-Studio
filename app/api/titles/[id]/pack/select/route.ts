// The platform pick: one selected title and one selected hook per title
// (the data layer clears the previous pick of the same kind and mirrors a
// title pick onto the adaptation's display_title_en). Other kinds are 400.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle, parseJson } from "../../../_lib/handler";

const Body = z.object({ variant_id: z.string().uuid() });

export async function POST(req: NextRequest, { params: _params }: { params: { id: string } }) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const p = await parseJson(req, Body);
    if (p.response) return p.response;
    const variant = await getData().selectVariant(g.session, p.data.variant_id);
    return NextResponse.json({ variant });
  });
}
