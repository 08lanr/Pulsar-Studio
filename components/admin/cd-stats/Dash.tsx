import { fmtShare, histSummary, share, type DashTotals, type PathStep } from "@/lib/crazydramas/stats-summary";
import { t, type Locale } from "@/lib/i18n";

// The dashboard's pieces (/crazydramas/stats, 2026-09-25): a timing histogram, the path with its biggest drop
// marked, and one table to compare groups. Server components on the house chart classes; every bar carries
// its number in text and a tooltip.

const n0 = (v: number) => v.toLocaleString("en-US");

/** A timing histogram as columns, one per bin (under 1 s, 1-2 s, ...), with its count on top and a summary line. */
export function HistView({ title, hist, edges, locale }: { title: string; hist: number[]; edges: number[]; locale: Locale }) {
  const h = histSummary(hist, edges);
  const max = Math.max(1, ...h.bins.map((b) => b.people));
  return (
    <figure className="cdd-hist">
      <figcaption>
        <strong>{title}</strong>
        <span>
          {h.n > 0 ? t(locale, "cdx.hist.sum", { n: n0(h.n), median: h.median ?? "–" }) : t(locale, "cdx.hist.none")}
        </span>
      </figcaption>
      {h.n > 0 && (
        <div className="cdd-hist-cols" role="list">
          {h.bins.map((b) => (
            <div key={b.label} className="cdd-hist-col" role="listitem" title={t(locale, "cdd.hist.tip", { label: b.label, n: n0(b.people) })}>
              <span className="cdd-hist-n">{b.people > 0 ? n0(b.people) : ""}</span>
              <span className="cdd-hist-bar-wrap" aria-hidden>
                <span className={`cdd-hist-bar${b.people === 0 ? " is-zero" : ""}`} style={{ height: `${(b.people / max) * 100}%` }} />
              </span>
              {/* "13–20", not "13–20s": the unit is said once, under the columns. */}
              <span className="cdd-hist-label">{b.label.replace(/s(\+?)$/, "$1")}</span>
            </div>
          ))}
        </div>
      )}
      {h.n > 0 && <div className="cdd-hist-axis">{t(locale, "cdd.hist.axis")}</div>}
    </figure>
  );
}

// ---- the second cut (2026-09-25): the path with its biggest drop marked, and one table to compare groups ----------

/** The path as bars (each as long as its share of the first step shown), the biggest drop marked in words. */
export function FunnelChart({ steps, drop, locale }: { steps: PathStep[]; drop: { to: PathStep; lost: number } | null; locale: Locale }) {
  const top = Math.max(1, steps[0]?.people ?? 0);
  return (
    <ul className="cdx-funnel">
      {steps.map((s) => {
        const isDrop = drop?.to.key === s.key;
        return (
          <li key={s.key} className={isDrop ? "is-drop" : undefined}>
            <span className="cdx-funnel-label">{t(locale, `cdd.path.${s.key}`)}</span>
            <span className="cds-path-track" aria-hidden>
              <span className={`cds-path-fill${s.people === 0 ? " is-zero" : ""}${s.key === "landed" ? " cdd-soft" : ""}`} style={{ width: `${(s.people / top) * 100}%`, display: "block" }} />
            </span>
            <span className="cds-path-count">{n0(s.people)}</span>
            <span className="cds-path-share">{s.key === "landed" ? "" : fmtShare(s.of_seen)}</span>
            {isDrop && <span className="cdx-drop-tag">{t(locale, "cdx.drop.tag", { n: n0(drop!.lost) })}</span>}
          </li>
        );
      })}
    </ul>
  );
}

export type CompareRow = { key: string; name: string; href?: string | null; totals: DashTotals };

/** Groups side by side: visitors, then every step as a share of them (the count in the tooltip). */
export function CompareTable({ rows, caption, locale }: { rows: CompareRow[]; caption: string; locale: Locale }) {
  if (!rows.length) return <p className="cdx-empty">{t(locale, "cdx.empty")}</p>;
  const rate = (n: number, of: number) => (
    <td className="gt-num" title={n0(n)}>
      {of > 0 ? fmtShare(share(n, of)) : "–"}
    </td>
  );
  return (
    <div className="an-scroll" tabIndex={0} role="region" aria-label={caption}>
      <table className="an-table cds-table cdx-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col" className="gt-num">{t(locale, "cdx.kpi.visitors")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdx.kpi.started")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdx.col.quarter")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdx.kpi.finished")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdx.kpi.ep2")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdx.kpi.buyers")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" className="cds-title">{r.href ? <a href={r.href}>{r.name}</a> : r.name}</th>
              <td className="gt-num">{n0(r.totals.opened)}</td>
              {rate(r.totals.started_ep1, r.totals.opened)}
              {rate(r.totals.ep1_25, r.totals.opened)}
              {rate(r.totals.finished_ep1, r.totals.opened)}
              {rate(r.totals.watched_ep2, r.totals.opened)}
              {rate(r.totals.buyers, r.totals.opened)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
