import AccountsForm from "@/components/producer/research/AccountsForm";
import CompanyNav from "@/components/producer/research/CompanyNav";
import OnboardingForm from "@/components/producer/research/OnboardingForm";
import ReportImport from "@/components/producer/research/ReportImport";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { EvidenceTag, StateBadge } from "@/components/producer/research/ui";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { normalizeMarkets } from "@/lib/research/navigation";
import { REPORT_METRICS } from "@/lib/research/reports";
import { tropeLabel } from "@/lib/research/taxonomy";

// /producer/company — Company & accounts: goals and profile, the accounts
// the customer owns (recorded, never created), who can act and how billing
// works, and the imported reports. Four tabs in the URL.

export const dynamic = "force-dynamic";

type Tab = "profile" | "accounts" | "access" | "reports";
const TABS: Tab[] = ["profile", "accounts", "access", "reports"];

export default async function CompanyPage({ searchParams }: { searchParams: { tab?: string; edit?: string } }) {
  const session = await portalSession("/producer/company");
  const locale = producerLocale();
  const data = getData();
  const [company, profile, accounts, batches, rows] = await Promise.all([data.getCompanyIdentity(session), data.getResearchProfile(session), data.listCompanyAccounts(session), data.listReportBatches(session), data.listReportRows(session)]);
  const tab: Tab = TABS.includes(searchParams.tab as Tab) ? (searchParams.tab as Tab) : "profile";
  const canAct = !isStaffPreview(session) && (session.producerRole === "approver" || session.producerRole === "reviewer");
  const edit = searchParams.edit === "1" || !profile;
  const name = company ? (locale === "en" ? company.name_en || company.name_zh : company.name_zh) : t(locale, "portal.staffPreview");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{name}</h1>
          <p className="page-sub">{t(locale, "ws.company.sub")}</p>
        </div>
        {tab === "profile" && !edit && canAct && <a className="btn btn-primary" href="/producer/company?tab=profile&edit=1">{t(locale, "ux.edit")}</a>}
      </div>
      <CompanyNav active={tab} locale={locale} />

      {tab === "profile" && (
        <>
          {!canAct && <p className="note note-info">{t(locale, "research.onboard.viewerOnly")}</p>}
          {edit ? (
            <OnboardingForm initial={profile} readOnly={!canAct} />
          ) : (
            <section className="rs-panel">
              <dl className="rs-kv">
                <dt>{t(locale, "ws.company.goal")}</dt><dd>{profile!.goal || <span className="gt-muted">{t(locale, "ux.unknown")}</span>}</dd>
                <dt>{t(locale, "ws.company.monthlyBudget")}</dt><dd>{profile!.monthly_test_budget_usd != null ? `$${profile!.monthly_test_budget_usd}` : <span className="gt-muted">{t(locale, "ux.unknown")}</span>}</dd>
                <dt>{t(locale, "research.onboard.tropes")}</dt><dd>{profile!.tropes.map((id) => tropeLabel(id, locale)).join(" · ")}</dd>
                <dt>{t(locale, "research.onboard.audience")}</dt><dd>{profile!.audience ? t(locale, profile!.audience === "both" ? "research.onboard.audienceBoth" : `research.audience.${profile!.audience}`) : t(locale, "ux.unknown")}</dd>
                <dt>{t(locale, "research.onboard.markets")}</dt><dd>{normalizeMarkets(profile!.target_markets).join(" · ") || t(locale, "ux.unknown")}</dd>
                <dt>{t(locale, "research.onboard.distribution")}</dt><dd>{profile!.distribution.map((d) => t(locale, `research.onboard.dist.${d}`)).join(" · ") || t(locale, "ux.unknown")}</dd>
                <dt>{t(locale, "research.onboard.volume")}</dt><dd>{profile!.titles_per_year ?? t(locale, "ux.unknown")}</dd>
              </dl>
            </section>
          )}
        </>
      )}

      {tab === "accounts" && (
        <section className="rs-panel">
          <div className="rs-panel-head"><div><h2>{t(locale, "ws.company.tab.accounts")}</h2><p>{t(locale, "ws.accounts.sub")}</p></div></div>
          <AccountsForm accounts={accounts} canAct={canAct} />
          <div className="rs-panel-foot">{t(locale, "ws.accounts.steps")} <a href="https://business.tiktok.com/" target="_blank" rel="noreferrer noopener">TikTok Business Center ↗</a></div>
        </section>
      )}

      {tab === "access" && (
        <div className="rs-grid">
          <section className="rs-panel">
            <div className="rs-panel-head"><div><h2>{t(locale, "ws.access.roles")}</h2><p>{t(locale, "ws.access.rolesSub")}</p></div></div>
            <ul className="rs-list">
              <li><span className="state state-available">approver</span> {t(locale, "ws.access.approver")}{session.producerRole === "approver" && <span className="gt-muted"> · {t(locale, "ws.access.you")}</span>}</li>
              <li><span className="state state-collecting_history">reviewer</span> {t(locale, "ws.access.reviewer")}{session.producerRole === "reviewer" && <span className="gt-muted"> · {t(locale, "ws.access.you")}</span>}</li>
              <li><span className="state state-unavailable">viewer</span> {t(locale, "ws.access.viewer")}{session.producerRole === "viewer" && <span className="gt-muted"> · {t(locale, "ws.access.you")}</span>}</li>
            </ul>
          </section>
          <section className="rs-panel">
            <div className="rs-panel-head"><div><h2>{t(locale, "ws.billing")}</h2><p>{t(locale, "ws.billing.sub")}</p></div></div>
            <div className="rs-panel-body"><StateBadge status="requires_connection" locale={locale} /> {t(locale, "ws.billing.state")}</div>
          </section>
        </div>
      )}

      {tab === "reports" && (
        <>
          <p className="note note-info"><EvidenceTag evidence="partner_reported" locale={locale} /> {t(locale, "research.reports.sub")} {t(locale, "research.reports.columns", { metrics: REPORT_METRICS.join(", ") })}</p>
          <ReportImport batches={batches} canAct={canAct} />
          {rows.length > 0 && <p className="rs-meta"><span>{t(locale, "research.reports.rowCount", { n: rows.length })}</span></p>}
        </>
      )}
    </>
  );
}
