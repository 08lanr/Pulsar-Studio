// US potential assessment (decision 2026-09-08, "US launch workspace").
//
// One number per title, 0-100, that says how much of OUR evidence points at
// testing this title in the US first. It is an explained, versioned
// composite of five things we actually hold, never a probability of
// success and never an audience measurement:
//
//   story_match   0-35  half the mean prominent-listing share of its tropes (0-25)
//                       plus its comparables' prominence (0-10), within platform
//   market_signal 0-10  whether those tropes are gaining chart visibility
//                       (needs history; otherwise 0 and says so)
//   readiness     0-25  English subtitles, materials,
//                       destination, ad account (facts the company recorded)
//   own_evidence  0-25  imported US reports and measured test results
//                       (demo-labelled results count at half)
//   fit           0-5   the company's stated targets and goal
//
// Every component reports its points, the facts behind them, the evidence
// label, and what would raise it. The UI shows the number AND the reasons.

import { catalogMatches, type CatalogMatch, type Scores, type TropeStat } from "./engine";
import { tagCatalogTitle, type CatalogRow } from "./engine";
import type { CompanyAccount, CreativeResult, PromoCampaign, TitleSummary } from "@/lib/types";
import { fmtLift } from "./lift";
import type { TropeId } from "./taxonomy";
import type { Evidence, MarketTitle, ReportRow, ResearchProfile } from "./types";

export const ASSESSMENT_VERSION = "1.2";

export type ComponentKey = "story_match" | "market_signal" | "readiness" | "own_evidence" | "fit";

export type Fact = {
  key: string;
  vars?: Record<string, string | number>;
  evidence: Evidence | null;
  /** true supports, false argues against, null unknown/missing */
  ok: boolean | null;
  points: number;
};

export type Component = {
  key: ComponentKey;
  points: number;
  max: number;
  facts: Fact[];
  /** What would raise this component: template keys. */
  raise: string[];
};

export type Band = "test_first" | "prepare" | "hold" | "insufficient";

export type Assessment = {
  title_id: string;
  version: string;
  score: number;
  band: Band;
  components: Component[];
  tropes: TropeId[];
  comparables: { key: string; title: string; platform: MarketTitle["platform"]; overlap: TropeId[]; prominence: number | null }[];
  /** Ordered next actions, template keys. */
  next: string[];
  observed_at: string | null;
};

export type AssessmentInput = {
  summary: TitleSummary;
  row: CatalogRow;
  detail: {
    license_start: string | null;
    license_end: string | null;
    approved_episodes: number;
    episodes_with_video: number;
    china_metrics: { views?: number; completion_rate?: number; paying_rate?: number } | null;
  };
  market: {
    titles: MarketTitle[];
    scores: Scores;
    stats: TropeStat[];
    observed_at: string | null;
    hasHistory: boolean;
    /** Per trope, its share of recent listings over its share of the whole catalog (What to make next, v1.0); null lifts mean fewer than 10 recent listings. */
    fresh?: { lifts: Map<TropeId, number | null>; sample: number } | null;
  };
  reports: ReportRow[];
  campaigns: PromoCampaign[];
  results: CreativeResult[];
  accounts: CompanyAccount[];
  profile: ResearchProfile | null;
  today?: string;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Benchmarks a first batch is judged against; documented in the registry, not tuned per company. */
export const BENCHMARK = { hook_hold_rate: 0.3, ctr: 0.012 };

export function assessTitle(input: AssessmentInput): Assessment {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const tropes = tagCatalogTitle(input.row);
  const components: Component[] = [];

  // ---- story match (0-35) ------------------------------------------------------------
  const match: CatalogMatch | null = tropes.length ? catalogMatches([{ id: input.summary.id, tropes }], input.market.stats, input.market.titles, input.market.scores)[0] ?? null : null;
  const compRows = (match?.comparable_keys ?? [])
    .map((key) => input.market.titles.find((t) => t.key === key))
    .filter((t): t is MarketTitle => Boolean(t))
    .map((t) => ({ key: t.key, title: t.title, platform: t.platform, overlap: t.tropes.map((x) => x.id).filter((id) => tropes.includes(id)), prominence: input.market.scores.get(t.key)?.prominence ?? null }));
  const meanProm = compRows.length ? compRows.reduce((a, c) => a + (c.prominence ?? 0), 0) / compRows.length : 0;
  // market_score is the mean prominent-listing share of the title's tropes (typically 10-45), so half of it fills 0-25; comparables' prominence adds 0-10.
  const storyPts = match?.market_score == null ? 0 : Math.round(clamp(match.market_score * 0.5, 0, 25) + clamp(meanProm, 0, 100) * 0.1);
  const storyFacts: Fact[] = [];
  if (!tropes.length) storyFacts.push({ key: "ws.fact.noTropes", evidence: null, ok: null, points: 0 });
  else {
    storyFacts.push({ key: "ws.fact.tropes", vars: { n: tropes.length }, evidence: "inferred", ok: true, points: Math.round(clamp((match?.market_score ?? 0) * 0.5, 0, 25)) });
    storyFacts.push({ key: "ws.fact.comparables", vars: { n: compRows.length, prominence: Math.round(meanProm) }, evidence: "observed", ok: compRows.length > 0, points: Math.round(clamp(meanProm, 0, 100) * 0.1) });
    const hot = match?.hot_tropes ?? [];
    storyFacts.push({ key: hot.length ? "ws.fact.hotTropes" : "ws.fact.noHotTropes", vars: { n: hot.length }, evidence: "inferred", ok: hot.length > 0, points: 0 });
  }
  components.push({ key: "story_match", points: storyPts, max: 35, facts: storyFacts, raise: tropes.length ? [] : ["ws.raise.synopsis"] });

  // ---- market signal (0-10) ----------------------------------------------------------
  // 0-6: are the platforms launching this title's story types right now? The largest lift
  // among its tropes (share of recent listings ÷ share of the catalog, What to make next).
  // 0-4: are those story types gaining chart share day over day? Needs two published days.
  const signalFacts: Fact[] = [];
  let signalPts = 0;
  if (!input.market.hasHistory) signalFacts.push({ key: "ws.fact.noHistory", evidence: null, ok: null, points: 0 });
  const lifts = tropes.map((id) => input.market.fresh?.lifts.get(id) ?? null).filter((x): x is number => x != null);
  if (!tropes.length || !input.market.fresh || (input.market.fresh.sample < 10 && !lifts.length)) {
    if (tropes.length) signalFacts.push({ key: "ws.fact.noFreshSample", evidence: null, ok: null, points: 0 });
  } else {
    const best = lifts.length ? Math.max(...lifts) : 0;
    const above = lifts.filter((x) => x >= 1.2).length;
    const liftPts = best >= 1.5 ? 6 : best >= 1.2 ? 4 : best >= 1 ? 2 : 0;
    signalPts += liftPts;
    if (best >= 1.2) signalFacts.push({ key: "ws.fact.freshLift", vars: { n: above, pct: fmtLift(best) }, evidence: "inferred", ok: true, points: liftPts });
    else signalFacts.push({ key: "ws.fact.freshFlat", vars: { pct: fmtLift(best) }, evidence: "inferred", ok: false, points: liftPts });
  }
  if (input.market.hasHistory) {
    const deltas = input.market.stats.filter((s) => tropes.includes(s.id) && s.delta_pts != null).map((s) => s.delta_pts!);
    const mean = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
    const movePts = Math.round(clamp(2 + mean, 0, 4));
    signalPts += movePts;
    signalFacts.push({ key: "ws.fact.tropeDelta", vars: { pts: Math.round(mean) }, evidence: "observed", ok: mean > 0, points: movePts });
  }
  signalPts = Math.round(clamp(signalPts, 0, 10));
  components.push({ key: "market_signal", points: signalPts, max: 10, facts: signalFacts, raise: input.market.hasHistory ? [] : ["ws.raise.history"] });

  // ---- readiness (0-25) --------------------------------------------------------------
  const d = input.detail;
  const readyFacts: Fact[] = [];
  const raise: string[] = [];
  // The rights window is not scored (decision 2026-09-10): it is recorded on the title and shown in Materials, not here.
  if (d.approved_episodes > 0) readyFacts.push({ key: "ws.fact.subsApproved", vars: { n: d.approved_episodes, total: input.summary.episode_count }, evidence: "observed", ok: true, points: d.approved_episodes >= 2 ? 10 : 7 });
  else if (input.summary.percent_adapted > 0) readyFacts.push({ key: "ws.fact.subsPartial", vars: { pct: input.summary.percent_adapted }, evidence: "observed", ok: true, points: Math.min(6, Math.round(input.summary.percent_adapted * 0.06)) });
  else {
    readyFacts.push({ key: "ws.fact.subsNone", evidence: "observed", ok: false, points: 0 });
    raise.push("ws.raise.subtitles");
  }
  if (d.episodes_with_video > 0) readyFacts.push({ key: "ws.fact.videoOk", vars: { n: d.episodes_with_video }, evidence: "observed", ok: true, points: d.episodes_with_video >= 3 ? 8 : 5 });
  else {
    readyFacts.push({ key: input.summary.episodes_ingested > 0 ? "ws.fact.scriptsOnly" : "ws.fact.noMaterials", vars: { n: input.summary.episodes_ingested }, evidence: "observed", ok: false, points: 0 });
    raise.push("ws.raise.video");
  }
  const destination = input.campaigns.some((c) => c.destination_url);
  readyFacts.push({ key: destination ? "ws.fact.destinationOk" : "ws.fact.destinationMissing", evidence: "partner_reported", ok: destination, points: destination ? 4 : 0 });
  if (!destination) raise.push("ws.raise.destination");
  const adAccount = input.accounts.find((a) => a.kind === "ad_account" && (a.state === "connected" || a.state === "invited"));
  readyFacts.push({ key: adAccount ? (adAccount.state === "connected" ? "ws.fact.adAccountOk" : "ws.fact.adAccountInvited") : "ws.fact.adAccountMissing", evidence: "partner_reported", ok: adAccount ? adAccount.state === "connected" : false, points: adAccount ? (adAccount.state === "connected" ? 3 : 1) : 0 });
  if (!adAccount || adAccount.state !== "connected") raise.push("ws.raise.adAccount");
  const readyPts = clamp(readyFacts.reduce((a, f) => a + f.points, 0), 0, 25);
  components.push({ key: "readiness", points: readyPts, max: 25, facts: readyFacts, raise });

  // ---- own evidence (0-25) ------------------------------------------------------------
  const ownFacts: Fact[] = [];
  const ownRaise: string[] = [];
  const usReports = input.reports.filter((r) => r.title_id === input.summary.id);
  if (usReports.length) {
    const metrics = new Set(usReports.map((r) => r.metric));
    const pts = clamp(4 + metrics.size * 2, 0, 10);
    ownFacts.push({ key: "ws.fact.reports", vars: { n: usReports.length, metrics: Array.from(metrics).join(", ") }, evidence: "partner_reported", ok: true, points: pts });
  } else {
    ownFacts.push({ key: "ws.fact.noReports", evidence: null, ok: null, points: 0 });
    ownRaise.push("ws.raise.reports");
  }
  const myCampaignIds = new Set(input.campaigns.map((c) => c.id));
  const results = input.results.filter((r) => myCampaignIds.has(r.campaign_id));
  if (results.length) {
    const best = results.reduce((b, r) => (r.hook_hold_rate > b.hook_hold_rate ? r : b), results[0]);
    const ctr = best.impressions ? best.clicks / best.impressions : 0;
    const over = Number(best.hook_hold_rate >= BENCHMARK.hook_hold_rate) + Number(ctr >= BENCHMARK.ctr);
    const raw = 5 + over * 5;
    const demo = best.source === "demo";
    const pts = demo ? Math.round(raw / 2) : raw;
    ownFacts.push({ key: demo ? "ws.fact.resultsDemo" : "ws.fact.results", vars: { hold: Math.round(best.hook_hold_rate * 100), ctr: (ctr * 100).toFixed(2), benchHold: Math.round(BENCHMARK.hook_hold_rate * 100), benchCtr: (BENCHMARK.ctr * 100).toFixed(1) }, evidence: demo ? "estimated" : "observed", ok: over > 0, points: pts });
  } else {
    const hasTest = input.campaigns.length > 0;
    ownFacts.push({ key: hasTest ? "ws.fact.testPending" : "ws.fact.noTest", evidence: null, ok: null, points: 0 });
    ownRaise.push(hasTest ? "ws.raise.finishTest" : "ws.raise.test");
  }
  if (d.china_metrics && (d.china_metrics.paying_rate != null || d.china_metrics.completion_rate != null)) {
    ownFacts.push({ key: "ws.fact.china", vars: { completion: Math.round((d.china_metrics.completion_rate ?? 0) * 100), paying: ((d.china_metrics.paying_rate ?? 0) * 100).toFixed(1) }, evidence: "partner_reported", ok: true, points: 0 });
  }
  const ownPts = clamp(ownFacts.reduce((a, f) => a + f.points, 0), 0, 25);
  components.push({ key: "own_evidence", points: ownPts, max: 25, facts: ownFacts, raise: ownRaise });

  // ---- fit (0-5) ----------------------------------------------------------------------
  const fitFacts: Fact[] = [];
  const targetsUS = input.profile?.target_markets.some((m) => /^(us|usa|united states|美国)$/i.test(m.trim())) ?? null;
  if (targetsUS === true) fitFacts.push({ key: "ws.fact.targetsUS", evidence: "partner_reported", ok: true, points: 3 });
  else if (targetsUS === false) fitFacts.push({ key: "ws.fact.notUS", evidence: "partner_reported", ok: false, points: 0 });
  else fitFacts.push({ key: "ws.fact.noProfile", evidence: null, ok: null, points: 0 });
  const mine = new Set(input.profile?.tropes ?? []);
  const overlap = tropes.filter((id) => mine.has(id)).length;
  if (input.profile) fitFacts.push({ key: "ws.fact.profileOverlap", vars: { n: overlap }, evidence: "partner_reported", ok: overlap > 0, points: overlap > 0 ? 2 : 0 });
  const fitPts = clamp(fitFacts.reduce((a, f) => a + f.points, 0), 0, 5);
  components.push({ key: "fit", points: fitPts, max: 5, facts: fitFacts, raise: input.profile ? [] : ["ws.raise.profile"] });

  const score = clamp(components.reduce((a, c) => a + c.points, 0), 0, 100);
  const known = tropes.length > 0 || usReports.length > 0 || results.length > 0;
  const band: Band = !known ? "insufficient" : score >= 60 ? "test_first" : score >= 35 ? "prepare" : "hold";

  const next: string[] = [];
  if (!tropes.length) next.push("ws.next.synopsis");
  if (d.episodes_with_video === 0) next.push("ws.next.video");
  if (!input.campaigns.length && band !== "hold") next.push("ws.next.test");
  const open = input.campaigns.find((c) => c.status === "review" || c.status === "draft");
  if (open) next.push(open.status === "draft" ? "ws.next.generate" : "ws.next.review");
  const approved = input.campaigns.find((c) => c.status === "approved");
  if (approved) next.push("ws.next.submit");
  if (results.length) next.push("ws.next.results");
  if (!usReports.length) next.push("ws.next.reports");

  return { title_id: input.summary.id, version: ASSESSMENT_VERSION, score, band, components, tropes, comparables: compRows, next: next.slice(0, 4), observed_at: input.market.observed_at };
}

export const BAND_ORDER: Band[] = ["test_first", "prepare", "hold", "insufficient"];
