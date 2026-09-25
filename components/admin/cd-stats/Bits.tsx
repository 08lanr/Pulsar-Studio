import type { CdStatsRead } from "@/lib/crazydramas/stats";
import { STATS_RANGES, type StatsRange } from "@/lib/crazydramas/stats-summary";
import { t, type Locale } from "@/lib/i18n";

// Pieces both CrazyDramas stats pages share: the period switch, the line that
// says where the numbers came from, the refusal, and the definitions.

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

export function ReadLine({ read, span, refreshHref, locale }: { read: Extract<CdStatsRead, { ok: true }>; span: { from: string; to: string }; refreshHref: string; locale: Locale }) {
  const time = new Date(read.read_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
  return (
    <p className="cds-read">
      {t(locale, "cds.range.span", span)} · {read.mode === "fake" ? t(locale, "cds.readAtFake") : t(locale, "cds.readAt", { time })} <a href={refreshHref}>{t(locale, "cds.refresh")}</a>
    </p>
  );
}

export function ReadFailure({ read, locale }: { read: Extract<CdStatsRead, { ok: false }>; locale: Locale }) {
  return (
    <p className="note note-warn" role="alert">
      {t(locale, read.code === "read_off" ? "cds.failed.readOff" : "cds.failed", { error: read.error })}
    </p>
  );
}

export function Definitions({ robots, locale }: { robots: number; locale: Locale }) {
  return (
    <details className="cds-defs">
      <summary>{t(locale, "cds.defs.title")}</summary>
      <ul>
        <li>{t(locale, "cds.defs.person")}</li>
        <li>{t(locale, "cds.defs.robots", { n: robots.toLocaleString("en-US") })}</li>
        <li>{t(locale, "cds.defs.team")}</li>
        <li>{t(locale, "cds.defs.played")}</li>
        <li>{t(locale, "cds.defs.watched")}</li>
        <li>{t(locale, "cds.defs.paywall")}</li>
        <li>{t(locale, "cds.defs.test")}</li>
      </ul>
    </details>
  );
}

export function Tile({ label, value, note, hero }: { label: string; value: string; note?: string | null; hero?: boolean }) {
  return (
    <div className={`cds-tile${hero ? " cds-tile-hero" : ""}`}>
      <span className="cds-tile-label">{label}</span>
      <strong className="cds-tile-value">{value}</strong>
      {note && <span className="cds-tile-note">{note}</span>}
    </div>
  );
}
