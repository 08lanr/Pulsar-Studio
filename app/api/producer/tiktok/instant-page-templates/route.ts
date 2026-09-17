import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle } from "@/app/api/titles/_lib/handler";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireSession();
    if (g.response) return g.response;
    return NextResponse.json({ templates: await getData().listInstantPageTemplates(g.session) });
  });
}
