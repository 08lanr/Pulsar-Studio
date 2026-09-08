import { fmtCount } from "@/components/producer/research/ui";
import type { SeriesPoint } from "@/lib/analytics/types";
import { t, type Locale } from "@/lib/i18n";
import { fmtUsd } from "./bits";

// One time-series chart, inline SVG, no animation: daily viewers as a line
// on the left axis and daily IAP gross as a second line on the right axis.
// Readable axes with real tick labels, a text legend, and the same numbers
// as a table behind <details> for screen readers and copy-paste.

const W = 720;
const H = 240;
const PAD = { l: 52, r: 60, t: 16, b: 34 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  const n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return n * p;
}

export default function SeriesChart({ series, locale }: { series: SeriesPoint[]; locale: Locale }) {
  const pts = series.filter((s) => s.viewers != null);
  if (!pts.length) return <div className="rs-empty">{t(locale, "an.chart.empty")}</div>;
  const maxV = niceMax(Math.max(...pts.map((s) => s.viewers ?? 0)));
  const maxU = niceMax(Math.max(...pts.map((s) => s.iap_gross_usd ?? 0)));
  const x = (i: number) => PAD.l + (i * (W - PAD.l - PAD.r)) / Math.max(1, pts.length - 1);
  const yV = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / maxV);
  const yU = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / maxU);
  const lineV = pts.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yV(s.viewers ?? 0).toFixed(1)}`).join(" ");
  const lineU = pts.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yU(s.iap_gross_usd ?? 0).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const labelEvery = Math.max(1, Math.ceil(pts.length / 6));
  const title = t(locale, "an.chart.title");
  return (
    <figure className="an-chart">
      <figcaption id="an-chart-cap">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="an-chart-cap" aria-describedby="an-chart-desc" className="an-chart-svg">
        <desc id="an-chart-desc">{t(locale, "an.chart.desc", { n: pts.length, from: pts[0].date, to: pts[pts.length - 1].date })}</desc>
        {ticks.map((k) => (
          <g key={k}>
            <line x1={PAD.l} x2={W - PAD.r} y1={yV(k * maxV)} y2={yV(k * maxV)} className="an-gridline" />
            <text x={PAD.l - 6} y={yV(k * maxV) + 4} textAnchor="end" className="an-tick">{fmtCount(Math.round(k * maxV))}</text>
            <text x={W - PAD.r + 6} y={yU(k * maxU) + 4} textAnchor="start" className="an-tick">{fmtUsd(k * maxU, 0)}</text>
          </g>
        ))}
        {pts.map((s, i) => (i % labelEvery === 0 || i === pts.length - 1) && <text key={s.date} x={x(i)} y={H - PAD.b + 16} textAnchor="middle" className="an-tick">{s.date.slice(5)}</text>)}
        <path d={lineV} className="an-line an-line-viewers" fill="none" />
        <path d={lineU} className="an-line an-line-usd" fill="none" strokeDasharray="5 4" />
        <text x={PAD.l} y={H - 4} className="an-axis">{t(locale, "an.chart.leftAxis")}</text>
        <text x={W - PAD.r} y={H - 4} textAnchor="end" className="an-axis">{t(locale, "an.chart.rightAxis")}</text>
      </svg>
      <ul className="an-legend" aria-label={t(locale, "an.chart.legend")}>
        <li><span className="an-swatch an-swatch-viewers" aria-hidden /> {t(locale, "an.chart.viewers")} ({t(locale, "an.chart.solid")})</li>
        <li><span className="an-swatch an-swatch-usd" aria-hidden /> {t(locale, "an.chart.iap")} ({t(locale, "an.chart.dashed")})</li>
      </ul>
      <details className="an-table-alt">
        <summary>{t(locale, "an.chart.table")}</summary>
        <div className="an-scroll">
          <table className="an-table">
            <caption className="sr-only">{title}</caption>
            <thead><tr><th scope="col">{t(locale, "an.col.date")}</th><th scope="col" className="gt-num">{t(locale, "an.chart.viewers")}</th><th scope="col" className="gt-num">{t(locale, "an.col.starts")}</th><th scope="col" className="gt-num">{t(locale, "an.chart.iap")}</th><th scope="col" className="gt-num">{t(locale, "an.col.adRevenue")}</th><th scope="col" className="gt-num">{t(locale, "an.col.newPayers")}</th></tr></thead>
            <tbody>
              {pts.map((s) => (
                <tr key={s.date}><th scope="row">{s.date}</th><td className="gt-num">{s.viewers?.toLocaleString("en-US")}</td><td className="gt-num">{s.starts?.toLocaleString("en-US")}</td><td className="gt-num">{fmtUsd(s.iap_gross_usd)}</td><td className="gt-num">{s.ad_revenue_usd == null ? t(locale, "an.unavailable") : fmtUsd(s.ad_revenue_usd)}</td><td className="gt-num">{s.new_payers?.toLocaleString("en-US")}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
