import type { NextRequest } from "next/server";
import { clipRoute } from "@/lib/launch/clip-routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Read only: the post behind each pasted Spark code (cover, caption, account); no code is authorized.
export function POST(req: NextRequest) { return clipRoute(req, false, "sparkPreviews"); }
