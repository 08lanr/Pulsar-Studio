// Creator accounts (decision 2026-10-12): one library item's file (staff only;
// fixture streams it from .uploads, Supabase answers a short signed URL) and its
// description and tags.
import { NextResponse, type NextRequest } from "next/server";
import { getData } from "@/lib/data";
import { notFound } from "@/lib/data/errors";
import { resolveUploadPath } from "@/lib/data/storage";
import { dataSource } from "@/lib/data-source";
import { signedCreatorMediaUrl } from "@/lib/creators/media";
import { mediaPatchBody, parse, patchMedia, staffOnly } from "@/lib/creators/routes";
import { streamFile } from "@/app/api/media/_lib/stream";
import { handle } from "@/app/api/titles/_lib/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: { id: string; mediaId: string } };

export async function GET(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const g = await staffOnly();
    if (g.response) return g.response;
    const data = getData();
    const account = await data.getCreatorAccount(g.session, params.id);
    const media = await data.getCreatorMedia(g.session, params.mediaId);
    if (media.account_id !== account.id) throw notFound("Media");
    if (dataSource() === "supabase") return NextResponse.redirect(await signedCreatorMediaUrl(media, 3600), 302);
    return streamFile(req, resolveUploadPath(media.path));
  });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  return handle(req, async () => {
    const g = await staffOnly();
    if (g.response) return g.response;
    const p = await parse(req, mediaPatchBody);
    if (p.response) return p.response;
    return patchMedia(g.session, params.id, params.mediaId, p.data);
  });
}
