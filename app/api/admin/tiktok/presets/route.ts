import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { launchSettingsSchema } from "@/lib/tiktok/settings";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// Pulsar-wide launch presets (overlord's ad group presets; decision
// 2026-09-16): staff read, admins write. GET lists, POST creates or updates
// (with id), DELETE removes (?id=).

export const dynamic = "force-dynamic";

const schema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(60),
  settings: launchSettingsSchema,
  note: z.string().trim().max(400).nullable().optional(),
});

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    return NextResponse.json({ presets: await getData().listLaunchPresets(g.session) });
  });
}

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff({ role: "admin" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, schema);
    if (parsed.response) return parsed.response;
    return NextResponse.json({ preset: await getData().saveLaunchPreset(g.session, parsed.data) });
  });
}

export async function DELETE(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff({ role: "admin" });
    if (g.response) return g.response;
    const id = req.nextUrl.searchParams.get("id");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "id required", code: "invalid" }, { status: 400 });
    await getData().deleteLaunchPreset(g.session, id);
    return NextResponse.json({ ok: true });
  });
}
