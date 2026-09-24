// POST /api/titles/[id]/crazydramas/series-text — the tagline, description and
// genres Studio drafts for the series form from the film's transcript (its
// opening and a sample, never the last fifth; decision 2026-09-23 "Upload
// automation: poster, slug, series text"; lib/crazydramas/series-text.ts).
// `{}` answers the newest draft of the title's current transcript (a model
// call only when there is none); `{again: true}` drafts anew. Fixture mode
// answers a canned draft (`status: demo`); with no model key the fields are
// empty and `note` says why (`status: unavailable`). The answer is the text
// alone — never the job row or its cost. The title's approver or a staff
// administrator (a draft spends).

import type { NextRequest } from "next/server";
import { SeriesTextBodySchema, type SeriesTextBody } from "@/lib/crazydramas/publish-types";
import { draftSeriesText } from "@/lib/crazydramas/series-text";
import { cdRoute } from "../_lib/publish-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return cdRoute(req, params, "write", SeriesTextBodySchema, (session, titleId, body) => draftSeriesText(session, titleId, { again: (body as SeriesTextBody).again === true }));
}
