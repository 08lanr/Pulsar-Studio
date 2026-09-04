// A hand edit on one adapted line. The data layer flips authored_by to
// 'editor' and keeps the ai_* columns, and refuses when the line's version
// is frozen (409). The [id]/[n] segments are the workbench coordinates; the
// line id is what the row is looked up by.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-guard";
import { requireMember } from "@/lib/auth";
import { getData } from "@/lib/data";
import { TAGS } from "@/lib/types";
import { episodeNumber, handle, isResponse, parseJson } from "../../../../../_lib/handler";

const CHANGE_TYPES = ["keep", "literal", "rewrite", "tighten", "tone", "cultural", "pacing", "cut", "add"] as const;

const Patch = z.object({
  text_en: z.string().nullable().optional(),
  back_translation_zh: z.string().nullable().optional(),
  rationale_en: z.string().nullable().optional(),
  rationale_zh: z.string().nullable().optional(),
  tone_note_en: z.string().nullable().optional(),
  tone_note_zh: z.string().nullable().optional(),
  tags: z.array(z.enum(TAGS)).optional(),
  change_type: z.enum(CHANGE_TYPES).optional(),
  is_major: z.boolean().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; n: string; adaptedLineId: string } }
) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    const p = await parseJson(req, Patch);
    if (p.response) return p.response;
    if (!Object.keys(p.data).length) return apiError("Nothing to change", undefined, 400);
    const line = await getData().updateAdaptedLine(g.session, params.adaptedLineId, p.data);
    return NextResponse.json({ line });
  });
}
