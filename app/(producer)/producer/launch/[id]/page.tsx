import { portalSession } from "@/components/producer/server";
import LaunchStudio from "@/components/launch/LaunchStudio";
export const dynamic = "force-dynamic";
export default async function LaunchDetailPage({ params }: { params: { id: string } }) { await portalSession(`/producer/launch/${params.id}`); return <LaunchStudio runId={params.id} />; }
