import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { decideRun } from "@/lib/segment/view";
import { ensureInProcessWorker } from "@/lib/segment/worker";
import { handle, parseJson } from "../../../../../titles/_lib/handler";

// POST one decision on a run → { run }. Every kind is validated against the
// run's stage and the film as it is (a move must be a legal cut in band, an
// apply needs every required decision, a join needs a delivered render) and
// appended to film_runs.decisions with who and when; the worker acts on it
// at its next tick. A refusal is 409 with the reason. Admin only.

const Region = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const Exclusion = z.object({ from_s: z.number().nonnegative(), to_s: z.number().nonnegative(), why: z.string().min(1), kind: z.string().nullish() });

const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("watermark"), accept: z.boolean().optional(), region: Region.optional(), no_delogo: z.boolean().optional() }),
  z.object({ kind: z.literal("unmark"), action: z.enum(["find", "fit", "test", "edge_fill"]), boxes: z.string().nullish() }),
  z.object({ kind: z.literal("cards"), templates: z.array(z.number().nonnegative()).min(1) }),
  z.object({ kind: z.literal("boundary"), boundary_s: z.number(), action: z.enum(["accept", "move", "reject", "remove"]), to_t: z.number().nullish(), reason: z.string().max(2000).nullish() }),
  z.object({ kind: z.literal("apply_review") }),
  z.object({ kind: z.literal("join"), join_index: z.number().int().positive(), to_t: z.number(), reason: z.string().max(2000).nullish() }),
  z.object({
    kind: z.literal("film_meta"),
    display_title_en: z.string().trim().min(1).max(200),
    crazydramas_slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).nullish(),
    spoiler_from_s: z.number().nonnegative().nullish(),
    exclusions: z.array(Exclusion).optional(),
    live_poster: z.string().trim().max(200).nullish(),
  }),
  z.object({ kind: z.literal("import_now") }),
  z.object({ kind: z.literal("handoff_vision"), output_path: z.string().trim().max(1024).nullish() }),
  z.object({ kind: z.literal("retry") }),
  z.object({ kind: z.literal("note"), text: z.string().trim().min(1).max(2000) }),
]);

export async function POST(req: NextRequest, { params }: { params: { runId: string } }) {
  return handle(req, async () => {
    const g = await requireStaff({ role: "admin" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, Body);
    if (parsed.response) return parsed.response;
    const run = await decideRun(g.session, params.runId, parsed.data);
    ensureInProcessWorker();
    return NextResponse.json({ run });
  });
}
