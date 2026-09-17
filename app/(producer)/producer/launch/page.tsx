import { portalSession } from "@/components/producer/server";
import LaunchStudio from "@/components/launch/LaunchStudio";
export const dynamic = "force-dynamic";
export default async function LaunchPage() { await portalSession("/producer/launch"); return <LaunchStudio />; }
