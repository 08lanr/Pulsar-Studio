import { staffSession } from "@/components/admin/server";
import LaunchStudio from "@/components/launch/LaunchStudio";
export const dynamic = "force-dynamic";
export default async function StaffLaunchDetailPage({ params }: { params: { id: string } }) { await staffSession(); return <LaunchStudio staff runId={params.id} />; }
