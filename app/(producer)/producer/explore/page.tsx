import { redirect } from "next/navigation";

// /producer/explore opens on Titles.
export default function ExploreIndex() {
  redirect("/producer/explore/titles");
}
