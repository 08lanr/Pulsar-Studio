import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { fingerprintAccount, FULL_COUNTRY_COUNT } from "@/lib/tiktok/fingerprint";
import { handle, parseJson } from "@/app/api/titles/_lib/handler";

// What has each ad account been used for? (overlord's account fingerprint;
// decision 2026-09-16). One paced /campaign/get/ per account plus the geo
// catalogue; the page scans a Business Center in batches of at most 30.

export const maxDuration = 300;

const schema = z.object({ accounts: z.array(z.string().regex(/^\d{5,}$/)).min(1).max(30), force: z.boolean().optional() });

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const parsed = await parseJson(req, schema);
    if (parsed.response) return parsed.response;
    const results = [];
    for (const id of parsed.data.accounts) results.push(await fingerprintAccount(id, { force: parsed.data.force }));
    return NextResponse.json({ results, fullCountryCount: FULL_COUNTRY_COUNT });
  });
}
