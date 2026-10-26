import type { CdStatsRead } from "@/lib/crazydramas/stats";
import { coinValueCoverage } from "@/lib/crazydramas/stats-money";
import type { CdStatsReport } from "@/lib/crazydramas/stats-types";
import { STATS_RANGES, type StatsRange } from "@/lib/crazydramas/stats-summary";
import { t, type Locale } from "@/lib/i18n";

// Pieces both CrazyDramas stats pages share: the period switch and the refusal.

export function CoinValueNotice({ report, locale }: { report: Pick<CdStatsReport, "coins">; locale: Locale }) {
  const coverage = coinValueCoverage(report);
  if (!coverage || coverage === "complete") return null;
  return <p className="note note-warn" role="status">{t(locale, `cdcoin.value.${coverage}`)}</p>;
}

const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * When crazydramas read fewer days than its 120 (`window.limited`: it reads a bounded number of events and keeps the
 * most recent whole days that fit; since 2026-10-26 every report), every period shows those days only, and the
 * weekly / monthly audience counts only them where its days reach before the rows read.
 */
export function WindowNotice({ report, locale }: { report: Pick<CdStatsReport, "window" | "from" | "to" | "days">; locale: Locale }) {
  const w = report.window;
  if (!w?.limited) return null;
  const partial = report.days.some((d) => !d.wau_whole || !d.mau_whole);
  const vars = { days: w.days, from: shortDay(report.from), to: shortDay(report.to) };
  return <p className="note note-warn" role="status" data-testid="window-notice">{t(locale, partial ? "cdx.window.limitedAudience" : "cdx.window.limited", vars)}</p>;
}

export function RangeTabs({ range, hrefFor, locale }: { range: StatsRange; hrefFor: (r: StatsRange) => string; locale: Locale }) {
  return (
    <nav className="seg" aria-label={t(locale, "cds.range.label")}>
      {STATS_RANGES.map((r) => (
        <a key={r} className={`seg-btn${r === range ? " on" : ""}`} aria-current={r === range ? "true" : undefined} href={hrefFor(r)}>
          {t(locale, `cds.range.${r}`)}
        </a>
      ))}
    </nav>
  );
}

export function ReadFailure({ read, locale }: { read: Extract<CdStatsRead, { ok: false }>; locale: Locale }) {
  return (
    <p className="note note-warn" role="alert">
      {t(locale, read.code === "read_off" ? "cds.failed.readOff" : "cds.failed", { error: read.error })}
    </p>
  );
}
