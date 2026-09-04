// Partner "Approve episode": approve_version() in producer mode. Approvers
// only; the data layer records an approved sign-off for every scene (there
// is no per-scene request loop on the producer side — 2026-09-03 evening),
// moves in_review -> approved (frozen from here on) and writes the audit
// row. The staff on-behalf path is a separate admin route.

import { NextResponse, type NextRequest } from "next/server";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle } from "../../../../titles/_lib/handler";

export async function POST(req: NextRequest, { params }: { params: { versionId: string } }) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "approver" });
    if (g.response) return g.response;
    const version = await getData().approveVersion(g.session, params.versionId, { mode: "producer", channel: "in_app" });
    return NextResponse.json({ version });
  });
}
