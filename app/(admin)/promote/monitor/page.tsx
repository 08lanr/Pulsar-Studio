import { staffSession } from "@/components/admin/server";
import LaunchMonitorV2 from "@/components/launch/LaunchMonitorV2";

export const dynamic = "force-dynamic";

export default async function StaffMonitorPage({ searchParams }: { searchParams?: { run?: string } }) {
  await staffSession();
  return <LaunchMonitorV2 staff focusId={searchParams?.run} />;
}
