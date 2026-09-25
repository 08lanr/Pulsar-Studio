import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-guard";
import { requireStaff, systemSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { FolderImportRequestSchema, folderImportProgress, scanFolder, startFolderImport } from "@/lib/film-import/folder";
import { handle, parseJson } from "../../../titles/_lib/handler";

// "Upload by folder" (decision 2026-09-24): a folder of ep1.mp4 … epN.mp4 on
// THIS computer becomes a title for a company. Admin staff only, both ways:
// the folder is a path on the server's own disk, so even reading its listing
// is not a producer's (or a viewer's) to ask for.
//
//   GET  ?folder=…&producer_id=…  what the folder holds (episodes, size, what
//                                  stands in the way), the company's title for
//                                  it when there is one, and the import's
//                                  progress — the card polls this while it runs
//   POST {folder, display_title, producer_id}  starts the import (202)

const Query = z.object({ folder: z.string().trim().min(1).max(1000), producer_id: z.string().uuid().nullish() });

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff({ role: "admin" });
    if (g.response) return g.response;
    const parsed = Query.safeParse({ folder: req.nextUrl.searchParams.get("folder") ?? "", producer_id: req.nextUrl.searchParams.get("producer_id") || null });
    if (!parsed.success) return apiError("Invalid request", parsed.error.flatten(), 400);
    const scan = await scanFolder(parsed.data.folder);
    const producerId = parsed.data.producer_id ?? null;
    const title = producerId ? await getData().findTitleBySourceRef(systemSession(), producerId, scan.source_ref) : null;
    return NextResponse.json({
      scan,
      title: title ? { id: title.id, external_id: title.external_id, name: title.name_en ?? title.name_zh, crazydramas_slug: title.crazydramas_slug ?? null } : null,
      progress: producerId ? folderImportProgress(producerId, scan.source_ref) : null,
    });
  });
}

const Body = FolderImportRequestSchema.extend({ producer_id: z.string().uuid() });

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff({ role: "admin" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, Body);
    if (parsed.response) return parsed.response;
    const { producer_id, ...request } = parsed.data;
    const started = await startFolderImport(g.session, request, producer_id, g.session.userId);
    return NextResponse.json(started, { status: 202 });
  });
}
