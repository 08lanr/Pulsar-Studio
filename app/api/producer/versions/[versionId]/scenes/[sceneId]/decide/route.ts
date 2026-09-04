// The partner's one write: approve a scene, or ask for an alternative with
// a one-line reason (required for needs_alternative; the data layer
// enforces it and that the version is in_review). Reviewers and approvers
// may decide; viewers get 403. Upserts on (version, scene).

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

const Body = z.object({
  decision: z.enum(["approved", "needs_alternative"]),
  note: z.string().trim().max(1000).nullish(),
  line_id: z.string().uuid().nullish(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { versionId: string; sceneId: string } }
) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const p = await parseJson(req, Body);
    if (p.response) return p.response;
    const decision = await getData().decideScene(
      g.session,
      params.versionId,
      params.sceneId,
      p.data.decision,
      p.data.note || null,
      p.data.line_id || null
    );
    return NextResponse.json({ decision });
  });
}
