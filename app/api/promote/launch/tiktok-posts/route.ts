import type { NextRequest } from "next/server";
import { clipRoute } from "@/lib/launch/clip-routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Read only: the TikTok account linked to the ad account and its newest posts, cached 60 s.
export function GET(req: NextRequest) { return clipRoute(req, true, "tiktokPosts"); }
