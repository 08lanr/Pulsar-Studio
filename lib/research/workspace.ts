// Server helper for the launch workspace: one read of everything the
// assessment needs, for one title or the whole catalog, through getData().
// Pages call `loadWorkspace(session)` and never assemble inputs themselves,
// so Overview, My catalog and the assessment page agree to the point.

import type { Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import type { CompanyAccount, CreativeResult, PromoCampaignSummary, TitleDetail, TitleSummary } from "@/lib/types";
import { assessTitle, type Assessment } from "./assessment";
import { scoreSnapshot, tropeStats, type CatalogRow, type Scores, type TropeStat } from "./engine";
import { hasHistory } from "./history";
import type { MarketView } from "./snapshot";
import type { ReportRow, ResearchProfile } from "./types";

export type WorkspaceTitle = {
  summary: TitleSummary;
  row: CatalogRow;
  detail: TitleDetail | null;
  assessment: Assessment;
  campaigns: PromoCampaignSummary[];
  results: CreativeResult[];
  reports: ReportRow[];
  facts: {
    license_start: string | null;
    license_end: string | null;
    approved_episodes: number;
    episodes_with_video: number;
    rights: "ok" | "expiring" | "outside" | "unknown";
  };
};

export type Workspace = {
  market: MarketView;
  scores: Scores;
  stats: TropeStat[];
  profile: ResearchProfile | null;
  accounts: CompanyAccount[];
  campaigns: PromoCampaignSummary[];
  results: CreativeResult[];
  reports: ReportRow[];
  titles: WorkspaceTitle[];
  truncated: boolean;
  total: number;
};

function rightsState(start: string | null, end: string | null, today: string): WorkspaceTitle["facts"]["rights"] {
  if (!start && !end) return "unknown";
  if ((start && today < start) || (end && today > end)) return "outside";
  if (end && new Date(end).getTime() - new Date(today).getTime() < 90 * 86_400_000) return "expiring";
  return "ok";
}

/**
 * Load the whole workspace. `withDetail` fetches each title's detail (license,
 * versions, episodes with video); the catalog is bounded by the data layer's
 * limit and reports `truncated` rather than silently cutting.
 */
export async function loadWorkspace(session: Session, opts: { titleId?: string; today?: string } = {}): Promise<Workspace> {
  const data = getData();
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const [market, profile, accounts, campaigns, results, reports, catalog, summaries] = await Promise.all([
    data.getMarket(session),
    data.getResearchProfile(session),
    data.listCompanyAccounts(session),
    data.listPromoCampaigns(session),
    data.listCreativeResults(session),
    data.listReportRows(session),
    data.listCatalogForMatching(session),
    data.listTitles(session),
  ]);
  const snapshot = market.latest;
  const scores = snapshot ? scoreSnapshot(snapshot) : new Map();
  const stats = snapshot ? tropeStats(snapshot.titles, scores, snapshot.taxonomy_version) : [];
  const history = hasHistory(market.days);
  const rows = opts.titleId ? catalog.rows.filter((r) => r.id === opts.titleId) : catalog.rows;
  const summaryById = new Map(summaries.map((s) => [s.id, s]));
  const details = await Promise.all(rows.map((r) => data.getTitle(session, r.id).catch(() => null)));
  const titles: WorkspaceTitle[] = rows.flatMap((row, i) => {
    const summary = summaryById.get(row.id);
    if (!summary) return [];
    const detail = details[i];
    const myCampaigns = campaigns.filter((c) => c.title_id === row.id);
    const myIds = new Set(myCampaigns.map((c) => c.id));
    const myResults = results.filter((r) => myIds.has(r.campaign_id));
    const myReports = reports.filter((r) => r.title_id === row.id);
    const facts = {
      license_start: detail?.title.license_start ?? null,
      license_end: detail?.title.license_end ?? null,
      approved_episodes: detail ? detail.episodes.filter((e) => e.version_status === "approved").length : 0,
      episodes_with_video: detail ? detail.episodes.filter((e) => e.has_video).length : 0,
      rights: rightsState(detail?.title.license_start ?? null, detail?.title.license_end ?? null, today),
    };
    const assessment = assessTitle({
      summary,
      row,
      detail: { license_start: facts.license_start, license_end: facts.license_end, approved_episodes: facts.approved_episodes, episodes_with_video: facts.episodes_with_video, china_metrics: (detail?.title.china_metrics ?? null) as never },
      market: { titles: snapshot?.titles ?? [], scores, stats, observed_at: snapshot?.observed_at ?? null, hasHistory: history },
      reports: myReports,
      campaigns: myCampaigns,
      results: myResults,
      accounts,
      profile,
      today,
    });
    return [{ summary, row, detail, assessment, campaigns: myCampaigns, results: myResults, reports: myReports, facts }];
  });
  titles.sort((a, b) => b.assessment.score - a.assessment.score || a.summary.name_zh.localeCompare(b.summary.name_zh));
  return { market, scores, stats, profile, accounts, campaigns, results, reports, titles, truncated: catalog.truncated, total: catalog.total };
}

/** The stage an experiment is in, for lists and the overview. */
export type ExperimentStage = "brief" | "concepts" | "batch" | "budget" | "submitted" | "results" | "decide";

export function experimentStage(c: PromoCampaignSummary, results: CreativeResult[]): { stage: ExperimentStage; waiting: "generate" | "select" | "budget" | "submit" | "results" | "decide" | "none" } {
  const hasResults = results.some((r) => r.campaign_id === c.id);
  if (["live", "paused", "ended"].includes(c.status) || (c.status === "submitted" && hasResults)) return { stage: hasResults ? "decide" : "results", waiting: hasResults ? "decide" : "results" };
  if (c.status === "submitted" || c.status === "launching") return { stage: "submitted", waiting: "results" };
  if (c.status === "approved") return { stage: c.experiment?.approved_at ? "submitted" : "budget", waiting: c.experiment?.approved_at ? "submit" : "budget" };
  if (c.status === "review") return c.approved_count > 0 ? { stage: "batch", waiting: c.experiment?.approved_at ? "submit" : "budget" } : { stage: "concepts", waiting: "select" };
  if (c.creative_count > 0) return { stage: "concepts", waiting: "select" };
  return { stage: "brief", waiting: "generate" };
}
