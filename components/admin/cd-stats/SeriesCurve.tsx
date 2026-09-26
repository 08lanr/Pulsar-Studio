import { fmtShare, fmtUsdCents } from "@/lib/crazydramas/stats-summary";
import type { EpisodeCurve, SeriesStep } from "@/lib/crazydramas/stats-series";
import { t, type Locale } from "@/lib/i18n";

// The Series tab's chart (decision 2026-09-26; Ruobin: "Our current series metric also stops at episode 2"):
// of the people who started episode 1, the share who reached each episode, to the last one. The paywall episode
// is a dashed line, the biggest drops are marked with how many they lost. Server component in the house chart
// look; every episode's number in its tooltip and in the table under the chart.

const n0 = (v: number) => v.toLocaleString("en-US");

function Curve({ W, H, curve, labelledBy, className, every, locale }: { W: number; H: number; curve: EpisodeCurve; labelledBy: string; className: string; every: number; locale: Locale }) {
  const PAD = { l: 40, r: 12, t: 26, b: 30 };
  const pts = curve.points;
  const n = pts.length;
  const x = (i: number) => PAD.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (s: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - s);
  const base = y(0);
  const line = pts.map((p, i) => `${x(i)},${y(p.share ?? 0)}`).join(" ");
  const band = n <= 1 ? W : (W - PAD.l - PAD.r) / (n - 1);
  const dropAt = new Map(curve.drops.map((d) => [d.n, d]));
  const wall = curve.paywall ? pts.findIndex((p) => p.n === curve.paywall!.n) : -1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={labelledBy} className={`an-chart-svg ${className}`}>
      {[0, 0.5, 1].map((k) => (
        <g key={k}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(k)} y2={y(k)} className="an-gridline cds-grid" />
          <text x={PAD.l - 6} y={y(k) + 4} textAnchor="end" className="an-tick">
            {Math.round(k * 100)}%
          </text>
        </g>
      ))}
      {wall >= 0 && (
        <g>
          <line x1={x(wall)} x2={x(wall)} y1={PAD.t - 12} y2={base} className="cds-wall" strokeDasharray="4 3" />
          <text x={x(wall) + 4} y={PAD.t - 14} className="an-tick an-tick-strong">
            {t(locale, "cdv.chart.paywall", { n: curve.paywall!.n })}
          </text>
        </g>
      )}
      <polygon points={`${x(0)},${base} ${line} ${x(n - 1)},${base}`} className="cds-area" />
      <polyline points={line} className="cds-line" fill="none" vectorEffect="non-scaling-stroke" />
      {pts.map((p, i) => {
        const d = dropAt.get(p.n);
        return (
          <g key={p.n} className="cds-hit">
            <title>{t(locale, "cdv.chart.tip", { n: p.n, share: fmtShare(p.share), people: n0(p.people) })}</title>
            <rect x={x(i) - band / 2} y={PAD.t} width={Math.max(band, 4)} height={base - PAD.t} className="cds-hit-area" />
            {d && (
              <>
                <circle cx={x(i)} cy={y(p.share ?? 0)} r={4} className="cdv-drop-dot" />
                <text x={x(i)} y={Math.max(PAD.t + 10, y(p.share ?? 0) - 8)} textAnchor="middle" className="an-tick cdv-drop-label">
                  −{n0(d.lost)}
                </text>
              </>
            )}
            {(i === 0 || i === n - 1 || (p.n % every === 0 && n - 1 - i >= every / 2)) && (
              <text x={x(i)} y={H - PAD.b + 16} textAnchor="middle" className="an-tick">
                {p.n}
              </text>
            )}
          </g>
        );
      })}
      <line x1={PAD.l} x2={W - PAD.r} y1={base} y2={base} className="cds-baseline" />
    </svg>
  );
}

export function EpisodeCurveChart({ title, curve, locale }: { title: string; curve: EpisodeCurve; locale: Locale }) {
  const id = "cdv-curve";
  if (!curve.starters) return <p className="cdx-empty">{t(locale, "cds.ep1.none")}</p>;
  const n = curve.points.length;
  return (
    <figure className="an-chart cds-chart cdx-trend">
      <figcaption id={id}>{title}</figcaption>
      <Curve W={680} H={260} curve={curve} labelledBy={id} className="cdx-trend-wide" every={n > 40 ? 10 : 5} locale={locale} />
      <Curve W={400} H={230} curve={curve} labelledBy={id} className="cdx-trend-narrow" every={n > 40 ? 20 : 10} locale={locale} />
      <p className="cdx-note">
        {curve.drops.map((d) => t(locale, "cdv.drop", { n: d.n, lost: n0(d.lost), share: fmtShare(d.share_lost) })).join(" · ")}
      </p>
      <details className="an-table-alt">
        <summary>{t(locale, "cdx.numbers")}</summary>
        <div className="an-scroll">
          <table className="an-table">
            <caption className="sr-only">{title}</caption>
            <tbody>
              {curve.points.map((p) => (
                <tr key={p.n}>
                  <th scope="row">{t(locale, "cdv.ep", { n: p.n })}</th>
                  <td className="gt-num">{n0(p.people)}</td>
                  <td className="gt-num">{fmtShare(p.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/** The path from the page to paying beside the curve, and the two rates under it. */
export function SeriesFunnelList({ steps, paywallToPaid, revenuePerBuyer, locale }: { steps: SeriesStep[]; paywallToPaid: number | null; revenuePerBuyer: number | null; locale: Locale }) {
  return (
    <>
      <ul className="cdx-list">
        {steps.map((s) => (
          <li key={s.key}>
            <span>{t(locale, `cdv.step.${s.key}`)}</span>
            <span>
              <strong>{n0(s.people)}</strong> <span className="cdx-muted">{s.key === "opened" ? "" : fmtShare(s.of_opened)}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="cdv-rates">
        <div>
          <span className="cdx-muted">{t(locale, "cdv.paywallToPaid")}</span>
          <strong>{fmtShare(paywallToPaid)}</strong>
        </div>
        <div>
          <span className="cdx-muted">{t(locale, "cdv.perBuyer")}</span>
          <strong>{revenuePerBuyer === null ? "–" : fmtUsdCents(revenuePerBuyer)}</strong>
        </div>
      </div>
    </>
  );
}
