import { Suspense } from "react";
import { staffSession } from "@/components/admin/server";
import ClipsTable from "@/components/launch/ClipsTable";

export const dynamic = "force-dynamic";

export default async function StaffClipsPage() {
  await staffSession();
  return <Suspense fallback={null}><ClipsTable staff /></Suspense>;
}
