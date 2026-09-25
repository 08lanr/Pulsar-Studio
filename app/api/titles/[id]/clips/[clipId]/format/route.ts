// Label a clip with its ad type, or clear the label (decision 2026-09-25,
// "Ad types on clips"; lib/ad-formats.ts). JSON { ad_format: AdFormat | null }
// -> { clip }. Any clip of the title may be labelled: an uploaded ad, a
// 60-second ad, a window the cutter made.
//
// Authorization is the caller's, as for the upload beside it: requireMember
// (staff, or a producer reviewer / approver) and assertTitleEditable (a viewer
// and a foreign title are refused); the row is then written by the system
// actor, because studio.clips has no producer update policy. A clip of another
// title is not found. On a database without migration 0023 the answer is a
// 409 that names the migration.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMember, systemSession } from "@/lib/auth";
import { AD_FORMATS } from "@/lib/ad-formats";
import { getData } from "@/lib/data";
import { handle, parseJson } from "../../../../_lib/handler";

const Body = z.object({ ad_format: z.enum(AD_FORMATS).nullable() });

export async function POST(req: NextRequest, { params }: { params: { id: string; clipId: string } }) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const p = await parseJson(req, Body);
    if (p.response) return p.response;
    const data = getData();
    await data.assertTitleEditable(g.session, params.id); // refuses a viewer and a foreign title
    const clip = await data.setClipAdFormat(systemSession(), params.id, params.clipId, p.data.ad_format);
    return NextResponse.json({ clip });
  });
}
