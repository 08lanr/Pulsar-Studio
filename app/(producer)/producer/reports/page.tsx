import CompanyNav from '@/components/producer/research/CompanyNav';
import ReportImport from "@/components/producer/research/ReportImport";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { EvidenceTag, StateBadge } from "@/components/producer/research/ui";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { REPORT_METRICS } from "@/lib/research/reports";

// /producer/reports — 我的报表: import the company's own distribution or
// platform reports (CSV) with preview, validation, duplicate detection and
// reversible batches. Rows are partner-reported evidence and never mix
// with platform counters.

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const session = await portalSession("/producer/reports");
  const locale = producerLocale();
  const data = getData();
  const [batches, rows] = await Promise.all([data.listReportBatches(session), data.listReportRows(session)]);
  const canAct = !isStaffPreview(session) && (session.producerRole === "approver" || session.producerRole === "reviewer");
  return (
    <>
      <nav className="studio-crumbs" aria-label={t(locale, "v3.breadcrumbs")}>
        <a href="/producer/company">{t(locale, "ws.company.title")}</a>
        <span>›</span>
        <span>{t(locale, "research.reports.title")}</span>
      </nav>
      <div className="page-head">
        <div>
          <h1>{t(locale, "research.reports.title")}</h1>
          <p className="page-sub">{t(locale, "research.reports.sub")}</p>
        </div>
        <span><EvidenceTag evidence="partner_reported" locale={locale} /> <StateBadge status={rows.length ? "available" : "requires_connection"} locale={locale} /></span>
      </div>
      <CompanyNav active="reports" locale={locale}/><a className="btn btn-outline" href="/report-template.csv" download>{t(locale,"ux.reportTemplate")}</a>
      <p className="note note-info">{t(locale, "research.reports.columns", { metrics: REPORT_METRICS.join(", ") })}</p>
      <ReportImport batches={batches} canAct={canAct} />
    </>
  );
}
