"use client";

import { Fragment, useState } from "react";
import { CreativeLabel, Reasons } from "@/components/admin/cd-stats/Creative";
import Info from "@/components/admin/cd-stats/Info";
import { useT } from "@/components/locale";
import type { CompareAd, CompareCampaign } from "@/lib/crazydramas/stats-ads";
import { fmtUsdCents } from "@/lib/crazydramas/stats-summary";

// The Campaigns tab (decision 2026-09-26): one row per launched campaign, its ads under it. Spend and clicks
// are TikTok's; "TikTok says" is TikTok's own purchases (complete_payment); "We saw" is crazydramas' buyers whose
// landing carried the campaign or ad; a short chip says why the two differ. Every ad names the clip it played
// (Ruobin: "I need to see which clip it is so I can recreate more"): its ad type, its words and a still of the
// video, the TikTok id in grey, and a link to the ad's own panel. Day-0 / day-7 return (2026-09-28): what the
// campaign's viewers paid by the end of their first day, and within 7 days (coins where spent), over its spend.

const n0 = (v: number) => v.toLocaleString("en-US");
/** Money back over spend, "0.42×", as the server-side stats-ads module writes it (not imported: it is server-side). */
const ratio = (cents: number, spend: number | null) => {
  const v = spend && spend > 0 ? cents / spend : null;
  return v === null ? "–" : `${v < 10 ? v.toFixed(2) : Math.round(v)}×`;
};
type Tt = (k: string, v?: Record<string, string | number>) => string;

export type CampaignsViewAd = CompareAd & { href: string; media_url: string | null };
export type CampaignsViewRow = Omit<CompareCampaign, "ads"> & { ads: CampaignsViewAd[] };

function Seen({ r, tt }: { r: { ours: CompareAd["ours"] }; tt: Tt }) {
  if (!r.ours.people && !r.ours.purchases) return <td className="gt-num">0</td>;
  return (
    <td className="gt-num">
      <strong>{tt(r.ours.people === 1 ? "cdc.people1" : "cdc.people", { n: n0(r.ours.people) })}</strong>
      <span className="cds-sub">{[r.ours.purchases !== r.ours.people ? tt("cdc.purchases", { n: n0(r.ours.purchases) }) : null, fmtUsdCents(r.ours.revenue_cents)].filter(Boolean).join(" · ")}</span>
    </td>
  );
}

function Numbers({ r, tt }: { r: CampaignsViewRow | CampaignsViewAd; tt: Tt }) {
  return (
    <>
      <td className="gt-num">{r.spend_cents != null ? fmtUsdCents(r.spend_cents) : "–"}</td>
      <td className="gt-num">{r.clicks != null ? n0(r.clicks) : "–"}</td>
      <td className="gt-num">{n0(r.opened)}</td>
      <td className="gt-num">{n0(r.finished_ep1)}</td>
      <td className="gt-num" title={fmtUsdCents(r.revenue_d0_cents)}>{ratio(r.revenue_d0_cents, r.spend_cents)}</td>
      <td className="gt-num" title={fmtUsdCents(r.revenue_d7_cents)}>{ratio(r.revenue_d7_cents, r.spend_cents)}</td>
      <td className="gt-num">{r.tiktok != null ? n0(r.tiktok) : "–"}</td>
      <Seen r={r} tt={tt} />
      <td className="cdc-why-cell">
        <Reasons reasons={r.reasons} tt={tt} />
      </td>
    </>
  );
}

export default function CampaignsView({ rows, caption, launchedLabel }: { rows: CampaignsViewRow[]; caption: string; launchedLabel: Record<string, string> }) {
  const { tt } = useT();
  const campaigns = rows.filter((r) => r.kind === "campaign");
  const [open, setOpen] = useState<Set<string>>(() => new Set(campaigns.map((c) => c.key)));
  if (!rows.length) return <p className="rs-empty">{tt("cds.ads.none")}</p>;
  const allOpen = campaigns.length > 0 && campaigns.every((c) => open.has(c.key));
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <>
      {campaigns.length > 0 && (
        <div className="cds-ads-tools">
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setOpen(allOpen ? new Set() : new Set(campaigns.map((c) => c.key)))}>
            {tt(allOpen ? "cds.ads.collapseAll" : "cds.ads.expandAll")}
          </button>
        </div>
      )}
      <div className="an-scroll" tabIndex={0} role="region" aria-label={caption}>
        <table className="an-table cds-table cdc-table">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">{tt("cds.ads.col.campaign")}</th>
              <th scope="col" className="gt-num">{tt("cds.ads.col.spend")}</th>
              <th scope="col" className="gt-num">{tt("cds.ads.col.clicks")}</th>
              <th scope="col" className="gt-num">{tt("cdx.kpi.visitors")}</th>
              <th scope="col" className="gt-num">{tt("cdx.kpi.finished")}</th>
              <th scope="col" className="gt-num">
                {tt("cdc.col.d0")} <Info text={tt("cdc.col.d0Info")} label={tt("cdx.about", { what: tt("cdc.col.d0") })} />
              </th>
              <th scope="col" className="gt-num">
                {tt("cdc.col.d7")} <Info text={tt("cdc.col.d7Info")} label={tt("cdx.about", { what: tt("cdc.col.d7") })} />
              </th>
              <th scope="col" className="gt-num">
                {tt("cdc.col.tiktok")} <Info text={tt("cdc.col.tiktokInfo")} label={tt("cdx.about", { what: tt("cdc.col.tiktok") })} />
              </th>
              <th scope="col" className="gt-num">
                {tt("cdc.col.ours")} <Info text={tt("cdc.col.oursInfo")} label={tt("cdx.about", { what: tt("cdc.col.ours") })} />
              </th>
              <th scope="col">{tt("cdc.col.why")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const isOpen = open.has(c.key);
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
                              {[c.campaign_name, c.goal ? tt(`cdc.goalShort.${c.goal}`) : null, tt("cds.ads.adCount", { n: c.ads.length }), launchedLabel[c.key] ?? null].filter(Boolean).join(" · ")}
                            </span>
                          </span>
                        </button>
                      ) : (
                        <>
                          <strong>{tt(c.kind === "stored_copy" ? "cds.ads.storedCopy" : "cds.ads.noAd")}</strong>
                          <span className="cds-sub">{tt(c.kind === "stored_copy" ? "cds.ads.storedCopySub" : "cdc.noAdSub")}</span>
                        </>
                      )}
                    </th>
                    <Numbers r={c} tt={tt} />
                  </tr>
                  {c.kind === "campaign" &&
                    isOpen &&
                    c.ads.map((a) => (
                      <tr key={a.ad_id} className="cds-ad-row">
                        <th scope="row" className="cds-title cds-ad-name">
                          <CreativeLabel ad={a} media={a.media_url} href={a.href} tt={tt} />
                        </th>
                        <Numbers r={a} tt={tt} />
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
