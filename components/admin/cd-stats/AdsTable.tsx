"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FormatPill, Thumb } from "@/components/admin/cd-stats/Creative";
import Info from "@/components/admin/cd-stats/Info";
import { useT } from "@/components/locale";
import type { AdFormat } from "@/lib/ad-formats";
import { fmtPct, type RateKey, type VideoRates } from "@/lib/crazydramas/stats-creatives";
import { fmtUsdCents } from "@/lib/crazydramas/stats-summary";

// The Ads tab's one table (decision 2026-09-28, "Ad video stats"): one row per ad creative, TikTok's numbers
// summed across every ad it ran as. Sortable (most impressions first), a benchmark row (the median of ads with
// 500+ impressions) on top, cells clearly above or below it tinted, ads under 500 impressions marked early.
// Checkouts sit with spend and CTR (2026-10-01, Ruobin: "checkouts disappears here", off the right edge); the
// headers wrap and the ad stays pinned while the table scrolls sideways.

const n0 = (v: number | null) => (v === null ? "–" : v.toLocaleString("en-US"));
const secs = (v: number | null) => (v === null ? "–" : `${v.toFixed(1)} s`);
const per1k = (v: number | null) => (v === null ? "–" : v.toFixed(2));

export type AdsViewRow = {
  key: string;
  title: string;
  ad_format: AdFormat | null;
  /** The ad's words, or what it is when it has none ("TikTok post (Spark code)"). */
  words: string;
  sub: string;
  media_url: string | null;
  early: boolean;
  spend_cents: number | null;
  impressions: number | null;
  checkouts: number | null;
  rates: VideoRates;
  marks: Partial<Record<RateKey, "above" | "below">>;
};

type Col = { key: string; label: string; info: string; value: (r: AdsViewRow) => number | null; show: (r: AdsViewRow) => string; rate?: RateKey };
type Sort = { key: string; desc: boolean };

export default function AdsTable({ rows, bench }: { rows: AdsViewRow[]; bench: { n: number; rates: VideoRates } }) {
  const { tt } = useT();
  const [sort, setSort] = useState<Sort>({ key: "impressions", desc: true });
  const cols: Col[] = [
    { key: "spend", label: tt("cda.spend"), info: tt("cda.spendInfo"), value: (r) => r.spend_cents, show: (r) => (r.spend_cents === null ? "–" : fmtUsdCents(r.spend_cents)) },
    { key: "impressions", label: tt("cda.impressions"), info: tt("cda.impressionsInfo"), value: (r) => r.impressions, show: (r) => n0(r.impressions) },
    { key: "ctr", label: tt("cda.ctr"), info: tt("cda.ctrInfo"), value: (r) => r.rates.ctr, show: (r) => fmtPct(r.rates.ctr), rate: "ctr" },
    { key: "checkouts", label: tt("cda.checkouts"), info: tt("cda.checkoutsInfo"), value: (r) => r.checkouts, show: (r) => n0(r.checkouts) },
    { key: "per1k", label: tt("cda.col.per1k"), info: tt("cda.per1kInfo"), value: (r) => r.rates.checkouts_per_1k, show: (r) => per1k(r.rates.checkouts_per_1k), rate: "checkouts_per_1k" },
    { key: "hold_2s", label: tt("cda.hold2"), info: tt("cda.hold2Info"), value: (r) => r.rates.hold_2s, show: (r) => fmtPct(r.rates.hold_2s), rate: "hold_2s" },
    { key: "hold_6s", label: tt("cda.hold6"), info: tt("cda.hold6Info"), value: (r) => r.rates.hold_6s, show: (r) => fmtPct(r.rates.hold_6s), rate: "hold_6s" },
    { key: "p25", label: tt("cda.p25"), info: tt("cda.p25Info"), value: (r) => r.rates.p25, show: (r) => fmtPct(r.rates.p25), rate: "p25" },
    { key: "p100", label: tt("cda.p100"), info: tt("cda.p100Info"), value: (r) => r.rates.p100, show: (r) => fmtPct(r.rates.p100), rate: "p100" },
    { key: "avg", label: tt("cda.col.avg"), info: tt("cda.avgInfo"), value: (r) => r.rates.avg_play_s, show: (r) => secs(r.rates.avg_play_s), rate: "avg_play_s" },
  ];
  const sorted = useMemo(() => {
    const col = cols.find((c) => c.key === sort.key) ?? cols[1];
    // Unknown last whichever way; ties by impressions.
    return [...rows].sort((a, b) => {
      const x = col.value(a);
      const y = col.value(b);
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      return (sort.desc ? y - x : x - y) || (b.impressions ?? 0) - (a.impressions ?? 0);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);
  const benchShow = (c: Col) => {
    if (!c.rate) return "";
    const v = bench.rates[c.rate];
    return c.rate === "avg_play_s" ? secs(v) : c.rate === "checkouts_per_1k" ? per1k(v) : fmtPct(v);
  };

  return (
    <div className="an-scroll" tabIndex={0} role="region" aria-label={tt("cda.table")}>
      <table className="an-table cds-table cdx-table cda-table" data-testid="ads-table">
        <caption className="sr-only">{tt("cda.table")}</caption>
        <thead>
          <tr>
            <th scope="col">{tt("cda.col.ad")}</th>
            <th scope="col">{tt("cda.col.title")}</th>
            {cols.map((c) => {
              const on = sort.key === c.key;
              return (
                <th key={c.key} scope="col" className="gt-num" aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}>
                  <button type="button" className={`cda-sort${on ? " on" : ""}`} title={tt("cda.sortBy", { what: c.label })} onClick={() => setSort(on ? { key: c.key, desc: !sort.desc } : { key: c.key, desc: true })}>
                    {c.label}
                    <span aria-hidden>{on ? (sort.desc ? " ▾" : " ▴") : ""}</span>
                  </button>
                  <Info text={c.info} label={tt("cdx.about", { what: c.label })} />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          <tr className="cda-bench" data-testid="ads-bench">
            <th scope="row" colSpan={2}>
              <span className="cda-bench-name">
                {tt("cda.bench")} <Info text={tt("cda.benchInfo")} label={tt("cdx.about", { what: tt("cda.bench") })} />
              </span>
              <span className="cds-sub">{tt("cda.benchSub", { n: bench.n })}</span>
            </th>
            {cols.map((c) => (
              <td key={c.key} className="gt-num">
                {benchShow(c)}
              </td>
            ))}
          </tr>
          {sorted.map((r) => (
            <tr key={r.key} className={r.early ? "cda-early-row" : undefined} data-testid="ads-row">
              <th scope="row" className="cds-title">
                <span className="cdc-creative">
                  <Thumb src={r.media_url} />
                  <span className="cdc-creative-text">
                    <span className="cdc-creative-top">
                      <FormatPill format={r.ad_format} tt={tt} />
                      {r.early && (
                        <span className="pill pill-neutral cdc-pill cda-early" title={tt("cda.earlyInfo")}>
                          {tt("cda.early")}
                        </span>
                      )}
                    </span>
                    <span className="cdc-words">{r.words}</span>
                    <span className="cdc-id">{r.sub}</span>
                  </span>
                </span>
              </th>
              <td className="cda-title">{r.title}</td>
              {cols.map((c) => {
                const mark = c.rate ? r.marks[c.rate] : undefined;
                return (
                  <td key={c.key} className={`gt-num${mark ? ` cda-${mark}` : ""}`} title={mark ? tt(mark === "above" ? "cda.above" : "cda.below") : undefined}>
                    {c.show(r)}
                    {mark && <span className="sr-only"> ({tt(mark === "above" ? "cda.above" : "cda.below")})</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The Ads tab's own filters (title, ad type), kept in the address bar with the period. */
export function AdsFilter({ range, value, titles, types }: { range: string; value: { title: string | null; type: string | null }; titles: { id: string; name: string }[]; types: string[] }) {
  const { tt } = useT();
  const router = useRouter();
  const go = (patch: Partial<typeof value>) => {
    const next = { ...value, ...patch };
    const q = new URLSearchParams({ range, tab: "ads" });
    if (next.title) q.set("ad_title", next.title);
    if (next.type) q.set("ad_type", next.type);
    router.push(`/crazydramas/stats?${q.toString()}`);
  };
  return (
    <div className="cdd-filters cdx-filters" role="group" aria-label={tt("cda.filter.label")}>
      <label className="cdd-filter">
        <span className="sr-only">{tt("cda.filter.title")}</span>
        <select className={value.title ? "on" : undefined} value={value.title ?? ""} onChange={(e) => go({ title: e.target.value || null })}>
          <option value="">{tt("cda.filter.allTitles")}</option>
          {titles.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label className="cdd-filter">
        <span className="sr-only">{tt("cda.filter.type")}</span>
        <select className={value.type ? "on" : undefined} value={value.type ?? ""} onChange={(e) => go({ type: e.target.value || null })}>
          <option value="">{tt("cda.filter.allTypes")}</option>
          {types.map((f) => (
            <option key={f} value={f}>
              {f === "none" ? tt("cdc.type.none") : tt(`adFormat.${f}`)}
            </option>
          ))}
        </select>
      </label>
      {(value.title || value.type) && (
        <button type="button" className="btn btn-outline btn-sm" onClick={() => go({ title: null, type: null })}>
          {tt("cda.filter.clear")}
        </button>
      )}
    </div>
  );
}
