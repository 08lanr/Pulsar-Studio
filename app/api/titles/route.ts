// The projects list and "new title". POST creates the title row (and its one
// adaptation, per the data layer); episodes arrive later through
// POST /api/titles/[id]/ingest, one subtitle file per episode.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMember } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle, parseJson } from "./_lib/handler";

const CreateTitle = z.object({
  name_zh: z.string().trim().min(1),
  name_en: z.string().trim().nullish(),
  // Staff name the producer; a producer session is always their own company
  // (the data layer forces it), so the field is optional for them.
  producer_id: z.string().uuid().optional(),
  genre: z.string().trim().nullish(),
  synopsis_zh: z.string().trim().nullish(),
  synopsis_en: z.string().trim().nullish(),
  character_notes: z.string().trim().nullish(),
});

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const titles = await getData().listTitles(g.session);
    return NextResponse.json({ titles });
  });
}

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const p = await parseJson(req, CreateTitle);
    if (p.response) return p.response;
    const b = p.data;
    if (g.session.kind === "staff" && !b.producer_id) {
      return NextResponse.json({ error: "producer_id is required", code: "invalid" }, { status: 400 });
    }
    const title = await getData().createTitle(g.session, {
      name_zh: b.name_zh,
      name_en: b.name_en || null,
      producer_id: b.producer_id ?? g.session.producerId ?? "",
      genre: b.genre || null,
      synopsis_zh: b.synopsis_zh || null,
      synopsis_en: b.synopsis_en || null,
      character_notes: b.character_notes || null,
    });
    return NextResponse.json({ title }, { status: 201 });
  });
}
