import { notFound } from "next/navigation";
import { portalSession } from "@/components/producer/server";
import TitleResults from "@/components/launch/TitleResults";
import { getData, isDataError } from "@/lib/data";

// /producer/monitor/titles/[id] — one title's ad results: every launch,
// campaign and ad that promotes it, with totals, and the way to
// crazydramas' own dashboard (components/launch/TitleResults.tsx).
// A title of another company is not found.

export const dynamic = "force-dynamic";

export default async function TitleResultsPage({ params }: { params: { id: string } }) {
  const session = await portalSession(`/producer/monitor/titles/${params.id}`);
  let title;
  try { title = (await getData().getTitle(session, params.id)).title; }
  catch (e) { if (isDataError(e) && (e.code === "not_found" || e.code === "forbidden")) notFound(); throw e; }
  return <TitleResults titleId={title.id} titleName={title.name_en || title.name_zh} crazydramasSlug={title.crazydramas_slug ?? null} />;
}
