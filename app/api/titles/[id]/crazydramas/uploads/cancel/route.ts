// POST /api/titles/[id]/crazydramas/uploads/cancel — a person's Stop: one
// episode's upload (`episode`), or every queued or sending one of the title.
// An upload that has not sent its last byte stops before its next chunk; the
// unfinished upload on crazydramas expires within the hour and never reaches
// the episode. One whose bytes are all at Mux cannot be stopped (only
// unpublished). Answers `{cancelled}`, the episode numbers stopped. The
// title's approver or a staff administrator; needs no live-write gate (it
// sends nothing to crazydramas).
// Phase 5, "Upload to crazydramas"; lib/crazydramas/publish.ts cancelUploads.

import type { NextRequest } from "next/server";
import { cancelUploads } from "@/lib/crazydramas/publish";
import { CancelBodySchema } from "@/lib/crazydramas/publish-types";
import { cdRoute } from "../../_lib/publish-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return cdRoute(req, params, "write", CancelBodySchema, (session, titleId, body) => cancelUploads(session, titleId, body));
}
