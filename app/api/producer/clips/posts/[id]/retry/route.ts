import type { NextRequest } from "next/server";
import { clipRoute } from "@/lib/launch/clip-routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export function POST(req: NextRequest, { params }: { params: { id: string } }) { return clipRoute(req, false, "retry", params.id); }
