// Partner companies (制片方). The list feeds the producer picker on
// /titles/new; POST adds one. Staff only — a producer never sees the
// other partners.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth";
import { getData } from "@/lib/data";
import { handle, parseJson } from "../titles/_lib/handler";

const CreateProducer = z.object({
  name_zh: z.string().trim().min(1),
  name_en: z.string().trim().nullish(),
  contact_email: z.string().trim().email().nullish().or(z.literal("")),
  contact_wechat: z.string().trim().nullish(),
});

export async function GET(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const producers = await getData().listProducers(g.session);
    return NextResponse.json({ producers });
  });
}

export async function POST(req: NextRequest) {
  return handle(req, async () => {
    const g = await requireStaff();
    if (g.response) return g.response;
    const p = await parseJson(req, CreateProducer);
    if (p.response) return p.response;
    const b = p.data;
    const producer = await getData().createProducer(g.session, {
      name_zh: b.name_zh,
      name_en: b.name_en || null,
      contact_email: b.contact_email || null,
      contact_wechat: b.contact_wechat || null,
    });
    return NextResponse.json({ producer }, { status: 201 });
  });
}
