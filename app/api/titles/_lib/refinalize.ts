// The shared tail of every "repair" route (retime, timing offset, cue
// edits): when the episode's current version is approved, the row edits
// haven't reached the frozen snapshot exports read — so fork a draft and,
// if QC passes, refinalize it. QC errors leave the draft open for review
// (the workspace's QC card lists them), mirroring the finalize route's gate.

import type { Session } from "@/lib/auth";
import type { DataLayer } from "@/lib/data";
import { runQc } from "@/lib/qc";

export type RefinalizeOutcome = { refinalized: boolean; needs_review: boolean };

export async function refreshApprovalAfterRepair(
  data: DataLayer,
  session: Session,
  titleId: string,
  episodeNumber: number
): Promise<RefinalizeOutcome> {
  const wb = await data.getWorkbench(session, titleId, episodeNumber);
  if (wb.version?.status !== "approved") return { refinalized: false, needs_review: false };
  const draft = await data.forkVersion(session, wb.version.id);
  const fresh = await data.getWorkbench(session, titleId, episodeNumber);
  const qc = runQc({
    lines: fresh.lines,
    adapted: fresh.adapted_lines.filter((a) => a.version_id === draft.id),
    characterNames: new Map(fresh.characters.map((c) => [c.id, c.name_en])),
  });
  if (qc.errors.length) return { refinalized: false, needs_review: true };
  await data.finalizeVersion(session, draft.id);
  return { refinalized: true, needs_review: false };
}
