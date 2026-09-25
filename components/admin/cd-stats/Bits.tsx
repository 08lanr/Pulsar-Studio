import type { CdStatsRead } from "@/lib/crazydramas/stats";
import { STATS_RANGES, type StatsRange } from "@/lib/crazydramas/stats-summary";
import { t, type Locale } from "@/lib/i18n";

// Pieces both CrazyDramas stats pages share: the period switch and the refusal.

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
