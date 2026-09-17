import type { NextRequest } from "next/server";
import { launchRoute } from "@/lib/launch/routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: NextRequest, { params }: { params: { id: string } }) { return launchRoute(req, false, "get", params.id); }
export function PUT(req: NextRequest, { params }: { params: { id: string } }) { return launchRoute(req, false, "update", params.id); }
