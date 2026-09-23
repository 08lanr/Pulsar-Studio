import "@/app/segment.css";
import { notFound } from "next/navigation";
import BoundaryReview from "@/components/admin/segment/BoundaryReview";
import { staffSession } from "@/components/admin/server";

// /films/runs/[runId]/review — the boundary review (plan B3), and the join
// review once the episodes are built. Staff-gated for now (decision
// 2026-09-23 #9).

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function FilmRunReviewPage({ params }: { params: { runId: string } }) {
  await staffSession();
  if (!UUID.test(params.runId)) notFound();
  return <BoundaryReview runId={params.runId} />;
}
