import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// The company's watchlist of market listings. Any producer role reads;
// reviewer/approver add and remove. Staff previewing are refused by
// requireProducer, matching the data layer.

const keySchema = z.object({ listing_key: z.string().regex(/^(reelshort|dramabox)-[A-Za-z0-9]+$/) });

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer();
    if (g.response) return g.response;
    return NextResponse.json({ watchlist: await getData().listWatchlist(g.session) });
  });
}

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, keySchema);
    if (parsed.response) return parsed.response;
    return NextResponse.json({ watch: await getData().addWatch(g.session, parsed.data.listing_key) }, { status: 201 });
  });
}

export async function DELETE(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, keySchema);
    if (parsed.response) return parsed.response;
    await getData().removeWatch(g.session, parsed.data.listing_key);
    return NextResponse.json({ ok: true });
  });
}
