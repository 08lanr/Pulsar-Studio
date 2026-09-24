import { notFound } from "next/navigation";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { getData, isDataError } from "@/lib/data";
import type { Locale } from "@/lib/i18n";
import { parseRange, parseWindow, type AnalyticsRange, type AnalyticsWindow, type TitleAnalytics } from "@/lib/analytics/types";
import type { Session } from "@/lib/auth";
import { adStatus, platformStatus, type AdReading, type PlatformStatus } from "@/lib/research/title-status";
import { loadCrazydramasStatus } from "@/lib/crazydramas";
import { chipReading, type CrazydramasChipReading } from "@/components/producer/CrazydramasChip";
import { titleResults, type TitleResults } from "@/lib/launch/title-stats";

// What every analytics page needs in one call: the session, the locale, the
// record for the range in the URL, and the base href the sub-views share.
// A foreign or unknown title is a 404 (the data layer never says forbidden
// for a title the caller cannot see).

export type AnalyticsPageData = {
  session: Session;
  locale: Locale;
  record: TitleAnalytics;
  range: AnalyticsRange;
  /** The explicit window when range is "custom". */
  window: AnalyticsWindow | null;
  base: string;
  /** `?range=` suffix to keep on every link between the views. */
  query: string;
  canEdit: boolean;
  /** The title workspace shell statuses: TikTok publication, Pulsar advertising and the crazydramas series chip (state, stale read, older renders). */
  platform: PlatformStatus;
  ads: AdReading;
  crazydramas: CrazydramasChipReading;
  /** What the launches that promote this title spent and brought (lib/launch/title-stats.ts). */
  launched: TitleResults;
};

export type View = "overview" | "revenue" | "episodes" | "acquisition" | "link";

export async function loadAnalyticsPage(titleId: string, view: View, searchParams: { range?: string; from?: string; to?: string }): Promise<AnalyticsPageData> {
  const base = `/producer/titles/${titleId}/analytics`;
  const path = view === "overview" ? base : `${base}/${view}`;
  const session = await portalSession(path);
  const locale = producerLocale();
  const window = parseWindow(searchParams.from, searchParams.to);
  const range: AnalyticsRange = window ? "custom" : parseRange(searchParams.range);
  let record: TitleAnalytics;
  try {
    record = await getData().getTitleAnalytics(session, titleId, { range, window });
  } catch (e) {
    if (isDataError(e) && (e.code === "not_found" || e.code === "forbidden")) notFound();
    throw e;
  }
  const canEdit = !isStaffPreview(session) && (session.producerRole === "approver" || session.producerRole === "reviewer");
  const data = getData();
  const [campaigns, results, cd, runs] = await Promise.all([
    data.listPromoCampaigns(session),
    data.listCreativeResults(session, { titleId }),
    // The third header chip (plan A4): the shell reads the state only. The analytics record carries no slug, so the
    // reading starts from the title row (getTitleAnalytics already answered not_found for a foreign title).
    data.getTitle(session, titleId).then((detail) => loadCrazydramasStatus(session, detail.title)),
    // The launches (unified launch, 2026-09-16) are where this title's ad numbers live now.
    data.listLaunchRuns(session).catch(() => []),
  ]);
  const query = window ? `?range=custom&from=${window.from}&to=${window.to}` : `?range=${range}`;
  return { session, locale, record, range, window, base, query, canEdit, platform: platformStatus(record.analytics_state), ads: adStatus(campaigns.filter((c) => c.title_id === titleId), results), crazydramas: chipReading(cd), launched: titleResults(runs, titleId) };
}
