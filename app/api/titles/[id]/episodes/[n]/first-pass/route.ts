// The AI first pass on an episode, run inline (V1: the editor waits). One
// job per scene, idempotent on (version, scene, prompt version), so a
// re-run after a partial failure resumes where it stopped. Optional body
// { scene_id } limits the run to one scene.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireMember } from "@/lib/auth";
import { demoReplayActive, replayFirstPass } from "@/lib/demo-replay";
import { runFirstPass } from "@/lib/jobs";
import { episodeNumber, handle, isResponse, parseJson } from "../../../../_lib/handler";

const Body = z.object({ scene_id: z.string().uuid().optional() });

export async function POST(req: NextRequest, { params }: { params: { id: string; n: string } }) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;
    const p = await parseJson(req, Body);
    if (p.response) return p.response;

    // Fixture mode replays the pre-authored adaptations (lib/demo-replay.ts):
    // same shape, zero spend, deterministic — the demo never calls a model.
    if (demoReplayActive()) {
      const r = await replayFirstPass(g.session, params.id, n, { sceneId: p.data.scene_id });
      return NextResponse.json({
        job: r.job,
        version: r.version,
        scenes: r.scenes.map((s) => ({ scene_id: s.scene_id, scene_number: s.scene_number, skipped: false, lines: s.lines.length })),
        cost_cents: 0,
        unmatched: r.unmatched,
      });
    }

    const r = await runFirstPass(g.session, params.id, n, { sceneId: p.data.scene_id });
    return NextResponse.json({
      job: r.job,
      version: r.version,
      scenes: r.scenes.map((s) => ({ scene_id: s.scene_id, scene_number: s.scene_number, skipped: s.skipped, lines: s.lines.length })),
      cost_cents: r.cost_cents,
    });
  });
}
