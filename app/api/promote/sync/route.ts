import { NextResponse, type NextRequest } from "next/server";
import { requireStaff } from "@/lib/auth";
import { schedulerStatus, tick } from "@/lib/tiktok/scheduler";
import { handle } from "@/app/api/titles/_lib/handler";

// "Sync now": one scheduler tick on demand — adopt launches, poll review,
// read metrics — so the desk never waits for the five-minute heartbeat.

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    return NextResponse.json({ summary: await tick({ metrics: true }), scheduler: schedulerStatus() });
  });
}

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    return NextResponse.json({ scheduler: schedulerStatus() });
  });
}
