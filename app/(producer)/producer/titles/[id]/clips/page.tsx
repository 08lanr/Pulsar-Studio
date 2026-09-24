import { notFound } from "next/navigation";
import { portalSession } from "@/components/producer/server";
import { getData, isDataError } from "@/lib/data";
import ClipsLibrary from "@/components/launch/ClipsLibrary";
import { montageStatus, type MontageStatus } from "@/lib/clips/montage-run";

export const dynamic = "force-dynamic";

export default async function TitleClipsPage({ params }: { params: { id: string } }) {
  const session = await portalSession(`/producer/titles/${params.id}/clips`);
  let initial: MontageStatus | null = null;
  try {
    await getData().getTitle(session, params.id);
    initial = await montageStatus(session, params.id);
  } catch (error) {
    if (isDataError(error) && (error.code === "not_found" || error.code === "forbidden")) notFound();
    throw error;
  }
  // The 60-second ad is built by the title's reviewer or approver; staff previewing the portal only look (CLAUDE.md).
  const canBuild = session.kind === "producer" && (session.producerRole === "approver" || session.producerRole === "reviewer");
  return <ClipsLibrary titleId={params.id} montage={{ canBuild, initial }} />;
}
