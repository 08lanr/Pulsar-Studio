import { notFound } from "next/navigation";
import { portalSession } from "@/components/producer/server";
import { getData, isDataError } from "@/lib/data";
import ClipsLibrary from "@/components/launch/ClipsLibrary";

export const dynamic = "force-dynamic";

export default async function TitleClipsPage({ params }: { params: { id: string } }) {
  const session = await portalSession(`/producer/titles/${params.id}/clips`);
  try {
    await getData().getTitle(session, params.id);
  } catch (error) {
    if (isDataError(error) && (error.code === "not_found" || error.code === "forbidden")) notFound();
    throw error;
  }
  return <ClipsLibrary titleId={params.id} />;
}
