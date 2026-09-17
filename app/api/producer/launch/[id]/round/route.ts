import type { NextRequest } from "next/server";
import { launchRoute } from "@/lib/launch/routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(req: NextRequest, { params }: { params: { id: string } }) { return launchRoute(req, false, "round", params.id); }
