import Info from "@/components/admin/cd-stats/Info";
import { fmtShare, fmtUsdCents } from "@/lib/crazydramas/stats-summary";

// The dashboard's headline pieces (2026-09-25, second cut): a number card with its change against the period
// before and a small line of its days, and one chart of a number per day. Server components in the house chart
// look (one colour, thin marks, hairline grid; every mark carries its numbers as a tooltip).

const n0 = (v: number) => v.toLocaleString("en-US");
const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** The line of a number's days, drawn to its own height. */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="cdx-spark" aria-hidden />;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${26 - (v / max) * 24}`);
  return (
    <svg className="cdx-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden>
      <polygon points={`0,28 ${pts.join(" ")} 100,28`} className="cdx-spark-area" />
      <polyline points={pts.join(" ")} className="cdx-spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export type KpiCardProps = {
  label: string;
  info: string;
  value: string;
  sub?: string | null;
  /** The change against the period before (0.12 = up 12%), and what that period was. */
  change?: number | null;
  vs?: string | null;
  /** Up is good (visitors) or bad (pages never seen): the arrow's colour follows. */
  upIsGood?: boolean;
  spark?: number[];
  href?: string;
  on?: boolean;
  /** The ⓘ button's name for screen readers ("About Visitors"); the label itself when absent. */
  infoLabel?: string;
};

export function KpiCard({ label, info, value, sub, change, vs, upIsGood = true, spark, href, on, infoLabel }: KpiCardProps) {
  const body = (
    <>
      <span className="cdx-kpi-label">
        <span className="cdx-kpi-name">{label}</span>
        <Info text={info} label={infoLabel ?? label} />
      </span>
      <strong className="cdx-kpi-value">{value}</strong>
      <span className="cdx-kpi-foot">
        {sub && <span>{sub}</span>}
        {change != null && (
          <span className={change >= 0 === upIsGood ? "delta-up" : "delta-down"} title={vs ?? undefined}>
            {change >= 0 ? "▲" : "▼"} {fmtShare(Math.abs(change))}
          </span>
        )}
      </span>
      {spark && <Sparkline values={spark} />}
    </>
  );
  // A clickable card is a link stretched under the card (the ⓘ sits above it, a button of its own).
  return (
    <div className={`cdx-kpi${href ? " cdx-kpi-click" : ""}${on ? " on" : ""}`}>
      {href && (
        <a className="cdx-kpi-link" href={href} aria-current={on ? "true" : undefined}>
          <span className="sr-only">{label}</span>
        </a>
      )}
      {body}
    </div>
  );
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

function column(x: number, w: number, yTop: number, yBase: number): string {
  const h = yBase - yTop;
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${yBase} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + w - r} Q${x + w},${yTop} ${x + w},${yTop + r} V${yBase} Z`;
}

/** The columns of TrendChart at one width: a wide drawing for a screen, a narrow one for a phone (an SVG's text
 * shrinks with it, so a phone gets its own drawing rather than a shrunk one). */
function Columns({ W, H, points, cents, labelledBy, dates, className }: { W: number; H: number; points: { day: string; value: number }[]; cents: boolean; labelledBy: string; dates: number; className: string }) {
  const PAD = { l: 44, r: 10, t: 22, b: 28 };
  const fmt = (v: number) => (cents ? fmtUsdCents(v) : n0(v));
  const max = niceMax(Math.max(1, ...points.map((p) => p.value)));
  const band = (W - PAD.l - PAD.r) / Math.max(1, points.length);
  const bw = Math.max(2, Math.min(26, band - 3));
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  const base = y(0);
  const last = points.length - 1;
  let peak = 0;
  points.forEach((p, i) => {
    if (p.value > points[peak].value) peak = i;
  });
  const labelled = new Set((last - peak) * band < 48 ? [last] : [peak, last]);
  const every = Math.max(1, Math.ceil(points.length / dates));
  const dateShown = (i: number) => i === last || (i % every === 0 && last - i >= Math.ceil(every / 2));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={labelledBy} className={`an-chart-svg ${className}`}>
      {[0, 0.5, 1].map((k) => (
        <g key={k}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(k * max)} y2={y(k * max)} className="an-gridline cds-grid" />
          <text x={PAD.l - 6} y={y(k * max) + 4} textAnchor="end" className="an-tick">
            {cents ? fmtUsdCents(Math.round(k * max)).replace(/\.00$/, "") : n0(Math.round(k * max))}
          </text>
        </g>
      ))}
      {points.map((p, i) => {
        const x = PAD.l + i * band + (band - bw) / 2;
        return (
          <g key={p.day} className="cds-hit">
            <title>{`${shortDay(p.day)}: ${fmt(p.value)}`}</title>
            <rect x={PAD.l + i * band} y={PAD.t} width={band} height={base - PAD.t} className="cds-hit-area" />
            <path d={column(x, bw, y(p.value), base)} className="cds-mark" />
            {labelled.has(i) && p.value > 0 && (
              <text x={x + bw / 2} y={y(p.value) - 6} textAnchor="middle" className="an-tick an-tick-strong">
                {fmt(p.value)}
              </text>
            )}
            {dateShown(i) && (
              <text x={x + bw / 2} y={H - PAD.b + 16} textAnchor="middle" className="an-tick">
                {shortDay(p.day)}
              </text>
            )}
          </g>
        );
      })}
      <line x1={PAD.l} x2={W - PAD.r} y1={base} y2={base} className="cds-baseline" />
    </svg>
  );
}

/** One number per day as columns: the busiest day and the last day labelled, every column's number in its tooltip. */
export function TrendChart({ title, points, cents = false, tableLabel }: { title: string; points: { day: string; value: number }[]; cents?: boolean; tableLabel: string }) {
  const fmt = (v: number) => (cents ? fmtUsdCents(v) : n0(v));
  const id = `cdx-trend-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <figure className="an-chart cds-chart cdx-trend">
      <figcaption id={id}>{title}</figcaption>
      <Columns W={1000} H={230} points={points} cents={cents} labelledBy={id} dates={7} className="cdx-trend-wide" />
      <Columns W={400} H={220} points={points} cents={cents} labelledBy={id} dates={3} className="cdx-trend-narrow" />
      <details className="an-table-alt">
        <summary>{tableLabel}</summary>
        <div className="an-scroll">
          <table className="an-table">
            <caption className="sr-only">{title}</caption>
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.day}>
                  <th scope="row">{p.day}</th>
                  <td className="gt-num">{fmt(p.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
