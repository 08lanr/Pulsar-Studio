// Attach or replace an existing episode's video (2026-09-04). Ingest only
// accepted a video at episode creation, which made the dub demo invisible on
// any episode uploaded without one — this closes that gap: multipart
// { video }, stored beside the episode's other files, episode pointed at it.

import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api-guard";
import { requireMember } from "@/lib/auth";
import { getData } from "@/lib/data";
import { mediaUrl, uploadMedia } from "@/lib/data/storage";
import { episodeNumber, handle, isResponse } from "../../../../_lib/handler";

export async function POST(req: NextRequest, { params }: { params: { id: string; n: string } }) {
  return handle(req, async () => {
    const g = await requireMember();
    if (g.response) return g.response;
    const n = episodeNumber(params.n);
    if (isResponse(n)) return n;

    const form = await req.formData().catch(() => null);
    const video = form?.get("video");
    if (!(video instanceof File) || video.size === 0) {
      return apiError("a video file is required", undefined, 400);
    }

    const data = getData();
    const wb = await data.getWorkbench(g.session, params.id, n); // scoping + 404 for foreign titles
    const stored = await uploadMedia(
      params.id,
      wb.episode.id,
      video.name,
      new Uint8Array(await video.arrayBuffer()),
      video.type || undefined
    );
    const episode = await data.setEpisodeVideo(g.session, params.id, n, stored);
    return NextResponse.json({ episode, video_url: mediaUrl(stored) });
  });
}
