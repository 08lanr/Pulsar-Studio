"use client";

// The delivery panel of a launched campaign — Pulsar Grow's launch monitor
// card on one campaign (decision 2026-09-16), shared by the producer's
// campaign page and the staff desk. What it shows is what TikTok says now
// (the sweep), and what it offers is every control: on/off, end, the
// budget, the daily budget, the cost cap, the schedule end, copies, and the
// switch on each ad group. Every action reads back and refreshes the sweep.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import type { MonitorRow } from "@/lib/tiktok/monitor";
import { MAX_DUPLICATE_COPIES, MIN_ADGROUP_BUDGET_USD, goalOption } from "@/lib/tiktok/options";
import type { PromoLaunch } from "@/lib/types";
import { call, int, pct, usd } from "./api";

type Props = {
  campaignId: string;
  status: string;
  launch: PromoLaunch | null;
  /** GET: the sweep for this campaign; POST: the controls. */
  monitorUrl: string;
  controlsUrl: string;
  canAct: boolean;
  stopOnly?: boolean;
  /** Extra buttons the host adds (staff: retry, relaunch, override). */
  extra?: ReactNode;
  /** Wrap in the producer's panel chrome or the desk's card. */
  chrome?: "producer" | "staff";
  /** The workflow sentence for this state ("Created on TikTok. The ads are in TikTok's review…"), shown as the panel's subtitle. */
  hint?: string | null;
};

const REVIEW_CLASS: Record<string, string> = { approved: "pill-success", limited: "pill-warning", in_review: "pill-accent", not_reviewed: "pill-neutral", rejected: "pill-error", unknown: "pill-neutral", none: "pill-neutral" };

export default function DeliveryPanel({ campaignId, status, launch, monitorUrl, controlsUrl, canAct, stopOnly = false, extra, chrome = "producer", hint = null }: Props) {
  const { tt } = useT();
  const router = useRouter();
  const [row, setRow] = useState<MonitorRow | null>(null);
  const [sweptAt, setSweptAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [form, setForm] = useState<"budget" | "daily" | "bid" | "schedule" | "duplicate" | "end" | null>(null);
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const r = await call<{ row?: MonitorRow | null; rows?: MonitorRow[]; swept_at: string }>(`${monitorUrl}${force ? (monitorUrl.includes("?") ? "&" : "?") + "force=1" : ""}`);
      setRow(r.row !== undefined ? r.row : r.rows?.[0] ?? null);
      setSweptAt(r.swept_at);
      setError(null);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [monitorUrl]);
  useEffect(() => { void load(); }, [load]);

  const act = async (key: string, body: Record<string, unknown>, done?: string) => {
    setBusy(key); setError(null); setInfo(null);
    try {
      const r = await call<Record<string, unknown>>(controlsUrl, "POST", body);
      if (r.applied === false) setInfo(String(r.note ?? tt("tk.notApplied")));
      else if (done) setInfo(done);
      if (Array.isArray(r.errors) && r.errors.length) setInfo(tt("tk.someFailed", { n: r.errors.length, first: String(r.errors[0]) }));
      setForm(null); setAmount(""); setDay(""); setNote("");
      await load(true);
      router.refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  const lifetime = (row?.settings ?? launch?.settings)?.budget_mode !== "BUDGET_MODE_DAY";
  const settings = row?.settings ?? launch?.settings ?? null;
  const goal = goalOption(settings?.optimization_goal);
  const on = row?.on ?? (status === "paused" ? false : status === "live" || status === "submitted" ? true : null);
  const switchable = canAct && (!stopOnly || on === true) && ["submitted", "live", "paused"].includes(status) && !!launch?.tiktok_campaign_id;
  const manageable = canAct && !stopOnly && ["submitted", "live", "paused"].includes(status) && !!launch?.tiktok_campaign_id;
  const activeGroups = (row?.adgroups ?? []).filter((g) => !g.retired);
  const m = row?.metrics ?? null;

  const body = <>
    {error && <p className="note note-warn" role="alert">{error}</p>}
    {info && <p className="note note-info" role="status">{info}</p>}
    {row?.account.suspended && <p className="note note-warn" role="alert"><strong>{tt("tk.suspendedTitle")}</strong> {tt("tk.suspendedBody")}</p>}
    {row?.sweep_error && <p className="gt-muted tk-sweep-error">{tt("tk.sweepError")}: {row.sweep_error}</p>}

    <div className="tk-state-row">
      <span className={`tk-switch${on === true ? " is-on" : on === false ? " is-off" : ""}`}>
        <button type="button" className="tk-switch-btn" disabled={!switchable || !!busy || status === "ended"} aria-pressed={on === true} title={switchable ? tt(on ? "tk.turnOff" : "tk.turnOn") : undefined} onClick={() => act("switch", { action: on ? "pause" : "resume" })}>{busy === "switch" ? "…" : on === true ? `● ${tt("tk.on")}` : on === false ? `○ ${tt("tk.off")}` : "—"}</button>
      </span>
      <span className={`pill ${REVIEW_CLASS[row?.review.rollup ?? "none"]}`}>{tt(`tk.review.${row?.review.rollup ?? "none"}`)}</span>
      {row?.account.name && <span className="gt-muted">{row.account.name} · <span className="pd-mono">{row.advertiser_id}</span> · {row.account.label}</span>}
      <span className="gt-muted tk-swept">{loading ? tt("common.loading") : sweptAt ? tt("tk.sweptAt", { at: sweptAt.slice(11, 16) + " UTC" }) : ""} <button type="button" className="btn btn-ghost btn-sm" disabled={loading || !!busy} onClick={() => void load(true)}>{tt("tk.refresh")}</button></span>
    </div>

    <div className="stat-grid tk-stats">
      <div className="stat"><span className="stat-label">{tt("tk.spend")}</span><strong className="stat-value">{usd(m?.spend ?? null)}</strong><span className="stat-foot">{tt("tk.of", { budget: usd(row?.budget_usd ?? launch?.budget_usd ?? null, 0) })}</span></div>
      <div className="stat"><span className="stat-label">{tt("tk.impressions")}</span><strong className="stat-value">{int(m?.impressions ?? null)}</strong></div>
      <div className="stat"><span className="stat-label">{tt("tk.clicks")}</span><strong className="stat-value">{int(m?.clicks ?? null)}</strong><span className="stat-foot">{tt("tk.ctr")} {pct(m?.ctr ?? null)}</span></div>
      <div className="stat"><span className="stat-label">{tt("tk.cpc")}</span><strong className="stat-value">{usd(m?.cpc ?? null)}</strong></div>
    </div>

    {row?.review.reasons.length ? <div className="pd-ask"><span>{tt("tk.rejectReasons")}</span>{row.review.reasons.map((r) => <p key={r}>{r}</p>)}</div> : null}

    {row && <div className="gtable gtable-flush tk-groups" style={{ "--cols": "minmax(160px,1.6fr) 90px minmax(120px,1fr) minmax(110px,1fr) minmax(120px,1fr) 100px" } as React.CSSProperties}>
      <div className="gt-head"><span>{tt("tk.adGroup")}</span><span>{tt("tk.state")}</span><span>{tt("tk.groupBudget")}</span><span>{tt("tk.bid")}</span><span>{tt("tk.ends")}</span><span /></div>
      {row.adgroups.map((g) => <div className={`gt-row${g.retired ? " is-retired" : ""}`} key={g.adgroup_id}>
        <span><strong>{g.role === "primary" ? tt("tk.primaryGroup") : tt("tk.copyGroup")}</strong>{g.retired && <> · {tt("tk.retired")}</>}<br /><small className="pd-mono gt-muted">{g.adgroup_id} · {g.ad_ids.length} {tt("tk.ads")}</small></span>
        <span><span className={`pill ${g.on ? "pill-success" : "pill-neutral"}`}>{g.on === null ? "—" : g.on ? tt("tk.on") : tt("tk.off")}</span></span>
        <span>{usd(g.budget, 0)} <small className="gt-muted">{g.budget_mode === "BUDGET_MODE_DAY" ? tt("tk.perDay") : tt("tk.lifetime")}</small></span>
        <span>{g.bid_type === "BID_TYPE_CUSTOM" ? `${usd(g.bid)} ${g.billing_event === "CPC" ? tt("tk.perClick") : tt("tk.perResult")}` : tt("tk.bid.LOWEST_COST_short")}</span>
        <span className="gt-muted">{g.schedule_end ? g.schedule_end.slice(0, 10) : "—"}</span>
        <span>{canAct && (!stopOnly || g.on === true) && !g.retired && <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => act(`g-${g.adgroup_id}`, { action: "adgroup_switch", adgroup_id: g.adgroup_id, on: !g.on })}>{busy === `g-${g.adgroup_id}` ? "…" : g.on ? tt("tk.turnOff") : tt("tk.turnOn")}</button>}</span>
      </div>)}
      {!row.adgroups.length && <div className="gt-row"><span className="gt-muted" style={{ gridColumn: "1 / -1" }}>{tt("tk.noGroups")}</span></div>}
    </div>}

    {stopOnly && canAct && ["submitted", "live", "paused"].includes(status) && <div className="tk-controls"><button type="button" className="btn btn-ghost btn-sm tk-end" disabled={!!busy} onClick={() => act("end", { action: "end" })}>{tt("tk.end")}</button>{extra}</div>}
    {manageable && <div className="tk-controls">
      <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => { setForm(form === "budget" ? null : "budget"); setAmount(String(row?.budget_usd ?? launch?.budget_usd ?? "")); }}>{tt("tk.changeBudget")}</button>
      {!lifetime && <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => { setForm(form === "daily" ? null : "daily"); setAmount(String(settings?.daily_budget_usd ?? "")); }}>{tt("tk.changeDaily")}</button>}
      <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => { setForm(form === "bid" ? null : "bid"); setAmount(String(row?.adgroups.find((g) => !g.retired && g.bid)?.bid ?? launch?.bid_usd ?? "")); }}>{tt("tk.changeBid")}</button>
      <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => { setForm(form === "schedule" ? null : "schedule"); setDay(""); }}>{tt("tk.extend")}</button>
      <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => { setForm(form === "duplicate" ? null : "duplicate"); setAmount("1"); }}>{tt("tk.duplicate")}</button>
      <button type="button" className="btn btn-ghost btn-sm tk-end" disabled={!!busy} onClick={() => { setForm(form === "end" ? null : "end"); setNote(""); }}>{tt("tk.end")}</button>
      {extra}
    </div>}
    {!manageable && extra && <div className="tk-controls">{extra}</div>}

    {form && <form className="tk-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {form === "budget" && <>
        <label className="tk-label" htmlFor="tk-f-amount">{tt("tk.newBudget")}</label>
        <input id="tk-f-amount" className="input tk-num" type="number" min={MIN_ADGROUP_BUDGET_USD} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} required />
        <p className="hint">{tt(lifetime ? "tk.newBudgetLifetimeHint" : "tk.newBudgetDailyHint", { groups: activeGroups.length || 1 })}</p>
        <input className="input" placeholder={tt("tk.noteOptional")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={400} />
      </>}
      {form === "daily" && <>
        <label className="tk-label" htmlFor="tk-f-amount">{tt("tk.newDaily")}</label>
        <input id="tk-f-amount" className="input tk-num" type="number" min={MIN_ADGROUP_BUDGET_USD} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} required />
        <p className="hint">{tt("tk.newDailyHint", { cap: usd(row?.budget_usd ?? launch?.budget_usd ?? null, 0) })}</p>
      </>}
      {form === "bid" && <>
        <label className="tk-label" htmlFor="tk-f-amount">{tt("tk.newBid")}</label>
        <input id="tk-f-amount" className="input tk-num" type="number" min={0.01} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} required />
        <p className="hint">{tt(goal.billing === "CPC" ? "tk.bidAmountCpc" : "tk.bidAmountOcpm")} {activeGroups.some((g) => g.bid_type !== "BID_TYPE_CUSTOM") && tt("tk.bidReplaceHint")}</p>
      </>}
      {form === "schedule" && <>
        <label className="tk-label" htmlFor="tk-f-day">{tt("tk.newEnd")}</label>
        <input id="tk-f-day" className="input tk-date" type="date" value={day} onChange={(e) => setDay(e.target.value)} required />
        <p className="hint">{tt("tk.newEndHint")}</p>
      </>}
      {form === "duplicate" && <>
        <label className="tk-label" htmlFor="tk-f-amount">{tt("tk.copies")}</label>
        <input id="tk-f-amount" className="input tk-num" type="number" min={1} max={MAX_DUPLICATE_COPIES} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} required />
        <p className="hint">{tt(lifetime ? "tk.copiesLifetimeHint" : "tk.copiesDailyHint")}</p>
      </>}
      {form === "end" && <>
        <p className="note note-warn"><strong>{tt("tk.endConfirmTitle")}</strong> {tt("tk.endConfirmBody")}</p>
        <input className="input" placeholder={tt("tk.noteOptional")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={400} />
      </>}
      <div className="rs-form-foot">
        <button className={`btn btn-sm ${form === "end" ? "btn-outline tk-end" : "btn-primary"}`} disabled={!!busy}>{busy === "form" ? tt("common.loading") : tt(form === "end" ? "tk.endNow" : "tk.apply")}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => setForm(null)}>{tt("tk.cancel")}</button>
      </div>
    </form>}
  </>;

  async function submit() {
    if (!form) return;
    const n = Number(amount);
    if (form === "budget") return act("form", { action: "budget", budget_usd: n, note: note || null }, tt("tk.budgetChanged", { budget: usd(n, 0) }));
    if (form === "daily") return act("form", { action: "daily_budget", daily_budget_usd: n }, tt("tk.dailyChanged", { daily: usd(n, 0) }));
    if (form === "bid") return act("form", { action: "bid", bid_usd: n }, tt("tk.bidChanged", { bid: usd(n) }));
    if (form === "schedule") return act("form", { action: "schedule_end", end_day: day }, tt("tk.endChanged", { day }));
    if (form === "duplicate") return act("form", { action: "duplicate", copies: Math.round(n) }, tt("tk.copiesMade", { n: Math.round(n) }));
    if (form === "end") return act("form", { action: "end", note: note || null }, tt("tk.ended"));
  }

  if (chrome === "staff") return <div className="tk-delivery">{body}</div>;
  return <section className="rs-panel tk-delivery" id="launch-status">
    <div className="rs-panel-head"><div><h2>{tt("tk.deliveryTitle")}</h2><p>{hint ?? tt("tk.deliverySub")}</p></div><span className="rs-panel-aside"><span className={`pill ${status === "live" ? "status-live" : status === "failed" ? "pill-error" : status === "paused" ? "pill-warning" : status === "ended" ? "pill-neutral" : "pill-accent"}`}>{tt(`promote.status.${status}`)}</span></span></div>
    <div className="rs-panel-body">{body}</div>
  </section>;
}
