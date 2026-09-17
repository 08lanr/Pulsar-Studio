"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import { call, usd } from "@/components/tiktok/api";
import LaunchSettingsDialog from "@/components/launch/LaunchSettingsDialog";
import LaunchPresetPicker from "@/components/launch/LaunchPresetPicker";
import InstantPageTemplatePicker from "@/components/launch/InstantPageTemplatePicker";
import LaunchAccountPicker from "@/components/launch/LaunchAccountPicker";
import LaunchConfirmDialog from "@/components/launch/LaunchConfirmDialog";
import { summarizeLaunchSettings } from "@/lib/tiktok/settings";
import { defaultLaunchDraft } from "@/lib/launch/plan";
import { feeLineVars } from "@/lib/promote/fee";
import type { LaunchContent, LaunchDraft, LaunchPlan, LaunchProvider, LaunchRun, LaunchWorkspace } from "@/lib/launch/types";

type Props = { staff?: boolean; runId?: string };
const DIRECT_ACCOUNTS = "__direct_accounts__";
const money = (cents: number | null | undefined) => usd(cents == null ? null : cents / 100);
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const localDateTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
};

export default function LaunchStudio({ staff = false, runId }: Props) {
  const { tt } = useT();
  const router = useRouter();
  const base = staff ? "/api/promote/launches" : "/api/producer/launch";
  const pageBase = staff ? "/promote/launches" : "/producer/launch";
  const [producerId, setProducerId] = useState("");
  const [workspace, setWorkspace] = useState<LaunchWorkspace | null>(null);
  const [producers, setProducers] = useState<{ id: string; name_zh: string; name_en: string | null }[]>([]);
  const [run, setRun] = useState<LaunchRun | null>(null);
  const [loadedRunId, setLoadedRunId] = useState<string | null>(null);
  const [runLoadFailed, setRunLoadFailed] = useState(false);
  const [draft, setDraft] = useState<LaunchDraft>(() => defaultLaunchDraft("tiktok"));
  const [plan, setPlan] = useState<LaunchPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const [businessId, setBusinessId] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  const closeConfirm = useCallback(() => { setConfirmOpen(false); setConfirmError(""); }, []);
  const submitting = useRef(false);
  const errorBox = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) {
      errorBox.current?.focus({ preventScroll: true });
      errorBox.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [error]);
  const workspaceRequest = useRef(0);
  const [postKind, setPostKind] = useState<"facebook_post" | "instagram_post">("facebook_post");
  const [postValue, setPostValue] = useState("");
  const [codesRaw, setCodesRaw] = useState("");
  const [localReady, setLocalReady] = useState(false);
  useEffect(() => setLocalReady(true), []);

  const workspaceUrl = `${base}/workspace${staff && producerId ? `?producer_id=${encodeURIComponent(producerId)}` : ""}`;
  const reload = useCallback(async () => {
    const request = ++workspaceRequest.current;
    try {
      const w = await call<{ workspace: LaunchWorkspace }>(workspaceUrl);
      if (request !== workspaceRequest.current) return;
      setWorkspace(w.workspace);
      if (w.workspace.producers?.length) setProducers(w.workspace.producers);
      if (!runId && !run) setDraft((d) => ({ ...d, destination_url: d.destination_url || w.workspace.default_destination_url }));
    } catch (e) { if (request === workspaceRequest.current) throw e; }
  }, [workspaceUrl, runId, run]);
  useEffect(() => {
    const requests = workspaceRequest;
    void reload().catch((e) => setError(errorText(e)));
    return () => { requests.current++; };
  }, [reload]);
  useEffect(() => {
    if (!runId) { setRun(null); setPlan(null); setLoadedRunId(null); setRunLoadFailed(false); return; }
    let active = true;
    setRun(null); setPlan(null); setLoadedRunId(null); setRunLoadFailed(false); setError("");
    void call<{ run: LaunchRun }>(`${base}/${encodeURIComponent(runId)}`)
      .then((r) => {
        if (!active) return;
        setRun(r.run);
        setDraft(r.run.draft);
        setBusinessId("");
        setCodesRaw(r.run.draft.content.filter((x) => x.kind === "spark").map((x) => x.value).join("\n"));
        setProducerId(r.run.producer_id);
        setLoadedRunId(runId);
      })
      .catch((e) => { if (active) { setError(errorText(e)); setRunLoadFailed(true); setLoadedRunId(runId); } });
    return () => { active = false; };
  }, [base, runId]);

  const connections = useMemo(() => (workspace?.connections ?? []).filter((c) => c.provider === draft.provider && c.enabled), [workspace, draft.provider]);
  const businessCenters = useMemo(() => {
    const named = (workspace as LaunchWorkspace & { business_centers?: { business_id: string; name: string; provider?: LaunchProvider }[] } | null)?.business_centers ?? [];
    const groups = [...new Set(connections.map(c => c.business_id).filter((id): id is string => !!id))].map(id => ({ id, name: named.find(b => b.business_id === id && (!b.provider || b.provider === draft.provider))?.name ?? id }));
    if (connections.some(c => !c.business_id)) groups.push({ id: DIRECT_ACCOUNTS, name: tt("launchRedesign.directAccounts") });
    return groups;
  }, [connections, workspace, draft.provider, tt]);
  const inferredBusinessId = connections.find(c => draft.account_ids.includes(c.id))?.business_id ?? (draft.account_ids.length ? DIRECT_ACCOUNTS : "");
  const chosenBusinessId = businessCenters.some(b => b.id === businessId) ? businessId : businessCenters.some(b => b.id === inferredBusinessId) ? inferredBusinessId : businessCenters.length === 1 ? businessCenters[0].id : "";
  const businessPlaceholder = staff && !producerId ? draft.provider === "meta" ? "launchBusiness.chooseProducerMeta" : "launchBusiness.chooseProducer" : !workspace ? draft.provider === "meta" ? "launchBusiness.loadingMeta" : "launchBusiness.loading" : !businessCenters.length ? draft.provider === "meta" ? "launchBusiness.noneMeta" : "launchBusiness.none" : draft.provider === "meta" ? "launchRedesign.chooseBusinessPortfolio" : "launchRedesign.chooseBusinessCenter";
  const inChosenBusiness = (businessId: string | null) => !businessCenters.length || (chosenBusinessId === DIRECT_ACCOUNTS ? !businessId : businessId === chosenBusinessId);
  const campaigns = draft.account_ids.length * draft.campaigns_per_account;
  const required = draft.allocation === "unique" ? campaigns * draft.content_per_campaign : draft.content_per_campaign;
  const available = draft.content.length;
  const update = <K extends keyof LaunchDraft>(key: K, value: LaunchDraft[K]) => { setDraft((d) => ({ ...d, [key]: value })); setPlan(null); };
  const toggleContent = (item: LaunchContent) => update("content", draft.content.some((x) => x.kind === item.kind && x.value === item.value) ? draft.content.filter((x) => !(x.kind === item.kind && x.value === item.value)) : [...draft.content, item]);
  const setContentField = (item: LaunchContent, field: "text" | "headline", value: string) => update("content", draft.content.map((x) => x.kind === item.kind && x.value === item.value ? { ...x, [field]: value } : x));
  const setProvider = (provider: LaunchProvider) => { const next = defaultLaunchDraft(provider); setDraft({ ...next, name: draft.name, destination_url: draft.destination_url, total_budget_cents: draft.total_budget_cents }); setCodesRaw(""); setBusinessId(""); setPlan(null); };
  const setCodes = (s: string) => { setCodesRaw(s); update("content", [...new Set(s.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean))].map((value) => ({ kind: "spark" as const, value }))); };
  const editorDaily = draft.daily_budget_cents === null ? null : Math.floor(draft.daily_budget_cents / (draft.tiktok_settings.duplicate_copies + 1)) / 100;
  const editorSettings = { ...draft.tiktok_settings, start_paused: draft.start_paused, budget_mode: draft.daily_budget_cents === null ? "BUDGET_MODE_TOTAL" : "BUDGET_MODE_DAY", daily_budget_usd: editorDaily } as LaunchDraft["tiktok_settings"];
  const updateTikTokSettings = (value: LaunchDraft["tiktok_settings"]) => {
    let daily = draft.daily_budget_cents;
    if (value.budget_mode === "BUDGET_MODE_TOTAL") daily = null;
    else if (daily === null || value.daily_budget_usd !== editorDaily) daily = Math.round((value.daily_budget_usd ?? 20) * 100 * (value.duplicate_copies + 1));
    setDraft((d) => ({ ...d, tiktok_settings: value, daily_budget_cents: daily, start_paused: value.start_paused }));
    setPlan(null);
  };

  async function save(preview = false) {
    setBusy(true); setError("");
    try {
      const result = run
        ? await call<{ run: LaunchRun }>(`${base}/${run.id}`, "PUT", { draft, revision: run.revision })
        : await call<{ run: LaunchRun }>(base, "POST", { draft, ...(staff && producerId ? { producer_id: producerId } : {}) });
      setRun(result.run);
      if (preview) {
        const p = await call<{ plan: LaunchPlan }>(`${base}/${result.run.id}/preview`, "POST");
        setPlan(p.plan);
      } else router.replace(`${pageBase}/${result.run.id}`);
      return result.run;
    } catch (e) { setError(errorText(e)); return null; }
    finally { setBusy(false); }
  }
  async function prepareLaunch() {
    if (busy) return;
    if (!canLaunch) { setError(tt("lv2.needsApprover")); return; }
    const saved = await save(true);
    if (saved) { setConfirmError(""); setConfirmOpen(true); }
  }
  function requestLaunch() {
    setError("");
    if (!run || !plan) { setError(tt("launchFeedback.previewFirst")); return; }
    if (!canLaunch) { setError(tt("lv2.needsApprover")); return; }
    setConfirmError("");
    setConfirmOpen(true);
  }
  async function launch() {
    if (submitting.current) return;
    if (!run || !plan) { setConfirmError(tt("launchFeedback.previewFirst")); return; }
    if (!canLaunch) { setConfirmError(tt("lv2.needsApprover")); return; }
    if (staff && !note.trim()) { setConfirmError(tt("launchFeedback.noteRequired")); return; }
    setConfirmOpen(false);
    submitting.current = true;
    setBusy(true); setError("");
    try {
      const result = await call<{ run: LaunchRun }>(`${base}/${run.id}/launch`, "POST", { revision: run.revision, ...(staff ? { note } : {}) });
      setRun(result.run); setPlan(null); router.push(`${staff ? "/promote/monitor" : "/producer/monitor"}?run=${encodeURIComponent(result.run.id)}`);
    } catch (e) { setError(errorText(e)); }
    finally { submitting.current = false; setBusy(false); }
  }
  async function newRound() {
    if (!run) return;
    setBusy(true); setError("");
    try { const r = await call<{ run: LaunchRun }>(`${base}/${run.id}/round`, "POST"); router.push(`${pageBase}/${r.run.id}`); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  const canEdit = workspace?.can_edit ?? false;
  const canLaunch = workspace?.can_launch ?? false;
  const posted = !!run && run.status !== "draft";
  if (runId && (loadedRunId !== runId || runLoadFailed)) return <div className="launch-flow">
    <div className="page-head"><h1>{tt("lv2.launch.title")}</h1></div>
    {runLoadFailed ? <p className="note note-warn" role="alert" tabIndex={-1} ref={errorBox}>{error}</p> : <p>{tt("common.loading")}</p>}
    <Link className="btn btn-outline" href={pageBase}>{tt("lv2.launch.title")}</Link>
  </div>;
  return <div className="launch-flow">
    <div className="page-head"><div><h1>{tt("lv2.launch.title")}</h1><p className="page-sub">{tt("lv2.launch.sub")}</p></div><div className="rs-tool-row"><Link className="btn btn-outline" href={staff ? "/promote/monitor" : "/producer/monitor"}>{tt("lv2.monitor.title")}</Link></div></div>
    {staff && <div className="rs-panel"><label>{tt("lv2.producerId")} <select className="select" value={producerId} onChange={(e) => { setWorkspace(null); setRun(null); setError(""); setBusinessId(""); setDraft((d) => ({ ...d, account_ids: [], content: [] })); setCodesRaw(""); setPlan(null); setProducerId(e.target.value); }} disabled={!!runId || busy}><option value="">{tt("lv2.choose")}</option>{producers.map((p) => <option key={p.id} value={p.id}>{p.name_en || p.name_zh}</option>)}</select></label>{run && <p className="hint">{tt("lv2.onBehalf")}: {run.producer_id}</p>}</div>}
    {posted ? <section className="rs-panel"><h2>{run.draft.name}</h2><p>{tt("lv2.status")}: {run.status} · {tt("lv2.round")} {run.round} · {tt("lv2.signedBy")} {run.approved_by ?? "—"} · {run.approved_at ? new Date(run.approved_at).toLocaleString() : "—"}</p><p>{tt("lv2.budget")}: {money(run.draft.total_budget_cents)} · {tt("lv2.campaigns")}: {run.campaigns.length}</p><div className="rs-tool-row"><Link className="btn btn-primary" href={`${staff ? "/promote/monitor" : "/producer/monitor"}?run=${run.id}`}>{tt("lv2.monitor.open")}</Link><button className="btn btn-outline" disabled={busy} onClick={() => void newRound()}>{tt("lv2.round.new")}</button></div>{error && <p className="note note-warn" role="alert" tabIndex={-1} ref={errorBox}>{error}</p>}</section> : <>
      <fieldset className="launch-edit-region" disabled={busy}><section className="rs-panel"><h2>1. {tt("lv2.provider")}</h2><div className="seg"><button className={`seg-btn${draft.provider === "tiktok" ? " on" : ""}`} onClick={() => setProvider("tiktok")} disabled={!!run}>TikTok</button><button className={`seg-btn${draft.provider === "meta" ? " on" : ""}`} onClick={() => setProvider("meta")} disabled={!!run}>Meta · Facebook / Instagram</button></div></section>
      <section className="rs-panel"><h2>2. {tt("lv2.accounts")}</h2>
  <label className="launch-bc-picker">{tt(draft.provider === "meta" ? "launchRedesign.businessPortfolio" : "launchRedesign.businessCenter")}<select className="select" value={staff && !producerId || !workspace ? "" : chosenBusinessId} disabled={staff && !producerId || !workspace || !businessCenters.length} onChange={(e) => { setBusinessId(e.target.value); update("account_ids", []); }}><option value="">{tt(businessPlaceholder)}</option>{businessCenters.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
  {businessCenters.length > 0 && !chosenBusinessId && <p className="hint">{tt(draft.provider === "meta" ? "launchRedesign.selectPortfolioFirst" : "launchRedesign.selectBusinessFirst")}</p>}
  {(workspace as LaunchWorkspace & { account_warnings?: string[] } | null)?.account_warnings?.map((warning, i) => <p className="note note-warn" role="alert" key={i}>{warning}</p>)}
  {(!businessCenters.length || chosenBusinessId) && <LaunchAccountPicker key={`${draft.provider}:${producerId}:${chosenBusinessId}`} connections={connections.filter(c => inChosenBusiness(c.business_id))} selectedIds={draft.account_ids} onSelectionChange={ids => update("account_ids", ids)} provider={draft.provider} base={base} producerId={producerId} staff={staff} />}
</section>
      <section className="rs-panel"><h2>3. {tt("lv2.content")}</h2>
        <div className="launch-quantity-grid"><label htmlFor="lv2-per-account">{tt("lv2.campaignsPerAccount")}<input id="lv2-per-account" className="input tk-num" type="number" min={1} value={draft.campaigns_per_account} onChange={(e) => update("campaigns_per_account", Math.max(1, Number(e.target.value) || 1))} /></label><label htmlFor="lv2-per-campaign">{draft.provider === "tiktok" ? tt("launchRedesign.sparksPerCampaign") : tt("lv2.contentPerCampaign")}<input id="lv2-per-campaign" className="input tk-num" type="number" min={1} value={draft.content_per_campaign} onChange={(e) => update("content_per_campaign", Math.max(1, Number(e.target.value) || 1))} /></label></div>
        <div className="seg"><button className={`seg-btn${draft.allocation === "unique" ? " on" : ""}`} onClick={() => update("allocation", "unique")}>{tt("lv2.unique")}</button><button className={`seg-btn${draft.allocation === "shared" ? " on" : ""}`} onClick={() => update("allocation", "shared")}>{tt("lv2.shared")}</button></div>
        <p className="hint">{draft.allocation === "unique" ? tt(draft.provider === "meta" ? "launchRedesign.metaUniqueExplainer" : "launchRedesign.uniqueExplainer") : tt(draft.provider === "meta" ? "launchRedesign.metaSharedExplainer" : "launchRedesign.sharedExplainer")}</p>
        <div className={`launch-spark-count${available === required && required > 0 ? " ready" : ""}`} role="status"><strong>{available} / {required}</strong><span>{draft.provider === "tiktok" ? tt("launchRedesign.sparkCount") : tt("launchRedesign.creativeCount")}</span><small>{draft.allocation === "unique" ? tt(draft.provider === "meta" ? "launchRedesign.metaUniqueMath" : "launchRedesign.uniqueMath", { perCampaign: draft.content_per_campaign, perAccount: draft.campaigns_per_account * draft.content_per_campaign, total: required, campaignsPerAccount: draft.campaigns_per_account, accounts: draft.account_ids.length }) : tt(draft.provider === "meta" ? "launchRedesign.metaSharedMath" : "launchRedesign.sharedMath", { perCampaign: draft.content_per_campaign, campaigns })}</small></div>
        {draft.provider === "tiktok" ? <><label className="tk-label" htmlFor="lv2-codes">{tt("lv2.codes")}</label><textarea id="lv2-codes" className="input" rows={5} value={codesRaw} onChange={(e) => setCodes(e.target.value)} placeholder={tt("lv2.codesHint")} /><p className="hint">{tt("lv2.manualTikTok")}</p></> : <p className="hint">{tt("lv2.metaHint")}</p>}
      {draft.provider === "tiktok" ? <Link href="/producer/clips">{tt("lv2.clips.title")}&nbsp;→</Link> : <><div className="tk-field tk-row"><select className="select" value={postKind} onChange={(e) => setPostKind(e.target.value as "facebook_post" | "instagram_post")} aria-label={tt("lv2.postType")}><option value="facebook_post">Facebook post</option><option value="instagram_post">Instagram post</option></select><input className="input" value={postValue} onChange={(e) => setPostValue(e.target.value)} placeholder={postKind === "facebook_post" ? "pageID_postID" : "Instagram media ID"} aria-label={tt("lv2.postId")} /><button className="btn btn-outline" disabled={!postValue.trim()} onClick={() => { if (postValue.trim()) { const value = postValue.trim(); if (!draft.content.some((item) => item.kind === postKind && item.value === value)) update("content", [...draft.content, { kind: postKind, value }]); setPostValue(""); } }}>{tt("lv2.addPost")}</button></div><div className="tk-chips">{draft.content.filter((x) => x.kind !== "video").map((item) => <button className="filter-chip on" key={`${item.kind}:${item.value}`} onClick={() => toggleContent(item)}>{item.kind}: {item.value} ×</button>)}{(workspace?.library ?? []).filter((x) => x.kind === "video").map((item) => <label key={item.id} className="filter-chip"><input type="checkbox" checked={draft.content.some((x) => x.kind === item.kind && x.value === item.value)} onChange={() => toggleContent({ kind: item.kind, value: item.value, creative_id: item.creative_id, title_id: item.title_id, label: `${item.title_name} · ${item.label ?? item.value}` })} /> {item.title_name} · {item.label ?? item.value}</label>)}</div>{draft.content.map((item) => <div className="tk-field tk-row" key={`${item.kind}:${item.value}`}><strong>{item.label ?? item.value}</strong><label>{tt("lv2.primaryText")} <input className="input" value={item.text ?? ""} onChange={(e) => setContentField(item, "text", e.target.value)} /></label><label>{tt("lv2.headline")} <input className="input" value={item.headline ?? ""} onChange={(e) => setContentField(item, "headline", e.target.value)} /></label></div>)}</>}</section>
      <section className="rs-panel"><h2>4. {tt("lv2.delivery")}</h2><div className="tk-field tk-row"><label htmlFor="lv2-name">{tt("lv2.name")}</label><input id="lv2-name" className="input" value={draft.name} onChange={(e) => update("name", e.target.value)} /><label htmlFor="lv2-dest">{tt("lv2.destination")}</label><input id="lv2-dest" className="input" type="url" value={draft.destination_url} onChange={(e) => update("destination_url", e.target.value)} placeholder="https://" /></div><div className="tk-field tk-row"><label htmlFor="lv2-total">{tt("lv2.budget")}</label><input id="lv2-total" className="input tk-num" type="number" min={1} step="0.01" value={draft.total_budget_cents / 100} onChange={(e) => update("total_budget_cents", Math.round((Number(e.target.value) || 0) * 100))} /><label htmlFor="lv2-daily">{tt("lv2.dailyTotal")}</label><input id="lv2-daily" className="input tk-num" type="number" min={0} step="0.01" value={draft.daily_budget_cents == null ? "" : draft.daily_budget_cents / 100} onChange={(e) => update("daily_budget_cents", e.target.value === "" ? null : Math.round(Number(e.target.value) * 100))} /></div><p className="hint">{tt("lv2.budgetMath", { campaigns, share: campaigns ? money(Math.floor(draft.total_budget_cents / campaigns)) : "—" })}</p><label className="tk-check"><input type="checkbox" checked={draft.start_paused} onChange={(e) => update("start_paused", e.target.checked)} /> {tt("lv2.startPaused")}</label></section>
      <section className="rs-panel"><h2>5. {tt("lv2.settings")}</h2>{draft.provider === "tiktok" ? <><LaunchPresetPicker value={editorSettings} onSelect={(v) => updateTikTokSettings({ ...v, start_paused: draft.start_paused })} />{draft.tiktok_settings.objective_type === "WEB_CONVERSIONS" && <InstantPageTemplatePicker value={draft.tiktok_settings.instant_page_template} onChange={template => update("tiktok_settings", { ...draft.tiktok_settings, instant_page_template: template })} />}<button className="btn btn-outline" onClick={() => setSettingsOpen(!settingsOpen)}>{settingsOpen ? tt("lv2.hideSettings") : tt("lv2.customize")}</button><p className="hint">{summarizeLaunchSettings(editorSettings).join(" · ")}</p>{settingsOpen && <LaunchSettingsDialog value={editorSettings} onChange={updateTikTokSettings} budgetUsd={campaigns ? draft.total_budget_cents / 100 / campaigns : 0} regionsEndpoint={staff ? "/api/admin/tiktok/regions" : "/api/producer/tiktok/regions"} onClose={closeSettings} />}</> : <div className="tk-field tk-row"><label>{tt("lv2.countries")} <input className="input" value={draft.meta_settings.countries.join(", ")} onChange={(e) => update("meta_settings", { ...draft.meta_settings, countries: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label><label>{tt("lv2.placements")} <select className="select" value={draft.meta_settings.placements.join(",")} onChange={(e) => update("meta_settings", { ...draft.meta_settings, placements: e.target.value.split(",") as ("facebook" | "instagram")[] })}><option value="facebook,instagram">Facebook + Instagram</option><option value="facebook">Facebook</option><option value="instagram">Instagram</option></select></label><label>{tt("lv2.goal")} <select className="select" value={draft.meta_settings.optimization_goal} onChange={(e) => update("meta_settings", { ...draft.meta_settings, optimization_goal: e.target.value as "LINK_CLICKS" | "LANDING_PAGE_VIEWS" })}><option value="LINK_CLICKS">Link clicks</option><option value="LANDING_PAGE_VIEWS">Landing page views</option></select></label><label>{tt("lv2.cta")} <select className="select" value={draft.meta_settings.call_to_action} onChange={(e) => update("meta_settings", { ...draft.meta_settings, call_to_action: e.target.value as "LEARN_MORE" | "WATCH_MORE" })}><option value="LEARN_MORE">Learn more</option><option value="WATCH_MORE">Watch more</option></select></label><label>{tt("lv2.bid")} <input className="input tk-num" type="number" min={0} step="0.01" value={draft.meta_settings.bid_cents == null ? "" : draft.meta_settings.bid_cents / 100} onChange={(e) => update("meta_settings", { ...draft.meta_settings, bid_cents: e.target.value === "" ? null : Math.round(Number(e.target.value) * 100), bid_strategy: e.target.value === "" ? "LOWEST_COST_WITHOUT_CAP" : "LOWEST_COST_WITH_BID_CAP" })} /></label><label>{tt("lv2.start")} <input className="input" type="datetime-local" value={localReady ? localDateTime(draft.meta_settings.start_time) : draft.meta_settings.start_time.slice(0, 16)} onChange={(e) => update("meta_settings", { ...draft.meta_settings, start_time: e.target.value ? new Date(e.target.value).toISOString() : "" })} /></label><label>{tt("lv2.end")} <input className="input" type="datetime-local" value={localReady ? localDateTime(draft.meta_settings.end_time) : draft.meta_settings.end_time.slice(0, 16)} onChange={(e) => update("meta_settings", { ...draft.meta_settings, end_time: e.target.value ? new Date(e.target.value).toISOString() : "" })} /></label><span className="hint">{tt("lv2.localTime")} ({localReady ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC"})</span></div>}</section>
      </fieldset><section className="rs-panel" aria-busy={busy}><h2>6. {tt("launchFeedback.reviewLaunch")}</h2>{!plan && <p className="hint">{tt("launchFeedback.launchHelp", { provider: draft.provider === "tiktok" ? "TikTok" : "Meta" })}</p>}{!workspace && !error && <p role="status">{tt("common.loading")}</p>}{workspace && !canEdit && <p className="note">{tt(staff && !producerId ? "launchFeedback.chooseProducer" : "launchFeedback.cannotEdit")}</p>}<div className="rs-tool-row">{!plan && <button type="button" className="btn btn-primary" disabled={busy || !workspace} onClick={() => void prepareLaunch()}>{busy ? tt("launchFeedback.preparing") : tt("launchFeedback.launchOn", { provider: draft.provider === "tiktok" ? "TikTok" : "Meta" })}</button>}<button className="btn btn-outline" disabled={busy || !canEdit} onClick={() => void save(false)}>{tt("lv2.save")}</button><button className="btn btn-outline" disabled={busy || !canEdit} onClick={() => void save(true)}>{busy ? tt("common.loading") : tt("lv2.preview")}</button></div>{plan && <><p>{run?.mode !== "production" && <span className="pill pill-accent">{tt(run?.mode === "sandbox" ? "lv2.sandbox" : "lv2.demo")}</span>}</p><p>{tt("lv2.planSummary", { count: plan.campaign_count, accounts: plan.account_count, total: money(plan.total_budget_cents), daily: money(plan.daily_total_cents) })}</p>{draft.provider === "tiktok" && draft.tiktok_settings.objective_type === "WEB_CONVERSIONS" && draft.tiktok_settings.instant_page_template && <p className="note">{tt("salesLaunch.sales")}: {draft.tiktok_settings.instant_page_template.name} · {tt("tipTemplates.button")}: {draft.tiktok_settings.instant_page_template.button_text} · {tt(`tipTemplates.background.${draft.tiktok_settings.instant_page_template.background}`)}{draft.tiktok_settings.instant_page_template.hand_cursor ? ` · ${tt("tipTemplates.handCursor")}` : ""}</p>}{plan.warnings.length > 0 && <div className="note"><ul>{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}<div className="gtable" style={{ "--cols": "48px minmax(180px,2fr) minmax(140px,1fr) minmax(200px,2fr) 110px" } as React.CSSProperties}><div className="gt-head"><span>#</span><span>{tt("lv2.campaign")}</span><span>{tt("lv2.account")}</span><span>{tt("lv2.content")}</span><span>{tt("lv2.campaignBudget")}</span></div>{plan.rows.map((row) => <div className="gt-row" key={row.index}><span>{row.index}</span><span>{row.name}{row.campid && <small className="gt-muted">{tt("salesLaunch.campid")}: {row.campid}</small>}{row.tracking_url && <small className="gt-muted">{tt("salesLaunch.tracking")}: {row.tracking_url}</small>}</span><span>{row.advertiser_id}</span><span>{row.content.map((x) => x.label ?? x.value).join(", ")}</span><span>{money(row.budget_cents)}</span></div>)}</div><p className="note">{tt("lv2.feeLine", feeLineVars(plan.total_budget_cents / 100))}</p>{draft.provider === "meta" && <div className="rs-panel"><p>{tt("lv2.destination")}: {draft.destination_url} · {draft.meta_settings.countries.join(", ")} · {draft.meta_settings.placements.join(" / ")} · {draft.meta_settings.optimization_goal} · {draft.meta_settings.call_to_action}</p>{plan.rows.map((row) => { const account = connections.find((x) => x.id === row.connection_id); return <article key={row.index} className="rs-panel"><strong>{row.name}</strong><p>{account?.name ?? "—"} · Facebook Page {account?.page_id ?? "—"} · Instagram {account?.instagram_id ?? "—"}</p>{row.content.map((item, i) => { const asset = workspace?.library.find((x) => x.id === item.value); return <div key={`${item.kind}:${item.value}:${i}`} className="tk-field"><strong>{item.label ?? asset?.label ?? item.kind}</strong><p>{tt("lv2.primaryText")}: {item.text ?? asset?.text ?? "—"}</p><p>{tt("lv2.headline")}: {item.headline ?? asset?.headline ?? "—"}</p>{asset?.media_url ? <video src={asset.media_url} controls playsInline preload="metadata" style={{ maxWidth: 180, aspectRatio: "9 / 16" }} /> : <p className="hint">{tt("lv2.existingPostMedia")}: {item.value}</p>}</div>; })}</article>; })}</div>}<button className="btn btn-approve" disabled={busy} onClick={requestLaunch}>{busy ? tt("launchFeedback.submitting") : tt("lv2.launchButton", { count: plan.campaign_count, state: draft.start_paused ? tt("lv2.paused") : tt("lv2.live") })}</button>{!canLaunch && <p className="hint">{tt("lv2.needsApprover")}</p>}</>}{error && <p className="note note-warn" role="alert" tabIndex={-1} ref={errorBox}>{error}</p>}</section>
    </>}
    {confirmOpen && plan && <LaunchConfirmDialog name={draft.name} plan={plan} destination={draft.destination_url} startPaused={draft.start_paused} provider={draft.provider} mode={run?.mode ?? "fake"} accountNames={Object.fromEntries(connections.map(c => [c.id, c.name]))} pageDesign={draft.provider === "tiktok" && draft.tiktok_settings.objective_type === "WEB_CONVERSIONS" ? draft.tiktok_settings.instant_page_template : undefined} staff={staff} note={note} onNoteChange={value => { setNote(value); setConfirmError(""); }} error={confirmError} onClose={closeConfirm} onConfirm={() => void launch()} />}
  </div>;
}
