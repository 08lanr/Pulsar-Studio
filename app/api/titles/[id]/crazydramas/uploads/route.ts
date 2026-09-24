// POST /api/titles/[id]/crazydramas/uploads — plan episodes (a list, or
// "all") for the background uploader and start it (spec §1c, §8). Uploading
// never publishes. `replace: true` sends a re-cut over an episode
// crazydramas already holds (spec §10, after the viewer warning). Answers
// `{queued, skipped}`: each episode not queued with the reason (no imported
// file, already on crazydramas, an older file still uploading, replace
// needed). Refused when writes are disabled (409 writes_disabled), the
// series does not exist yet (409 series_missing) or was made in the CMS
// (403 series_not_studio). The title's approver or a staff administrator.
// Phase 5, "Upload to crazydramas"; lib/crazydramas/publish.ts queueUploads.

import type { NextRequest } from "next/server";
import { queueUploads } from "@/lib/crazydramas/publish";
import { UploadsBodySchema } from "@/lib/crazydramas/publish-types";
import { cdRoute } from "../_lib/publish-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The rows are planned and answered at once; the bytes go in the background.
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return cdRoute(req, params, "write", UploadsBodySchema, (session, titleId, body) => queueUploads(session, titleId, body));
}
