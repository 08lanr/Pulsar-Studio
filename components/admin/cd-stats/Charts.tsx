import type { CdStatsDay } from "@/lib/crazydramas/stats-types";
import { fmtClock, fmtShare, fmtUsdCents, type Ep1Curve, type EpisodeBar } from "@/lib/crazydramas/stats-summary";
import { t, type Locale } from "@/lib/i18n";

// The three CrazyDramas stats charts, inline SVG with no library and no
// animation, in the house chart look (app/analytics.css ticks and grid,
// app/crazydramas-stats.css marks): one colour (--data-1), thin marks with 4px
// rounded ends on a single baseline, a hairline grid, labels on the one or two
// values that tell the story and nowhere else. Every mark has a hit area wider
// than itself with its numbers as a tooltip, and every chart has the same
// numbers as a table behind "Show the numbers". Server components.

const W = 720;

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

/** A column from the baseline up, rounded 4px at its top only. */
function column(x: number, w: number, yTop: number, yBase: number): string {
  const h = yBase - yTop;
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${yBase} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + w - r} Q${x + w},${yTop} ${x + w},${yTop + r} V${yBase} Z`;
}

const n0 = (v: number) => v.toLocaleString("en-US");
const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// ---- people watching each day ----------------------------------------------------------------------------------

export function DailyChart({ days, locale }: { days: CdStatsDay[]; locale: Locale }) {
  const H = 220;
  const PAD = { l: 44, r: 12, t: 22, b: 30 };
  const max = niceMax(Math.max(1, ...days.map((d) => d.watchers)));
  const band = (W - PAD.l - PAD.r) / Math.max(1, days.length);
  const bw = Math.max(2, Math.min(24, band - 2));
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  const base = y(0);
  const labelEvery = Math.max(1, Math.ceil(days.length / 8));
  // Label the busiest day and today, nothing else.
  let peak = 0;
  days.forEach((d, i) => {
    if (d.watchers > days[peak].watchers) peak = i;
  });
  const last = days.length - 1;
  // Two value labels closer than ~44px would overlap: keep today's alone then.
  const labelled = new Set((last - peak) * band < 44 ? [last] : [peak, last]);
  // Every nth date, and today's; a stride date too close to today's is dropped.
  const dateShown = (i: number) => i === last || (i % labelEvery === 0 && last - i >= Math.ceil(labelEvery / 2));
  const cap = t(locale, "cds.aud.chart");
  return (
    <figure className="an-chart cds-chart">
      <figcaption id="cds-daily-cap">{cap}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="cds-daily-cap" aria-describedby="cds-daily-desc" className="an-chart-svg">
        <desc id="cds-daily-desc">{t(locale, "cds.aud.chartDesc", { from: days[0]?.day ?? "", to: days[days.length - 1]?.day ?? "" })}</desc>
        {[0, 0.25, 0.5, 0.75, 1].map((k) => (
          <g key={k}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(k * max)} y2={y(k * max)} className="an-gridline cds-grid" />
            <text x={PAD.l - 6} y={y(k * max) + 4} textAnchor="end" className="an-tick">{n0(Math.round(k * max))}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = PAD.l + i * band + (band - bw) / 2;
          return (
            <g key={d.day} className="cds-hit">
              <title>{t(locale, "cds.aud.tip", { day: shortDay(d.day), watchers: n0(d.watchers), visitors: n0(d.visitors), fresh: n0(d.new_watchers) })}</title>
              <rect x={PAD.l + i * band} y={PAD.t} width={band} height={base - PAD.t} className="cds-hit-area" />
              <path d={column(x, bw, y(d.watchers), base)} className="cds-mark" />
              {labelled.has(i) && d.watchers > 0 && <text x={x + bw / 2} y={y(d.watchers) - 6} textAnchor="middle" className="an-tick an-tick-strong">{n0(d.watchers)}</text>}
              {dateShown(i) && <text x={x + bw / 2} y={H - PAD.b + 16} textAnchor="middle" className="an-tick">{shortDay(d.day)}</text>}
            </g>
          );
        })}
        <line x1={PAD.l} x2={W - PAD.r} y1={base} y2={base} className="cds-baseline" />
      </svg>
      <details className="an-table-alt">
        <summary>{t(locale, "cds.aud.table")}</summary>
        <div className="an-scroll">
          <table className="an-table">
            <caption className="sr-only">{cap}</caption>
            <thead>
              <tr>
                <th scope="col">{t(locale, "cds.col.day")}</th>
                <th scope="col" className="gt-num">{t(locale, "cds.col.visitors")}</th>
                <th scope="col" className="gt-num">{t(locale, "cds.col.watchers")}</th>
                <th scope="col" className="gt-num">{t(locale, "cds.col.new")}</th>
                <th scope="col" className="gt-num">{t(locale, "cds.col.wau")}</th>
                <th scope="col" className="gt-num">{t(locale, "cds.col.revenue")}</th>
                <th scope="col" className="gt-num">{t(locale, "cds.col.robots")}</th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.day}>
                  <th scope="row">{d.day}</th>
                  <td className="gt-num">{n0(d.visitors)}</td>
                  <td className="gt-num">{n0(d.watchers)}</td>
                  <td className="gt-num">{n0(d.new_watchers)}</td>
                  <td className="gt-num">{n0(d.wau)}</td>
                  <td className="gt-num">{fmtUsdCents(d.revenue_cents)}</td>
                  <td className="gt-num">{n0(d.robots)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

// ---- episode 1: the share still watching -----------------------------------------------------------------------

export function Ep1Chart({ curve, locale }: { curve: Ep1Curve; locale: Locale }) {
  const H = 230;
  const PAD = { l: 44, r: 20, t: 24, b: 30 };
  const pts = curve.points.filter((p) => p.share !== null);
  const end = Math.max(curve.duration_s ?? 0, pts[pts.length - 1]?.t ?? 0, curve.step_s);
  const x = (s: number) => PAD.l + ((W - PAD.l - PAD.r) * s) / end;
  const y = (share: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - share);
  const base = y(0);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.share!).toFixed(1)}`).join(" ");
  const area = pts.length ? `${line} L${x(pts[pts.length - 1].t).toFixed(1)},${base} L${x(pts[0].t).toFixed(1)},${base} Z` : "";
  const isEnd = (i: number) => curve.duration_s !== null && i === pts.length - 1 && pts[i].t === curve.duration_s;
  // Label the first step (the early drop) and the end.
  const labelled = new Set([Math.min(1, pts.length - 1), pts.length - 1]);
  const ticksX: number[] = [];
  const tickStep = end > 150 ? 60 : 30;
  for (let s = 0; s <= end - tickStep / 3; s += tickStep) ticksX.push(s);
  const cap = t(locale, "cds.ep1.chart");
  const at = (i: number) => (isEnd(i) ? `${fmtClock(pts[i].t)} (${t(locale, "cds.ep1.end")})` : fmtClock(pts[i].t));
  return (
    <figure className="an-chart cds-chart">
      <figcaption id="cds-ep1-cap">{cap}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="cds-ep1-cap" aria-describedby="cds-ep1-desc" className="an-chart-svg">
        <desc id="cds-ep1-desc">{t(locale, "cds.ep1.chartDesc", { n: n0(curve.started) })}</desc>
        {[0, 0.25, 0.5, 0.75, 1].map((k) => (
          <g key={k}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(k)} y2={y(k)} className="an-gridline cds-grid" />
            <text x={PAD.l - 6} y={y(k) + 4} textAnchor="end" className="an-tick">{Math.round(k * 100)}%</text>
          </g>
        ))}
        {ticksX.map((s) => (
          <text key={s} x={x(s)} y={H - PAD.b + 16} textAnchor="middle" className="an-tick">{fmtClock(s)}</text>
        ))}
        {curve.duration_s !== null && <text x={x(end)} y={H - PAD.b + 16} textAnchor="end" className="an-tick">{fmtClock(end)}</text>}
        <path d={area} className="cds-area" />
        <path d={line} className="cds-line" fill="none" />
        {pts.map((p, i) => {
          const left = i === 0 ? PAD.l : (x(pts[i - 1].t) + x(p.t)) / 2;
          const right = i === pts.length - 1 ? W - PAD.r : (x(p.t) + x(pts[i + 1].t)) / 2;
          return (
            <g key={p.t} className="cds-hit">
              <title>{t(locale, "cds.ep1.tip", { at: at(i), people: n0(p.people), share: fmtShare(p.share) })}</title>
              <rect x={left} y={PAD.t} width={Math.max(1, right - left)} height={base - PAD.t} className="cds-hit-area" />
              <circle cx={x(p.t)} cy={y(p.share!)} r={4} className="cds-dot" />
              {labelled.has(i) && (
                <text x={x(p.t) + (i === pts.length - 1 ? -8 : 8)} y={y(p.share!) - 10} textAnchor={i === pts.length - 1 ? "end" : "start"} className="an-tick an-tick-strong">
                  {fmtShare(p.share)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <details className="an-table-alt">
        <summary>{t(locale, "cds.aud.table")}</summary>
        <div className="an-scroll">
          <table className="an-table">
            <caption className="sr-only">{cap}</caption>
            <thead>
              <tr>
                <th scope="col">{t(locale, "cds.col.time")}</th>
                <th scope="col" className="gt-num">{t(locale, "cds.col.stillWatching")}</th>
                <th scope="col" className="gt-num">{t(locale, "cds.col.share")}</th>
              </tr>
            </thead>
            <tbody>
              {pts.map((p, i) => (
                <tr key={p.t}>
                  <th scope="row">{at(i)}</th>
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

// ---- every episode -----------------------------------------------------------------------------------------------

export function EpisodeChart({ bars, freeEpisodes, locale }: { bars: EpisodeBar[]; freeEpisodes: number; locale: Locale }) {
  const H = 230;
  const PAD = { l: 44, r: 12, t: 24, b: 30 };
  const max = niceMax(Math.max(1, ...bars.map((b) => b.started)));
  const band = (W - PAD.l - PAD.r) / Math.max(1, bars.length);
  const bw = Math.max(2, Math.min(24, band - 2));
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  const base = y(0);
  const labelEvery = bars.length > 30 ? 5 : bars.length > 15 ? 2 : 1;
  const wall = freeEpisodes > 0 && freeEpisodes < bars.length ? PAD.l + freeEpisodes * band : null;
  const cap = t(locale, "cds.eps.chart");
  return (
    <figure className="an-chart cds-chart">
      <figcaption id="cds-eps-cap">{cap}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="cds-eps-cap" aria-describedby="cds-eps-desc" className="an-chart-svg">
        <desc id="cds-eps-desc">{t(locale, "cds.eps.chartDesc", { n: bars.length })}</desc>
        {[0, 0.25, 0.5, 0.75, 1].map((k) => (
          <g key={k}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(k * max)} y2={y(k * max)} className="an-gridline cds-grid" />
            <text x={PAD.l - 6} y={y(k * max) + 4} textAnchor="end" className="an-tick">{n0(Math.round(k * max))}</text>
          </g>
        ))}
        {bars.map((b, i) => {
          const x = PAD.l + i * band + (band - bw) / 2;
          return (
            <g key={b.n} className="cds-hit">
              <title>{t(locale, "cds.eps.tip", { n: b.n, started: n0(b.started), watched: n0(b.watched) })}</title>
              <rect x={PAD.l + i * band} y={PAD.t} width={band} height={base - PAD.t} className="cds-hit-area" />
              <path d={column(x, bw, y(b.started), base)} className="cds-mark cds-mark-soft" />
              <path d={column(x, bw, y(b.watched), base)} className="cds-mark" />
              {(i === 0 || i === 1) && b.started > 0 && <text x={x + bw / 2} y={y(b.started) - 6} textAnchor="middle" className="an-tick an-tick-strong">{n0(b.started)}</text>}
              {((b.n - 1) % labelEvery === 0 || b.n === freeEpisodes + 1) && <text x={x + bw / 2} y={H - PAD.b + 16} textAnchor="middle" className="an-tick">{b.n}</text>}
            </g>
          );
        })}
        <line x1={PAD.l} x2={W - PAD.r} y1={base} y2={base} className="cds-baseline" />
        {wall !== null && (
          <g>
            <line x1={wall} x2={wall} y1={PAD.t - 8} y2={base} className="cds-wall" />
            <text x={wall + 6} y={PAD.t - 10} className="an-tick an-tick-strong">{t(locale, "cds.eps.paywall")}</text>
          </g>
        )}
      </svg>
      <ul className="an-legend" aria-label={cap}>
        <li><span className="cds-key cds-key-soft" aria-hidden /> {t(locale, "cds.eps.started")}</li>
        <li><span className="cds-key" aria-hidden /> {t(locale, "cds.eps.watched")}</li>
      </ul>
      <details className="an-table-alt">
        <summary>{t(locale, "cds.aud.table")}</summary>
        <div className="an-scroll">
          <table className="an-table">
            <caption className="sr-only">{cap}</caption>
            <thead>
              <tr>
                <th scope="col">{t(locale, "cds.col.episode")}</th>
                <th scope="col">{t(locale, "cds.col.free")}</th>
                <th scope="col" className="gt-num">{t(locale, "cds.col.started")}</th>
                <th scope="col" className="gt-num">{t(locale, "cds.col.watchedQuarter")}</th>
              </tr>
            </thead>
            <tbody>
              {bars.map((b) => (
                <tr key={b.n}>
                  <th scope="row">{b.n}</th>
                  <td>{t(locale, b.free ? "cds.yes" : "cds.no")}</td>
                  <td className="gt-num">{n0(b.started)}</td>
                  <td className="gt-num">{n0(b.watched)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
