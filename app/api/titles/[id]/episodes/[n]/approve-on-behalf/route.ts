// The pilot path: a staff ADMIN records the producer's approval (a WeChat
// screenshot, an email) with an evidence note. approve_version(on_behalf)
// completes every undecided scene as staff_on_behalf, moves in_review ->
// approved and writes the audit row with the note. Editors get 403.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { DataError, getData } from "@/lib/data";
import { episodeNumber, handle, isResponse, parseJson } from "../../../../_lib/handler";

const Body = z.object({
  evidence_note: z.string().trim().min(1).max(4000),
  channel: z.enum(["in_app", "wechat", "email", "script"]).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string; n: string } }) {
  return handle(req, async () => {
    const g = await requireStaff({ role: "admin" });
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    const p = await parseJson(req, Body);
    if (p.response) return p.response;
    const data = getData();
    const wb = await data.getWorkbench(g.session, params.id, n);
    if (!wb.version) throw new DataError("not_found", "no version for this episode yet");
    const version = await data.approveVersion(g.session, wb.version.id, {
      mode: "on_behalf",
      evidenceNote: p.data.evidence_note,
      channel: p.data.channel ?? "wechat",
    });
    return NextResponse.json({ version });
  });
}
