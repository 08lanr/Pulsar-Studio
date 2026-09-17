import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { guardApiRequest } from "@/lib/api-guard";
import { requireProducer } from "@/lib/auth";
import { dataSource } from "@/lib/data-source";
import { createServerSupabase } from "@/lib/supabase/server";

const Body = z.object({
  password: z.string().min(12).max(128),
  confirm: z.string(),
}).refine(({ password, confirm }) => password === confirm);

export async function POST(req: NextRequest) {
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;
  if (dataSource() !== "supabase") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const guard = await requireProducer();
  if (guard.response) return guard.response;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Use matching passwords of 12–128 characters." }, { status: 400 });

  const supabase = createServerSupabase();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return NextResponse.json({ error: "Could not update password. Please try again." }, { status: 502 });
  return NextResponse.json({ ok: true });
}
