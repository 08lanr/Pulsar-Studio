import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

// Who am I. The Nav reads this to draw the identity block and the right
// surface links; a signed-out browser gets a 200 with `null`, not a 401,
// because the route is public (the wall lets /api/auth/* through) and the
// answer "nobody" is a valid one here.

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  return NextResponse.json(session);
}
