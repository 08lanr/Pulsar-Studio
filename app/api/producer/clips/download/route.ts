import { type NextRequest } from "next/server";
import { z } from "zod";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { downloadClips } from "@/lib/launch/clip-download";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

const Body = z.object({ clip_ids: z.array(z.string().uuid()).min(1).max(30) }).strict();

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, Body);
    if (parsed.response) return parsed.response;
    const workspace = await getData().getLaunchWorkspace(g.session);
    const zip = await downloadClips(parsed.data.clip_ids, workspace.library);
    return new Response(new Uint8Array(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="studio-clips.zip"',
        "Content-Length": String(zip.length),
        "Cache-Control": "private, no-store",
      },
    });
  });
}

export const dynamic = "force-dynamic";
