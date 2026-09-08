import { t, type Locale } from "@/lib/i18n";

// A small link into a title's analytics for other pages (the campaign
// results page, the title console). With a campaignId it opens the
// acquisition view, which links back to that campaign; the range stays the
// default so the bookmark is short. Server component, no state.

export default function AnalyticsLink({ titleId, campaignId, locale, className = "btn btn-outline btn-sm" }: { titleId: string; campaignId?: string; locale: Locale; className?: string }) {
  const href = campaignId ? `/producer/titles/${titleId}/analytics/acquisition?campaign=${campaignId}` : `/producer/titles/${titleId}/analytics`;
  return (
    <a className={className} href={href}>
      {t(locale, campaignId ? "an.linkFrom.campaign" : "an.linkFrom.title")} →
    </a>
  );
}
