// Small server-safe pieces the market desk pages share: the evidence label,
// a trope chip, the prominence meter, state badges, metric labels that link
// to their registry entry, number formatting. No client state here.

import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import type { RegistryStatus } from "@/lib/research/registry";
import { tropeLabel, type TropeId } from "@/lib/research/taxonomy";
import type { Evidence, Observation, Platform } from "@/lib/research/types";

export function EvidenceTag({ evidence, locale }: { evidence: Evidence; locale: Locale }) {
  return (
    <span className={`ev ev-${evidence}`} title={t(locale, "research.evidence.legend")}>
      {t(locale, `research.evidence.${evidence}`)}
    </span>
  );
}

const STATE_KEY: Record<RegistryStatus, string> = {
  available: "research.state.available",
  collecting_history: "research.state.collecting",
  requires_connection: "research.state.requiresConnection",
  manual: "research.state.manual",
  unavailable: "research.state.unavailable",
  stale: "research.state.stale",
  failed: "research.state.failed",
};

export function StateBadge({ status, locale }: { status: RegistryStatus; locale: Locale }) {
  return <span className={`state state-${status}`}>{t(locale, STATE_KEY[status])}</span>;
}

/** A metric name that opens its methodology entry. */
export function MetricLabel({ metric, locale, children }: { metric: string; locale: Locale; children: React.ReactNode }) {
  return (
    <a className="metric-label" href={`/producer/sources/${metric}`} title={t(locale, "research.title.methodology")}>
      {children}
    </a>
  );
}

export function TropeChip({
  id,
  locale,
  hot,
  mine,
  evidence,
  href,
}: {
  id: TropeId;
  locale: Locale;
  hot?: boolean;
  mine?: boolean;
  evidence?: Evidence;
  href?: string;
}) {
  const cls = `trope${hot ? " is-hot" : ""}${mine ? " is-mine" : ""}`;
  const body = (
    <>
      {tropeLabel(id, locale)}
      {evidence === "inferred" && <span className="ev ev-inferred">{t(locale, "research.evidence.inferred")}</span>}
    </>
  );
  return href ? (
    <a className={cls} href={href}>
      {body}
    </a>
  ) : (
    <span className={cls}>{body}</span>
  );
}

/** Prominence meter; renders the "not scored" state instead of a zero. */
export function Prominence({ value, locale }: { value: number | null; locale: Locale }) {
  if (value == null) return <span className="heat heat-none" title={t(locale, "research.state.notShown")}>–</span>;
  return (
    <span className="heat" style={{ ["--heat" as string]: `${Math.max(0, Math.min(100, value))}%` }}>
      <i aria-hidden />
      <b>{Math.round(value)}</b>
    </span>
  );
}

export function platformName(platform: Platform): string {
  return platform === "reelshort" ? "ReelShort" : "DramaBox";
}

/** 1234567 -> 1.2M; deterministic on server and client. */
export function fmtCount(n: number | null | undefined): string {
  if (n == null) return "–";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

export function fmtPct(v: number | null | undefined, digits = 0): string {
  if (v == null) return "–";
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtSeconds(s: number | null | undefined): string {
  if (s == null) return "–";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}:${String(r).padStart(2, "0")}` : `${r}s`;
}

/** A counter cell: value with its unit's label, or the honest missing state. */
export function ObservationCell({ o, locale }: { o: Observation | null; locale: Locale }) {
  if (!o) return <span className="gt-muted" title={t(locale, "research.state.notShown")}>–</span>;
  return (
    <span title={`${o.source_field} · ${o.observed_at}`}>
      {o.value === 0 ? <span className="gt-muted">{t(locale, "research.state.validZero")}</span> : fmtCount(o.value)}
    </span>
  );
}

export function unitLabel(unit: Observation["unit"], locale: Locale): string {
  return unit === "collects" ? t(locale, "research.col.collects") : unit === "follows" ? t(locale, "research.col.follows") : unit === "views" ? t(locale, "research.col.views") : t(locale, "research.col.rating");
}

export function fmtUtc(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/** Build a URL under `path` from a base query and a patch; "all"/empty values drop out. */
export function hrefWith(path: string, base: Record<string, string | undefined | null>, patch: Record<string, string | undefined | null>): string {
  const params = new URLSearchParams();
  const merged = { ...base, ...patch };
  for (const [k, v] of Object.entries(merged)) if (v && v !== "all") params.set(k, v);
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}

export const marketHref = (base: Record<string, string | undefined | null>, patch: Record<string, string | undefined | null>) => hrefWith("/producer", base, patch);
export const exploreHref = (base: Record<string, string | undefined | null>, patch: Record<string, string | undefined | null>) => hrefWith("/producer/explore/titles", base, patch);
