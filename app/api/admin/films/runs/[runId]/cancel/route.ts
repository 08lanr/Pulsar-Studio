import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { cancelRun } from "@/lib/segment/view";
import { handle } from "../../../../../titles/_lib/handler";

// POST → { run }: the run is `cancelled` now; a worker mid-script sees it at
// its next heartbeat, kills the child (`taskkill /T /F`) and releases the
// locks. The film folder is left as it is. Admin only; 409 when the run
// already ended.

export async function POST(req: NextRequest, { params }: { params: { runId: string } }) {
  return handle(req, async () => {
    const g = await requireStaff({ role: "admin" });
    if (g.response) return g.response;
    return NextResponse.json({ run: await cancelRun(g.session, params.runId) });
  });
}
