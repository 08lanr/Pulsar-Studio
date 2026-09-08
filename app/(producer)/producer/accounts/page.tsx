import { redirect } from "next/navigation";

// Accounts live under Company & accounts now.
export default function LegacyAccounts() {
  redirect("/producer/company?tab=accounts");
}
