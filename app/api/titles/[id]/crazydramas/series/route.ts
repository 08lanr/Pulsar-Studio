// PUT /api/titles/[id]/crazydramas/series — create the title's DRAFT series
// on crazydramas, or update Studio's own draft (spec §1a–b). The slug is the
// title's (film-meta's crazydramas_slug; none is 409 not_linked). Refused
// before any call: a series made in the CMS (403 series_not_studio), a show
// already live under another name (409 series_title_exists with `existing`,
// from the working-name table and the public catalog), a poster that does not
// answer 200 image/* (400 poster_unreachable), writes disabled (409
// writes_disabled with `reason`). crazydramas' own refusals pass through with
// their words (409 series_title_exists / iap_product_id_taken /
// series_not_draft, 400 bad_request with `issues`, …). The title's approver
// or a staff administrator. Answers `{series, created, changed}`.
// Phase 5, "Upload to crazydramas"; lib/crazydramas/publish.ts saveSeries.

import type { NextRequest } from "next/server";
import { saveSeries } from "@/lib/crazydramas/publish";
import { SeriesBodySchema } from "@/lib/crazydramas/publish-types";
import { cdRoute } from "../_lib/publish-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  return cdRoute(req, params, "write", SeriesBodySchema, (session, titleId, body) => saveSeries(session, titleId, body));
}
