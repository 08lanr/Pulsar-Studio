// GET /api/public-posters/<title_external_id>/<sha8>.jpg — fixture mode's
// stand-in for Studio's public poster bucket (decision 2026-09-23 "Upload
// automation: poster, slug, series text"; lib/crazydramas/poster.ts). The
// posters fixture mode stores under .uploads/public-posters/ are served here,
// so the screens can show the poster the crazydramas fake was sent (its
// made-up https://studio-fixture.invalid/… address maps to this path).
// Supabase mode answers 404: the real bucket is Supabase's own public URL.
// Only the bucket's own shape of path is served (one folder, an 8-hex name,
// .jpg).

import { readFile } from "node:fs/promises";
import { NextResponse, type NextRequest } from "next/server";
import { fixturePosterFile } from "@/lib/crazydramas/poster";
import { dataSource } from "@/lib/data-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { path: string[] } }) {
  const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });
  if (dataSource() !== "fixture") return notFound();
  let objectPath: string;
  try {
    objectPath = (params.path ?? []).map((s) => decodeURIComponent(s)).join("/");
  } catch {
    return notFound();
  }
  const file = fixturePosterFile(objectPath);
  if (!file) return notFound();
  const bytes = await readFile(file).catch(() => null);
  if (!bytes) return notFound();
  return new NextResponse(new Uint8Array(bytes), { status: 200, headers: { "Content-Type": "image/jpeg", "Content-Length": String(bytes.length), "Cache-Control": "public, max-age=31536000, immutable" } });
}
