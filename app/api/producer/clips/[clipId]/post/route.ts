import type { NextRequest } from "next/server";
import { clipRoute } from "@/lib/launch/clip-routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The row is created and returned at once; publishing continues detached.
export const maxDuration = 60;
export function POST(req: NextRequest, { params }: { params: { clipId: string } }) { return clipRoute(req, false, "post", params.clipId); }
