import { redirect } from "next/navigation";
import { portalSession } from "@/components/producer/server";

export default async function RetiredNewPromoPage() {
  await portalSession("/producer/promote/new");
  redirect("/producer/launch");
}
