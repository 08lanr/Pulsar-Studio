import { portalSession } from "@/components/producer/server";
import ClipsLibrary from "@/components/launch/ClipsLibrary";
export const dynamic = "force-dynamic";
export default async function ClipsPage() { await portalSession("/producer/clips"); return <ClipsLibrary />; }
