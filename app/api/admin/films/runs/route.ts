import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-guard";
import { requireStaff } from "@/lib/auth";
import { thisComputer } from "@/lib/computer";
import { getData } from "@/lib/data";
import { FILM_SLUG } from "@/lib/data/film-runs";
import { createRun } from "@/lib/segment/view";
import { ensureInProcessWorker } from "@/lib/segment/worker";
import { handle, parseJson } from "../../../titles/_lib/handler";

// The segmenting runs (decision 2026-09-23; docs/segment-a-film.md).
//   GET  ?producer_id=  → { runs, computer } newest first (staff read every company's; `computer` is this one, so the list marks the runs started elsewhere)
//   POST { producer_id, source_path, bucket, slug, mode, lang, settings } → { run } (201; admin)
// The source must be a file under one of the picker's roots; one live run
// per film folder. In fixture mode the first call boots the in-process
// worker, which drives the run from here on.

const Query = z.object({ producer_id: z.string().uuid().nullish() });

const Settings = z
  .object({
    allow_dirty: z.boolean().optional(),
    no_delogo: z.boolean().optional(),
    target_s: z.number().positive().optional(),
    band: z.tuple([z.number().positive(), z.number().positive()]).optional(),
    threads: z.number().int().positive().optional(),
    to_s: z.number().positive().nullish(),
    watermark_region: z.string().regex(/^\s*\d*\.?\d+\s*(,\s*\d*\.?\d+\s*){3}$/).nullish(),
    vision: z.enum(["api", "handoff"]).optional(),
    film_notes: z.string().max(2000).nullish(),
    /** The explicit claim of a film folder no Studio run made (B0); refused at intake without it. */
    claim_existing: z.boolean().optional(),
    /** Cut the rest of a delivered film under its pinned episodes; a delivered film is refused at intake without it. */
    extend: z.boolean().optional(),
  })
  .strict();

const Body = z.object({
  producer_id: z.string().uuid(),
  source_path: z.string().trim().min(1).max(1024),
  bucket: z.enum(["low-quality"]),
  slug: z.string().trim().regex(FILM_SLUG, "a slug is lowercase words joined by hyphens (a leading _ for a scratch folder)"),
  mode: z.enum(["by_eye_2min", "source_episodes"]),
  lang: z.string().trim().min(2).max(12).default("en"),
  settings: Settings.optional(),
});

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const parsed = Query.safeParse({ producer_id: req.nextUrl.searchParams.get("producer_id") || null });
    if (!parsed.success) return apiError("Invalid request", parsed.error.flatten(), 400);
    ensureInProcessWorker();
    const runs = await getData().listFilmRuns(g.session, parsed.data.producer_id ? { producerId: parsed.data.producer_id } : {});
    return NextResponse.json({ runs, computer: thisComputer() });
  });
}

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff({ role: "admin" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, Body);
    if (parsed.response) return parsed.response;
    const run = await createRun(g.session, { ...parsed.data, settings: parsed.data.settings ?? {} });
    ensureInProcessWorker();
    return NextResponse.json({ run }, { status: 201 });
  });
}
