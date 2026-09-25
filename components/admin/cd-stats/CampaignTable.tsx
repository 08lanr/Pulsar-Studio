"use client";

import { Fragment, useMemo, useState } from "react";
import { useT } from "@/components/locale";
import { CAMPAIGN_SORTS, fmtShare, fmtUsdCents, share, sortCampaigns, type AdRow, type AdTitle, type CampaignRow, type CampaignSort } from "@/lib/crazydramas/stats-summary";

// "By ad", grouped by campaign (Ruobin, 2026-09-24: "add the title it was
// connected to, and group it by campaign rather than individually, with a
// drop down sorting option"): one row per campaign with its ads' numbers
// summed, a button that opens its ads under it, the title(s) the people
// opened, and one sort for campaigns and their ads alike. TikTok's stored
// copy and "no ad" stay at the bottom whatever the sort.

const n0 = (v: number) => v.toLocaleString("en-US");
const cents = (v: number | null) => (v == null ? "–" : v < 100 ? `${v}¢` : fmtUsdCents(v));
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" }) : null);

/** The ad whose episode 1 finishers cost least, among ads with at least 3 of them (and more than one such ad). */
export function bestAdKey(rows: CampaignRow[]): string | null {
  const ranked = rows
    .flatMap((c) => c.ads)
    .filter((a) => a.kind === "ad" && a.cost_per_finisher_cents != null && a.finished_ep1 >= 3)
    .sort((a, b) => a.cost_per_finisher_cents! - b.cost_per_finisher_cents!);
  return ranked.length > 1 ? ranked[0].key : null;
}

function Cell({ n, of }: { n: number; of: number }) {
  return (
    <td className="gt-num">
      {n0(n)}
      {n > 0 && of > 0 && <span className="cds-sub">{fmtShare(share(n, of))}</span>}
    </td>
  );
}

function Titles({ titles, tt }: { titles: AdTitle[]; tt: (k: string, v?: Record<string, string | number>) => string }) {
  if (!titles.length) return <td className="cds-title-cell">–</td>;
  return (
    <td className="cds-title-cell" title={titles.map((t) => `${t.title} (${t.people})`).join("\n")}>
      {titles[0].title}
      {titles.length > 1 && <span className="cds-sub">{tt("cds.ads.moreTitles", { n: titles.length - 1 })}</span>}
    </td>
  );
}

function Numbers({ r, tt }: { r: CampaignRow | AdRow; tt: (k: string, v?: Record<string, string | number>) => string }) {
  return (
    <>
      <td className="gt-num">{r.spend_cents != null ? fmtUsdCents(r.spend_cents) : "–"}</td>
      <td className="gt-num">{r.clicks != null ? n0(r.clicks) : "–"}</td>
      <td className="gt-num">
        {n0(r.opened)}
        {r.clicks ? <span className="cds-sub">{tt("cds.ads.ofClicks", { share: fmtShare(share(r.opened, r.clicks)) })}</span> : null}
      </td>
      <Cell n={r.started_ep1} of={r.opened} />
      <Cell n={r.finished_ep1} of={r.opened} />
      <Cell n={r.watched_ep2} of={r.opened} />
      <Cell n={r.buyers} of={r.opened} />
      <td className="gt-num"><strong>{cents(r.cost_per_finisher_cents)}</strong></td>
      <td className="gt-num">{cents(r.cost_per_ep2_cents)}</td>
    </>
  );
}

export default function CampaignTable({ rows, showTitle = true, caption }: { rows: CampaignRow[]; showTitle?: boolean; caption: string }) {
  const { tt } = useT();
  const [sort, setSort] = useState<CampaignSort>("spend");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const sorted = useMemo(() => sortCampaigns(rows, sort), [rows, sort]);
  const best = useMemo(() => bestAdKey(rows), [rows]);
  const campaigns = sorted.filter((c) => c.kind === "campaign");
  const allOpen = campaigns.length > 0 && campaigns.every((c) => open.has(c.key));
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (!rows.length) return <p className="rs-empty">{tt("cds.ads.none")}</p>;
  const cols = showTitle ? 11 : 10;
  return (
    <>
      <div className="cds-ads-tools">
        <label className="cds-sort">
          <span>{tt("cds.ads.sort.label")}</span>
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value as CampaignSort)}>
            {CAMPAIGN_SORTS.map((s) => (
              <option key={s} value={s}>
                {tt(`cds.ads.sort.${s}`)}
              </option>
            ))}
          </select>
        </label>
        {campaigns.length > 0 && (
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setOpen(allOpen ? new Set() : new Set(campaigns.map((c) => c.key)))}>
            {tt(allOpen ? "cds.ads.collapseAll" : "cds.ads.expandAll")}
          </button>
        )}
      </div>
      <div className="an-scroll" tabIndex={0} role="region" aria-label={caption}>
        <table className="an-table cds-table cds-ads">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">{tt("cds.ads.col.campaign")}</th>
              {showTitle && <th scope="col">{tt("cds.ads.col.title")}</th>}
              <th scope="col" className="gt-num">{tt("cds.ads.col.spend")}</th>
              <th scope="col" className="gt-num">{tt("cds.ads.col.clicks")}</th>
              <th scope="col" className="gt-num">{tt("cds.ads.col.people")}</th>
              <th scope="col" className="gt-num">{tt("cds.col.playedEp1")}</th>
              <th scope="col" className="gt-num">{tt("cds.col.finishedEp1")}</th>
              <th scope="col" className="gt-num">{tt("cds.col.watchedEp", { n: 2 })}</th>
              <th scope="col" className="gt-num">{tt("cds.col.buyers")}</th>
              <th scope="col" className="gt-num">{tt("cds.ads.col.perFinisher")}</th>
              <th scope="col" className="gt-num">{tt("cds.ads.col.perEp2")}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => {
              const isOpen = open.has(c.key);
              const launched = day(c.launched_at);
              return (
                <Fragment key={c.key}>
                  <tr className={c.kind === "campaign" ? "cds-camp" : "cds-camp cds-camp-other"}>
                    <th scope="row" className="cds-title">
                      {c.kind === "campaign" ? (
                        <button type="button" className="cds-toggle" aria-expanded={isOpen} onClick={() => toggle(c.key)}>
                          <span className="cds-caret" aria-hidden>{isOpen ? "▾" : "▸"}</span>
                          <span>
                            <strong>{c.launch_name ?? tt("cds.ads.campaignUnknown", { id: c.campaign_id ?? "–" })}</strong>
                            <span className="cds-sub">
                              {[c.campaign_name, tt("cds.ads.adCount", { n: c.ads.length }), launched ? tt("cds.ads.launched", { day: launched }) : c.launch_name ? null : tt("cds.ads.campaignNotStudio")].filter(Boolean).join(" · ")}
                            </span>
                          </span>
                        </button>
                      ) : (
                        <>
                          <strong>{tt(c.kind === "stored_copy" ? "cds.ads.storedCopy" : "cds.ads.noAd")}</strong>
                          <span className="cds-sub">{tt(c.kind === "stored_copy" ? "cds.ads.storedCopySub" : "cds.ads.noAdSub")}</span>
                        </>
                      )}
                    </th>
                    {showTitle && <Titles titles={c.titles} tt={tt} />}
                    <Numbers r={c} tt={tt} />
                  </tr>
                  {c.kind === "campaign" &&
                    isOpen &&
                    c.ads.map((a) => (
                      <tr key={a.key} className={`cds-ad-row${a.key === best ? " cds-best" : ""}`}>
                        <th scope="row" className="cds-title cds-ad-name">
                          <strong>{tt("cds.ads.adId", { id: a.ad ?? "–" })}</strong>
                          {a.key === best && <span className="cds-badge">{tt("cds.ads.best")}</span>}
                        </th>
                        {showTitle && <Titles titles={a.titles} tt={tt} />}
                        <Numbers r={a} tt={tt} />
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
          {best && !campaigns.some((c) => open.has(c.key) && c.ads.some((a) => a.key === best)) && (
            <tfoot>
              <tr>
                <td colSpan={cols} className="cds-best-hint">
                  {tt("cds.ads.bestHint", { id: best.replace(/^ad:/, "") })}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </>
  );
}
