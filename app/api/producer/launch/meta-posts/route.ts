import type { NextRequest } from "next/server";
import { clipRoute } from "@/lib/launch/clip-routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Read only: the newest 25 Page posts and 25 Instagram media, cached 60 s.
export function GET(req: NextRequest) { return clipRoute(req, false, "pagePosts"); }
