// The explainable catalog shortlist (docs/market-desk-plan.md, phase 4).
//
// "Which of my dramas deserve a US launch test, and why?" answered as an
// explained HYPOTHESIS, never a probability of success: every entry lists
// the reasons it was ranked (comparables among prominent listings, rights
// window, localization readiness, the producer's stated constraints, own
// evidence) and what is missing. The formula is versioned and its inputs
// are visible in the UI.

import type { CatalogMatch } from "./engine";
import type { ReportRow, ResearchProfile } from "./types";

export const SHORTLIST_VERSION = "1.0";

export type ShortlistTitle = {
  id: string;
  name_zh: string;
  name_en: string | null;
  license_start: string | null;
  license_end: string | null;
  /** 0-100 lines adapted (Adapt state). */
  percent_adapted: number;
  has_approved_version: boolean;
  episodes_ingested: number;
  episode_count: number;
  has_synopsis: boolean;
};

export type ReasonKind = "comparables" | "rights" | "localization" | "constraints" | "own_evidence";

export type Reason = {
  kind: ReasonKind;
  /** true = supports the test, false = argues against or blocks, null = unknown (listed under missing). */
  ok: boolean | null;
  /** Contribution to the score, in points. */
  points: number;
  /** Template key + vars for the UI; no free-form prose. */
  key: string;
  vars: Record<string, string | number>;
};

export type ShortlistEntry = {
  title_id: string;
  /** 0-100 explained score; null when nothing is known about the title. */
  score: number | null;
  reasons: Reason[];
  missing: ReasonKind[];
  version: string;
};

function rightsCoverToday(t: ShortlistTitle, today: string): boolean | null {
  if (!t.license_start && !t.license_end) return null;
  if (t.license_start && today < t.license_start) return false;
  if (t.license_end && today > t.license_end) return false;
  return true;
}

export function shortlist(input: { titles: ShortlistTitle[]; matches: CatalogMatch[]; profile: ResearchProfile | null; reports: ReportRow[]; today?: string }): ShortlistEntry[] {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const matchById = new Map(input.matches.map((m) => [m.title_id, m]));
  const reportsByTitle = new Map<string, ReportRow[]>();
  for (const r of input.reports) if (r.title_id) reportsByTitle.set(r.title_id, [...(reportsByTitle.get(r.title_id) ?? []), r]);
  const targetsUS = input.profile?.target_markets.some((m) => /^(us|usa|united states|美国)$/i.test(m.trim())) ?? null;

  return input.titles
    .map((t) => {
      const reasons: Reason[] = [];
      const missing: ReasonKind[] = [];
      const m = matchById.get(t.id) ?? null;

      // 1. Comparables: similarity of the title's tropes to prominent listings (0-50 points).
      if (m && m.market_score != null) {
        const pts = Math.round(m.market_score * 0.5);
        reasons.push({ kind: "comparables", ok: m.market_score >= 25, points: pts, key: "research.shortlist.reason.comparables", vars: { score: m.market_score, n: m.comparable_keys.length, hot: m.hot_tropes.length } });
      } else {
        missing.push("comparables");
        reasons.push({ kind: "comparables", ok: null, points: 0, key: t.has_synopsis ? "research.shortlist.reason.untagged" : "research.shortlist.reason.noSynopsis", vars: {} });
      }

      // 2. Rights: a license window that covers today (partner-reported), 0-15 points.
      const rights = rightsCoverToday(t, today);
      if (rights === true) reasons.push({ kind: "rights", ok: true, points: 15, key: "research.shortlist.reason.rightsOk", vars: { end: t.license_end ?? "–" } });
      else if (rights === false) reasons.push({ kind: "rights", ok: false, points: -30, key: "research.shortlist.reason.rightsOutside", vars: { start: t.license_start ?? "–", end: t.license_end ?? "–" } });
      else {
        missing.push("rights");
        reasons.push({ kind: "rights", ok: null, points: 0, key: "research.shortlist.reason.rightsUnknown", vars: {} });
      }

      // 3. Localization readiness from Adapt state, 0-20 points.
      if (t.has_approved_version) reasons.push({ kind: "localization", ok: true, points: 20, key: "research.shortlist.reason.subtitlesApproved", vars: {} });
      else if (t.percent_adapted > 0) reasons.push({ kind: "localization", ok: true, points: Math.round(t.percent_adapted * 0.12), key: "research.shortlist.reason.subtitlesPartial", vars: { pct: t.percent_adapted, eps: t.episodes_ingested, total: t.episode_count } });
      else if (t.episodes_ingested > 0) reasons.push({ kind: "localization", ok: false, points: 3, key: "research.shortlist.reason.scriptsOnly", vars: { eps: t.episodes_ingested } });
      else {
        missing.push("localization");
        reasons.push({ kind: "localization", ok: null, points: 0, key: "research.shortlist.reason.noMaterials", vars: {} });
      }

      // 4. Constraints the producer stated, ±10 points.
      if (targetsUS === true) reasons.push({ kind: "constraints", ok: true, points: 10, key: "research.shortlist.reason.targetsUS", vars: {} });
      else if (targetsUS === false) reasons.push({ kind: "constraints", ok: false, points: -5, key: "research.shortlist.reason.notTargetingUS", vars: { markets: input.profile?.target_markets.join(", ") ?? "" } });
      else {
        missing.push("constraints");
        reasons.push({ kind: "constraints", ok: null, points: 0, key: "research.shortlist.reason.noProfile", vars: {} });
      }

      // 5. Own evidence: imported reports for this title, +5 (it can be measured), never a hit signal.
      const own = reportsByTitle.get(t.id) ?? [];
      if (own.length) reasons.push({ kind: "own_evidence", ok: true, points: 5, key: "research.shortlist.reason.ownReports", vars: { n: own.length } });
      else {
        missing.push("own_evidence");
        reasons.push({ kind: "own_evidence", ok: null, points: 0, key: "research.shortlist.reason.noReports", vars: {} });
      }

      const known = reasons.some((r) => r.ok !== null);
      const raw = reasons.reduce((a, r) => a + r.points, 0);
      return { title_id: t.id, score: known ? Math.max(0, Math.min(100, raw)) : null, reasons, missing, version: SHORTLIST_VERSION };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}
