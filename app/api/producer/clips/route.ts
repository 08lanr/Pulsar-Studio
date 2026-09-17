import type { NextRequest } from "next/server";
import { clipRoute } from "@/lib/launch/clip-routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: NextRequest) { return clipRoute(req, false, "list"); }
