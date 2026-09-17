import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle } from "@/app/api/titles/_lib/handler";

// Pulsar's launch presets, read-only for producers (decision 2026-09-16).

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireSession(); // producers and staff previewing alike
    if (g.response) return g.response;
    return NextResponse.json({ presets: await getData().listLaunchPresets(g.session) });
  });
}
