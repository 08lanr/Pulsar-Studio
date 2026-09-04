import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiError, guardApiRequest } from "@/lib/api-guard";
import {
  DEV_SESSION_COOKIE,
  devCookieOptions,
  externalOrigin,
  homeFor,
  safeNextPath,
} from "@/lib/auth";
import { dataSource } from "@/lib/data-source";

// Fixture mode's sign-in: pick a persona, get a cookie. Exists so the whole
// UI runs and demos with no Supabase project. In supabase mode it does not
// exist (404) — a persona cookie must never be a way past real auth. Accepts
// a JSON body or a plain form POST, so the login card works before hydration.

const Body = z.object({
  kind: z.enum(["staff", "producer"]),
  next: z.string().nullish(),
});

async function readBody(req: NextRequest): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return req.json().catch(() => null);
  const form = await req.formData().catch(() => null);
  if (!form) return null;
  return { kind: form.get("kind"), next: form.get("next") };
}

export async function POST(req: NextRequest) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;
  if (dataSource() !== "fixture") return apiError("Not found", undefined, 404);

  const parsed = Body.safeParse(await readBody(req));
  if (!parsed.success) {
    return apiError("Invalid request", parsed.error.flatten(), 400);
  }
  const { kind } = parsed.data;
  const next = safeNextPath(parsed.data.next);

  const res = NextResponse.redirect(
    new URL(next ?? homeFor(kind), externalOrigin(req)),
    303
  );
  res.cookies.set(DEV_SESSION_COOKIE, kind, devCookieOptions());
  return res;
}
