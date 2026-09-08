import type { EpisodesView } from "@/lib/analytics/types";
import { t, type Locale } from "@/lib/i18n";

// Continuation between consecutive episodes as a bar per step (N → N+1),
// with the eligible base under each bar, plus a table alternative. A step
// without an elapsed window is drawn as an empty, labelled slot, never as
// zero. The paywall step is marked with text, not only color.

const W = 720;
const H = 220;
const PAD = { l: 44, r: 12, t: 20, b: 44 };

export default function RetentionChart({ ep, locale }: { ep: EpisodesView; locale: Locale }) {
  const steps = ep.rows.slice(0, -1);
  if (!steps.length) return <div className="rs-empty">{t(locale, "an.ep.noSteps")}</div>;
  const bw = (W - PAD.l - PAD.r) / steps.length;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v);
  const cap = t(locale, "an.ep.chartTitle", { days: ep.continuation_window_days });
  return (
    <figure className="an-chart">
      <figcaption id="an-ret-cap">{cap}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="an-ret-cap" className="an-chart-svg">
        {[0, 0.25, 0.5, 0.75, 1].map((k) => (
          <g key={k}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(k)} y2={y(k)} className="an-gridline" />
            <text x={PAD.l - 6} y={y(k) + 4} textAnchor="end" className="an-tick">{Math.round(k * 100)}%</text>
          </g>
        ))}
        {steps.map((r, i) => {
          const v = r.continuation.value;
          const x0 = PAD.l + i * bw + bw * 0.18;
          const w = bw * 0.64;
          const paywall = ep.paywall_episode != null && r.number + 1 === ep.paywall_episode;
          return (
            <g key={r.number}>
              {v == null ? (
                <rect x={x0} y={y(0.06)} width={w} height={H - PAD.b - y(0.06)} className="an-bar an-bar-empty" />
              ) : (
                <rect x={x0} y={y(v)} width={w} height={H - PAD.b - y(v)} className={`an-bar${r.flags.includes("continuation_loss") ? " an-bar-loss" : ""}`} />
              )}
              <text x={x0 + w / 2} y={(v == null ? y(0.06) : y(v)) - 5} textAnchor="middle" className="an-tick an-tick-strong">{v == null ? "–" : `${Math.round(v * 100)}%`}</text>
              <text x={x0 + w / 2} y={H - PAD.b + 14} textAnchor="middle" className="an-tick">{r.number}→{r.number + 1}{paywall ? ` ${t(locale, "an.ep.paywallMark")}` : ""}</text>
              <text x={x0 + w / 2} y={H - PAD.b + 28} textAnchor="middle" className="an-tick an-tick-faint">{r.continuation.denominator == null ? t(locale, "an.na") : `n=${r.continuation.denominator.toLocaleString("en-US")}`}</text>
            </g>
          );
        })}
      </svg>
      <details className="an-table-alt">
        <summary>{t(locale, "an.chart.table")}</summary>
        <div className="an-scroll">
          <table className="an-table">
            <caption className="sr-only">{cap}</caption>
            <thead><tr><th scope="col">{t(locale, "an.ep.step")}</th><th scope="col" className="gt-num">{t(locale, "an.ep.continued")}</th><th scope="col" className="gt-num">{t(locale, "an.ep.eligible")}</th><th scope="col" className="gt-num">{t(locale, "an.ep.rate")}</th></tr></thead>
            <tbody>
              {steps.map((r) => (
                <tr key={r.number}><th scope="row">{r.number} → {r.number + 1}</th><td className="gt-num">{r.continuation.numerator?.toLocaleString("en-US") ?? "–"}</td><td className="gt-num">{r.continuation.denominator?.toLocaleString("en-US") ?? "–"}</td><td className="gt-num">{r.continuation.value == null ? t(locale, r.continuation.reason ?? "an.unavailable") : `${(r.continuation.value * 100).toFixed(1)}%`}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
