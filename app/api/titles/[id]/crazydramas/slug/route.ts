// POST /api/titles/[id]/crazydramas/slug — the title's crazydramas slug,
// picked and checked by Studio (decision 2026-09-23 "Upload automation:
// poster, slug, series text"; lib/crazydramas/slug.ts). No body: Studio picks
// one from the display title (the show's own slug when it is already on the
// site; else the title as a slug, `-2`, `-3`, … while another series has it).
// `{slug}`: the one the person typed, checked. Either way the slug is saved on
// the title and written into the film's cut/film-meta.json. Refused: 409
// slug_locked once the draft series exists (ad links depend on it), 409
// slug_taken with `suggestion` for a typed slug another series has, 400
// bad_slug, 503 crazydramas_unreachable (nothing saved; Retry). The title's
// approver or a staff administrator. Answers `{outcome, slug, series?,
// film_meta, film_meta_note?}`.

import type { NextRequest } from "next/server";
import { SlugBodySchema, type SlugBody } from "@/lib/crazydramas/publish-types";
import { assignCrazydramasSlug } from "@/lib/crazydramas/slug";
import { cdRoute } from "../_lib/publish-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  return cdRoute(req, params, "write", SlugBodySchema, async (session, titleId, body) => {
    const r = await assignCrazydramasSlug(session, titleId, { slug: (body as SlugBody).slug ?? null });
    return { outcome: r.outcome, slug: r.slug, series: r.series ?? null, film_meta: r.film_meta, film_meta_note: r.film_meta_note ?? null };
  });
}
