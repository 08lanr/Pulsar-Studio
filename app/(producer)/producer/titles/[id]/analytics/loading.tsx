import { producerLocale } from "@/components/producer/server";
import { t } from "@/lib/i18n";

// Route loading state for every analytics view: keeps the page structure
// (a head, a control row, a panel) so the layout does not jump when the
// record arrives. No animation beyond the existing brief-loading bar.

export default function AnalyticsLoading() {
  const locale = producerLocale();
  return (
    <div className="an-page" role="status" aria-busy="true" aria-live="polite">
      <div className="page-head an-head"><div><span className="page-kicker">{t(locale, "an.title")}</span><h1>{t(locale, "ux.loading")}</h1></div></div>
      <section className="rs-panel rs-empty"><p>{t(locale, "an.loading")}</p><div className="brief-loading" aria-hidden="true" /></section>
    </div>
  );
}
