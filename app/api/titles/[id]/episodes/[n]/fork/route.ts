// After the partner asks for an alternative (or after an approval that
// needs a change): fork_version() copies the in_review / approved version's
// adapted lines into a new draft, marks the parent superseded and writes
// the audit row. An open draft already existing is a 409.

import { NextResponse, type NextRequest } from "next/server";
import { requireMember } from "@/lib/auth";
import { DataError, getData } from "@/lib/data";
import { episodeNumber, handle, isResponse } from "../../../../_lib/handler";

export async function POST(req: NextRequest, { params }: { params: { id: string; n: string } }) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    const data = getData();
    const wb = await data.getWorkbench(g.session, params.id, n);
    if (!wb.version) throw new DataError("not_found", "no version for this episode yet");
    const version = await data.forkVersion(g.session, wb.version.id);
    return NextResponse.json({ version }, { status: 201 });
  });
}
