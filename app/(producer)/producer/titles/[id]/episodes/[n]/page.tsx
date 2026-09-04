import { notFound } from "next/navigation";
import EpisodeWorkspace from "@/components/producer/EpisodeWorkspace";
import EpisodeStageNav from "@/components/producer/EpisodeStageNav";
import { isStaffPreview, portalSession } from "@/components/producer/server";
import { getData, isDataError } from "@/lib/data";

// /producer/titles/[id]/episodes/[n] — one episode, one screen, every state
// (2026-09-03 evening: the request-changes review flow is gone from this
// side; a Pulsar-submitted version shows the same list read-only with
// 确认定稿 / 自己修改, and "changing it" means editing directly, never filing
// a request). The workspace client component owns the interaction; it is
// keyed on the server truth because router.refresh() re-renders the server
// component while React keeps a client component's useState.

export const dynamic = "force-dynamic";

export default async function ProducerEpisodePage({ params }: { params: { id: string; n: string } }) {
  const n = Number(params.n);
  if (!Number.isInteger(n) || n < 1) notFound();
  const session = await portalSession(`/producer/titles/${params.id}/episodes/${params.n}`);

  let wb;
  try {
    wb = await getData().getWorkbench(session, params.id, n);
  } catch (e) {
    if (isDataError(e) && (e.code === "not_found" || e.code === "forbidden")) notFound();
    throw e;
  }

  const readOnly = isStaffPreview(session) || session.producerRole === "viewer";
  // The studio shell draws its own header (back link, title, status), like
  // the review screen this layout comes from — no page-head wrapper here.
  return (
    <>
      <EpisodeStageNav
        titleId={wb.title.id}
        titleName={wb.title.name_en || wb.title.name_zh}
        episodeNumber={wb.episode.number}
        active="script"
        finalized={wb.version?.status === "approved"}
      />
      <EpisodeWorkspace
        key={`${wb.version?.id ?? "none"}:${wb.version?.status ?? ""}:${wb.adapted_lines.length}:${wb.adapted_lines.reduce((m, a) => (a.updated_at > m ? a.updated_at : m), "")}`}
        payload={wb}
        readOnly={readOnly}
      />
    </>
  );
}
