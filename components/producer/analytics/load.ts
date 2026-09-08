import { notFound } from "next/navigation";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { getData, isDataError } from "@/lib/data";
import type { Locale } from "@/lib/i18n";
import { parseRange, type AnalyticsRange, type TitleAnalytics } from "@/lib/analytics/types";
import type { Session } from "@/lib/auth";
import { adStatus, platformStatus, type AdReading, type PlatformStatus } from "@/lib/research/title-status";

// What every analytics page needs in one call: the session, the locale, the
// record for the range in the URL, and the base href the sub-views share.
// A foreign or unknown title is a 404 (the data layer never says forbidden
// for a title the caller cannot see).

export type AnalyticsPageData = {
  session: Session;
  locale: Locale;
  record: TitleAnalytics;
  range: AnalyticsRange;
  base: string;
  /** `?range=` suffix to keep on every link between the views. */
  query: string;
  canEdit: boolean;
  /** The title workspace shell statuses: TikTok publication and Pulsar advertising. */
  platform: PlatformStatus;
  ads: AdReading;
};

export type View = "overview" | "revenue" | "episodes" | "acquisition" | "link";

export async function loadAnalyticsPage(titleId: string, view: View, searchParams: { range?: string }): Promise<AnalyticsPageData> {
  const base = `/producer/titles/${titleId}/analytics`;
  const path = view === "overview" ? base : `${base}/${view}`;
  const session = await portalSession(path);
  const locale = producerLocale();
  const range = parseRange(searchParams.range);
  let record: TitleAnalytics;
  try {
    record = await getData().getTitleAnalytics(session, titleId, { range });
  } catch (e) {
    if (isDataError(e) && (e.code === "not_found" || e.code === "forbidden")) notFound();
    throw e;
  }
  const canEdit = !isStaffPreview(session) && (session.producerRole === "approver" || session.producerRole === "reviewer");
  const data = getData();
  const [campaigns, results] = await Promise.all([data.listPromoCampaigns(session), data.listCreativeResults(session, { titleId })]);
  return { session, locale, record, range, base, query: `?range=${range}`, canEdit, platform: platformStatus(record.analytics_state), ads: adStatus(campaigns.filter((c) => c.title_id === titleId), results) };
}
