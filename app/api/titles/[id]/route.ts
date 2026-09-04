// The title page's payload: episodes with status and progress, every
// version row (snapshots omitted), the platform picks and cost to date.

import { NextResponse, type NextRequest } from "next/server";
import { requireMember } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle } from "../_lib/handler";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const detail = await getData().getTitle(g.session, params.id);
    return NextResponse.json(detail);
  });
}
