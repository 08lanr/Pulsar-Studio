import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth";
import { regionNames, searchRegions } from "@/lib/tiktok/regions";
import { handle } from "@/app/api/titles/_lib/handler";

// The location picker's search (decision 2026-09-16): ?q= names, ?ids= resolves ids to names.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireSession(); // producers and staff previewing alike
    if (g.response) return g.response;
    const q = req.nextUrl.searchParams;
    const ids = (q.get("ids") ?? "").split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).slice(0, 50);
    if (ids.length) return NextResponse.json({ names: await regionNames(ids) });
    const { hits, error } = await searchRegions(q.get("q") ?? "");
    return NextResponse.json({ hits, error: error ?? null });
  });
}
