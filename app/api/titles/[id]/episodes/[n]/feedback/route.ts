import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { episodeNumber, handle, isResponse, parseJson } from "../../../../_lib/handler";

const Body = z.object({
  version_id: z.string().uuid(),
  scene_id: z.string().uuid(),
  disposition: z.enum(["agreed", "partially_agreed", "disagreed"]),
  note: z.string().trim().min(1).max(1600),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; n: string } }
) {
  return handle(req, async () => {
    const guard = await requireStaff();
    if (guard.response) return guard.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    const parsed = await parseJson(req, Body);
    if (parsed.response) return parsed.response;
    const decision = await getData().respondToFeedback(
      guard.session,
      parsed.data.version_id,
      parsed.data.scene_id,
      parsed.data.disposition,
      parsed.data.note
    );
    return NextResponse.json({ decision });
  });
}
