import "@/app/segment.css";
import { notFound } from "next/navigation";
import RunDetail from "@/components/admin/segment/RunDetail";
import { staffSession } from "@/components/admin/server";

// /films/runs/[runId] — one run: the stage timeline and the panel of the
// stage it is at (plan B2). The client component reads the run through
// GET /api/admin/films/runs/[runId] and polls it; the page only checks the
// id's shape and the staff session.

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function FilmRunPage({ params }: { params: { runId: string } }) {
  await staffSession();
  if (!UUID.test(params.runId)) notFound();
  return <RunDetail runId={params.runId} />;
}
