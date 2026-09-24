// Upload a finished ad as a clip (decision 2026-09-24). The cutter needs an
// episode video and re-cuts a 20-30 s window; a partner who already has a
// graded ad had no way in. Multipart { video, hook? }: the bytes are stored
// and hashed exactly as delivered, never re-encoded, and filed under the
// episode as a rendered, shortlisted clip the launch path can use at once.
//
// Authorization is the caller's (requireMember + assertTitleEditable, so a
// viewer and a foreign title are refused before any byte is stored); the row
// is written by the system actor because studio.clips has no producer insert
// policy — the same split the background cutter uses.

import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api-guard";
import { requireMember, systemSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { mediaUrl, uploadMedia, uploadedClipFilename } from "@/lib/data/storage";
import { probeSourceSize, withSourceFile } from "@/lib/clips/cut";
import { ffmpegAvailable } from "@/lib/promote/render";
import { probeDurationMs } from "@/lib/clips/signals";
import { episodeNumber, handle, isResponse } from "../../../../../_lib/handler";

/** Meta and TikTok both refuse a file this large; refuse it here rather than after the upload. */
const MAX_BYTES = 500 * 1024 * 1024;
const HOOK_MAX = 100;

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
    if (video.size > MAX_BYTES) {
      return apiError("that file is larger than 500 MB", undefined, 400);
    }
    const type = (video.type || "").toLowerCase();
    if (type && !type.startsWith("video/")) {
      return apiError("that file is not a video", undefined, 400);
    }

    const data = getData();
    // Refuse a viewer and a foreign title BEFORE the bytes are stored, so a
    // refused upload never leaves an orphan file in the bucket.
    await data.assertTitleEditable(g.session, params.id);
    const wb = await data.getWorkbench(g.session, params.id, n);

    const raw = form?.get("hook");
    const hook = (typeof raw === "string" ? raw : "").replace(/\s+/g, " ").trim().slice(0, HOOK_MAX);

    const bytes = new Uint8Array(await video.arrayBuffer());
    const render_sha256 = createHash("sha256").update(bytes).digest("hex");
    // The object key is CONTENT-ADDRESSED, never the caller's bare filename.
    // storagePath is <title>/<episode>/<name> and putObject upserts, so a
    // second `ad.mp4` would otherwise overwrite the first clip's bytes (its
    // recorded hash would then fail the launch re-verification, silently
    // dropping an approved ad) and an ad sharing the episode video's name
    // would overwrite the master. Hashing the name also makes a genuine
    // re-upload of identical bytes idempotent instead of destructive.
    const stored = await uploadMedia(
      params.id,
      wb.episode.id,
      uploadedClipFilename(render_sha256, video.name),
      bytes,
      video.type || undefined
    );

    // Duration and pixel size come from the file itself when ffmpeg is on the
    // machine; without it they stay null rather than inventing a range.
    let probed: { duration_ms: number | null; width: number | null; height: number | null } = { duration_ms: null, width: null, height: null };
    try {
      if (await ffmpegAvailable()) {
        probed = await withSourceFile(stored, async (srcAbs) => {
          const [duration_ms, size] = await Promise.all([probeDurationMs(srcAbs), probeSourceSize(srcAbs)]);
          return { duration_ms, width: size?.width ?? null, height: size?.height ?? null };
        });
      }
    } catch {
      // A probe failure is never a reason to lose an uploaded ad.
    }

    const clip = await data.addUploadedClip(systemSession(), wb.episode.id, {
      render_path: stored,
      render_sha256,
      hook_en: hook || video.name.replace(/\.[^.]+$/, "").slice(0, HOOK_MAX),
      ...probed,
    });
    return NextResponse.json({ clip, video_url: mediaUrl(stored) }, { status: 201 });
  });
}
