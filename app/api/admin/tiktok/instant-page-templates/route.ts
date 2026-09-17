import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

export const dynamic = "force-dynamic";
const templateInput = z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(60), button_text: z.string().trim().min(1).max(40), background: z.enum(["white", "black"]), hand_cursor: z.boolean() });

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    return NextResponse.json({ templates: await getData().listInstantPageTemplates(g.session) });
  });
}

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff({ role: "admin" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, templateInput);
    if (parsed.response) return parsed.response;
    return NextResponse.json({ template: await getData().saveInstantPageTemplate(g.session, parsed.data) });
  });
}

export async function DELETE(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff({ role: "admin" });
    if (g.response) return g.response;
    const id = req.nextUrl.searchParams.get("id");
    if (!id || !z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "id required", code: "invalid" }, { status: 400 });
    await getData().deleteInstantPageTemplate(g.session, id);
    return NextResponse.json({ ok: true });
  });
}
