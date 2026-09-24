import { notFound } from "next/navigation";
import { staffSession } from "@/components/admin/server";
import TitleResults from "@/components/launch/TitleResults";
import { getData, isDataError } from "@/lib/data";

// /promote/monitor/titles/[id] — one title's ad results for staff: every
// launch, campaign and ad that promotes it, with totals, and the way to
// crazydramas' own dashboard (components/launch/TitleResults.tsx).

export const dynamic = "force-dynamic";

export default async function StaffTitleResultsPage({ params }: { params: { id: string } }) {
  const session = await staffSession();
  let title;
  try { title = (await getData().getTitle(session, params.id)).title; }
  catch (e) { if (isDataError(e) && (e.code === "not_found" || e.code === "forbidden")) notFound(); throw e; }
  return <TitleResults staff titleId={title.id} titleName={title.name_en || title.name_zh} crazydramasSlug={title.crazydramas_slug ?? null} />;
}
