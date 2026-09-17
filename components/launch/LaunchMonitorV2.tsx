"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import { call, int, usd } from "@/components/tiktok/api";
import { splitBudget } from "@/lib/launch/plan";
import type { LaunchCampaign, LaunchControl, LaunchRun } from "@/lib/launch/types";
import "@/app/launch-monitor.css";

const money = (cents: number | null | undefined) => usd(cents == null ? null : cents / 100);
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
const switchState = (value?: string | null): boolean | null => {
  const status = value?.toUpperCase();
  if (status === "ENABLE" || status === "ACTIVE") return true;
  if (["DISABLE", "PAUSED", "ARCHIVED", "DELETED"].includes(status ?? "")) return false;
  return null;
};
const friendlyName = (name: string) => name.replace(/-lr_[a-z0-9]+-r\d+(?=-\d+$|$)/i, "").trim() || name;
const skippedOf = (c: LaunchCampaign): unknown[] => {
  const value = c.state.skipped ?? c.state.skipped_sparks;
  return Array.isArray(value) ? value : [];
};
const ended = (c: LaunchCampaign) => c.snapshot?.delivery === "ended" || c.state.desired_status === "ended" || c.state.stop_applied === "ended";
const status = (c: LaunchCampaign) => c.status === "failed" && !c.snapshot ? "failed" : c.snapshot?.delivery ?? "unknown";
const providerCampaignId = (c: LaunchCampaign): string | null => typeof c.state.campaign_id === "string" ? c.state.campaign_id : null;
const total = (campaigns: LaunchCampaign[], field: "spend_cents" | "clicks" | "conversions") =>
  campaigns.length && campaigns.every(c => c.snapshot?.[field] != null)
    ? campaigns.reduce((sum, c) => sum + (c.snapshot?.[field] ?? 0), 0) : null;
const reviewTone = (delivery: string) => ["failed", "rejected", "suspended"].includes(delivery) ? "error" : delivery === "live" ? "live" : ["review", "submitted"].includes(delivery) ? "review" : "neutral";
type EditKind = "budget" | "daily_budget" | "bid" | "schedule" | "end";
type Edit = { run: LaunchRun; campaign: LaunchCampaign; kind: EditKind };

export default function LaunchMonitorV2({ staff = false, focusId, embedded = false }: { staff?: boolean; focusId?: string; embedded?: boolean }) {
  const { tt } = useT();
  const router = useRouter();
  const api = staff ? "/api/promote/launches" : "/api/producer/launch";
  const page = staff ? "/promote/launches" : "/producer/launch";
  const [runs, setRuns] = useState<LaunchRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState<Record<string, string>>({});
  const [capabilities, setCapabilities] = useState({ can_edit: false, can_launch: false });
  const [producers, setProducers] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState("");
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState("");
  const [edit, setEdit] = useState<Edit | null>(null);
  const [amount, setAmount] = useState("");
  const [endTime, setEndTime] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [filter, setFilter] = useState("all");
  const [focused, setFocused] = useState(!!focusId);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef("");
  busyRef.current = busy;

  const refresh = useCallback(async (force = false) => {
    const url = staff ? `${api}${force ? "?force=1" : ""}` : `/api/producer/monitor${force ? "?force=1" : ""}`;
    const r = await call<{ runs: LaunchRun[]; can_edit: boolean; can_launch: boolean; producers?: { id: string; name_zh: string; name_en: string | null }[] }>(url);
    setRuns(r.runs);
    setError("");
    setLoading(false);
    setCapabilities({ can_edit: r.can_edit, can_launch: r.can_launch });
    setProducers(Object.fromEntries((r.producers ?? []).map((p) => [p.id, p.name_en || p.name_zh])));
  }, [api, staff]);
  useEffect(() => { void refresh().catch((e) => { setError(message(e)); setLoading(false); }); }, [refresh]);
  useEffect(() => {
    const pending = runs.some((r) => r.status === "pending" || r.status === "running");
    const timer = window.setInterval(() => { void refresh().catch((e) => setError(message(e))); }, pending ? 5000 : 60000);
    return () => window.clearInterval(timer);
  }, [runs, refresh]);
  useEffect(() => {
    if (!edit) return;
    const dialog = dialogRef.current;
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? [])];
    (focusable()[0] ?? dialog)?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) { setEdit(null); return; }
      if (event.key !== "Tab") return;
      const nodes = focusable();
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); returnFocus.current?.focus(); };
  }, [edit]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-monitor-menu]")) return;
      setMenu("");
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(""); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", key); window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [menu]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(""), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  async function copyId(value: string) {
    try { await navigator.clipboard.writeText(value); setCopied(value); }
    catch { setError(tt("monitorTable.copyFailed")); }
  }
  async function refreshDelivery() {
    setRefreshing(true);
    try { await refresh(true); } catch (e) { setError(message(e)); } finally { setRefreshing(false); }
  }

  const visible = useMemo(() => runs
    .filter((r) => !focused || !focusId || r.id === focusId || r.external_id === focusId)
    .filter((r) => provider === "all" || r.draft.provider === provider)
    .filter((r) => filter === "all" || (filter === "active" ? r.campaigns.some((c) => ["live", "review", "submitted"].includes(status(c))) : r.status === filter))
    .filter((r) => !query.trim() || [r.draft.name, r.external_id, producers[r.producer_id], ...r.campaigns.flatMap((c) => [c.name, c.advertiser_id, providerCampaignId(c)]), ...(r.connections ?? []).flatMap((c) => [c.name, c.advertiser_id])].some((x) => x?.toLowerCase().includes(query.trim().toLowerCase())))
    .sort((a, b) => b.created_at.localeCompare(a.created_at)), [runs, focused, focusId, provider, filter, query, producers]);

  async function action(run: LaunchRun, suffix: "retry" | "round") {
    setBusy(`${run.id}:${suffix}`); setActionError((x) => ({ ...x, [run.id]: "" }));
    try {
      const result = await call<{ run: LaunchRun }>(`${api}/${run.id}/${suffix}`, "POST");
      if (suffix === "round") router.push(`${page}/${result.run.id}`);
      else await refresh(true);
    } catch (e) { setActionError((x) => ({ ...x, [run.id]: message(e) })); }
    finally { setBusy(""); }
  }
  async function control(run: LaunchRun, c: LaunchCampaign, change: LaunchControl, inDialog = false) {
    setBusy(c.id); setActionError((x) => ({ ...x, [c.id]: "" })); setDialogError("");
    try {
      await call(`${api}/${run.id}/controls`, "POST", { campaign_id: c.id, control: change });
      await refresh(true);
      if (inDialog) setEdit(null);
      setMenu("");
    } catch (e) {
      if (inDialog) setDialogError(message(e));
      else setActionError((x) => ({ ...x, [c.id]: message(e) }));
    } finally { setBusy(""); }
  }
  function openEdit(run: LaunchRun, campaign: LaunchCampaign, kind: EditKind) {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEdit({ run, campaign, kind }); setDialogError(""); setMenu("");
    const current = kind === "budget" ? campaign.budget_cents : kind === "daily_budget" ? campaign.daily_budget_cents : kind === "bid" ? campaign.snapshot?.groups?.[0]?.bid_cents : null;
    setAmount(current == null ? "" : String(current / 100));
    setEndTime(campaign.snapshot?.groups?.[0]?.end_time?.slice(0, 16) ?? "");
  }
  function saveEdit() {
    if (!edit) return;
    const { run, campaign, kind } = edit;
    if (kind === "end") { void control(run, campaign, { action: "end" }, true); return; }
    if (kind === "schedule") {
      const parsed = Date.parse(endTime);
      if (!Number.isFinite(parsed) || parsed <= Date.now()) { setDialogError(tt("monitorV2.invalidFutureDate")); return; }
      void control(run, campaign, { action: "schedule", end_time: new Date(parsed).toISOString() }, true);
      return;
    }
    const cents = Math.round(Number(amount) * 100);
    if (!amount.trim() || !Number.isFinite(cents) || cents <= 0) { setDialogError(tt("lv2.invalidAmount")); return; }
    const ceiling = splitBudget(run.draft.total_budget_cents, run.draft.account_ids.length * run.draft.campaigns_per_account)[campaign.index - 1];
    if (kind === "budget" && cents > ceiling) { setDialogError(tt("lv2.budgetOverCap", { max: money(ceiling) })); return; }
    const change: LaunchControl = kind === "budget" ? { action: "budget", budget_cents: cents } : kind === "daily_budget" ? { action: "daily_budget", daily_budget_cents: cents } : { action: "bid", bid_cents: cents };
    void control(run, campaign, change, true);
  }

  return <div className="launch-flow lm" id="launch-monitor">
    <div className="page-head"><div><h1>{tt("lv2.monitor.title")}</h1><p className="page-sub">{tt("monitorV2.subtitle")}</p></div><div className="rs-tool-row">{!embedded && <Link className="btn btn-outline" href={page}>{tt("launchFeedback.createLaunch")}</Link>}<button className="btn btn-outline" disabled={!!busy || refreshing} onClick={() => void refreshDelivery()}>{tt(refreshing ? "common.loading" : "lv2.refresh")}</button></div></div>
    {error && <p className="note note-warn" role="alert">{error}</p>}
    {focusId && focused && <div className="lm-focus"><span>{tt("monitorV2.focused")}</span><button className="btn btn-outline btn-sm" onClick={() => setFocused(false)}>{tt("monitorV2.showAll")}</button></div>}
    <div className="lm-filters" aria-label={tt("monitorV2.filters")}>
      <label>{tt("monitorV2.search")}<input value={query} onChange={(e) => setQuery(e.target.value)} type="search" placeholder={tt("monitorV2.searchPlaceholder")} /></label>
      <label>{tt("monitorV2.provider")}<select value={provider} onChange={(e) => setProvider(e.target.value)}><option value="all">{tt("monitorV2.all")}</option><option value="tiktok">TikTok</option><option value="meta">Meta</option></select></label>
      <label>{tt("monitorV2.status")}<select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">{tt("monitorV2.all")}</option><option value="active">{tt("monitorV2.active")}</option><option value="draft">{tt("lv2.plan.draft")}</option><option value="pending">{tt("lv2.run.pending")}</option><option value="running">{tt("lv2.run.running")}</option><option value="done">{tt("lv2.run.complete")}</option><option value="failed">{tt("lv2.run.failed")}</option></select></label>
      <span className="lm-count">{visible.length} {tt("monitorV2.runs")}</span>
    </div>
    {loading ? <p>{tt("common.loading")}</p> : visible.length === 0 ? <div className="empty"><p>{runs.length ? tt("monitorV2.noMatches") : tt("lv2.monitor.empty")}</p>{focused && <button className="btn btn-outline btn-sm" onClick={() => setFocused(false)}>{tt("monitorV2.showAll")}</button>}</div> : visible.map((run) => {
      const names = new Map(run.connections?.map(connection => [connection.id, connection.name]) ?? []);
      const spend = total(run.campaigns, "spend_cents");
      const clicks = total(run.campaigns, "clicks");
      const conversions = total(run.campaigns, "conversions");
      const activeCount = run.campaigns.filter(c => switchState(c.snapshot?.configured_status) === true).length;
      const knownStates = run.campaigns.every(c => switchState(c.snapshot?.configured_status) !== null);
      const averageCpc = spend != null && clicks ? Math.round(spend / clicks) : null;
      const checked = run.campaigns.map(c => c.snapshot?.checked_at).filter((at): at is string => !!at).sort().at(-1);
      return <section className="lm-run" key={run.id} data-run-id={run.external_id}>
        <header className="lm-run-head">
          <div className="lm-run-identity">
            <div className="lm-run-title"><h2><Link href={`${page}/${run.id}`}>{run.draft.name}</Link></h2><span className="lm-run-status">{run.status === "draft" ? tt("lv2.plan.draft") : tt(`lv2.run.${run.status === "done" ? "complete" : run.status}`)}</span></div>
            <div className="lm-eyebrow"><span>{run.draft.provider === "meta" ? "Meta" : "TikTok"}</span>{staff && <span>{producers[run.producer_id] ?? tt("monitorV2.producer")}</span>}<span>{tt("lv2.round")} {run.round}</span><span><span>{tt("monitorV2.created")}</span> <time dateTime={run.created_at}>{date(run.created_at)}</time></span>{run.mode !== "production" && <span>{tt(run.mode === "fake" ? "lv2.demo" : "lv2.sandbox")}</span>}</div>
          </div>
          <div className="lm-head-actions"><Link className="lm-toolbar-button" href={`${page}/${run.id}`}>{run.status === "draft" ? tt("lv2.openDraft") : tt("monitorTable.openLaunch")}</Link>{capabilities.can_edit && <button className="lm-toolbar-button" disabled={!!busy} onClick={() => void action(run, "round")}>{tt("lv2.round.new")}</button>}{capabilities.can_launch && run.status === "failed" && <button className="lm-toolbar-button" disabled={!!busy} onClick={() => void action(run, "retry")}>{tt("lv2.retry")}</button>}</div>
        </header>
        <div className="lm-summary" aria-label={tt("monitorTable.launchTotals")}>
          <div><small>{tt("lv2.campaigns")}</small><strong>{knownStates ? activeCount : "—"}<span className="lm-stat-denominator"> / {run.campaigns.length}</span></strong><span className="lm-stat-hint">{tt("monitorTable.enabledCampaigns")}</span></div>
          <div><small>{tt("lv2.spent")} · {run.draft.provider === "meta" ? "Meta" : "TikTok"}</small><strong>{money(spend)}</strong></div>
          <div><small>{tt("lv2.clicks")}</small><strong>{int(clicks)}</strong></div>
          <div><small>{tt("lv2.conversions")}</small><strong>{int(conversions)}</strong></div>
          <div><small>{tt("lv2.cpc")}</small><strong>{money(averageCpc)}</strong></div>
          <div><small>{tt(run.approved_at ? "monitorV2.approvedBudget" : "monitorTable.plannedBudget")}</small><strong>{money(run.draft.total_budget_cents)}</strong></div>
        </div>
        {(run.error || actionError[run.id]) && <p className="note note-warn lm-run-error" role="alert">{actionError[run.id] || run.error}</p>}
        {run.campaigns.length > 0 ? <div className="lm-table-scroll"><table className="lm-table" aria-label={tt("lv2.campaigns")}>
          <colgroup><col className="lm-col-state" /><col className="lm-col-campaign" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-actions" /></colgroup>
          <thead><tr><th scope="col">{tt("lv2.state")}</th><th scope="col">{tt("lv2.campaign")}</th><th scope="col">{tt("lv2.spent")}</th><th scope="col">{tt("lv2.clicks")}</th><th scope="col">{tt("lv2.cpc")}</th><th scope="col">{tt("lv2.conversions")}</th><th scope="col">{tt("lv2.costPerConv")}</th><th scope="col">CTR</th><th scope="col"><span className="sr-only">{tt("lv2.actions")}</span></th></tr></thead>
          <tbody>{run.campaigns.map(c => {
            const active = switchState(c.snapshot?.configured_status);
            const canControl = capabilities.can_launch && c.status === "done" && !ended(c);
            const canEnd = capabilities.can_launch && run.status !== "draft" && !ended(c);
            const ceiling = splitBudget(run.draft.total_budget_cents, run.draft.account_ids.length * run.draft.campaigns_per_account)[c.index - 1];
            const campaignId = providerCampaignId(c);
            const delivery = status(c);
            const controlError = actionError[c.id] || c.error || (typeof c.state.control_error === "string" ? c.state.control_error : null);
            const ctr = c.snapshot?.impressions && c.snapshot.clicks != null ? `${(c.snapshot.clicks / c.snapshot.impressions * 100).toFixed(2)}%` : "—";
            const costPerConversion = c.snapshot?.conversions && c.snapshot.spend_cents != null ? money(Math.round(c.snapshot.spend_cents / c.snapshot.conversions)) : "—";
            return <Fragment key={c.id}>
              <tr className={`lm-campaign ${expanded[c.id] ? "is-expanded" : ""}`} data-campaign-id={c.id}>
                <td className="lm-state-cell">
                  {canControl && active !== null ? <button className={`lm-state-toggle ${active ? "is-on" : "is-off"}`} disabled={!!busy} aria-label={tt(active ? "monitorV2.pauseCampaign" : "monitorV2.resumeCampaign")} title={tt(active ? "monitorV2.pauseCampaign" : "monitorV2.resumeCampaign")} onClick={() => void control(run, c, { action: active ? "pause" : "resume" })}><i aria-hidden="true" />{tt(active ? "lv2.switchOn" : "lv2.switchOff")}</button> : <span className={`lm-state-toggle ${active ? "is-on" : "is-off"}`}><i aria-hidden="true" />{tt(active === null ? "lv2.switchUnknown" : active ? "lv2.switchOn" : "lv2.switchOff")}</span>}
                  <span className={`lm-delivery lm-delivery-${reviewTone(delivery)}`}>{tt(`lv2.delivery.${delivery}`)}</span>
                </td>
                <td className="lm-campaign-cell">
                  <button className="lm-campaign-name" aria-expanded={!!expanded[c.id]} aria-controls={`campaign-details-${c.id}`} onClick={() => setExpanded(x => ({ ...x, [c.id]: !x[c.id] }))}><svg className="lm-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>{friendlyName(c.name)}</button>
                  <div className="lm-account-line"><span>{names.get(c.connection_id) ?? tt("monitorV2.account")}</span><button className="lm-copy-id" title={tt("monitorTable.copyAccountId")} aria-label={tt("monitorTable.copyAccountIdValue", { id: c.advertiser_id })} onClick={() => void copyId(c.advertiser_id)}>{c.advertiser_id}{copied === c.advertiser_id ? <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3.2 3.2L13 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg> : <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5" y="4" width="8" height="9" rx="1" stroke="currentColor" strokeWidth="1.3" /><path d="M3 11H2V3a1 1 0 0 1 1-1h7v1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>}</button></div>
                  <div className="lm-row-meta">{campaignId && <span title={tt("monitorTable.platformCampaignId")}>{tt("monitorTable.id")} {campaignId}</span>}<span>{tt("monitorTable.creatives", { count: c.content.length })}</span>{c.snapshot?.note && <span className="lm-provider-note" title={c.snapshot.note}>{c.snapshot.note}</span>}</div>
                </td>
                <td className="lm-number">{money(c.snapshot?.spend_cents)}</td><td className="lm-number">{int(c.snapshot?.clicks)}</td><td className="lm-number">{money(c.snapshot?.cpc_cents)}</td><td className="lm-number">{int(c.snapshot?.conversions)}</td><td className="lm-number">{costPerConversion}</td><td className="lm-number">{ctr}</td>
                <td><div className="lm-actions"><button className="lm-row-button" aria-expanded={!!expanded[c.id]} aria-controls={`campaign-details-${c.id}`} onClick={() => setExpanded(x => ({ ...x, [c.id]: !x[c.id] }))}>{expanded[c.id] ? tt("lv2.hide") : tt("lv2.details")}</button>{(canControl || canEnd) && <button data-monitor-menu className="lm-row-button lm-more" aria-expanded={menu === c.id} aria-label={tt("monitorV2.moreActions")} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenuPosition({ top: Math.max(12, Math.min(rect.bottom + 4, window.innerHeight - 300)), left: Math.max(12, Math.min(rect.right - 220, window.innerWidth - 232)) }); setMenu(menu === c.id ? "" : c.id); }}><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="13" cy="8" r="1.2" /></svg></button>}</div></td>
              </tr>
              {controlError && <tr className="lm-error-row"><td colSpan={9}><p className="note note-warn" role="alert">{controlError}</p></td></tr>}
              {expanded[c.id] && <tr className="lm-detail-row"><td colSpan={9}><div className="lm-detail" id={`campaign-details-${c.id}`}>
                <div className="lm-detail-facts"><span>{tt("lv2.campaignBudget")}: <strong>{money(c.budget_cents)}</strong></span><span>{tt("monitorV2.approvedCeiling")}: {money(ceiling)}</span><span>{tt("lv2.campaignDaily")}: {money(c.daily_budget_cents)}</span><span>{tt("lv2.lastChecked")}: {date(c.snapshot?.checked_at)}</span></div>
                {c.snapshot?.groups?.map((g, i) => <div className="lm-group" key={g.id}><div><strong>{tt("lv2.group")} {i + 1}</strong><span>{g.id}</span><span>{tt(run.draft.provider === "tiktok" && run.draft.tiktok_settings.budget_mode === "BUDGET_MODE_DAY" ? "monitorV2.groupDaily" : "monitorV2.groupLifetime")} {money(g.budget_cents)}</span><span>{tt("lv2.bid")} {money(g.bid_cents)}</span></div>{canControl && run.draft.provider === "tiktok" && switchState(g.status) !== null ? <button className="lm-row-button" disabled={!!busy} onClick={() => void control(run, c, { action: "group", group_id: g.id, enabled: switchState(g.status) === false })}>{tt(switchState(g.status) === true ? "monitorV2.pauseGroup" : "monitorV2.resumeGroup")}</button> : <span>{switchState(g.status) === true ? tt("monitorV2.enabled") : switchState(g.status) === false ? tt("monitorV2.paused") : tt("monitorV2.unknown")}</span>}</div>)}
                {c.snapshot?.ads && c.snapshot.ads.length > 0 && <div className="lm-ad-statuses">{c.snapshot.ads.map((ad, i) => <span key={ad.id} title={`${ad.id}${ad.note ? ` · ${ad.note}` : ""}`}><strong>{tt("monitorV2.ad")} {i + 1}</strong><span>{ad.status.replaceAll("_", " ").toLowerCase()}</span></span>)}</div>}
                {skippedOf(c).map((item, i) => <p className="note note-warn" key={i}>{typeof item === "string" ? item : JSON.stringify(item)}</p>)}
                <details className="lm-authorization"><summary>{tt(run.draft.provider === "tiktok" ? "monitorTable.authorizationCodes" : "lv2.content")}</summary><p>{c.content.map(x => run.draft.provider === "tiktok" ? x.value : x.label ?? x.value).join(", ") || "—"}</p></details>
              </div></td></tr>}
              {menu === c.id && createPortal(<div data-monitor-menu className="lm-menu-list" style={{ top: menuPosition.top, left: menuPosition.left }}>{canControl && <><button onClick={() => openEdit(run, c, "budget")}>{tt("lv2.changeBudget")}</button>{c.daily_budget_cents != null && <button onClick={() => openEdit(run, c, "daily_budget")}>{tt("lv2.changeDaily")}</button>}<button onClick={() => openEdit(run, c, "bid")}>{tt("lv2.changeBid")}</button><button onClick={() => openEdit(run, c, "schedule")}>{tt("lv2.endDate")}</button>{run.draft.provider === "tiktok" && <button disabled={!!busy} onClick={() => void control(run, c, { action: "duplicate" })}>{tt("lv2.duplicate")}</button>}</>}{canEnd && <button className="lm-danger" onClick={() => openEdit(run, c, "end")}>{tt("monitorV2.endCampaign")}</button>}</div>, document.body)}
            </Fragment>;
          })}</tbody>
        </table></div> : <p className="lm-pending">{tt(run.status === "draft" ? "monitorTable.draftHint" : "monitorTable.creatingHint")}</p>}
        <footer className="lm-run-footer"><span>{tt("lv2.lastChecked")}: {date(checked)}</span><details><summary>{tt("monitorTable.launchDetails")}</summary><div><span>{run.external_id}</span><span>{tt("monitorV2.approved")}: {date(run.approved_at)}</span>{run.approval_note && <p>{run.approval_note}</p>}</div></details></footer>
      </section>;
    })}
    <span className="sr-only" role="status">{copied ? tt("monitorTable.copied") : ""}</span>
    {edit && <div className="lm-dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setEdit(null); }}><div ref={dialogRef} tabIndex={-1} className="lm-dialog" role="dialog" aria-modal="true" aria-labelledby="lm-dialog-title"><h2 id="lm-dialog-title">{edit.kind === "end" ? tt("monitorV2.endCampaign") : edit.kind === "schedule" ? tt("lv2.endDate") : tt(edit.kind === "budget" ? "lv2.changeBudget" : edit.kind === "daily_budget" ? "lv2.changeDaily" : "lv2.changeBid")}</h2><p className="lm-meta">{edit.campaign.name}</p>{edit.kind === "end" ? <p>{tt("monitorV2.endWarning")}</p> : edit.kind === "schedule" ? <label>{tt("monitorV2.newEndDate")}<input autoFocus type="datetime-local" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></label> : <label>{tt(edit.kind === "budget" ? "lv2.campaignBudget" : edit.kind === "daily_budget" ? "lv2.campaignDaily" : "lv2.bid")}<input autoFocus type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>}{edit.kind === "budget" && <p className="lm-meta">{tt("monitorV2.approvedCeiling")}: {money(splitBudget(edit.run.draft.total_budget_cents, edit.run.draft.account_ids.length * edit.run.draft.campaigns_per_account)[edit.campaign.index - 1])}</p>}{dialogError && <p className="note note-warn" role="alert">{dialogError}</p>}<div className="lm-dialog-actions"><button className="btn btn-outline" disabled={!!busy} onClick={() => setEdit(null)}>{tt("monitorV2.cancel")}</button><button className="btn btn-primary" disabled={!!busy} onClick={saveEdit}>{edit.kind === "end" ? tt("monitorV2.endCampaign") : tt("monitorV2.save")}</button></div></div></div>}
  </div>;
}








