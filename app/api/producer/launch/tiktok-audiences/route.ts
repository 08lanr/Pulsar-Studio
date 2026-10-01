import type { NextRequest } from "next/server";
import { clipRoute } from "@/lib/launch/clip-routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Read only: the custom audiences of the chosen TikTok ad account, cached 60 s (lib/tiktok/audiences.ts).
export function GET(req: NextRequest) { return clipRoute(req, false, "tiktokAudiences"); }
