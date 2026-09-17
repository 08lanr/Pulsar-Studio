import { staffSession } from "@/components/admin/server";
import MetaSetup from "@/components/launch/MetaSetup";
export const dynamic = "force-dynamic";
export default async function MetaPage() { await staffSession(); return <MetaSetup />; }
