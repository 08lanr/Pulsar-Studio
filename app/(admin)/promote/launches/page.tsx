import { staffSession } from "@/components/admin/server";
import LaunchStudio from "@/components/launch/LaunchStudio";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function StaffLaunchesPage({ searchParams }: { searchParams?: { run?: string } }) {
  await staffSession();
  if (searchParams?.run) redirect(`/promote/monitor?run=${encodeURIComponent(searchParams.run)}`);
  return <LaunchStudio staff />;
}
