import { portalSession } from "@/components/producer/server";
import LaunchMonitorV2 from "@/components/launch/LaunchMonitorV2";
export const dynamic = "force-dynamic";
export default async function MonitorPage({ searchParams }: { searchParams?: { run?: string } }) { await portalSession("/producer/monitor"); return <LaunchMonitorV2 focusId={searchParams?.run} />; }
