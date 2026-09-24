// GET  /api/titles/[id]/crazydramas/publish — where the title's series and
//      every episode stand on crazydramas (series_state, the series, the
//      form's defaults, per episode the ledger step, crazydramas' status,
//      published, free, the verdict), whether writes are enabled (and, when
//      not, the missing setting by name) and whether the paywall is live.
//      Whoever reads the title; `can_write` says whether the buttons are
//      theirs. The section polls it while uploads run.
// POST /api/titles/[id]/crazydramas/publish — publish exactly the listed
//      episodes, and the series when `publish_series` (spec §1d, §2). Each
//      must be uploaded and verified by Studio (409 not_verified); a paid one
//      needs `confirm_paid` until CRAZYDRAMAS_PAYWALL_LIVE=1 (409
//      paid_needs_confirm with `paid`); crazydramas' partial
//      `episodes_changed` comes back as that 409 with `published` and
//      `not_published`. The title's approver or a staff administrator.
// Phase 5, "Upload to crazydramas"; lib/crazydramas/publish.ts.

import type { NextRequest } from "next/server";
import { getPublishState, publishEpisodes } from "@/lib/crazydramas/publish";
import { PublishBodySchema } from "@/lib/crazydramas/publish-types";
import { cdRoute } from "../_lib/publish-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  return cdRoute(req, params, "read", null, (session, titleId) => getPublishState(session, titleId));
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return cdRoute(req, params, "write", PublishBodySchema, (session, titleId, body) => publishEpisodes(session, titleId, body));
}
