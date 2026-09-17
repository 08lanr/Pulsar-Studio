"use client";

// The launch monitor on the Promote desk — Pulsar Grow's LaunchMonitor on
// Studio's campaigns (decision 2026-09-16). One row per launched campaign:
// the on/off switch (read back), the review rollup, the account's state,
// lifetime spend, clicks, cost per click, conversions, TikTok's note, and
// the door into the campaign's desk page for everything else.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import type { MonitorRow } from "@/lib/tiktok/monitor";
import { call, int, pct, usd } from "@/components/tiktok/api";

const REVIEW_CLASS: Record<string, string> = { approved: "pill-success", limited: "pill-warning", in_review: "pill-accent", not_reviewed: "pill-neutral", rejected: "pill-error", unknown: "pill-neutral", none: "pill-neutral" };

export default function LaunchMonitor({ producers }: { producers: Record<string, string> }) {
  const { tt } = useT();
  const router = useRouter();
  const [rows, setRows] = useState<MonitorRow[] | null>(null);
  const [sweptAt, setSweptAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const load = useCallback(async (force = false) => {
    setLoading(true);
    try { const r = await call<{ rows: MonitorRow[]; swept_at: string }>(`/api/promote/monitor${force ? "?force=1" : ""}`); setRows(r.rows); setSweptAt(r.swept_at); setError(null); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const flip = async (row: MonitorRow) => {
    setBusy(row.campaign_id); setError(null); setInfo(null);
    try {
      const r = await call<{ applied: boolean; note: string | null }>(`/api/promote/${row.campaign_id}/controls`, "POST", { action: row.on ? "pause" : "resume" });
      if (!r.applied) setInfo(r.note ?? tt("tk.notApplied"));
      await load(true);
      router.refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const sync = async () => {
    setBusy("sync"); setError(null); setInfo(null);
    try { const r = await call<{ summary: { polled: number; synced: number; errors: string[] } }>("/api/promote/sync", "POST", {}); setInfo(tt("admin.promote.launch.synced", { polled: r.summary.polled, synced: r.summary.synced, errors: r.summary.errors.length })); await load(true); router.refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  return <section className="pd-queue tk-monitor">
    <div className="tk-head-row">
      <h2 className="section-title">{tt("admin.promote.queue.launched")} <span className="pd-count">{rows?.length ?? 0}</span></h2>
      <span className="tk-monitor-tools"><span className="gt-muted">{loading ? tt("common.loading") : sweptAt ? tt("tk.sweptAt", { at: sweptAt.slice(11, 16) + " UTC" }) : ""}</span><button type="button" className="btn btn-ghost btn-sm" disabled={loading || !!busy} onClick={() => void load(true)}>{tt("tk.refresh")}</button><button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => void sync()}>{busy === "sync" ? tt("common.loading") : tt("admin.promote.launch.sync")}</button></span>
    </div>
    {error && <p className="note note-warn" role="alert">{error}</p>}
    {info && <p className="note note-info" role="status">{info}</p>}
    {rows && !rows.length && <div className="empty"><p>{tt("tkm.empty")}</p></div>}
    {rows && rows.length > 0 && <div className="gtable" style={{ "--cols": "92px minmax(200px,2fr) minmax(140px,1.2fr) 120px 96px 80px 80px 70px minmax(160px,1.4fr) 90px" } as React.CSSProperties}>
      <div className="gt-head"><span>{tt("tk.state")}</span><span>{tt("admin.promote.col.campaign")}</span><span>{tt("tkm.account")}</span><span>{tt("tkm.review")}</span><span className="gt-num">{tt("tk.spend")}</span><span className="gt-num">{tt("tk.clicks")}</span><span className="gt-num">{tt("tk.cpc")}</span><span className="gt-num">{tt("tkm.conv")}</span><span>{tt("admin.promote.col.note")}</span><span /></div>
      {rows.map((r) => {
        const switchable = ["submitted", "live", "paused"].includes(r.status) && !r.account.suspended;
        return <div className="gt-row" key={r.campaign_id}>
          <span><span className={`tk-switch${r.on === true ? " is-on" : r.on === false ? " is-off" : ""}`}><button type="button" className="tk-switch-btn" disabled={!switchable || !!busy} aria-pressed={r.on === true} onClick={() => void flip(r)}>{busy === r.campaign_id ? "…" : r.on === true ? `● ${tt("tk.on")}` : r.on === false ? `○ ${tt("tk.off")}` : "—"}</button></span></span>
          <span><strong>{r.name}</strong><br /><small className="gt-muted">{producers[r.producer_id] ?? r.producer_id} · <span className="pd-mono">{r.tiktok_campaign_id}</span> · {tt(`admin.promote.status.${r.status}`)}</small></span>
          <span>{r.account.name ?? <span className="pd-mono">{r.advertiser_id}</span>}<br /><small className={r.account.suspended || r.account.health === "blocked" ? "err" : "gt-muted"}>{r.account.suspended ? tt("tkm.suspended") : r.account.label}</small></span>
          <span><span className={`pill ${REVIEW_CLASS[r.review.rollup]}`}>{tt(`tk.review.${r.review.rollup}`)}</span>{r.adgroups.filter((g) => !g.retired).length > 1 && <><br /><small className="gt-muted">{tt("tkm.groups", { n: r.adgroups.filter((g) => !g.retired).length })}</small></>}</span>
          <span className="gt-num">{usd(r.metrics?.spend ?? null)}<br /><small className="gt-muted">{tt("tk.of", { budget: usd(r.budget_usd, 0) })}</small></span>
          <span className="gt-num">{int(r.metrics?.clicks ?? null)}<br /><small className="gt-muted">{pct(r.metrics?.ctr ?? null)}</small></span>
          <span className="gt-num">{usd(r.metrics?.cpc ?? null)}</span>
          <span className="gt-num">{int(r.metrics?.conversions ?? null)}</span>
          <span className="gt-muted" style={{ whiteSpace: "normal" }}>{r.sweep_error ? <span className="err">{r.sweep_error}</span> : r.review.reasons[0] ?? r.status_note ?? ""}</span>
          <span><a className="btn btn-outline btn-sm" href={`/promote/${r.campaign_id}`}>{tt("tkm.open")}</a></span>
        </div>;
      })}
    </div>}
  </section>;
}
