import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { ImportRequestSchema, startImport } from "@/lib/film-import/import";
import { handle, parseJson } from "../../../titles/_lib/handler";

// Staff mirror of POST /api/producer/films/import with a company picker: a
// staff administrator imports a film on a company's behalf (CLAUDE.md: staff
// may not act in the producer portal). The same job, the same refusals; the
// adaptation records the administrator as its creator.

const Body = ImportRequestSchema.extend({ producer_id: z.string().uuid() });

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff({ role: "admin" });
    if (g.response) return g.response;
    const parsed = await parseJson(req, Body);
    if (parsed.response) return parsed.response;
    const { producer_id, ...request } = parsed.data;
    const started = await startImport(g.session, request, { producer_id, created_by: g.session.userId });
    return NextResponse.json(started, { status: 202 });
  });
}
