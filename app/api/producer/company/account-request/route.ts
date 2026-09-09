import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireProducer } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// "Make a new ad account through Pulsar": the producer's request with a
// contact and an optional (mock) payment opt-in. Never a card number —
// brand, holder and last four only, and Studio charges nothing.

const schema = z.object({
  contact_name: z.string().trim().min(1).max(120),
  contact_email: z.string().trim().email().max(200),
  payment: z.object({ brand: z.string().trim().min(1).max(40), last4: z.string().regex(/^\d{4}$/), holder: z.string().trim().min(1).max(120) }).nullable().optional(),
  note: z.string().trim().max(400).nullable().optional(),
});

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer();
    if (g.response) return g.response;
    return NextResponse.json({ requests: await getData().listAccountRequests(g.session) });
  });
}

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireProducer({ minRole: "reviewer" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, schema);
    if (parsed.response) return parsed.response;
    return NextResponse.json({ request: await getData().createAccountRequest(g.session, parsed.data) });
  });
}
