import { t, type Locale } from "@/lib/i18n";
import { fmtLift } from "@/lib/research/lift";
import type { FreshReason, FreshTitle, RisingTrope } from "@/lib/research/next";
import { fmtCount, platformName } from "./ui";

// Shared cells for the "what to make next" board and its overview miniature.
// Every number keeps its state: a missing baseline is a labelled gap, not 0.

export function GrowthCell({ x, locale, compact = false }: { x: FreshTitle; locale: Locale; compact?: boolean }) {
  const g = x.growth;
  if (g.state === "ok") {
    return (
      <span className="nx-growth">
        <b>+{fmtCount(g.per_day)}{t(locale, "next.growth.perDay")}</b>
        {!compact && <small>{g.growth_pct != null ? `+${g.growth_pct}%` : "—"}</small>}
      </span>
    );
  }
  const key = g.state === "collecting_history" ? "next.growth.collecting" : g.state === "no_baseline" ? "next.growth.no_baseline" : g.state === "anomaly" ? "next.growth.anomaly" : "next.growth.incomparable";
  return <span className="nx-growth is-empty">{t(locale, key)}</span>;
}

export function WhenCell({ x, locale }: { x: FreshTitle; locale: Locale }) {
  const rel = x.title.released_at;
  return (
    <span className="nx-when">
      {rel ? (
        <>
          <span>{t(locale, "next.when.released", { date: rel })}</span>
          <small>{x.days_since_release === 0 ? t(locale, "next.when.today") : x.days_since_release != null ? t(locale, "next.when.daysAgo", { n: x.days_since_release }) : ""}</small>
        </>
      ) : (
        <small>{t(locale, "next.when.noDate")}</small>
      )}
      {x.first_seen && <small>{t(locale, "next.when.seen", { date: x.first_seen })}</small>}
    </span>
  );
}

export function ReasonChips({ reasons, locale }: { reasons: FreshReason[]; locale: Locale }) {
  return (
    <span className="nx-reasons">
      {reasons.map((r, i) => (
        <span key={i} className={r.kind === "first_seen" ? "is-first" : undefined}>
          {r.kind === "platform_new" && t(locale, "next.reason.platform_new")}
          {r.kind === "released" && t(locale, "next.reason.released", { date: r.date })}
          {r.kind === "new_list" && t(locale, "next.reason.new_list", { name: r.name, rank: r.rank })}
          {r.kind === "first_seen" && t(locale, "next.reason.first_seen", { date: r.date })}
        </span>
      ))}
    </span>
  );
}

export function ChartCell({ x, locale }: { x: FreshTitle; locale: Locale }) {
  if (!x.best_chart) return <span className="gt-muted">{t(locale, "next.chart.none")}</span>;
  const m = x.chart;
  const move =
    m?.state === "entered" ? t(locale, "next.chart.entered")
    : m?.state === "ok" ? (m.movement > 0 ? t(locale, "next.chart.up", { n: m.movement }) : m.movement < 0 ? t(locale, "next.chart.down", { n: -m.movement }) : t(locale, "next.chart.same"))
    : null;
  return (
    <span className="nx-when">
      <span>{x.best_chart.name} #{x.best_chart.rank}</span>
      {move && <small>{move}</small>}
    </span>
  );
}

export function LiftChip({ trope, locale }: { trope: RisingTrope; locale: Locale }) {
  if (trope.lift == null) return <span className="nx-lift is-down">{t(locale, "next.lift.na")}</span>;
  const cls = trope.lift >= 1.2 ? "is-up" : trope.lift <= 0.8 ? "is-down" : "";
  const label = trope.lift >= 1.2 ? "next.lift.up" : trope.lift <= 0.8 ? "next.lift.down" : "next.lift.flat";
  return (
    <span className={`nx-lift ${cls}`} title={t(locale, label)}>
      {trope.lift >= 1.2 ? "▲" : trope.lift <= 0.8 ? "▽" : "•"} {fmtLift(trope.lift)}
    </span>
  );
}

export function titleHref(x: FreshTitle, returnTo: string): string {
  return `/producer/market/${x.title.key}?returnTo=${encodeURIComponent(returnTo)}`;
}

export function platformLabel(x: FreshTitle): string {
  return platformName(x.title.platform);
}
