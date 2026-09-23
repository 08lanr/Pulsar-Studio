import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-guard";
import { requireStaff } from "@/lib/auth";
import { ffprobeFacts } from "@/lib/film-import/import";
import { listSources } from "@/lib/segment/intake";
import { runnerFor } from "@/lib/segment/worker";
import { handle } from "../../../titles/_lib/handler";

// GET ?dir=<downloads|onedrive|workspace|absolute path>&probe=1 — the
// server-side source picker of the intake (decision 6, 2026-09-23): the video
// files directly inside one of the folders Studio may read a source from,
// newest first, with the downloader's `_Media_` name parsed and, with
// `probe`, ffprobe's size and frame rate. A path outside the roots is 400.
// Staff only; the file itself is never sent anywhere.

const Query = z.object({ dir: z.string().trim().min(1).max(1024).default("downloads"), probe: z.string().nullish() });

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const parsed = Query.safeParse({ dir: req.nextUrl.searchParams.get("dir") || undefined, probe: req.nextUrl.searchParams.get("probe") });
    if (!parsed.success) return apiError("Invalid request", parsed.error.flatten(), 400);
    const probe = parsed.data.probe === "1" ? (runnerFor().fake ? (f: string) => runnerFor().probe(f) : ffprobeFacts) : null;
    return NextResponse.json(await listSources(parsed.data.dir, { probe }));
  });
}
