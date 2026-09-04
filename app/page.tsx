import { redirect } from "next/navigation";

// The signed-in home is the title list; there is no marketing surface in
// this repo (partners arrive through a deal, not a landing page).
export default function Home() {
  redirect("/titles");
}
