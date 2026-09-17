import type { NextRequest } from "next/server";
import { launchRoute } from "@/lib/launch/routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: NextRequest) { return launchRoute(req, false, "list"); }
export function POST(req: NextRequest) { return launchRoute(req, false, "create"); }
