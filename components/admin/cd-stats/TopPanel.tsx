"use client";

import { useState } from "react";
import { fmtShare } from "@/lib/crazydramas/stats-summary";

// "Top" on the dashboard's overview: one panel, a tab per breakdown (series, phones, sources, countries), the
// few biggest rows with a bar behind the visitor count, and a click on a row narrows the whole page to it
// (Plausible's panels). Only the tab switch runs in the browser; the rows come from the page.

export type TopRow = { key: string; name: string; href: string | null; visitors: number; started: number | null; finished: number | null };
export type TopTab = { key: string; label: string; rows: TopRow[]; allHref: string | null };

const SHOWN = 6;
const n0 = (v: number) => v.toLocaleString("en-US");

export default function TopPanel({ tabs, labels }: { tabs: TopTab[]; labels: { visitors: string; started: string; finished: string; all: string } }) {
  const [on, setOn] = useState(tabs[0]?.key ?? "");
  const tab = tabs.find((x) => x.key === on) ?? tabs[0];
  if (!tab) return null;
  const max = Math.max(1, ...tab.rows.map((r) => r.visitors));
  return (
    <div className="cdx-top">
      <div className="tabs cdx-top-tabs" role="tablist">
        {tabs.map((x) => (
          <button key={x.key} type="button" role="tab" aria-selected={x.key === tab.key} className={`tab${x.key === tab.key ? " on" : ""}`} onClick={() => setOn(x.key)}>
            {x.label}
          </button>
        ))}
      </div>
      <table className="cdx-top-table" role="tabpanel">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col" className="gt-num">{labels.visitors}</th>
            <th scope="col" className="gt-num">{labels.started}</th>
            <th scope="col" className="gt-num">{labels.finished}</th>
          </tr>
        </thead>
        <tbody>
          {tab.rows.slice(0, SHOWN).map((r) => (
            <tr key={r.key}>
              <th scope="row">
                <span className="cdx-top-bar" style={{ width: `${(r.visitors / max) * 100}%` }} aria-hidden />
                {r.href ? <a href={r.href}>{r.name}</a> : <span>{r.name}</span>}
              </th>
              <td className="gt-num">{n0(r.visitors)}</td>
              <td className="gt-num">{fmtShare(r.started)}</td>
              <td className="gt-num">{fmtShare(r.finished)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {tab.allHref && tab.rows.length > SHOWN && (
        <a className="cdx-top-all" href={tab.allHref}>
          {labels.all} ({tab.rows.length}) →
        </a>
      )}
    </div>
  );
}
