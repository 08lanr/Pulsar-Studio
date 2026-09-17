import { redirect } from "next/navigation";
import PasswordForm from "./PasswordForm";
import { portalSession } from "@/components/producer/server";
import { dataSource } from "@/lib/data-source";

export const dynamic = "force-dynamic";

export default async function PasswordSettingsPage() {
  const session = await portalSession("/producer/settings/password");
  if (dataSource() !== "supabase" || session.kind !== "producer") redirect("/producer/company");
  return (
    <div className="page">
      <div className="page-head"><div>
        <h1>Set or change password</h1>
        <p className="page-sub">Use a password to sign in to Pulsar Studio without a magic link.</p>
      </div></div>
      <div className="card" style={{ maxWidth: 520 }}><PasswordForm /></div>
    </div>
  );
}
