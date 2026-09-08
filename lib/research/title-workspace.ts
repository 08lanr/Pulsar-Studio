// Everything the title workspace shell needs, in one read through getData():
// the title detail (materials), its assessment (preparation), its campaigns
// and results (advertising), and its TikTok summary row (platform). Pages
// under /producer/titles/[id]/* call this and never assemble inputs
// themselves, so every section agrees on the same statuses.

import { notFound } from "next/navigation";
import type { Session } from "@/lib/auth";
import { getData, isDataError } from "@/lib/data";
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
  range: AnalyticsRange;
};

export async function loadTitleWorkspace(session: Session, titleId: string, range: AnalyticsRange = "30d"): Promise<TitleWorkspace> {
  const data = getData();
  let detail: TitleDetail;
  try {
    detail = await data.getTitle(session, titleId);
  } catch (e) {
    if (isDataError(e) && (e.code === "not_found" || e.code === "forbidden")) notFound();
    throw e;
  }
  const [ws, perf] = await Promise.all([loadWorkspace(session, { titleId }), data.listTitlePerformance(session, { range })]);
  const title = ws.titles[0];
  if (!title) notFound();
  const tiktok = perf.find((r) => r.title_id === titleId) ?? null;
  return { detail, title, tiktok, platform: platformStatus(tiktok?.analytics_state), ads: adStatus(title.campaigns, title.results), range };
}
