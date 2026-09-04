// The producer's one-action gate: freeze the draft (snapshot + sha256) AND
// approve it, with per-scene sign-off rows. The data layer refuses staff —
// staff submit for review and approve on behalf, so an approval always says
// truthfully which side made it.

import { NextResponse, type NextRequest } from "next/server";
import { requireMember } from "@/lib/auth";
import { DataError, getData } from "@/lib/data";
import { runQc } from "@/lib/qc";
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
    // QC preflight: errors block delivery outright; warnings ship visibly.
    const qc = runQc({
      lines: wb.lines,
      adapted: wb.adapted_lines.filter((a) => a.version_id === wb.version!.id),
      characterNames: new Map(wb.characters.map((c) => [c.id, c.name_en])),
    });
    if (qc.errors.length) {
      return NextResponse.json(
        { error: `QC found ${qc.errors.length} blocking issue(s)`, code: "qc_failed", qc },
        { status: 409 }
      );
    }
    const version = await data.finalizeVersion(g.session, wb.version.id);
    return NextResponse.json({ version, qc });
  });
}
