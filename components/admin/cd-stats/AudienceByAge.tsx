import Info from "@/components/admin/cd-stats/Info";
import { ageLabel, type AgeShare, type AudienceRow, type AudienceTable } from "@/lib/crazydramas/stats-audience";
import { fmtUsdCents } from "@/lib/crazydramas/stats-summary";
import { t, type Locale } from "@/lib/i18n";

// The Campaigns tab's "Audience by age" (2026-10-01): all campaigns together on top, then each campaign, one column
// per TikTok age group. A cell is the group's share of the row's spend, with its spend under it; the tooltip has
// its impressions, clicks and checkouts. A bar under the share shows the lean at a glance.

const n0 = (v: number) => v.toLocaleString("en-US");
const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);

function Cell({ s, known, tt }: { s: AgeShare; known: boolean; tt: (k: string, v?: Record<string, string | number>) => string }) {
  if (!known) return <td className="gt-num">–</td>;
  return (
    <td className="gt-num cdaud-cell" title={tt("cdaud.cellTip", { impressions: n0(s.impressions), clicks: n0(s.clicks), checkouts: n0(s.checkouts) })}>
      {pct(s.share)}
      <span className="cds-sub">{s.spend_cents ? fmtUsdCents(s.spend_cents) : "–"}</span>
      {s.share !== null && s.share > 0 && <span className="cdaud-bar" style={{ width: `${Math.max(2, Math.round(s.share * 100))}%` }} aria-hidden />}
    </td>
  );
}

export default function AudienceByAge({ table, locale }: { table: AudienceTable; locale: Locale }) {
  const tt = (k: string, v?: Record<string, string | number>) => t(locale, k, v);
  const row = (r: AudienceRow, total = false) => (
    <tr key={r.key} className={total ? "cdaud-total" : undefined} data-testid={total ? "audience-total" : "audience-row"}>
      <th scope="row" className="cds-title">{r.name}</th>
      {table.groups.map((g) => (
        <Cell key={g} s={r.ages[g]} known={r.known} tt={tt} />
      ))}
      <td className="gt-num">{r.known ? fmtUsdCents(r.spend_cents) : "–"}</td>
    </tr>
  );
  if (!table.rows.length) return <p className="cdx-empty">{tt("cdaud.none")}</p>;
  return (
    <div className="an-scroll" tabIndex={0} role="region" aria-label={tt("cdaud.title")}>
      <table className="an-table cds-table cdx-table cdaud-table" data-testid="audience-table">
        <caption className="sr-only">{tt("cdaud.title")}</caption>
        <thead>
          <tr>
            <th scope="col">{tt("cdaud.campaign")}</th>
            {table.groups.map((g) => (
              <th key={g} scope="col" className="gt-num">{ageLabel(g, tt("cdaud.unknownAge"))}</th>
            ))}
            <th scope="col" className="gt-num">
              {tt("cdaud.spend")} <Info text={tt("cdaud.spendInfo")} label={tt("cdx.about", { what: tt("cdaud.spend") })} />
            </th>
          </tr>
        </thead>
        <tbody>
          {row(table.total, true)}
          {table.rows.map((r) => row(r))}
        </tbody>
      </table>
    </div>
  );
}
