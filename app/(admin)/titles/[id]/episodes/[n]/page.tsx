// /titles/[id]/episodes/[n] — the Adaptation workbench, the hero screen.
// A server component so the payload is read straight from the data layer
// (never our own API) and the first paint already carries every line;
// the title detail is read beside it for the episode picker. The header,
// the three regions and every action live in the client <Workbench>,
// because the status pill, the save indicator and the gate buttons all
// change with client state.

import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getData, isDataError } from "@/lib/data";
import { Workbench } from "@/components/workbench/Workbench";

export const dynamic = "force-dynamic";

export default async function EpisodeWorkbenchPage({ params }: { params: { id: string; n: string } }) {
  const session = await getSession();
  if (!session || session.kind !== "staff") {
    redirect(`/login?next=${encodeURIComponent(`/titles/${params.id}/episodes/${params.n}`)}`);
  }
  const n = Number(params.n);
  if (!Number.isInteger(n) || n < 1) notFound();

  const data = getData();
  try {
    const [payload, detail] = await Promise.all([
      data.getWorkbench(session, params.id, n),
      data.getTitle(session, params.id),
    ]);
    return <Workbench titleId={params.id} episodeNumber={n} initial={payload} episodes={detail.episodes} />;
  } catch (e) {
    if (isDataError(e) && e.code === "not_found") notFound();
    throw e;
  }
}
