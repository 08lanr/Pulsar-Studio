// One episode in: multipart with episode_number and a subtitle/script, video,
// or both. Promote may start with a finished video; Adapt attaches text later.
// Subtitle files are parsed BEFORE anything is stored so
// a bad upload leaves no orphan in the bucket; then both files go to storage
// and the data layer writes episode + scenes + lines + the cost-0
// parse_subtitles job and opens the draft version.
//
// Storage paths are <title_id>/<folder>/<file>, where <folder> is a uuid
// minted here: the episode's own id does not exist until
// addEpisodeFromIngest returns, and the media route only needs the title
// id (the first segment) to check access.

import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-guard";
import { requireMember } from "@/lib/auth";
import { getData } from "@/lib/data";
import { uploadImport, uploadMedia } from "@/lib/data/storage";
import { ingestEpisodeFile, type IngestResult } from "@/lib/ingest";
import { handle } from "../../_lib/handler";

const Fields = z.object({
  episode_number: z.coerce.number().int().positive(),
});

const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024;

function asFile(v: FormDataEntryValue | null): File | null {
  return v instanceof File && v.size > 0 ? v : null;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;

    const form = await req.formData().catch(() => null);
    if (!form) return apiError("Expected a multipart form", undefined, 400);
    const fields = Fields.safeParse({ episode_number: form.get("episode_number") });
    if (!fields.success) return apiError("Invalid request", fields.error.flatten(), 400);
    const video = asFile(form.get("video"));
    const subtitles = asFile(form.get("subtitles"));
    if (!subtitles && !video) return apiError("A subtitle/script or video file is required", undefined, 400);
    if (subtitles && subtitles.size > MAX_SUBTITLE_BYTES) return apiError("Subtitle file too large", undefined, 400);

    const folder = randomUUID();
    if (!subtitles && video) {
      const videoPath = await uploadMedia(params.id, folder, video.name, new Uint8Array(await video.arrayBuffer()), video.type || undefined);
      const episode = await getData().addVideoOnlyEpisode(g.session, params.id, fields.data.episode_number, videoPath);
      return NextResponse.json({ episode, warnings: [], summary: { lines: 0, scenes: 0, has_timecodes: false } }, { status: 201 });
    }

    const subtitleBytes = new Uint8Array(await subtitles!.arrayBuffer());
    let ingest: IngestResult;
    try {
      ingest = ingestEpisodeFile(subtitleBytes, subtitles!.name);
    } catch (e) {
      return apiError(`Could not parse ${subtitles!.name}`, e instanceof Error ? e.message : String(e), 400);
    }
    if (!ingest.lines.length) return apiError(`${subtitles!.name} parsed to no lines`, ingest.warnings, 400);

    const subtitlePath = await uploadImport(params.id, folder, subtitles!.name, subtitleBytes);
    const videoPath = video
      ? await uploadMedia(params.id, folder, video.name, new Uint8Array(await video.arrayBuffer()), video.type || undefined)
      : null;

    const episode = await getData().addEpisodeFromIngest(g.session, params.id, fields.data.episode_number, ingest, {
      subtitlePath,
      videoPath,
    });
    return NextResponse.json(
      {
        episode,
        warnings: ingest.warnings,
        summary: {
          lines: ingest.lines.length,
          scenes: ingest.scenes.length,
          has_timecodes: ingest.hasTimecodes,
        },
      },
      { status: 201 }
    );
  });
}
