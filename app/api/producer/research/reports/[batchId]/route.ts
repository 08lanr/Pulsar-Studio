import { NextResponse, type NextRequest } from "next/server";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle } from "@/app/api/titles/_lib/handler";

// DELETE reverts an import batch: its rows disappear from every view, the
// batch stays on record as reverted. Reviewer/approver only.

export async function DELETE(req: NextRequest, { params }: { params: { batchId: string } }) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    return NextResponse.json({ batch: await getData().revertReportBatch(g.session, params.batchId) });
  });
}
