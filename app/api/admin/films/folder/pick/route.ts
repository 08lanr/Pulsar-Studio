import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { pickFolder } from "@/lib/film-import/folder-picker";
import { handle, parseJson } from "../../../../titles/_lib/handler";

// POST: open this computer's folder dialog (lib/film-import/folder-picker)
// and answer {folder} — the chosen path, or null when the person cancelled.
// Admin staff only, as the folder import itself; the dialog opens on the
// computer Studio's server runs on.

const Body = z.object({ start: z.string().trim().max(1000).nullish() });

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff({ role: "admin" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, Body);
    if (parsed.response) return parsed.response;
    return NextResponse.json(await pickFolder(parsed.data.start ?? null));
  });
}
