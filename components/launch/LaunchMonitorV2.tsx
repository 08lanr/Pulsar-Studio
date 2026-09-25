"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import { call, int, usd } from "@/components/tiktok/api";
import { adLandingUrl, splitBudget } from "@/lib/launch/plan";
import { adTitleId, adsOfContent, campaignTitleIds, contentNumbers, resultsByTitle, runTitleIds, totalsOf, type Totals } from "@/lib/launch/title-stats";
import AdCard, { type AdCardProps } from "@/components/launch/AdCard";
import {
  adSetPlatforms, campaignPlatforms, explainProviderError, monitorState, needsFirstSweep,
  providerCampaignId, switchState, type AdPlatform, type MonitorState,
} from "@/lib/launch/provider-errors";
import type { DeliverySnapshot, LaunchCampaign, LaunchContent, LaunchControl, LaunchProvider, LaunchRun } from "@/lib/launch/types";
import type { AdOutcome } from "@/lib/crazydramas/stats-summary";
// app/monitor-round2.css is loaded by app/layout.tsx, immediately before polish.css.
import "@/app/launch-monitor.css";

const money = (cents: number | null | undefined) => usd(cents == null ? null : cents / 100);
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
/** "Sep 18, 7:38 PM" — an end time read at a glance, not a record of one. */
const shortDate = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/** The host alone: the campid printed beside it already says which campaign the link tags. */
const linkHost = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const skippedOf = (c: LaunchCampaign): unknown[] => {
  const value = c.state.skipped ?? c.state.skipped_sparks;
  return Array.isArray(value) ? value : [];
};
const ended = (c: LaunchCampaign) => c.snapshot?.delivery === "ended" || c.state.desired_status === "ended" || c.state.stop_applied === "ended";
/**
 * TikTok-attributed website conversions across the campaigns that read them
 * (Website purchases launches): counts and value summed, ROAS and cost per
 * purchase recomputed from the sums. Null when no campaign has them.
 */
function webTotals(campaigns: LaunchCampaign[]) {
  const withWeb = campaigns.filter(c => c.snapshot?.web);
  if (!withWeb.length) return null;
  const sum = (pick: (w: NonNullable<DeliverySnapshot["web"]>) => number | null) =>
    withWeb.every(c => pick(c.snapshot!.web!) != null) ? withWeb.reduce((n, c) => n + (pick(c.snapshot!.web!) ?? 0), 0) : null;
  const purchases = sum(w => w.purchases), value = sum(w => w.purchase_value_cents), checkouts = sum(w => w.checkouts);
  const spend = withWeb.every(c => c.snapshot?.spend_cents != null) ? withWeb.reduce((n, c) => n + (c.snapshot?.spend_cents ?? 0), 0) : null;
  return { purchases, value, checkouts, attribution: withWeb[0].snapshot!.web!.attribution,
    roas: spend && value != null ? (value / spend).toFixed(2) : null,
    costPerPurchase: spend != null && purchases ? Math.round(spend / purchases) : null };
}
const total = (campaigns: LaunchCampaign[], field: "spend_cents" | "clicks" | "conversions") =>
  campaigns.length && campaigns.every(c => c.snapshot?.[field] != null)
    ? campaigns.reduce((sum, c) => sum + (c.snapshot?.[field] ?? 0), 0) : null;
const reviewTone = (state: MonitorState) => ["failed", "rejected", "suspended"].includes(state) ? "error"
  : state === "live" ? "live" : ["review", "submitted"].includes(state) ? "review" : "neutral";

const PLATFORM_LABEL: Record<AdPlatform | "tiktok", string> = { facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok" };

/**
 * One card per ad the provider actually holds, drawn with the shared `AdCard`
 * so step 3, the preview table, the confirm dialog and this expanded row can
 * never describe the same ad differently: a post is its own platform's ad, and
 * an uploaded clip is one card badged with every platform whose ad set holds it.
 */
function adsOf(content: LaunchContent[], platforms: AdPlatform[], provider: string): (AdCardProps & { key: string })[] {
  return content.map((item, index) => {
    // The card's kind chip already names a post, so a label that only repeats
    // the ad's own words is dropped rather than printed twice.
    const caption = item.text ?? null;
    const base = {
      kind: item.kind, label: item.label && item.label !== caption ? item.label : "", caption,
      headline: item.headline ?? null, thumbnail_url: null, id: item.value, compact: true, key: `${index}-${item.kind}`,
    };
    if (provider === "tiktok" || item.kind === "spark") return { ...base, platform: "tiktok" as const };
    if (item.kind === "facebook_post") return { ...base, platform: "facebook" as const };
    if (item.kind === "instagram_post") return { ...base, platform: "instagram" as const };
    const on = platforms.length ? platforms : (["facebook"] as AdPlatform[]);
    return { ...base, platform: on[0], platforms: on };
  });
}

type AdStatus = NonNullable<DeliverySnapshot["ads"]>[number];
/**
 * The provider's own word for one ad's review, tinted the way the campaign's
 * state word is. Unknown vocabulary stays neutral rather than guessing a
 * verdict — a grey "limited" is honest, a green one is not.
 */
const adStatusTone = (status: string) => {
  const word = status.toLowerCase();
  if (/reject|disapprove|denied|fail/.test(word)) return "error";
  if (/review|pending|process|prepar/.test(word)) return "review";
  if (/approve|active|deliver/.test(word)) return "live";
  return "neutral";
};
const adStatusWord = (status: string) => status.replaceAll("_", " ").toLowerCase();
/**
 * Which provider ad belongs to which card, so an ad is described once instead
 * of twice. The content reference is the real join (a Spark code, a post id);
 * position is the fallback when the sweep recorded none. Anything else returns
 * null and the ads keep their own separate status strip.
 */
/**
 * The page one ad sends people to, with TikTok's click macros filled in from
 * our own launch record: what a tap on that ad opens (Ruobin, 2026-09-24:
 * "each ad displayed with its link, so I can click into it and check it").
 * The ad group is known only when the campaign has one; otherwise its macro
 * stays as TikTok received it.
 */
function adLandingLink(template: string | null | undefined, ids: { campaign?: string | null; adgroup?: string | null; ad?: string | null; provider?: LaunchProvider }): string | null {
  if (!template || !/^https:\/\//i.test(template)) return null;
  // The macros are TikTok's and TikTok fills them. Filling them ourselves on a
  // Meta link would build a source=tiktok URL that never existed, and a click
  // on it writes a false TikTok session into crazydramas.
  if (ids.provider && ids.provider !== "tiktok") return template;
  let url = template;
  if (ids.campaign) url = url.split("__CAMPAIGN_ID__").join(ids.campaign);
  if (ids.adgroup) url = url.split("__AID__").join(ids.adgroup);
  if (ids.ad) url = url.split("__CID__").join(ids.ad);
  return url;
}

function pairAds(cards: { id: string }[], ads: AdStatus[]): AdStatus[] | null {
  if (!cards.length || cards.length !== ads.length) return null;
  const byValue = new Map(ads.filter((ad) => ad.content_value).map((ad) => [ad.content_value!, ad]));
  if (byValue.size === ads.length && cards.every((card) => byValue.has(card.id))) return cards.map((card) => byValue.get(card.id)!);
  return ads;
}

/**
 * What the ad brought on crazydramas.com after the click (staff): real people (robots and the team left
 * out), episode 1 started / finished, episode 2 watched, paid, and what one episode 1 finisher cost. The
 * CrazyDramas stats page has the same numbers for every ad.
 */
function CdAdLine({ outcome, spendCents, tt }: { outcome: AdOutcome | null; spendCents: number | null; tt: (key: string, vars?: Record<string, string | number>) => string }) {
  if (!outcome || outcome.opened === 0) return <p className="lm-ad-cd lm-ad-cd-none" data-testid="ad-cd">{tt("mcd.none")} <a href="/crazydramas/stats#ads">{tt("mcd.stats")}&nbsp;›</a></p>;
  const perFinisher = spendCents != null && outcome.finished_ep1 > 0 ? money(Math.round(spendCents / outcome.finished_ep1)) : "—";
  return <p className="lm-ad-cd" data-testid="ad-cd">
    <span className="lm-ad-cd-label">{tt("mcd.label")}</span>
    <span>{tt("mcd.people")} <b>{int(outcome.opened)}</b></span>
    <span>{tt("mcd.started")} <b>{int(outcome.started_ep1)}</b></span>
    <span>{tt("mcd.finished")} <b>{int(outcome.finished_ep1)}</b></span>
    <span>{tt("mcd.ep2")} <b>{int(outcome.watched_ep2)}</b></span>
    <span>{tt("mcd.paid")} <b>{int(outcome.buyers)}</b></span>
    <span>{tt("mcd.perFinisher")} <b>{perFinisher}</b></span>
    <a href="/crazydramas/stats#ads">{tt("mcd.stats")}&nbsp;›</a>
  </p>;
}

/** One ad's own numbers in one line: what it cost and what it brought. */
function AdNumbers({ totals, tt }: { totals: Totals; tt: (key: string, vars?: Record<string, string | number>) => string }) {
  const pct = totals.ctr === null ? "—" : `${(totals.ctr * 100).toFixed(2)}%`;
  return <span className="lm-ad-numbers" data-testid="ad-stats">
    <span>{tt("lv2.spent")} <b>{money(totals.spend_cents)}</b></span>
    <span>{tt("mad.impressions")} <b>{int(totals.impressions)}</b></span>
    <span>{tt("lv2.clicks")} <b>{int(totals.clicks)}</b></span>
    <span>CTR <b>{pct}</b></span>
    <span>{tt("lv2.cpc")} <b>{money(totals.cpc_cents)}</b></span>
    {totals.purchases !== null && <>
      <span>{tt("lpx.purchases")} <b>{int(totals.purchases)}</b></span>
      <span>{tt("lpx.value")} <b>{money(totals.value_cents)}</b></span>
      <span>{tt("lpx.roas")} <b>{totals.roas ?? "—"}</b></span>
      <span>{tt("lpx.costPerPurchase")} <b>{money(totals.cost_per_purchase_cents)}</b></span>
    </>}
    {/* The number an InitiateCheckout-optimised ad is optimised on (2026-09-24). */}
    {totals.checkouts !== null && <>
      <span>{tt("lpx.checkouts")} <b>{int(totals.checkouts)}</b></span>
      <span>{tt("mad.costPerCheckout")} <b>{money(totals.cost_per_checkout_cents)}</b></span>
    </>}
  </span>;
}

type EditKind = "budget" | "daily_budget" | "bid" | "schedule" | "end";
type Edit = { run: LaunchRun; campaign: LaunchCampaign; kind: EditKind };

export default function LaunchMonitorV2({ staff = false, focusId, embedded = false, initialView = "launches" }: { staff?: boolean; focusId?: string; embedded?: boolean; initialView?: "launches" | "titles" }) {
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
  // The titles the launches promote (by name), the Title filter, and whether
  // the page shows the launches or the "By title" table.
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [titleFilter, setTitleFilter] = useState("all");
  const [view, setView] = useState<"launches" | "titles">(initialView);
  const [renaming, setRenaming] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  // Staff: what each TikTok ad brought on crazydramas.com (people, episode 1, episode 2, paid), by ad id,
  // from the CrazyDramas stats (2026-09-24). Loaded once, beside the launches; missing is simply not shown.
  const [cdAds, setCdAds] = useState<Record<string, AdOutcome> | null>(null);
  useEffect(() => {
    if (!staff) return;
    let stop = false;
    void fetch("/api/admin/crazydramas/ad-outcomes", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { ok?: boolean; ads?: Record<string, AdOutcome> } | null) => {
        if (!stop && j?.ok && j.ads) setCdAds(j.ads);
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, [staff]);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRename = useRef(false);
  const sweptOnce = useRef(false);
  const busyRef = useRef("");
  busyRef.current = busy;

  const refresh = useCallback(async (force = false) => {
    const url = staff ? `${api}${force ? "?force=1" : ""}` : `/api/producer/monitor${force ? "?force=1" : ""}`;
    const r = await call<{ runs: LaunchRun[]; titles?: { id: string; name: string }[]; can_edit: boolean; can_launch: boolean; producers?: { id: string; name_zh: string; name_en: string | null }[] }>(url);
    setRuns(r.runs);
    setTitles(Object.fromEntries((r.titles ?? []).map((t) => [t.id, t.name])));
    setError("");
    setLoading(false);
    setCapabilities({ can_edit: r.can_edit, can_launch: r.can_launch });
    setProducers(Object.fromEntries((r.producers ?? []).map((p) => [p.id, p.name_en || p.name_zh])));
  }, [api, staff]);
  const refreshDelivery = useCallback(async () => {
    setRefreshing(true);
    try { await refresh(true); } catch (e) { setError(message(e)); } finally { setRefreshing(false); }
  }, [refresh]);
  useEffect(() => { void refresh().catch((e) => { setError(message(e)); setLoading(false); }); }, [refresh]);
  // A launch nobody has swept reads "Not checked yet" for as long as this
  // sweep takes and no longer: it starts as soon as the first list lands.
  useEffect(() => {
    if (loading || sweptOnce.current) return;
    if (!runs.some((r) => r.status !== "draft" && needsFirstSweep(r.campaigns))) return;
    sweptOnce.current = true;
    void refreshDelivery();
  }, [loading, runs, refreshDelivery]);
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

  const visible = useMemo(() => runs
    .filter((r) => !focused || !focusId || r.id === focusId || r.external_id === focusId)
    .filter((r) => provider === "all" || r.draft.provider === provider)
    .filter((r) => titleFilter === "all" || runTitleIds(r).includes(titleFilter))
    .filter((r) => filter === "all" || (filter === "active" ? r.campaigns.some((c) => ["live", "review", "submitted"].includes(monitorState(c))) : r.status === filter))
    .filter((r) => !query.trim() || [r.draft.name, r.external_id, producers[r.producer_id], ...r.campaigns.flatMap((c) => [c.name, c.campid, c.advertiser_id, providerCampaignId(c)]), ...(r.connections ?? []).flatMap((c) => [c.name, c.advertiser_id])].some((x) => x?.toLowerCase().includes(query.trim().toLowerCase())))
    .sort((a, b) => b.created_at.localeCompare(a.created_at)), [runs, focused, focusId, provider, filter, query, producers, titleFilter]);
  const titleName = (id: string | null | undefined) => (id ? titles[id] ?? tt("mad.unknownTitle") : null);
  const titleOptions = useMemo(() => Object.entries(titles).filter(([id]) => runs.some((r) => runTitleIds(r).includes(id))).sort((a, b) => a[1].localeCompare(b[1])), [titles, runs]);
  const byTitle = useMemo(() => view === "titles" ? resultsByTitle(runs.filter((r) => provider === "all" || r.draft.provider === provider)) : [], [view, runs, provider]);
  const titleHref = (id: string) => `${staff ? "/promote/monitor/titles" : "/producer/monitor/titles"}/${id}`;
  /** TikTok's own preview of one launched ad, through Studio (lib/launch/tiktok-posts.ts): the ad as TikTok shows it, whatever it was made from. */
  const adPreviewHref = (runId: string, adId: string) => `${api}/${encodeURIComponent(runId)}/ads/${encodeURIComponent(adId)}/preview`;

  async function action(run: LaunchRun, suffix: "retry" | "round") {
    setBusy(`${run.id}:${suffix}`); setActionError((x) => ({ ...x, [run.id]: "" }));
    try {
      const result = await call<{ run: LaunchRun }>(`${api}/${run.id}/${suffix}`, "POST");
      if (suffix === "round") router.push(`${page}/${result.run.id}`);
      else await refresh(true);
    } catch (e) { setActionError((x) => ({ ...x, [run.id]: message(e) })); }
    finally { setBusy(""); }
  }
  async function saveName(run: LaunchRun) {
    const value = nameDraft.trim();
    setRenaming("");
    if (!value || value === run.draft.name) return;
    setBusy(`${run.id}:rename`); setActionError((x) => ({ ...x, [run.id]: "" }));
    try { await call(`${api}/${run.id}/rename`, "PUT", { name: value }); await refresh(); }
    catch (e) { setActionError((x) => ({ ...x, [run.id]: message(e) })); }
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

  /** The hint first, the provider's own sentence beneath, then Retry. */
  function failure(run: LaunchRun, text: string, key: string) {
    const { hint, code } = explainProviderError(run.draft.provider, text);
    const providerName = run.draft.provider === "meta" ? "Meta" : "TikTok";
    return <div className="note note-warn mr2-failure" role="alert" data-failure={key}>
      {hint && <p className="mr2-hint">{tt(hint)}</p>}
      <p className="mr2-said">{code ? <><span>{tt("mr2.providerSaid", { provider: providerName })}</span> {text}</> : text}</p>
      {capabilities.can_launch && run.status === "failed" && <button className="lm-row-button" disabled={!!busy} onClick={() => void action(run, "retry")}>{tt("lv2.retry")}</button>}
    </div>;
  }

  return <div className="launch-flow lm" id="launch-monitor">
    <div className="page-head"><div><h1>{tt("lv2.monitor.title")}</h1><p className="page-sub">{tt("monitorV2.subtitle")}</p></div><div className="rs-tool-row">{!embedded && <Link className="btn btn-outline" href={page}>{tt("launchFeedback.createLaunch")}</Link>}<button className="btn btn-outline" disabled={!!busy || refreshing} onClick={() => void refreshDelivery()}>{tt(refreshing ? "common.loading" : "lv2.refresh")}</button></div></div>
    {error && <p className="note note-warn" role="alert">{error}</p>}
    {focusId && focused && <div className="lm-focus"><span>{tt("monitorV2.focused")}</span><button className="btn btn-outline btn-sm" onClick={() => setFocused(false)}>{tt("monitorV2.showAll")}</button></div>}
    {/* Two ways to read the same launches: one by one, or added up per title. */}
    <div className="seg lm-view" role="group" aria-label={tt("mad.view")}>
      <button type="button" className={`seg-btn${view === "launches" ? " on" : ""}`} aria-pressed={view === "launches"} onClick={() => setView("launches")}>{tt("mad.viewLaunches")}</button>
      <button type="button" className={`seg-btn${view === "titles" ? " on" : ""}`} aria-pressed={view === "titles"} onClick={() => setView("titles")}>{tt("mad.viewTitles")}</button>
    </div>
    {view === "titles" ? <section className="lm-by-title" aria-label={tt("mad.byTitle")}>
      <p className="hint">{tt("mad.byTitleHint")}</p>
      {/* The one filter that applies here, shown where it narrows the totals (it is never a hidden filter). */}
      <div className="lm-filters" aria-label={tt("monitorV2.filters")}>
        <label>{tt("monitorV2.provider")}<select value={provider} onChange={(e) => setProvider(e.target.value)} data-testid="by-title-provider"><option value="all">{tt("monitorV2.all")}</option><option value="tiktok">TikTok</option><option value="meta">Meta</option></select></label>
      </div>
      {loading ? <p>{tt("common.loading")}</p> : byTitle.length === 0 ? <div className="empty"><p>{tt("mad.byTitleEmpty")}</p></div> : <div className="lm-table-scroll"><table className="lm-table lm-title-table" data-testid="by-title-table">
        <colgroup><col className="lm-col-title" /><col className="lm-col-count" /><col className="lm-col-count" /><col className="lm-col-count" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /></colgroup>
        <thead><tr><th scope="col">{tt("mad.title")}</th><th scope="col">{tt("mad.launches")}</th><th scope="col">{tt("lv2.campaigns")}</th><th scope="col">{tt("mad.ads")}</th><th scope="col">{tt("lv2.spent")}</th><th scope="col">{tt("lv2.clicks")}</th><th scope="col">CTR</th><th scope="col">{tt("lv2.cpc")}</th><th scope="col">{tt("lpx.purchases")}</th><th scope="col">{tt("lpx.value")}</th><th scope="col">{tt("lpx.roas")}</th><th scope="col">{tt("lpx.costPerPurchase")}</th></tr></thead>
        <tbody>{byTitle.map((r) => <tr key={r.title_id} data-title-id={r.title_id}>
          <td><Link href={titleHref(r.title_id)} className="lm-title-link">{titleName(r.title_id)}</Link>{r.unattributed > 0 && <small className="lm-title-note">{tt("mad.unattributed", { n: r.unattributed })}</small>}{r.unattributed_meta > 0 && <small className="lm-title-note">{tt("mad.unattributedMeta", { n: r.unattributed_meta })}</small>}</td>
          <td className="lm-number">{r.launches}</td><td className="lm-number">{r.campaigns.length}</td><td className="lm-number">{r.ads}</td>
          <td className="lm-number">{money(r.totals.spend_cents)}</td><td className="lm-number">{int(r.totals.clicks)}</td>
          <td className="lm-number">{r.totals.ctr === null ? "—" : `${(r.totals.ctr * 100).toFixed(2)}%`}</td><td className="lm-number">{money(r.totals.cpc_cents)}</td>
          <td className="lm-number">{int(r.totals.purchases)}</td><td className="lm-number">{money(r.totals.value_cents)}</td>
          <td className="lm-number">{r.totals.roas ?? "—"}</td><td className="lm-number">{money(r.totals.cost_per_purchase_cents)}</td>
        </tr>)}</tbody>
      </table></div>}
    </section> : <>
    <div className="lm-filters" aria-label={tt("monitorV2.filters")}>
      <label>{tt("monitorV2.search")}<input value={query} onChange={(e) => setQuery(e.target.value)} type="search" placeholder={tt("monitorV2.searchPlaceholder")} /></label>
      <label>{tt("monitorV2.provider")}<select value={provider} onChange={(e) => setProvider(e.target.value)}><option value="all">{tt("monitorV2.all")}</option><option value="tiktok">TikTok</option><option value="meta">Meta</option></select></label>
      <label>{tt("mad.title")}<select value={titleFilter} onChange={(e) => setTitleFilter(e.target.value)} data-testid="monitor-title-filter"><option value="all">{tt("monitorV2.all")}</option>{titleOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      <label>{tt("monitorV2.status")}<select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">{tt("monitorV2.all")}</option><option value="active">{tt("monitorV2.active")}</option><option value="draft">{tt("lv2.plan.draft")}</option><option value="pending">{tt("lv2.run.pending")}</option><option value="running">{tt("lv2.run.running")}</option><option value="done">{tt("lv2.run.complete")}</option><option value="failed">{tt("lv2.run.failed")}</option></select></label>
      <span className="lm-count">{visible.length} {tt("monitorV2.runs")}</span>
    </div>
    {loading ? <p>{tt("common.loading")}</p> : visible.length === 0 ? <div className="empty"><p>{runs.length ? tt("monitorV2.noMatches") : tt("lv2.monitor.empty")}</p>{focused && <button className="btn btn-outline btn-sm" onClick={() => setFocused(false)}>{tt("monitorV2.showAll")}</button>}</div> : visible.map((run) => {
      const names = new Map(run.connections?.map(connection => [connection.id, connection.name]) ?? []);
      const spend = total(run.campaigns, "spend_cents");
      const clicks = total(run.campaigns, "clicks");
      const conversions = total(run.campaigns, "conversions");
      const swept = run.campaigns.some(c => c.snapshot);
      const activeCount = run.campaigns.filter(c => switchState(c.snapshot?.configured_status) === true).length;
      const averageCpc = spend != null && clicks ? Math.round(spend / clicks) : null;
      const web = webTotals(run.campaigns);
      const checked = run.campaigns.map(c => c.snapshot?.checked_at).filter((at): at is string => !!at).sort().at(-1);
      const renameBlocked = run.status === "running" || run.status === "pending";
      const providerName = run.draft.provider === "meta" ? "Meta" : "TikTok";
      return <section className="lm-run" key={run.id} data-run-id={run.external_id}>
        <header className="lm-run-head">
          <div className="lm-run-identity">
            <div className="lm-run-title">
              {renaming === run.id
                ? <input className="mr2-name-input" autoFocus aria-label={tt("mr2.launchName")} value={nameDraft} maxLength={80}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } else if (e.key === "Escape") { cancelRename.current = true; e.currentTarget.blur(); } }}
                    onBlur={() => { if (cancelRename.current) { cancelRename.current = false; setRenaming(""); return; } void saveName(run); }} />
                : <h2><Link href={`${page}/${run.id}`}>{run.draft.name}</Link></h2>}
              {capabilities.can_launch && renaming !== run.id && <button className="mr2-pencil" disabled={renameBlocked || !!busy}
                title={renameBlocked ? tt("mr2.renameWhileRunning") : tt("mr2.rename")} aria-label={tt("mr2.rename")}
                onClick={() => { setNameDraft(run.draft.name); setRenaming(run.id); }}>
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.1 2.9a1.4 1.4 0 0 1 2 2L6 12l-2.7.7.7-2.7 7.1-7.1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
              </button>}
              <span className="lm-run-status">{run.status === "draft" ? tt("lv2.plan.draft") : tt(`lv2.run.${run.status === "done" ? "complete" : run.status}`)}</span>
            </div>
            <div className="lm-eyebrow"><span>{providerName}</span>{runTitleIds(run).length > 0 && <span data-testid="run-titles">{runTitleIds(run).map((id) => titleName(id)).join(" · ")}</span>}{staff && <span>{producers[run.producer_id] ?? tt("monitorV2.producer")}</span>}<span>{tt("lv2.round")} {run.round}</span><span><time dateTime={run.created_at}>{date(run.created_at)}</time></span>{run.mode !== "production" && <span>{tt(run.mode === "fake" ? "lv2.demo" : "lv2.sandbox")}</span>}</div>
          </div>
          <div className="lm-head-actions"><Link className="lm-toolbar-button" href={`${page}/${run.id}`}>{run.status === "draft" ? tt("lv2.openDraft") : tt("monitorTable.openLaunch")}</Link>{capabilities.can_edit && <button className="lm-toolbar-button" disabled={!!busy} onClick={() => void action(run, "round")}>{tt("lv2.round.new")}</button>}{capabilities.can_launch && run.status === "failed" && <button className="lm-toolbar-button" disabled={!!busy} onClick={() => void action(run, "retry")}>{tt("lv2.retry")}</button>}</div>
        </header>
        <div className="lm-summary" aria-label={tt("monitorTable.launchTotals")}>
          <div><small>{tt("lv2.campaigns")}</small><strong>{swept ? activeCount : "—"}<span className="lm-stat-denominator"> / {run.campaigns.length}</span></strong><span className="lm-stat-hint">{tt("monitorTable.enabledCampaigns")}</span></div>
          <div><small>{tt("lv2.spent")} · {providerName}</small><strong>{money(spend)}</strong></div>
          <div><small>{tt("lv2.clicks")}</small><strong>{int(clicks)}</strong></div>
          <div><small>{tt("lv2.conversions")}</small><strong>{int(conversions)}</strong></div>
          <div><small>{tt("lv2.cpc")}</small><strong>{money(averageCpc)}</strong></div>
          <div><small>{tt(run.approved_at ? "monitorV2.approvedBudget" : "monitorTable.plannedBudget")}</small><strong>{money(run.draft.total_budget_cents)}</strong></div>
        </div>
        {/* TikTok's own attribution of crazydramas purchases, labelled as such:
            it is not crazydramas' click_id funnel and the two will not match. */}
        {web && <div className="lm-web-summary" data-testid="web-summary" aria-label={tt("lpx.attributed")} title={tt("lpx.webLine", { attribution: web.attribution })}>
          <div><small>{tt("lpx.purchases")} · {tt("lpx.attributed")}</small><strong>{int(web.purchases)}</strong></div>
          <div><small>{tt("lpx.value")}</small><strong>{money(web.value)}</strong></div>
          <div><small>{tt("lpx.roas")}</small><strong>{web.roas ?? "—"}</strong></div>
          <div><small>{tt("lpx.costPerPurchase")}</small><strong>{money(web.costPerPurchase)}</strong></div>
          <div><small>{tt("lpx.checkouts")}</small><strong>{int(web.checkouts)}</strong></div>
          <div><small>{tt("lpx.attribution")}</small><span className="lm-stat-hint">{web.attribution}</span></div>
        </div>}
        {/* The run-level sentence only earns its place when no campaign row
            explains the problem itself; one problem, one message, one Retry. */}
        {(actionError[run.id] || (run.error && !run.campaigns.some(c => c.error && !ended(c)))) && <div className="lm-run-error">{failure(run, actionError[run.id] || run.error || "", `run-${run.external_id}`)}</div>}
        {run.campaigns.length > 0 ? <div className="lm-table-scroll"><table className="lm-table" aria-label={tt("lv2.campaigns")}>
          <colgroup><col className="lm-col-state" /><col className="lm-col-campaign" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-metric" /><col className="lm-col-actions" /></colgroup>
          <thead><tr><th scope="col">{tt("lv2.state")}</th><th scope="col">{tt("lv2.campaign")}</th><th scope="col">{tt("lv2.spent")}</th><th scope="col">{tt("lv2.clicks")}</th><th scope="col">{tt("lv2.cpc")}</th><th scope="col">{tt("lv2.conversions")}</th><th scope="col">{tt("lv2.costPerConv")}</th><th scope="col">CTR</th><th scope="col"><span className="sr-only">{tt("lv2.actions")}</span></th></tr></thead>
          <tbody>{run.campaigns.filter(c => titleFilter === "all" || campaignTitleIds(run, c).includes(titleFilter)).map(c => {
            const active = switchState(c.snapshot?.configured_status);
            const state = monitorState(c);
            const switchKnown = active !== null;
            const canControl = capabilities.can_launch && c.status === "done" && !ended(c);
            const canEnd = capabilities.can_launch && run.status !== "draft" && !ended(c);
            const campaignId = providerCampaignId(c);
            const platforms = campaignPlatforms(run.draft, c);
            const groupPlatform = adSetPlatforms(c);
            const controlError = actionError[c.id] || c.error || (typeof c.state.control_error === "string" ? c.state.control_error : null);
            const ctr = c.snapshot?.impressions && c.snapshot.clicks != null ? `${(c.snapshot.clicks / c.snapshot.impressions * 100).toFixed(2)}%` : "—";
            const costPerConversion = c.snapshot?.conversions && c.snapshot.spend_cents != null ? money(Math.round(c.snapshot.spend_cents / c.snapshot.conversions)) : "—";
            const stateWord = state === "not_checked" ? tt("mr2.state.notChecked")
              : state === "created_paused" ? tt(`mr2.state.createdPaused.${run.draft.provider}`)
              : state === "waiting" ? tt("mr2.state.waiting")
              : tt(`lv2.delivery.${state}`);
            // The On/Off switch only exists once the provider holds a campaign;
            // a row that never launched, is ended, or is still preparing has
            // nothing to switch, so the pill is not drawn at all.
            const showSwitch = !!campaignId && !ended(c) && state !== "waiting";
            const cards = adsOf(c.content, platforms, run.draft.provider);
            // The budget lives in the "Change budget" dialog, not in the detail
            // row: printing the campaign total, its ceiling and its pacing said
            // the same money three times. The ad set still shows its own share,
            // because that is the amount the group out there is running on.
            const groups = c.snapshot?.groups ?? [];
            const groupsDaily = run.draft.provider === "meta"
              ? c.daily_budget_cents != null
              : run.draft.tiktok_settings.budget_mode === "BUDGET_MODE_DAY";
            const adStatuses = pairAds(cards, c.snapshot?.ads ?? []);
            return <Fragment key={c.id}>
              <tr className={`lm-campaign ${expanded[c.id] ? "is-expanded" : ""}`} data-campaign-id={c.id}>
                <td className="lm-state-cell">
                  {showSwitch && <button className={`lm-state-toggle ${active ? "is-on" : "is-off"}`} data-switch={switchKnown ? (active ? "on" : "off") : "unread"}
                    disabled={!!busy || !canControl || !switchKnown}
                    aria-label={switchKnown ? tt(active ? "monitorV2.pauseCampaign" : "monitorV2.resumeCampaign") : tt("mr2.switchPending")}
                    title={switchKnown ? tt(active ? "monitorV2.pauseCampaign" : "monitorV2.resumeCampaign") : tt("mr2.switchPending")}
                    onClick={() => { if (switchKnown && canControl) void control(run, c, { action: active ? "pause" : "resume" }); }}><i aria-hidden="true" />{tt(active ? "lv2.switchOn" : "lv2.switchOff")}</button>}
                  <span className={`lm-delivery lm-delivery-${reviewTone(state)}`} data-state={state}>{stateWord}</span>
                </td>
                <td className="lm-campaign-cell">
                  <button className="lm-campaign-name" aria-expanded={!!expanded[c.id]} aria-controls={`campaign-details-${c.id}`} onClick={() => setExpanded(x => ({ ...x, [c.id]: !x[c.id] }))}><svg className="lm-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>{run.draft.name} · {c.index}</button>
                  <div className="lm-account-line"><span>{names.get(c.connection_id) ?? tt("monitorV2.account")}</span>
                    <span className="mr2-badges">{(platforms.length ? platforms : (run.draft.provider === "tiktok" ? ["tiktok" as const] : [])).map(p => <span className={`mr2-badge ad-card-badge ad-card-badge-${p}`} key={p}>{PLATFORM_LABEL[p]}</span>)}</span>
                  </div>
                  <div className="lm-row-meta">{campaignTitleIds(run, c).length > 0 && <span className="lm-campaign-title" data-testid="campaign-title">{campaignTitleIds(run, c).map((id) => titleName(id)).join(" · ")}</span>}<span>{cards.length === 1 ? tt("mr2.adOne") : tt("mr2.adMany", { n: cards.length })}</span>{c.snapshot?.note && <span className="lm-provider-note" title={c.snapshot.note}>{c.snapshot.note}</span>}</div>
                </td>
                <td className="lm-number">{money(c.snapshot?.spend_cents)}</td><td className="lm-number">{int(c.snapshot?.clicks)}</td><td className="lm-number">{money(c.snapshot?.cpc_cents)}</td><td className="lm-number">{int(c.snapshot?.conversions)}</td><td className="lm-number">{costPerConversion}</td><td className="lm-number">{ctr}</td>
                <td><div className="lm-actions"><button className="lm-row-button" aria-expanded={!!expanded[c.id]} aria-controls={`campaign-details-${c.id}`} onClick={() => setExpanded(x => ({ ...x, [c.id]: !x[c.id] }))}>{expanded[c.id] ? tt("lv2.hide") : tt("lv2.details")}</button>{(canControl || canEnd) && <button data-monitor-menu className="lm-row-button lm-more" aria-expanded={menu === c.id} aria-label={tt("monitorV2.moreActions")} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenuPosition({ top: Math.max(12, Math.min(rect.bottom + 4, window.innerHeight - 300)), left: Math.max(12, Math.min(rect.right - 220, window.innerWidth - 232)) }); setMenu(menu === c.id ? "" : c.id); }}><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="13" cy="8" r="1.2" /></svg></button>}</div></td>
              </tr>
              {state === "waiting" && <tr className="lm-error-row"><td colSpan={9}><div className="note mr2-waiting" role="status">
                <p>{typeof c.state.waiting === "object" && c.state.waiting && "reason" in c.state.waiting ? String((c.state.waiting as { reason: string }).reason) : tt("mr2.waitingLine")}</p>
                <p className="hint">{tt("mr2.waitingLine")}</p>
                <button className="lm-row-button" disabled={!!busy || refreshing} onClick={() => void refresh(true)}>{tt("mr2.checkNow")}</button>
              </div></td></tr>}
              {controlError && !ended(c) && state !== "waiting" && <tr className="lm-error-row"><td colSpan={9}>{failure(run, controlError, `campaign-${c.index}`)}</td></tr>}
              {expanded[c.id] && <tr className="lm-detail-row"><td colSpan={9}><div className="lm-detail" id={`campaign-details-${c.id}`}>
                {groups.length > 0 && <div className="lm-groups">{groups.map((g, i) => {
                  // The driver names its ad set's platform; older rows are read back from what it recorded.
                  const platform = g.platform ?? groupPlatform[g.id] ?? (platforms.length === 1 ? platforms[0] : undefined);
                  const groupOn = switchState(g.status);
                  return <div className="lm-group mr2-group" key={g.id}>
                    <div className="lm-group-main">
                      <strong className="lm-group-name">{tt(run.draft.provider === "meta" ? "mr2.adSet" : "lv2.group")} {i + 1}</strong>
                      {platform && <span className={`mr2-badge ad-card-badge ad-card-badge-${platform}`}>{PLATFORM_LABEL[platform]}</span>}
                      <span>{groupOn === true ? tt("monitorV2.enabled") : groupOn === false ? tt("monitorV2.paused") : tt("mr2.state.notChecked")}</span>
                      {g.budget_cents != null && <span className="lm-group-money">{tt(groupsDaily ? "mr3.perDay" : "mr3.lifetime", { amount: money(g.budget_cents) })}</span>}
                      {g.bid_cents != null && <span className="lm-group-money">{tt("mr3.bidAmount", { amount: money(g.bid_cents) })}</span>}
                      {g.end_time && <span>{tt("mr3.endsAt", { when: shortDate(g.end_time) })}</span>}
                    </div>
                    <div className="lm-group-action">{canControl && run.draft.provider === "tiktok" && groupOn !== null
                      ? <button className="lm-row-button" disabled={!!busy} onClick={() => void control(run, c, { action: "group", group_id: g.id, enabled: groupOn === false })}>{tt(groupOn === true ? "monitorV2.pauseGroup" : "monitorV2.resumeGroup")}</button>
                      : null}</div>
                  </div>;
                })}</div>}
                {/* One row per ad: the same card every other screen draws, with
                    the provider's word for its review beside it. The Spark code
                    is the card's `title=` and `data-content-id`, never its text. */}
                <div className="mr2-ads" aria-label={tt("mr2.ads")}>{cards.length
                  ? cards.map(({ key, ...card }, i) => {
                    const item = c.content[i];
                    // The sweep's ad for this card: paired by position, else the
                    // first ad carrying its Spark code or post (copies included).
                    const ad = adStatuses?.[i] ?? (item ? adsOfContent(c, item)[0] : undefined);
                    // An ad with no picture of its own is one line named by its
                    // position ("Ad 1"), the same way the confirm dialog draws it.
                    const pictured = Boolean(card.thumbnail_url || card.media_url);
                    // Its own numbers, summed over its copies; its own title and link.
                    const numbers = item ? contentNumbers(c, item, run.draft.provider === "meta" ? "meta" : "tiktok") : null;
                    const adTitle = item ? titleName(adTitleId(run, item)) : null;
                    const link = adLandingLink(item ? adLandingUrl(item, run.draft.destination_url) : run.draft.destination_url, { campaign: campaignId, adgroup: groups.length === 1 ? groups[0].id : null, ad: ad?.id ?? null, provider: run.draft.provider });
                    return <div className="lm-ad" key={key}><div className="lm-ad-row">
                      <AdCard {...card} line={!pictured} fallbackName={pictured ? undefined : tt("lr3.adNumber", { n: i + 1 })} />
                      {ad && <span className={`lm-ad-state lm-ad-state-${adStatusTone(ad.status)}`} title={`${ad.id}${ad.note ? ` · ${ad.note}` : ""}`}>{adStatusWord(ad.status)}</span>}
                      {link ? <a className="lm-row-button lm-ad-link" href={link} target="_blank" rel="noreferrer" title={`${tt("mr4.landingHint")}\n${link}`} data-testid="ad-landing-link">{tt("mr4.landing")}</a> : null}
                      {ad && run.draft.provider === "tiktok" && <a className="lm-row-button lm-ad-link" href={adPreviewHref(run.id, ad.id)} target="_blank" rel="noreferrer" title={tt("ltc.watchHint")} data-testid="ad-watch">{tt("ltc.watch")}</a>}
                    </div>
                    <div className="lm-ad-facts">
                      {adTitle && <span className="lm-ad-title" data-testid="ad-title">{adTitle}</span>}
                      {numbers ? <AdNumbers totals={totalsOf(numbers)} tt={tt} /> : c.snapshot && run.draft.provider === "tiktok" && campaignId ? <span className="lm-ad-numbers-none">{tt(c.snapshot.ad_stats_error ? "mad.adStatsFailed" : "mad.adStatsNone")}</span> : null}
                      {ad && run.draft.provider === "tiktok" && <span className="lm-ad-id" title={tt("mad.adIdHint")}>{tt("mad.adId")} {ad.id}</span>}
                      {/* Which account it runs as, and whether its video stays off the profile, as TikTok's own ad record says. */}
                      {ad?.runs_as && <span className="lm-ad-runs-as" data-testid="ad-runs-as">{tt(ad.ads_only ? "ltc.runsAsAdsOnly" : "ltc.runsAs", { handle: ad.runs_as })}{ad.post_url ? <> · <a href={ad.post_url} target="_blank" rel="noreferrer" title={ad.ads_only ? tt("ltc.ownerPostHint") : undefined}>{tt(ad.ads_only ? "ltc.ownerPost" : "clipsPosting.openPost")}</a></> : null}</span>}
                    </div>
                    {staff && cdAds && ad && run.draft.provider === "tiktok" && <CdAdLine outcome={cdAds[ad.id] ?? null} spendCents={numbers ? totalsOf(numbers).spend_cents : null} tt={tt} />}
                    </div>;
                  })
                  : <p>{tt("mr2.noAds")}</p>}</div>
                {/* Only when the sweep's ads cannot be lined up with the cards
                    does the old strip come back, so nothing goes unsaid. */}
                {!adStatuses && c.snapshot?.ads && c.snapshot.ads.length > 0 && <div className="lm-ad-statuses">{c.snapshot.ads.map((ad, i) => { const link = adLandingLink(run.draft.destination_url, { campaign: campaignId, adgroup: groups.length === 1 ? groups[0].id : null, ad: ad.id, provider: run.draft.provider }); return <span key={ad.id} title={`${ad.id}${ad.note ? ` · ${ad.note}` : ""}`}><strong>{tt("monitorV2.ad")} {i + 1}</strong><span>{adStatusWord(ad.status)}</span>{link && <a className="lm-ad-link" href={link} target="_blank" rel="noreferrer" title={`${tt("mr4.landingHint")}\n${link}`}>{tt("mr4.landing")}</a>}{run.draft.provider === "tiktok" && <a className="lm-ad-link" href={adPreviewHref(run.id, ad.id)} target="_blank" rel="noreferrer" title={tt("ltc.watchHint")}>{tt("ltc.watch")}</a>}</span>; })}</div>}
                {/* The references a person only needs when they go looking. */}
                <div className="mr2-detail-links">
                  {c.campid && <span>{tt("mr3.ref.campid")} <code>{c.campid}</code></span>}
                  {c.tracking_url && <span><a href={c.tracking_url} target="_blank" rel="noreferrer" title={c.tracking_url} aria-label={tt("mr2.trackingLink")}>{linkHost(c.tracking_url)}</a></span>}
                  <span>{tt("mr3.ref.account")} <button className="lm-copy-id" title={tt("monitorTable.copyAccountId")} aria-label={tt("monitorTable.copyAccountIdValue", { id: c.advertiser_id })} onClick={() => void copyId(c.advertiser_id)}>{c.advertiser_id}{copied === c.advertiser_id ? <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3.2 3.2L13 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg> : <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5" y="4" width="8" height="9" rx="1" stroke="currentColor" strokeWidth="1.3" /><path d="M3 11H2V3a1 1 0 0 1 1-1h7v1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>}</button></span>
                  {campaignId && <span title={tt("monitorTable.platformCampaignId")}>{tt("mr3.ref.campaign")} <span className="lm-ref-id">{campaignId}</span></span>}
                </div>
                {c.snapshot?.web && <p className="hint lm-web-line" data-testid="web-conversions">{tt("lpx.webLine", { attribution: c.snapshot.web.attribution })}: {tt("lpx.purchases")} {int(c.snapshot.web.purchases)} · {tt("lpx.value")} {money(c.snapshot.web.purchase_value_cents)} · {tt("lpx.roas")} {c.snapshot.web.roas ?? "—"} · {tt("lpx.checkouts")} {int(c.snapshot.web.checkouts)}</p>}
                {c.snapshot?.web_error && <p className="hint">{tt("lpx.webUnavailable", { reason: c.snapshot.web_error })}</p>}
                {c.snapshot?.ad_stats_error && <p className="hint" data-testid="ad-stats-error">{tt("mad.adStatsUnavailable", { reason: c.snapshot.ad_stats_error })}</p>}
                {c.snapshot?.ad_web_error && !c.snapshot.ad_stats_error && <p className="hint" data-testid="ad-web-error">{tt("mad.adWebUnavailable", { reason: c.snapshot.ad_web_error })}</p>}
                {skippedOf(c).map((item, i) => <p className="note note-warn" key={i}>{typeof item === "string" ? item : JSON.stringify(item)}</p>)}
              </div></td></tr>}
              {menu === c.id && createPortal(<div data-monitor-menu className="lm-menu-list" style={{ top: menuPosition.top, left: menuPosition.left }}>{canControl && <><button onClick={() => openEdit(run, c, "budget")}>{tt("lv2.changeBudget")}</button>{c.daily_budget_cents != null && <button onClick={() => openEdit(run, c, "daily_budget")}>{tt("lv2.changeDaily")}</button>}<button onClick={() => openEdit(run, c, "bid")}>{tt("lv2.changeBid")}</button><button onClick={() => openEdit(run, c, "schedule")}>{tt("lv2.endDate")}</button>{run.draft.provider === "tiktok" && <button disabled={!!busy} onClick={() => void control(run, c, { action: "duplicate" })}>{tt("lv2.duplicate")}</button>}</>}{canEnd && <button className="lm-danger" onClick={() => openEdit(run, c, "end")}>{tt("monitorV2.endCampaign")}</button>}</div>, document.body)}
            </Fragment>;
          })}</tbody>
        </table></div> : <p className="lm-pending">{tt(run.status === "draft" ? "monitorTable.draftHint" : "monitorTable.creatingHint")}</p>}
        <footer className="lm-run-footer">
          {/* A launch with no campaigns has nothing to sweep, so it never says
              "not checked yet" — there is nothing out there to check. */}
          <span className="mr2-checked">{run.campaigns.length === 0
            ? tt("mr2.notLaunched")
            : checked
              ? <>{tt("lv2.lastChecked")}: <time dateTime={checked}>{date(checked)}</time></>
              : refreshing ? <><i className="mr2-spinner" aria-hidden="true" />{tt("mr2.sweeping")}</> : tt("mr2.state.notChecked")}</span>
          <details><summary>{tt("monitorTable.launchDetails")}</summary><div><span>{run.external_id}</span><span>{tt("monitorV2.approved")}: {date(run.approved_at)}</span>{run.approval_note && <p>{run.approval_note}</p>}</div></details>
        </footer>
      </section>;
    })}
    </>}
    <span className="sr-only" role="status">{copied ? tt("monitorTable.copied") : ""}</span>
    {edit && <div className="lm-dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setEdit(null); }}><div ref={dialogRef} tabIndex={-1} className="lm-dialog" role="dialog" aria-modal="true" aria-labelledby="lm-dialog-title"><h2 id="lm-dialog-title">{edit.kind === "end" ? tt("monitorV2.endCampaign") : edit.kind === "schedule" ? tt("lv2.endDate") : tt(edit.kind === "budget" ? "lv2.changeBudget" : edit.kind === "daily_budget" ? "lv2.changeDaily" : "lv2.changeBid")}</h2><p className="lm-meta">{edit.run.draft.name} · {edit.campaign.index}</p>{edit.kind === "end" ? <p>{tt("monitorV2.endWarning")}</p> : edit.kind === "schedule" ? <label>{tt("monitorV2.newEndDate")}<input autoFocus type="datetime-local" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></label> : <label>{tt(edit.kind === "budget" ? "lv2.campaignBudget" : edit.kind === "daily_budget" ? "lv2.campaignDaily" : "lv2.bid")}<input autoFocus type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>}{edit.kind === "budget" && <p className="lm-meta">{tt("monitorV2.approvedCeiling")}: {money(splitBudget(edit.run.draft.total_budget_cents, edit.run.draft.account_ids.length * edit.run.draft.campaigns_per_account)[edit.campaign.index - 1])}</p>}{dialogError && <p className="note note-warn" role="alert">{dialogError}</p>}<div className="lm-dialog-actions"><button className="btn btn-outline" disabled={!!busy} onClick={() => setEdit(null)}>{tt("monitorV2.cancel")}</button><button className="btn btn-primary" disabled={!!busy} onClick={saveEdit}>{edit.kind === "end" ? tt("monitorV2.endCampaign") : tt("monitorV2.save")}</button></div></div></div>}
  </div>;
}
