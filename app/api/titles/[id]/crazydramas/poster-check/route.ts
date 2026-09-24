// Poster check (phase 5, publish spec §4): before Studio sends a
// `poster_url` to crazydramas it asks whether the address answers 200 with
// an image. Same-origin guard, the title's approver or a staff
// administrator (who may send the series), a foreign title is not found,
// zod, JSON. The answer is always a 200 carrying `ok` and, when not, the
// reason in words; only the guard, the role and the body refuse.
//
// The request itself is the Studio transport's `checkImage`
// (lib/crazydramas/transport.ts stays the only module that fetches): in
// fixture mode the fake's rule answers and nothing is fetched (`fake: true`:
// an https address whose path ends in an image name answers 200, one named
// "missing" 404); live, one HEAD — GET when HEAD is refused — with no cookie
// and no credential, no redirect followed, only the status and the content
// type read. Only a public https address by name is asked at all: an IP
// literal, localhost or an internal name is refused here first, whatever
// the mode.

import { NextResponse, type NextRequest } from "next/server";
import { requireSession, requireProducer, requireStaff } from "@/lib/auth";
import { apiError } from "@/lib/api-guard";
import { PosterCheckBodySchema, type PosterCheckReply } from "@/lib/crazydramas/publish-types";
import { crazydramasStudioMode, crazydramasStudioTransport } from "@/lib/crazydramas/studio-client";
import { getData } from "@/lib/data";
import { handle, parseJson } from "../../../_lib/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function reply(r: PosterCheckReply): NextResponse {
  return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
}

/** Why an address may not be asked at all, or null when it may. */
function refuseAddress(url: URL): string | null {
  if (url.protocol !== "https:") return "The poster must be an https:// address.";
  if (url.username || url.password) return "The poster address must not carry a user name or password.";
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return "The poster must be on a named public web address.";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return "The poster must be on a named public web address, not an IP address.";
  if (url.port && url.port !== "443") return "The poster must be on the standard https port.";
  return null;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return handle(req, async () => {
    const who = await requireSession();
    if (who.response) return who.response;
    const g = who.session.kind === "staff" ? await requireStaff({ role: "admin" }) : await requireProducer({ minRole: "approver" });
    if (g.response) return g.response;
    const p = await parseJson(req, PosterCheckBodySchema);
    if (p.response) return p.response;
    if (!/^[0-9a-f-]{36}$/i.test(params.id)) return apiError("Not found", undefined, 404);
    // A title the session cannot see is not found (the data layer throws not_found, mapped by handle()).
    await getData().getTitle(g.session, params.id);

    let url: URL;
    try {
      url = new URL(p.data.url);
    } catch {
      return reply({ ok: false, status: null, content_type: null, reason: "That is not a web address." });
    }
    const refused = refuseAddress(url);
    if (refused) return reply({ ok: false, status: null, content_type: null, reason: refused });
    const fake = crazydramasStudioMode().read === "fake";
    const check = await crazydramasStudioTransport().checkImage(url.toString());
    return reply({ ...check, ...(fake ? { fake: true } : {}) });
  });
}
