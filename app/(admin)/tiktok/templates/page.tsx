import Link from "next/link";
import PresetsPanel from "@/components/admin/tiktok/PresetsPanel";
import InstantPageTemplatesPanel from "@/components/admin/tiktok/InstantPageTemplatesPanel";
import { adminLocale, staffSession } from "@/components/admin/server";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function LaunchTemplatesPage({ searchParams }: { searchParams?: { tab?: string } }) {
  const session = await staffSession();
  const locale = adminLocale();
  const tab = searchParams?.tab === "pages" ? "pages" : "presets";
  return <div className="launch-template-page"><div className="page-head"><div><h1>{t(locale, "launchRedesign.templatesTitle")}</h1><p className="page-sub">{t(locale, "launchRedesign.templatesSub")}</p></div><Link className="btn btn-outline" href="/tiktok">{t(locale, "launchRedesign.accountsBack")}</Link></div><nav className="seg" aria-label={t(locale, "tipTemplates.tabs")}><Link className={`seg-btn${tab === "presets" ? " on" : ""}`} aria-current={tab === "presets" ? "page" : undefined} href="/tiktok/templates">{t(locale, "tkp.title")}</Link><Link className={`seg-btn${tab === "pages" ? " on" : ""}`} aria-current={tab === "pages" ? "page" : undefined} href="/tiktok/templates?tab=pages">{t(locale, "tipTemplates.title")}</Link></nav>{tab === "pages" ? <InstantPageTemplatesPanel isAdmin={session.staffRole === "admin"} /> : <PresetsPanel isAdmin={session.staffRole === "admin"} />}</div>;
}
