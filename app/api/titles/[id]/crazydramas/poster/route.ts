// POST /api/titles/[id]/crazydramas/poster — the series poster, made ready to
// send (decision 2026-09-23 "Upload automation: poster, slug, series text";
// lib/crazydramas/poster.ts). JSON `{source: "cover"}`: the title's cover,
// normalised to a 1200×1600 JPEG and stored in Studio's public bucket
// (`public-posters`, made on first use; fixture mode: a folder served by
// /api/public-posters/…), its public URL checked to answer 200 image/jpeg.
// Multipart with `file`: a picked image, the same way. JSON `{source: "url",
// url}`: a pasted address, checked (200 image/*) and passed on as it is.
// `apply` (a JSON flag, or the form field "true") also sets it on the title's
// Studio series at once — the "Set poster" action, a PUT with poster_url
// alone; a series that is not a draft needs `confirm_live` (409
// series_live_confirm). The title's approver or a staff administrator.
// Answers `{poster: {poster_url, preview_url, source, sha256, bytes, width,
// height, cropped}, applied, series?}`.

import type { NextRequest } from "next/server";
import { apiError } from "@/lib/api-guard";
import { requireProducer, requireSession, requireStaff } from "@/lib/auth";
import { POSTER_MAX_UPLOAD_BYTES, posterForTitle, type PosterSource } from "@/lib/crazydramas/poster";
import { isCdPublishError, setSeriesPoster } from "@/lib/crazydramas/publish";
import { PosterBodySchema, type CdSeries } from "@/lib/crazydramas/publish-types";
import { handle, parseJson } from "../../../_lib/handler";
import { json } from "../_lib/publish-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(req, async () => {
    const who = await requireSession();
    if (who.response) return who.response;
    const g = who.session.kind === "staff" ? await requireStaff({ role: "admin" }) : await requireProducer({ minRole: "approver" });
    if (g.response) return g.response;
    if (!/^[0-9a-f-]{36}$/i.test(params.id)) return apiError("Not found", undefined, 404);

    let source: PosterSource;
    let apply = false;
    let confirmLive = false;
    if ((req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
      const form = await req.formData().catch(() => null);
      const file = form?.get("file");
      if (!form || !file || typeof file === "string") return apiError("Invalid request", { formErrors: ["a poster file is required (form field `file`)"] }, 400);
      if (file.size > POSTER_MAX_UPLOAD_BYTES) return json({ error: `The picked file is over ${Math.round(POSTER_MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`, code: "poster_failed" }, 413);
      source = { kind: "file", bytes: new Uint8Array(await file.arrayBuffer()) };
      apply = form.get("apply") === "true";
      confirmLive = form.get("confirm_live") === "true";
    } else {
      const p = await parseJson(req, PosterBodySchema);
      if (p.response) return p.response;
      source = p.data.source === "url" ? { kind: "url", url: p.data.url! } : { kind: "cover" };
      apply = p.data.apply === true;
      confirmLive = p.data.confirm_live === true;
    }
    try {
      const poster = await posterForTitle(g.session, params.id, source);
      let series: CdSeries | null = null;
      if (apply) series = (await setSeriesPoster(g.session, params.id, poster.poster_url, { confirmLive })).series;
      return json({ poster, applied: apply, series });
    } catch (e) {
      if (isCdPublishError(e)) return json(e.body(), e.status);
      throw e;
    }
  });
}
