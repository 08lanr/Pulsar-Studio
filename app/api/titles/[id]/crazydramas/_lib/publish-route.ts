// The shape every "Upload to crazydramas" route shares (phase 5; the routes
// under app/api/titles/[id]/crazydramas/: publish, series, uploads,
// uploads/cancel, unpublish): the house order — same-origin guard (handle),
// the role, zod, the lib call, JSON — plus one mapping of a refusal: a
// CdPublishError (crazydramas' codes passed through with their words, and
// Studio's own: writes_disabled, paid_needs_confirm, not_linked,
// series_missing, not_verified, poster_unreachable, catalog_unreadable) is
// `{error, code, ...details}` with its status. Writes need the title's
// approver or a staff administrator; a read needs only to see the title. A
// foreign title is not found, from the data layer, before anything else.
// Every answer is `Cache-Control: no-store`. A private folder: Next never
// routes it.

import { NextResponse, type NextRequest } from "next/server";
import type { ZodTypeAny } from "zod";
import { apiError } from "@/lib/api-guard";
import { requireProducer, requireSession, requireStaff, type Session } from "@/lib/auth";
import { isCdPublishError } from "@/lib/crazydramas/publish";
import { handle, parseJson } from "../../../_lib/handler";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * One route: the guard, the role (`write`: approver / staff admin; `read`:
 * anyone signed in, the data layer decides the title), the body (`schema`,
 * or none for a GET), then `run`. A CdPublishError becomes its own answer;
 * everything else goes to the shared handler's mapping.
 */
export async function cdRoute<S extends ZodTypeAny>(
  req: NextRequest,
  params: { id: string },
  access: "read" | "write",
  schema: S | null,
  run: (session: Session, titleId: string, body: unknown) => Promise<unknown>
): Promise<Response> {
  return handle(req, async () => {
    const who = await requireSession();
    if (who.response) return who.response;
    let session = who.session;
    if (access === "write") {
      const g = session.kind === "staff" ? await requireStaff({ role: "admin" }) : await requireProducer({ minRole: "approver" });
      if (g.response) return g.response;
      session = g.session;
    }
    let body: unknown = undefined;
    if (schema) {
      const p = await parseJson(req, schema);
      if (p.response) return p.response;
      body = p.data;
    }
    if (!/^[0-9a-f-]{36}$/i.test(params.id)) return apiError("Not found", undefined, 404);
    try {
      return json(await run(session, params.id, body));
    } catch (e) {
      if (isCdPublishError(e)) return json(e.body(), e.status);
      throw e;
    }
  });
}
