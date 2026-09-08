import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-guard";
import { requireSession } from "@/lib/auth";
import { dataSource } from "@/lib/data-source";
import { currentFixtureSeed, resetFixtureStore } from "@/lib/data/fixture";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// Fixture mode only: rebuild the in-memory demo dataset from data/fixture so a
// rehearsal starts from the same rows every time (decision 2026-09-09, "one
// demo journey"). Any signed-in member may reset: the store is process-wide
// demo data, not anyone's record. In supabase mode this route does not exist.
// Production data is never reseeded from a fixture.

const Body = z.object({ seed: z.enum(["demo", "empty"]).optional() });

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    if (dataSource() !== "fixture") return apiError("Not found", undefined, 404);
    const g = await requireSession();
    if (g.response) return g.response;
    const parsed = await parseJson(req, Body);
    if (parsed.response) return parsed.response;
    const seed = parsed.data.seed ?? "demo";
    resetFixtureStore(seed);
    return NextResponse.json({ ok: true, seed, reset_at: new Date().toISOString() });
  });
}

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    if (dataSource() !== "fixture") return apiError("Not found", undefined, 404);
    const g = await requireSession();
    if (g.response) return g.response;
    return NextResponse.json({ mode: "fixture", seed: currentFixtureSeed() });
  });
}
