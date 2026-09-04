import { notFound } from "next/navigation";
import SubtitleStudio from "@/components/producer/SubtitleStudio";
import EpisodeStageNav from "@/components/producer/EpisodeStageNav";
import { isStaffPreview, portalSession } from "@/components/producer/server";
import { getData, isDataError } from "@/lib/data";

// /producer/titles/[id]/episodes/[n]/subtitles — stage two of delivery
// (2026-09-05: "first we finalize the script, and then we finalize the
// subtitles"): after the script is approved, the producer styles the
// subtitles here — English or bilingual, font, size — sees them live on
// the video, and renders the burned deliverable.

export const dynamic = "force-dynamic";

export default async function ProducerSubtitlesPage({ params }: { params: { id: string; n: string } }) {
  const n = Number(params.n);
  if (!Number.isInteger(n) || n < 1) notFound();
  const session = await portalSession(`/producer/titles/${params.id}/episodes/${params.n}/subtitles`);

  let wb;
  try {
    wb = await getData().getWorkbench(session, params.id, n);
  } catch (e) {
    if (isDataError(e) && (e.code === "not_found" || e.code === "forbidden")) notFound();
    throw e;
  }

  const readOnly = isStaffPreview(session) || session.producerRole === "viewer";
  return (
    <>
      <EpisodeStageNav
        titleId={wb.title.id}
        titleName={wb.title.name_en || wb.title.name_zh}
        episodeNumber={wb.episode.number}
        active="subtitles"
        finalized={wb.version?.status === "approved"}
      />
      <SubtitleStudio key={`${wb.version?.id ?? "none"}:${wb.version?.status ?? ""}`} payload={wb} readOnly={readOnly} />
    </>
  );
}
