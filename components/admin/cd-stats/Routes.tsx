import Info from "@/components/admin/cd-stats/Info";
import type { RouteColumn } from "@/lib/crazydramas/stats-routes";
import { fmtShare, fmtUsdCents } from "@/lib/crazydramas/stats-summary";
import { t, type Locale } from "@/lib/i18n";

// The Routes tab's chart and table (decision 2026-10-12, "Acquisition routes A/B/C"): the three ways into the Android app
// side by side. One chart, a funnel per route (each bar a share of that route's clicks), and one table with every number,
// each name carrying its ⓘ. Server components on the house classes; every bar carries its number in text.

const n0 = (v: number) => v.toLocaleString("en-US");

/** A funnel step: its key (the label and ⓘ are `cdr.m.<key>`), and whether route A has it (no landing page, no /go). */
const STEPS: { key: "clicks" | "landed" | "store_taps" | "installs" | "opened_episode" | "trials" | "paid"; store: boolean }[] = [
  { key: "clicks", store: true },
  { key: "landed", store: false },
  { key: "store_taps", store: false },
  { key: "installs", store: true },
  { key: "opened_episode", store: true },
  { key: "trials", store: true },
  { key: "paid", store: true },
];

/** One funnel per route: clicks → landed → store taps → installs → opened on the episode → trials → paid. */
export function RouteFunnels({ columns, known, locale }: { columns: RouteColumn[]; known: boolean; locale: Locale }) {
  return (
    <div className="cdr-funnels">
      {columns.map((c) => {
        const steps = STEPS.filter((s) => c.route !== "store" || s.store).map((s) => ({ key: s.key, value: s.key === "clicks" ? c.clicks : known ? c[s.key] : null }));
        const top = Math.max(1, steps[0].value ?? 0, ...steps.map((s) => s.value ?? 0));
        return (
          <figure key={c.route} className="cdr-funnel" aria-labelledby={`cdr-funnel-${c.route}`}>
            <figcaption id={`cdr-funnel-${c.route}`}>{t(locale, `cdr.route.${c.route}`)}</figcaption>
            <ul className="cdx-funnel">
              {steps.map((s, i) => (
                <li key={s.key}>
                  <span className="cdx-funnel-label">{t(locale, `cdr.m.${s.key}`)}</span>
                  <span className="cds-path-track" aria-hidden>
                    <span className={`cds-path-fill${!s.value ? " is-zero" : ""}`} style={{ width: `${((s.value ?? 0) / top) * 100}%`, display: "block" }} />
                  </span>
                  <span className="cds-path-count">{s.value === null ? "–" : n0(s.value)}</span>
                  <span className="cds-path-share">{i === 0 || s.value === null || !steps[0].value ? "" : fmtShare(s.value / steps[0].value)}</span>
                </li>
              ))}
            </ul>
          </figure>
        );
      })}
    </div>
  );
}

type Row = { key: string; value: (c: RouteColumn) => string; crazydramas?: boolean };

/** Every number, the routes as columns (A, B, C), each row's name with its ⓘ. */
export function RouteTable({ columns, known, locale }: { columns: RouteColumn[]; known: boolean; locale: Locale }) {
  const money = (v: number | null) => (v === null ? "–" : fmtUsdCents(v));
  const count = (v: number | null) => (v === null ? "–" : n0(v));
  const rows: Row[] = [
    { key: "spend", value: (c) => money(c.spend_cents) },
    { key: "impressions", value: (c) => count(c.impressions) },
    { key: "clicks", value: (c) => count(c.clicks) },
    { key: "landed", value: (c) => (c.route === "store" ? "–" : n0(c.landed)), crazydramas: true },
    { key: "store_taps", value: (c) => (c.route === "store" ? "–" : n0(c.store_taps)), crazydramas: true },
    { key: "installs", value: (c) => n0(c.installs), crazydramas: true },
    { key: "opened_episode", value: (c) => n0(c.opened_episode), crazydramas: true },
    { key: "trials", value: (c) => n0(c.trials), crazydramas: true },
    { key: "paid", value: (c) => n0(c.paid), crazydramas: true },
    { key: "repeat_viewers", value: (c) => n0(c.repeat_viewers), crazydramas: true },
    { key: "revenue", value: (c) => fmtUsdCents(c.revenue_cents), crazydramas: true },
    { key: "per_install", value: (c) => money(c.cost_per_install_cents), crazydramas: true },
    { key: "per_trial", value: (c) => money(c.cost_per_trial_cents), crazydramas: true },
    { key: "per_paid", value: (c) => money(c.cost_per_paid_cents), crazydramas: true },
  ];
  const caption = t(locale, "cdr.table");
  return (
    <div className="an-scroll" tabIndex={0} role="region" aria-label={caption}>
      <table className="an-table cds-table cdx-table cdr-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" />
            {columns.map((c) => (
              <th key={c.route} scope="col" className="gt-num">{t(locale, `cdr.route.${c.route}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" className="cds-title">
                {t(locale, `cdr.m.${r.key}`)} <Info text={t(locale, `cdr.m.${r.key}.info`)} label={t(locale, "cdx.about", { what: t(locale, `cdr.m.${r.key}`) })} />
              </th>
              {columns.map((c) => (
                <td key={c.route} className="gt-num">{r.crazydramas && !known ? "–" : r.value(c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
