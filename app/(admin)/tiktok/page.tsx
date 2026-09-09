import TikTokSetup from "@/components/admin/tiktok/TikTokSetup";
import { adminLocale, staffSession } from "@/components/admin/server";
import { t } from "@/lib/i18n";

// /tiktok — the operator's TikTok setup (decision 2026-09-09): connect
// Pulsar's Business Center (Pulsar Grow's OAuth flow), see the ad accounts
// the authorizations reach, assign one to a producer with its publishing
// identity, work the account-request queue, and watch the scheduler. Live
// TikTok calls happen in the status route the component fetches.

export const dynamic = "force-dynamic";

export default async function TikTokSetupPage({ searchParams }: { searchParams: { connect?: string; detail?: string } }) {
  const session = await staffSession();
  const locale = adminLocale();
  return <>
    <div className="page-head"><div><h1>{t(locale, "admin.tiktok.title")}</h1><p className="page-sub">{t(locale, "admin.tiktok.sub")}</p></div></div>
    <TikTokSetup isAdmin={session.staffRole === "admin"} connect={searchParams.connect ?? null} connectDetail={searchParams.detail ?? null} />
  </>;
}
