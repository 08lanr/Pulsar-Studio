import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-guard";
import { requireStaff } from "@/lib/auth";
import { POSTER_MAX_UPLOAD_BYTES } from "@/lib/crazydramas/poster";
import { renameTitle, setTitlePoster, TITLE_NAME_MAX } from "@/lib/titles/details";
import { handle, parseJson } from "../../../../titles/_lib/handler";

// The Title details card (lib/titles/details; decision 2026-09-24 "Rename a
// title, choose its poster"). Staff administrators only.
//   PATCH {name, confirm_live?}: rename; the slug and the title's own series follow.
//   POST multipart {file, confirm_live?}: the picked image becomes the cover and the series' poster.
// Both answer the DetailsResult: the title, the slug move, and what crazydramas did.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const RenameBody = z.object({ name: z.string().trim().min(1).max(TITLE_NAME_MAX), confirm_live: z.boolean().optional() });
const isId = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(req, async () => {
    const g = await requireStaff({ role: "admin" });
    if (g.response) return g.response;
    if (!isId(params.id)) return apiError("Not found", undefined, 404);
    const parsed = await parseJson(req, RenameBody);
    if (parsed.response) return parsed.response;
    return NextResponse.json(await renameTitle(g.session, params.id, parsed.data.name, { confirmLive: parsed.data.confirm_live === true }));
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(req, async () => {
    const g = await requireStaff({ role: "admin" });
    if (g.response) return g.response;
    if (!isId(params.id)) return apiError("Not found", undefined, 404);
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !file || typeof file === "string") return apiError("Invalid request", { formErrors: ["a poster file is required (form field `file`)"] }, 400);
    if (file.size > POSTER_MAX_UPLOAD_BYTES) return apiError(`The picked file is over ${Math.round(POSTER_MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`, undefined, 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    return NextResponse.json(await setTitlePoster(g.session, params.id, bytes, { confirmLive: form.get("confirm_live") === "true" }));
  });
}
