// POST /api/titles/[id]/crazydramas/unpublish — hide the listed episodes on
// crazydramas; `unpublish_series` sets a published series back to draft (as
// the CMS's Unpublish does). The ledger rows go back to `verified`.
// crazydramas' refusals pass through (404 episodes_not_found with `missing`,
// 403 series_not_studio, …); writes disabled is 409 writes_disabled. The
// title's approver or a staff administrator. Answers `{unpublished,
// already_unpublished, series_status}`.
// Phase 5, "Upload to crazydramas"; lib/crazydramas/publish.ts unpublishEpisodes.

import type { NextRequest } from "next/server";
import { unpublishEpisodes } from "@/lib/crazydramas/publish";
import { UnpublishBodySchema } from "@/lib/crazydramas/publish-types";
import { cdRoute } from "../_lib/publish-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return cdRoute(req, params, "write", UnpublishBodySchema, (session, titleId, body) => unpublishEpisodes(session, titleId, body));
}
