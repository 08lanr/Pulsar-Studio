import OnboardingForm from "@/components/producer/research/OnboardingForm";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";

// /producer/onboarding — the studio profile that personalizes the market
// desk (decision 2026-09-06). A few questions, saved on the producer's own
// company row; never shown to another producer. Reviewer/approver may
// edit; viewers and staff previewing see it read-only.

export const dynamic = "force-dynamic";

export default async function Onboarding() {
  const session = await portalSession("/producer/onboarding");
  const locale = producerLocale();
  const profile = await getData().getResearchProfile(session);
  const readOnly = isStaffPreview(session) || (session.producerRole !== "approver" && session.producerRole !== "reviewer");
  const readOnlyNote = isStaffPreview(session) ? t(locale, "research.onboard.readOnly") : readOnly ? t(locale, "research.onboard.viewerOnly") : null;
  return (
    <>
      <nav className="studio-crumbs" aria-label={t(locale, "v3.breadcrumbs")}>
        <a href="/producer">{t(locale, "research.nav.market")}</a>
        <span>›</span>
        <span>{t(locale, "research.onboard.title")}</span>
      </nav>
      <div className="page-head">
        <div>
          <span className="page-kicker">{t(locale, "research.market.kicker")}</span>
          <h2>{t(locale, "research.onboard.title")}</h2>
          <p className="page-sub">{t(locale, "research.onboard.sub")}</p>
        </div>
      </div>
      {readOnlyNote && <p className="note note-info">{readOnlyNote}</p>}
      <OnboardingForm initial={profile} readOnly={readOnly} />
    </>
  );
}
