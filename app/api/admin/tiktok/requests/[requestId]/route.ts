import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// Staff move an account request along: provisioning (we are creating it in
// the Business Center) or declined. Assignment resolves it via /assign.

const schema = z.object({ status: z.enum(["provisioning", "declined"]), staff_note: z.string().trim().max(400).nullable().optional() });

export async function POST(req: NextRequest, { params }: { params: { requestId: string } }) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const parsed = await parseJson(req, schema);
    if (parsed.response) return parsed.response;
    return NextResponse.json({ request: await getData().resolveAccountRequest(g.session, params.requestId, parsed.data) });
  });
}
