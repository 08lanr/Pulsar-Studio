import { fmtUsdCents } from "@/lib/crazydramas/stats-summary";

// The Overview's one chart (decision 2026-09-26): ad spend and revenue per day, side by side. Server component
// in the house chart look (two data colours, thin marks, hairline grid; every day's numbers in its tooltip and
// in the table under the chart). A day whose spend TikTok did not report draws no spend column.

const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function niceMax(v: number): number {
  if (v <= 0) return 100;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

export type MoneyDay = { day: string; spend_cents: number | null; revenue_cents: number };

function Pairs({ W, H, days, labelledBy, dates, className, labels }: { W: number; H: number; days: MoneyDay[]; labelledBy: string; dates: number; className: string; labels: { spend: string; revenue: string } }) {
  const PAD = { l: 48, r: 10, t: 14, b: 28 };
  const max = niceMax(Math.max(1, ...days.map((d) => Math.max(d.spend_cents ?? 0, d.revenue_cents))));
  const band = (W - PAD.l - PAD.r) / Math.max(1, days.length);
  const bw = Math.max(1.5, Math.min(14, band / 2 - 2));
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  const base = y(0);
  const last = days.length - 1;
  const every = Math.max(1, Math.ceil(days.length / dates));
  const dateShown = (i: number) => i === last || (i % every === 0 && last - i >= Math.ceil(every / 2));
  const bar = (x: number, v: number, cls: string) => {
    const top = y(v);
    return v > 0 ? <rect x={x} y={top} width={bw} height={Math.max(1, base - top)} rx={Math.min(3, bw / 2)} className={cls} /> : null;
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={labelledBy} className={`an-chart-svg ${className}`}>
      {[0, 0.5, 1].map((k) => (
        <g key={k}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(k * max)} y2={y(k * max)} className="an-gridline cds-grid" />
          <text x={PAD.l - 6} y={y(k * max) + 4} textAnchor="end" className="an-tick">
            {fmtUsdCents(Math.round(k * max)).replace(/\.00$/, "")}
          </text>
        </g>
      ))}
      {days.map((d, i) => {
        const x0 = PAD.l + i * band + band / 2 - bw - 1;
        return (
          <g key={d.day} className="cds-hit">
            <title>{`${shortDay(d.day)}: ${labels.spend} ${d.spend_cents === null ? "–" : fmtUsdCents(d.spend_cents)} · ${labels.revenue} ${fmtUsdCents(d.revenue_cents)}`}</title>
            <rect x={PAD.l + i * band} y={PAD.t} width={band} height={base - PAD.t} className="cds-hit-area" />
            {d.spend_cents !== null && bar(x0, d.spend_cents, "cdm-spend")}
            {bar(x0 + bw + 2, d.revenue_cents, "cdm-revenue")}
            {dateShown(i) && (
              <text x={PAD.l + i * band + band / 2} y={H - PAD.b + 16} textAnchor="middle" className="an-tick">
                {shortDay(d.day)}
              </text>
            )}
          </g>
        );
      })}
      <line x1={PAD.l} x2={W - PAD.r} y1={base} y2={base} className="cds-baseline" />
    </svg>
  );
}

export function SpendRevenueChart({ title, days, labels, tableLabel }: { title: string; days: MoneyDay[]; labels: { spend: string; revenue: string }; tableLabel: string }) {
  const id = "cdm-money-chart";
  return (
    <figure className="an-chart cds-chart cdx-trend">
      <figcaption id={id}>{title}</figcaption>
      <ul className="cdm-legend" aria-hidden>
        <li><span className="cdp-dot cdm-spend-dot" />{labels.spend}</li>
        <li><span className="cdp-dot cdm-revenue-dot" />{labels.revenue}</li>
      </ul>
      <Pairs W={1000} H={230} days={days} labelledBy={id} dates={7} className="cdx-trend-wide" labels={labels} />
      <Pairs W={400} H={220} days={days} labelledBy={id} dates={3} className="cdx-trend-narrow" labels={labels} />
      <details className="an-table-alt">
        <summary>{tableLabel}</summary>
        <div className="an-scroll">
          <table className="an-table">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col" />
                <th scope="col" className="gt-num">{labels.spend}</th>
                <th scope="col" className="gt-num">{labels.revenue}</th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.day}>
                  <th scope="row">{d.day}</th>
                  <td className="gt-num">{d.spend_cents === null ? "–" : fmtUsdCents(d.spend_cents)}</td>
                  <td className="gt-num">{fmtUsdCents(d.revenue_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

// ---- stacked days (2026-09-28): money by product, coins in and out, VIP per week --------------------------------

/** One stack of the chart: its label, its colour (1–5 the data colours, "neg" the muted grey), and whether it goes below zero. */
export type StackSeries = { key: string; label: string; colour: 1 | 2 | 3 | 4 | 5 | "neg"; below?: boolean };
export type StackDay = { day: string; values: Record<string, number> };

function Stacks({ W, H, days, series, labelledBy, dates, className, fmt }: { W: number; H: number; days: StackDay[]; series: StackSeries[]; labelledBy: string; dates: number; className: string; fmt: (v: number) => string }) {
  const PAD = { l: 52, r: 10, t: 14, b: 28 };
  const up = (d: StackDay) => series.filter((x) => !x.below).reduce((a, x) => a + (d.values[x.key] ?? 0), 0);
  const down = (d: StackDay) => series.filter((x) => x.below).reduce((a, x) => a + (d.values[x.key] ?? 0), 0);
  const maxUp = niceMax(Math.max(1, ...days.map(up)));
  const maxDown = series.some((x) => x.below) ? Math.max(0, ...days.map(down)) : 0;
  const lo = maxDown > 0 ? niceMax(maxDown) : 0;
  const inner = H - PAD.t - PAD.b;
  // Below zero gets at least 15% of the height, so a small refund stays visible and its label clears "$0".
  const loShare = lo ? Math.max(0.15, lo / (maxUp + lo)) : 0;
  const y = (v: number) => (v >= 0 ? PAD.t + inner * (1 - loShare) * ((maxUp - v) / maxUp) : PAD.t + inner * (1 - loShare) + inner * loShare * (-v / lo));
  const zero = y(0);
  const band = (W - PAD.l - PAD.r) / Math.max(1, days.length);
  const bw = Math.max(2, Math.min(22, band - 4));
  const last = days.length - 1;
  const every = Math.max(1, Math.ceil(days.length / dates));
  const dateShown = (i: number) => i === last || (i % every === 0 && last - i >= Math.ceil(every / 2));
  const ticks = [maxUp, maxUp / 2, 0, ...(lo ? [-lo] : [])];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={labelledBy} className={`an-chart-svg ${className}`}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="an-gridline cds-grid" />
          <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" className="an-tick">
            {v < 0 ? `−${fmt(Math.round(-v))}` : fmt(Math.round(v))}
          </text>
        </g>
      ))}
      {days.map((d, i) => {
        const x = PAD.l + i * band + (band - bw) / 2;
        let top = 0;
        let bottom = 0;
        return (
          <g key={d.day} className="cds-hit">
            <title>{`${shortDay(d.day)}: ${series.map((sr) => `${sr.label} ${fmt(d.values[sr.key] ?? 0)}`).join(" · ")}`}</title>
            <rect x={PAD.l + i * band} y={PAD.t} width={band} height={inner} className="cds-hit-area" />
            {series.map((sr) => {
              const v = d.values[sr.key] ?? 0;
              if (v <= 0) return null;
              const cls = sr.colour === "neg" ? "cdm-kneg" : `cdm-k${sr.colour}`;
              if (sr.below) {
                const y0 = y(-bottom);
                bottom += v;
                return <rect key={sr.key} x={x} y={y0} width={bw} height={Math.max(1, y(-bottom) - y0)} className={cls} />;
              }
              const y1 = y(top + v);
              const h = Math.max(1, y(top) - y1);
              top += v;
              return <rect key={sr.key} x={x} y={y1} width={bw} height={h} className={cls} />;
            })}
            {dateShown(i) && (
              <text x={PAD.l + i * band + band / 2} y={H - PAD.b + 16} textAnchor="middle" className="an-tick">
                {shortDay(d.day)}
              </text>
            )}
          </g>
        );
      })}
      <line x1={PAD.l} x2={W - PAD.r} y1={zero} y2={zero} className="cds-baseline" />
    </svg>
  );
}

/**
 * A stacked bar per day (or per week): what goes in stacked above zero, what goes out below it. The legend names
 * every stack; each bar's tooltip and the table under the chart give the numbers.
 */
export function StackedDaysChart({ id, title, days, series, fmt, tableLabel, firstCol }: { id: string; title: string; days: StackDay[]; series: StackSeries[]; fmt: (v: number) => string; tableLabel: string; firstCol?: string }) {
  return (
    <figure className="an-chart cds-chart cdx-trend">
      <figcaption id={id}>{title}</figcaption>
      <ul className="cdm-legend" aria-hidden>
        {series.map((sr) => (
          <li key={sr.key}>
            <span className={`cdp-dot ${sr.colour === "neg" ? "cdm-dneg" : `cdm-d${sr.colour}`}`} />
            {sr.label}
          </li>
        ))}
      </ul>
      <Stacks W={1000} H={240} days={days} series={series} labelledBy={id} dates={7} className="cdx-trend-wide" fmt={fmt} />
      <Stacks W={400} H={220} days={days} series={series} labelledBy={id} dates={3} className="cdx-trend-narrow" fmt={fmt} />
      <details className="an-table-alt">
        <summary>{tableLabel}</summary>
        <div className="an-scroll">
          <table className="an-table">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">{firstCol ?? ""}</th>
                {series.map((sr) => (
                  <th key={sr.key} scope="col" className="gt-num">
                    {sr.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.day}>
                  <th scope="row">{d.day}</th>
                  {series.map((sr) => (
                    <td key={sr.key} className="gt-num">
                      {fmt(d.values[sr.key] ?? 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
