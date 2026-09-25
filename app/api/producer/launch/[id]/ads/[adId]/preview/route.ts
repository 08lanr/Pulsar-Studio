import type { NextRequest } from "next/server";
import { adPreviewRoute } from "@/lib/launch/routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Opens TikTok's own preview of one launched ad (a redirect; the link lasts 30 days).
export function GET(req: NextRequest, { params }: { params: { id: string; adId: string } }) { return adPreviewRoute(req, false, params.id, params.adId); }
