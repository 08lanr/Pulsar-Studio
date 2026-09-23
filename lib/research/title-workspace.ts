// Everything the title workspace shell needs, in one read through getData():
// the title detail (materials), its assessment (preparation), its campaigns
// and results (advertising), and its TikTok summary row (platform). Pages
// under /producer/titles/[id]/* call this and never assemble inputs
// themselves, so every section agrees on the same statuses.

import { notFound } from "next/navigation";
import type { Session } from "@/lib/auth";
import { getData, isDataError } from "@/lib/data";
import { chipReading, loadCrazydramasStatus, loadCrazydramasStatuses, PLATFORM, type CrazydramasChipReading, type CrazydramasStatus } from "@/lib/crazydramas";
import type { AnalyticsRange, TitlePerformanceRow } from "@/lib/analytics/types";
import type { TitleDetail } from "@/lib/types";
import { adStatus, platformStatus, type AdReading, type PlatformStatus } from "./title-status";
import { loadWorkspace, type WorkspaceTitle } from "./workspace";

export type TitleWorkspace = {
  detail: TitleDetail;
  title: WorkspaceTitle;
  tiktok: TitlePerformanceRow | null;
  platform: PlatformStatus;
  ads: AdReading;
  /** The third status of the title (plan A3): where the series stands on crazydramas.com, the reading lib/crazydramas derives from the newest snapshots. */
  crazydramas: CrazydramasStatus;
  range: AnalyticsRange;
};

/**
 * The chip state of every slugged title the session can see, keyed by title
 * id, for the Import films rows. A title without a slug is not in the map:
 * its row reads "Not linked: add a crazydramas slug" from the film itself.
 */
export async function crazydramasStatesByTitle(session: Session): Promise<Record<string, CrazydramasChipReading>> {
  const statuses = await loadCrazydramasStatuses(session, await getData().listTitlesWithPlatformSlug(session, PLATFORM));
  const out: Record<string, CrazydramasChipReading> = {};
  for (const [id, status] of statuses) out[id] = chipReading(status);
  return out;
}

export async function loadTitleWorkspace(session: Session, titleId: string, range: AnalyticsRange = "30d"): Promise<TitleWorkspace> {
  const data = getData();
  let detail: TitleDetail;
  try {
    detail = await data.getTitle(session, titleId);
  } catch (e) {
    if (isDataError(e) && (e.code === "not_found" || e.code === "forbidden")) notFound();
    throw e;
  }
  const [ws, perf, crazydramas] = await Promise.all([loadWorkspace(session, { titleId }), data.listTitlePerformance(session, { range }), loadCrazydramasStatus(session, detail.title)]);
  const title = ws.titles[0];
  if (!title) notFound();
  const tiktok = perf.find((r) => r.title_id === titleId) ?? null;
  return { detail, title, tiktok, platform: platformStatus(tiktok?.analytics_state), ads: adStatus(title.campaigns, title.results), crazydramas, range };
}
