"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import { launchButtonLabel, planPixelNote, planSummary } from "./plan-summary";
import { call, usd } from "@/components/tiktok/api";
import LaunchSettingsDialog from "@/components/launch/LaunchSettingsDialog";
import LaunchPresetPicker from "@/components/launch/LaunchPresetPicker";
import InstantPageTemplatePicker from "@/components/launch/InstantPageTemplatePicker";
import LaunchAccountPicker from "@/components/launch/LaunchAccountPicker";
import LaunchConfirmDialog from "@/components/launch/LaunchConfirmDialog";
import ContentPicker from "@/components/launch/ContentPicker";
import AdCard, { type AdCardProps } from "@/components/launch/AdCard";
import { launchShape, summarizeLaunchSettings } from "@/lib/tiktok/settings";
import { metaDestination, startingDraft } from "@/lib/launch/draft-defaults";
import { adLandingUrl, campidForRun, campidSeries, defaultLaunchDraft, deriveAdSets, metaDraftIssues, trackingUrlForCampaign } from "@/lib/launch/plan";
import { feeLineVars } from "@/lib/promote/fee";
import type { MetaPagePost, MetaPagePostList } from "@/lib/launch/clip-posts";
import type { LaunchContent, LaunchDraft, LaunchPlan, LaunchProvider, LaunchRun, LaunchWorkspace, MetaPlatform } from "@/lib/launch/types";

// Which draft this browser was last editing, per company. A convenience, so it
// lives in localStorage behind try/catch and the page works without it.
const draftKey = (scope: string) => `studio.launch.draft:${scope}`;
function rememberedDraft(scope: string): string | null {
  try { return window.localStorage.getItem(draftKey(scope)); } catch { return null; }
}
function rememberDraft(scope: string, id: string | null): void {
  try { if (id) window.localStorage.setItem(draftKey(scope), id); else window.localStorage.removeItem(draftKey(scope)); } catch { /* private window or blocked storage */ }
}

// The save a Launch page makes as it is left (unmount, pagehide). A draft's
// first save moves the bare Launch page to /launch/<id>, a new instance, and
// the old one flushes the edits made meanwhile as it unmounts: the new one
// waits for that write before it reads the run, so its read never answers
// with the revision before it (the edits lost, every later save a conflict).
// Module scope, because the two instances share nothing else.
let pendingFlush: Promise<void> | null = null;

/** The link an ad will carry once the tag is on it; shown under the campid field. The same rule the plan signs. */
function campidLink(draft: LaunchDraft, campid: string): string {
  try { return trackingUrlForCampaign(draft.destination_url, campid, { provider: draft.provider, shape: launchShape(draft.tiktok_settings) }); }
  catch { return `${draft.destination_url || "https://…"}?campid=${campid}`; }
}

/** A content row with its own title, or none (the launch's title then applies on save). */
function withTitle(item: LaunchContent, titleId: string | undefined): LaunchContent {
  const { title_id: _previous, ...rest } = item;
  return titleId ? { ...rest, title_id: titleId } : rest;
}

type Props = { staff?: boolean; runId?: string };
const PLATFORM_WORD: Record<MetaPlatform, string> = { facebook: "Facebook", instagram: "Instagram" };
const DIRECT_ACCOUNTS = "__direct_accounts__";
const money = (cents: number | null | undefined) => usd(cents == null ? null : cents / 100);
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
/** "crazydramas.com/watch/<slug>": a link read by where it goes; the whole string stays in title=. */
const shortLink = (url: string) => { try { const u = new URL(url); return `${u.host}${u.pathname}`; } catch { return url; } };
const localDateTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
};

export default function LaunchStudio({ staff = false, runId }: Props) {
  const { tt, locale } = useT();
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [codesRaw, setCodesRaw] = useState("");
  const [localReady, setLocalReady] = useState(false);
  useEffect(() => setLocalReady(true), []);
  // What the Page listing said about the posts this draft holds. Read only, kept
  // in memory: a post preview never becomes a stored draft field.
  const [postMeta, setPostMeta] = useState<Record<string, MetaPagePost>>({});
  const mergePostMeta = useCallback((posts: Record<string, MetaPagePost>) => setPostMeta(current => ({ ...current, ...posts })), []);
  // Set once the default name ("Company · Sep 24") has been offered, or once
  // the person is in the name field: focusing it is enough, so a default that
  // arrives with the workspace never lands in front of what they are typing.
  const namedOnce = useRef(false);
  // Quiet autosave: the draft as last written to the server, the draft as it
  // was when the page loaded (so an untouched page never creates a run), the
  // save in flight, and whether Reset just asked us not to resume an old draft.
  const lastSaved = useRef<string>("");
  const baseline = useRef<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const skipResume = useRef(false);
  const autosaveRef = useRef<(keepalive?: boolean) => Promise<void>>(async () => {});
  // The run as last written, for a save that waited on another: its render's
  // `run` may predate that write (and after an unmount no render follows).
  const latestRun = useRef<LaunchRun | null>(null);
  // A render that has not caught up with a write yet never takes it back.
  if (!run || !latestRun.current || run.id !== latestRun.current.id || run.revision >= latestRun.current.revision) latestRun.current = run;
  const [saveState, setSaveState] = useState<{ kind: "idle" | "saving" | "saved" | "unsaved" | "failed"; at?: string }>({ kind: "idle" });

  const workspaceUrl = `${base}/workspace${staff && producerId ? `?producer_id=${encodeURIComponent(producerId)}` : ""}`;
  const reload = useCallback(async () => {
    const request = ++workspaceRequest.current;
    try {
      const w = await call<{ workspace: LaunchWorkspace }>(workspaceUrl);
      if (request !== workspaceRequest.current) return;
      setWorkspace(w.workspace);
      if (w.workspace.producers?.length) setProducers(w.workspace.producers);
      if (!runId && !run) {
        setDraft((d) => startingDraft(d, w.workspace));
        // The defaults are part of an untouched page, not an edit: carry the
        // baseline forward so a name typed before this arrived still counts.
        if (baseline.current) baseline.current = JSON.stringify(startingDraft(JSON.parse(baseline.current) as LaunchDraft, w.workspace));
      }
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
    void (pendingFlush ?? Promise.resolve())
      .then(() => call<{ run: LaunchRun }>(`${base}/${encodeURIComponent(runId)}`))
      .then((r) => {
        if (!active) return;
        setRun(r.run);
        setDraft(r.run.draft);
        lastSaved.current = JSON.stringify(r.run.draft); baseline.current = lastSaved.current;
        setSaveState(r.run.status === "draft" ? { kind: "saved", at: r.run.updated_at } : { kind: "idle" });
        if (r.run.status === "draft") rememberDraft(staff ? r.run.producer_id : "me", r.run.id);
        setBusinessId("");
        setCodesRaw(r.run.draft.content.filter((x) => x.kind === "spark").map((x) => x.value).join("\n"));
        setProducerId(r.run.producer_id);
        setLoadedRunId(runId);
      })
      .catch((e) => { if (active) { setError(errorText(e)); setRunLoadFailed(true); setLoadedRunId(runId); } });
    return () => { active = false; };
  }, [base, runId, staff]);

  const metaPostsUrl = staff ? "/api/promote/launch/meta-posts" : "/api/producer/launch/meta-posts";
  const previewAccount = draft.account_ids[0] ?? "";
  const missingPosts = draft.provider === "meta"
    ? draft.content.filter((x) => (x.kind === "facebook_post" || x.kind === "instagram_post") && !postMeta[x.value]).map((x) => x.value).join(",")
    : "";
  const postProducerId = staff ? producerId || run?.producer_id || "" : "";
  // A reloaded page shows the posts it already holds without opening the picker:
  // the listing route is cached server-side, so this costs one read.
  useEffect(() => {
    if (!missingPosts || !previewAccount) return;
    let active = true;
    const query = new URLSearchParams({ connection_id: previewAccount, ...(postProducerId ? { producer_id: postProducerId } : {}) });
    void call<MetaPagePostList>(`${metaPostsUrl}?${query}`)
      .then((listed) => {
        if (!active) return;
        setPostMeta((current) => ({ ...current, ...Object.fromEntries([...listed.facebook, ...listed.instagram].map((post) => [post.id, post])) }));
      })
      .catch(() => { /* the picker reports its own failures; a missing preview is not an error here */ });
    return () => { active = false; };
  }, [missingPosts, previewAccount, metaPostsUrl, postProducerId]);

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
  const setProvider = (provider: LaunchProvider) => {
    const next = { ...defaultLaunchDraft(provider), name: draft.name, total_budget_cents: draft.total_budget_cents,
      destination_url: provider === "meta" ? metaDestination(draft.destination_url) : "" };
    setDraft(workspace ? startingDraft(next, workspace) : next); setCodesRaw(""); setBusinessId(""); setPlan(null);
  };
  const titles = useMemo(() => workspace?.titles ?? [], [workspace]);
  const chosenTitle = titles.find((t) => t.id === draft.title_id) ?? null;
  // The launch's title is every ad's default: ads that follow it move with it,
  // and an ad set to another title, or made from a clip, keeps its own.
  const chooseTitle = (id: string) => {
    const t = titles.find((x) => x.id === id);
    setDraft((d) => ({ ...d, title_id: t?.id ?? null, destination_url: t?.ad_url ?? "",
      content: d.provider !== "tiktok" ? d.content : d.content.map((x) => x.kind !== "spark" || x.clip_id || (x.title_id && x.title_id !== d.title_id) ? x : withTitle(x, t?.id)) }));
    setPlan(null);
  };
  // Per ad (TikTok): the title each Spark code promotes, and optionally the
  // clip the code was made from. Only titles that can be live are offered: a
  // series read as not live is left out; one not checked yet is offered with
  // that said, and preview checks it.
  const liveTitles = titles.filter((t) => t.ad_url && t.state !== "not_live" && t.state !== "not_linked");
  const titleOf = (id: string | null | undefined) => (id ? titles.find((t) => t.id === id) ?? null : null);
  const adTitleId = (item: LaunchContent) => item.title_id ?? draft.title_id ?? "";
  const adClips = useMemo(() => (workspace?.library ?? []).filter((c) => c.kind === "video" && titles.some((t) => t.id === c.title_id && t.ad_url)), [workspace, titles]);
  const setAdTitle = (value: string, titleId: string) => update("content", draft.content.map((x) => x.kind === "spark" && x.value === value ? withTitle(x, titleId || undefined) : x));
  const setAdClip = (value: string, clipId: string) => {
    const clip = adClips.find((c) => c.id === clipId);
    update("content", draft.content.map((x) => x.kind !== "spark" || x.value !== value ? x
      : clip ? { ...x, clip_id: clip.id, title_id: clip.title_id } : (({ clip_id: _dropped, ...rest }) => rest)(x)));
  };
  const titleStateWord = (state: string | null) => state && ["live_complete", "live_partial", "live_differs", "live_unverified", "local_newer"].includes(state) ? tt("lpx.state.live")
    : state === "not_live" ? tt("lpx.state.notLive") : state === "read_failed" ? tt("lpx.state.readFailed") : tt("lpx.state.notChecked");
  const shape = launchShape(draft.tiktok_settings);
  // Each pasted code is one ad; a code already listed keeps the title and
  // clip chosen for it, a new one starts on the launch's title.
  const setCodes = (s: string) => {
    setCodesRaw(s);
    const values = [...new Set(s.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean))];
    setDraft((d) => {
      const kept = new Map(d.content.filter((x) => x.kind === "spark").map((x) => [x.value, x]));
      return { ...d, content: values.map((value) => kept.get(value) ?? withTitle({ kind: "spark" as const, value }, d.title_id ?? undefined)) };
    });
    setPlan(null);
  };
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
      // Never race a quiet autosave: it may be carrying a newer revision.
      if (inFlight.current) await inFlight.current;
      const current = latestRun.current;
      const snapshot = JSON.stringify(draft);
      const write = (async () => {
        const written = current
          ? await call<{ run: LaunchRun }>(`${base}/${current.id}`, "PUT", { draft, revision: current.revision })
          : await call<{ run: LaunchRun }>(base, "POST", { draft, ...(staff && producerId ? { producer_id: producerId } : {}) });
        lastSaved.current = snapshot; latestRun.current = written.run;
        return written;
      })();
      // An autosave timer that fires meanwhile waits for this write, then finds
      // nothing new to send, instead of sending the same draft on the revision
      // this write is replacing (a conflict, and a preview on a stale revision).
      const held = write.then(() => undefined, () => undefined);
      inFlight.current = held;
      const result = await write.finally(() => { if (inFlight.current === held) inFlight.current = null; });
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
  // Staff screens name a producer, never its UUID (plan §5.3).
  const producerName = (id: string) => { const found = producers.find((p) => p.id === id); return found ? found.name_en || found.name_zh : tt("monitorV2.producer"); };
  // The launch name is the thing people see everywhere afterwards, so a new
  // draft opens with the company and today's date instead of the word "Launch".
  const namedCompany = producers.find((p) => p.id === (producerId || workspace?.producer_id));
  const companyName = namedCompany ? namedCompany.name_en || namedCompany.name_zh : workspace?.library[0]?.producer_name ?? "";
  useEffect(() => {
    if (namedOnce.current || runId || run || !workspace || (staff && !companyName)) return;
    namedOnce.current = true;
    const today = new Date().toLocaleDateString(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric" });
    setDraft((d) => (d.name === defaultLaunchDraft(d.provider).name ? { ...d, name: companyName ? `${companyName} · ${today}` : today } : d));
  }, [workspace, runId, run, companyName, locale, staff]);
  // The content decides the platforms; the derived ad sets are what Meta will
  // actually receive, so the screen shows them rather than the raw placements.
  const hasClips = draft.provider === "meta" && draft.content.some((x) => x.kind === "video");
  const campaignAdSets = useMemo(() => {
    if (draft.provider !== "meta") return [];
    const first = draft.allocation === "shared" ? draft.content : draft.content.slice(0, draft.content_per_campaign);
    const share = campaigns > 0 ? Math.floor(draft.total_budget_cents / campaigns) : draft.total_budget_cents;
    return deriveAdSets(first, draft.meta_settings.placements, share, draft.daily_budget_cents);
  }, [draft.provider, draft.allocation, draft.content, draft.content_per_campaign, draft.meta_settings.placements, draft.total_budget_cents, draft.daily_budget_cents, campaigns]);
  // Every reason this draft cannot be previewed, collected into one list.
  const issues = useMemo(() => draft.provider === "meta" ? metaDraftIssues(draft, connections) : [], [draft, connections]);
  const campidPreview = draft.campid_start?.trim() ? campidSeries(draft.campid_start, Math.min(Math.max(campaigns, 1), 3)) : [];
  // Traffic and Website purchases ads carry the title's link itself. An Instant
  // Page ad carries the page, and its button opens that link plus the
  // campaign's campid: the typed one, else the one the plan derives from the
  // saved run, else a placeholder until the draft is saved.
  const firstCampid = campidPreview[0] ?? (() => { try { return run ? campidForRun(run.external_id, 1, draft.name) : null; } catch { return null; } })();
  const buttonLink = !draft.destination_url ? "" : firstCampid ? campidLink(draft, firstCampid) : `${draft.destination_url}&campid=…`;
  const posted = !!run && run.status !== "draft";

  // ---- autosave, resume and reset ------------------------------------------
  // The draft is written to the server a moment after each edit and once more
  // when the page is left, without the busy lock the explicit Save uses. A
  // return to the bare Launch page continues the newest saved draft; Start
  // over begins a new one and leaves the old draft where it is.
  const draftJson = JSON.stringify(draft);
  const editableDraft = canEdit && !posted && (!staff || !!producerId);
  const autosave = useCallback(async (keepalive = false) => {
    if (!editableDraft || busy || confirmOpen || baseline.current === null) return;
    // Leaving the page may update the draft it was on; it never creates one.
    // A first write only ever comes from the timer, after a real edit.
    if (keepalive && !latestRun.current) return;
    if (inFlight.current) await inFlight.current;
    const snapshot = JSON.stringify(draft);
    if (snapshot === lastSaved.current || snapshot === baseline.current) return;
    // The write this one waited on may have made the run or moved its revision.
    const current = latestRun.current;
    setSaveState({ kind: "saving" });
    const work = (async () => {
      try {
        const url = current ? `${base}/${current.id}` : base;
        const body = current ? { draft, revision: current.revision } : { draft, ...(staff && producerId ? { producer_id: producerId } : {}) };
        const response = await fetch(url, { method: current ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive });
        const json = await response.json().catch(() => ({})) as { run?: LaunchRun; error?: string };
        if (!response.ok || !json.run) throw new Error(json.error || `HTTP ${response.status}`);
        lastSaved.current = snapshot;
        latestRun.current = json.run;
        setRun(json.run);
        setSaveState({ kind: "saved", at: json.run.updated_at });
        rememberDraft(staff ? producerId : "me", json.run.id);
        if (!current) router.replace(`${pageBase}/${json.run.id}`);
      } catch (e) { setSaveState({ kind: "failed" }); setError(errorText(e)); }
    })();
    inFlight.current = work; await work; if (inFlight.current === work) inFlight.current = null;
  }, [editableDraft, busy, confirmOpen, draft, base, staff, producerId, router, pageBase]);
  autosaveRef.current = autosave;
  useEffect(() => {
    // The first draft this page ever renders is its baseline, taken before the
    // workspace arrives: whatever the person types after that counts as an edit.
    if (baseline.current === null) { baseline.current = draftJson; return; }
    if (!editableDraft) return;
    if (draftJson === lastSaved.current || draftJson === baseline.current) return;
    setSaveState((s) => (s.kind === "saving" ? s : { kind: "unsaved" }));
    const timer = setTimeout(() => { void autosaveRef.current(); }, 1200);
    return () => clearTimeout(timer);
  }, [draftJson, editableDraft]);
  useEffect(() => {
    // Leaving the page, by tab close or by an in-app link: flush what the timer
    // has not written yet. keepalive lets the request outlive the page.
    const flush = () => {
      const write = autosaveRef.current(true).catch(() => { /* autosave reports its own failure */ });
      // Chained, never replaced: Strict Mode's remount flushes too (nothing to
      // write), and that must not hide the old instance's write still in flight.
      const prior = pendingFlush;
      const all = prior ? Promise.all([prior, write]).then(() => undefined) : write;
      pendingFlush = all;
      void all.finally(() => { if (pendingFlush === all) pendingFlush = null; });
    };
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush); document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", hidden); flush(); };
  }, []);
  useEffect(() => {
    // The bare Launch page continues the draft this browser was last editing,
    // as long as it is still a draft. Per browser, not per company: a colleague
    // opening Launch is not dropped into someone else's half-built launch.
    if (runId || run || !workspace || skipResume.current || (staff && !producerId)) return;
    const remembered = rememberedDraft(staff ? producerId : "me");
    const still = remembered ? workspace.runs.find((r) => r.id === remembered && r.status === "draft") : undefined;
    if (still) router.replace(`${pageBase}/${still.id}`);
  }, [runId, run, workspace, staff, producerId, router, pageBase]);
  const startOver = () => {
    if (!window.confirm(tt("lr2.resetConfirm"))) return;
    skipResume.current = true; lastSaved.current = ""; baseline.current = null;
    rememberDraft(staff ? producerId : "me", null);
    setRun(null); setPlan(null); setError(""); setCodesRaw(""); setBusinessId("");
    setDraft((d) => (workspace ? startingDraft(defaultLaunchDraft(d.provider), workspace) : defaultLaunchDraft(d.provider)));
    setSaveState({ kind: "idle" });
    router.replace(pageBase);
  };
  const saveWord = saveState.kind === "saving" ? tt("lr2.saving")
    : saveState.kind === "saved" && saveState.at ? tt("lr2.savedAt", { time: new Date(saveState.at).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", { hour: "numeric", minute: "2-digit" }) })
    : saveState.kind === "unsaved" ? tt("lr2.unsaved")
    : saveState.kind === "failed" ? tt("lr2.saveFailed") : "";
  /** One ad, resolved from the clip library or the Page listing, never from a new draft field. */
  const cardFor = useCallback((item: LaunchContent, compact = false): AdCardProps => {
    const asset = item.kind === "video" ? workspace?.library.find((x) => x.id === item.value) : undefined;
    const post = item.kind === "facebook_post" || item.kind === "instagram_post" ? postMeta[item.value] : undefined;
    const excerpt = post?.caption.split("\n")[0].slice(0, 60);
    const caption = item.kind === "video" ? (item.text ?? asset?.text ?? null) : (post?.caption ?? null);
    // A label that only repeats the ad's own words is dropped rather than
    // printed twice; the card then names the content by what it is.
    // A clip is named by its hook alone (the picker's "title · hook" label is
    // for the picker); in step 3 the two inputs beside the card already carry
    // the copy, so the full-size clip card shows the name and nothing twice.
    const named = item.kind === "video" ? (asset?.label || item.label?.split(" · ").pop() || "") : (item.label || excerpt || "");
    const clipInStepThree = item.kind === "video" && !compact;
    return {
      platform: item.kind === "instagram_post" ? "instagram" : item.kind === "spark" ? "tiktok" : "facebook",
      platforms: item.kind === "video" ? [...draft.meta_settings.placements] : undefined,
      kind: item.kind, label: named && named !== excerpt && named !== caption ? named : "",
      caption: clipInStepThree ? null : caption,
      headline: item.kind === "video" && !clipInStepThree ? (item.headline ?? asset?.headline ?? null) : null,
      thumbnail_url: asset?.thumbnail_url ?? post?.thumbnail_url ?? null,
      media_url: asset?.media_url ?? null, permalink: post?.permalink ?? asset?.post_url ?? null,
      id: item.value, compact,
    };
  }, [workspace, postMeta, draft.meta_settings.placements]);
  /** What one TikTok ad promotes and the exact link it carries (none for an Instant Page ad: it carries the page). */
  const adLine = (item: LaunchContent, campaignUrl?: string): { title: string; link: string | null } | null => {
    if (draft.provider !== "tiktok") return null;
    const title = titleOf(item.title_id ?? draft.title_id)?.name ?? tt("lpt.unknownTitle");
    return { title, link: shape === "instant_page" ? null : adLandingUrl(item, campaignUrl ?? draft.destination_url) || null };
  };
  const cards = useMemo(() => Object.fromEntries((plan?.rows ?? []).flatMap((row) => row.content)
    .map((item) => [`${item.kind}:${item.value}`, cardFor(item, true)])), [plan, cardFor]);
  if (runId && (loadedRunId !== runId || runLoadFailed)) return <div className="launch-flow">
    <div className="page-head"><h1>{tt("lv2.launch.title")}</h1></div>
    {runLoadFailed ? <p className="note note-warn" role="alert" tabIndex={-1} ref={errorBox}>{error}</p> : <p>{tt("common.loading")}</p>}
    <Link className="btn btn-outline" href={pageBase}>{tt("lv2.launch.title")}</Link>
  </div>;
  return <div className="launch-flow">
    <div className="page-head"><div><h1>{tt("lv2.launch.title")}</h1><p className="page-sub">{tt("lv2.launch.sub")}</p></div><div className="rs-tool-row">
      {saveWord && <span className="hint launch-save-state" role="status" data-save-state={saveState.kind}>{saveWord}</span>}
      {!posted && <button type="button" className="btn btn-outline" disabled={busy} onClick={startOver}>{tt("lr2.reset")}</button>}
      <Link className="btn btn-outline" href={staff ? "/promote/monitor" : "/producer/monitor"}>{tt("lv2.monitor.title")}</Link></div></div>
    {staff && <div className="rs-panel"><label>{tt("lv2.producerId")} <select className="select" value={producerId} onChange={(e) => { setWorkspace(null); setRun(null); setError(""); setBusinessId(""); setDraft((d) => ({ ...d, account_ids: [], content: [] })); setCodesRaw(""); setPlan(null); setProducerId(e.target.value); }} disabled={!!runId || busy}><option value="">{tt("lv2.choose")}</option>{producers.map((p) => <option key={p.id} value={p.id}>{p.name_en || p.name_zh}</option>)}</select></label>{run && <p className="hint">{tt("lv2.onBehalf")}: {producerName(run.producer_id)}</p>}</div>}
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
        {draft.provider === "tiktok" ? <><label className="tk-label" htmlFor="lv2-codes">{tt("lv2.codes")}</label><textarea id="lv2-codes" className="input" rows={5} value={codesRaw} onChange={(e) => setCodes(e.target.value)} placeholder={tt("lv2.codesHint")} /><p className="hint">{tt("lv2.manualTikTok")}</p>
          {/* One row per pasted code: the title that ad promotes (its own
              crazydramas link) and, optionally, the clip the code was made from. */}
          {draft.content.length > 0 && <div className="launch-ad-titles" data-testid="launch-ad-titles">
            <h3 className="launch-ad-titles-head">{tt("lpt.head")}</h3>
            <p className="hint">{tt(shape === "instant_page" ? "lpt.hintInstantPage" : "lpt.hint")}</p>
            <div className="gtable gt-resp" style={{ "--cols-lg": "96px minmax(170px,1.2fr) minmax(190px,1.3fr) minmax(220px,1.8fr)", "--cols-sm": "minmax(0,1fr)" } as React.CSSProperties}>
              <div className="gt-head gt-sm-hide"><span>{tt("lpt.ad")}</span><span>{tt("lpt.title")}</span><span>{tt("lpt.clip")}</span><span>{tt("lpt.link")}</span></div>
              {draft.content.map((item, i) => {
                const titleId = adTitleId(item);
                const current = titleOf(titleId);
                const clip = item.clip_id ? adClips.find((c) => c.id === item.clip_id) : undefined;
                const mismatch = !!clip && clip.title_id !== titleId;
                const options = current && !liveTitles.some((t) => t.id === current.id) ? [...liveTitles, current] : liveTitles;
                return <div className="gt-row launch-ad-title-row" key={item.value} data-ad-row={i + 1}>
                  <span title={item.value}><strong>{tt("lr3.adNumber", { n: i + 1 })}</strong><small className="gt-muted launch-ad-code">…{item.value.slice(-6)}</small></span>
                  <label className="launch-ad-cell"><span className="launch-ad-cell-label">{tt("lpt.title")}</span>
                    <select className="select" aria-label={tt("lpt.titleFor", { n: i + 1 })} value={current ? titleId : ""} onChange={(e) => setAdTitle(item.value, e.target.value)}>
                      {!current && <option value="">{tt("lpx.chooseTitle")}</option>}
                      {options.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    {current && <small className="gt-muted">{[titleId === draft.title_id ? tt("lpt.launchTitle") : null, titleStateWord(current.state)].filter(Boolean).join(" · ")}</small>}</label>
                  <label className="launch-ad-cell"><span className="launch-ad-cell-label">{tt("lpt.clip")}</span>
                    <select className="select" aria-label={tt("lpt.clipFor", { n: i + 1 })} value={clip ? clip.id : ""} onChange={(e) => setAdClip(item.value, e.target.value)}>
                      <option value="">{tt("lpt.noClip")}</option>
                      {liveTitles.map((t) => { const own = adClips.filter((c) => c.title_id === t.id); return own.length ? <optgroup key={t.id} label={t.name}>{own.map((c) => <option key={c.id} value={c.id}>{c.montage ? `${tt("montage.pill")} · ` : c.episode_label ? `${tt("lpt.episode", { n: c.episode_label })} · ` : ""}{c.label}</option>)}</optgroup> : null; })}
                    </select>
                    {mismatch && <small className="launch-ad-mismatch" role="alert">{tt("lpt.mismatch", { clip: clip!.title_name, title: current?.name ?? "—" })}</small>}</label>
                  <span className="launch-ad-cell"><span className="launch-ad-cell-label">{tt("lpt.link")}</span>
                    {shape === "instant_page"
                      ? <small className="gt-muted">{titleId === draft.title_id ? tt("lpt.instantPageLink") : tt("lpt.instantPageOther")}</small>
                      : <code className="launch-ad-url launch-ad-url-row" data-testid="ad-row-url">{current?.ad_url ?? "—"}</code>}</span>
                </div>;
              })}
            </div>
          </div>}</> : <p className="hint">{tt("lv2.metaHint")}</p>}
      {draft.provider === "tiktok" ? <Link href={staff ? "/clips" : "/producer/clips"}>{tt("lv2.clips.title")}&nbsp;→</Link> : <>
        <div className="rs-tool-row"><button type="button" className="btn btn-outline" onClick={() => setPickerOpen(true)}>{tt("contentPicker.open")}</button><span className="hint">{tt("contentPicker.chosen", { n: draft.content.length })}</span></div>
        {/* An uploaded clip carries the copy Studio sends; an existing post
            carries its own caption, so it gets no boxes that would be dropped. */}
        <div className="launch-content-list">{draft.content.map((item) => <div className="launch-content-item" key={`${item.kind}:${item.value}`}>
          <AdCard {...cardFor(item)} />
          {item.kind === "video" ? <div className="launch-content-copy">
            <label>{tt("lv2.primaryText")} <input className="input" value={item.text ?? ""} onChange={(e) => setContentField(item, "text", e.target.value)} /></label>
            <label>{tt("lv2.headline")} <input className="input" value={item.headline ?? ""} onChange={(e) => setContentField(item, "headline", e.target.value)} /></label>
          </div> : <p className="hint launch-content-copy">{tt("lr2.postCaptionHint")}</p>}
          <button type="button" className="btn btn-outline btn-sm" onClick={() => toggleContent(item)}>{tt("contentPicker.remove")}</button>
        </div>)}</div>
        <p className="hint launch-runs-on">{campaignAdSets.length
          ? tt("lr2.runsOn", { platforms: campaignAdSets.map((set) => PLATFORM_WORD[set.platform]).join(" · ") })
          : tt("lr2.runsOnNone")}</p>
      </>}</section>
      <section className="rs-panel"><h2>4. {tt("lv2.delivery")}</h2><div className="tk-field tk-row"><label htmlFor="lv2-name">{tt("lv2.name")}</label><input id="lv2-name" className="input" value={draft.name} onFocus={() => { namedOnce.current = true; }} onChange={(e) => { namedOnce.current = true; update("name", e.target.value); }} />{draft.provider === "tiktok"
        ? <><label htmlFor="lv2-title">{tt("lpx.title")}</label><select id="lv2-title" className="select" value={draft.title_id ?? ""} onChange={(e) => chooseTitle(e.target.value)}><option value="">{tt("lpx.chooseTitle")}</option>{titles.map((t) => <option key={t.id} value={t.id} disabled={!t.ad_url}>{t.name}</option>)}</select></>
        : <><label htmlFor="lv2-dest">{tt("lv2.destination")}</label><input id="lv2-dest" className="input" type="url" value={draft.destination_url} onChange={(e) => update("destination_url", e.target.value)} placeholder="https://" /></>}</div>
      {/* Every TikTok ad carries the title's crazydramas link with TikTok's own
          macros (lib/tiktok/ad-url.ts); the screen prints the exact string. */}
      {draft.provider === "tiktok" && <div className="launch-ad-link">
        {chosenTitle && chosenTitle.slug && <p className="hint" data-title-state={chosenTitle.state ?? ""}>{tt("lpx.titleState", { slug: chosenTitle.slug, state: titleStateWord(chosenTitle.state) })}</p>}
        {!titles.length && workspace && <p className="hint">{tt(staff && !producerId && !run?.producer_id ? "lpx.pickCompanyFirst" : "lpx.noTitles")}</p>}
        {shape === "instant_page"
          ? <><p className="hint">{tt("lpx.buttonLinkLabel")}</p>
            <code className="launch-ad-url" data-testid="tiktok-button-url">{buttonLink || "—"}</code></>
          : <><p className="hint">{tt("lpx.linkLabel")}</p>
            <code className="launch-ad-url" data-testid="tiktok-ad-url">{draft.destination_url || "—"}</code></>}
        <p className="hint">{tt("lpx.macroNote")}</p>
      </div>}<div className="tk-field tk-row"><label htmlFor="lv2-total">{tt("lv2.budget")}</label><input id="lv2-total" className="input tk-num" type="number" min={1} step="0.01" value={draft.total_budget_cents / 100} onChange={(e) => update("total_budget_cents", Math.round((Number(e.target.value) || 0) * 100))} /><label htmlFor="lv2-daily">{tt("lv2.dailyTotal")} {tt("lr2.dailyOptional")}</label><input id="lv2-daily" className="input tk-num" type="number" min={0} step="0.01" value={draft.daily_budget_cents == null ? "" : draft.daily_budget_cents / 100} onChange={(e) => { const cents = Math.round(Number(e.target.value) * 100); update("daily_budget_cents", e.target.value === "" || !(cents > 0) ? null : cents); }} /></div><p className="hint">{(campaigns === 1 ? tt("lr2.budgetMathOne", { campaigns, share: campaigns ? money(Math.floor(draft.total_budget_cents / campaigns)) : "—" }) : tt("lv2.budgetMath", { campaigns, share: campaigns ? money(Math.floor(draft.total_budget_cents / campaigns)) : "—" }))}</p><p className="hint">{tt("lr2.dailyHint")}</p>
      {/* overlord's mass launch: one campid per campaign, counted up from the
          first, appended to the destination as the tracking link. */}
      <div className="tk-field tk-row"><label htmlFor="lv2-campid">{tt("lr2.campidStart")}</label><input id="lv2-campid" className="input" value={draft.campid_start ?? ""} placeholder="rlapple01" onChange={(e) => update("campid_start", e.target.value)} /></div>
      <p className="hint" role="status">{campidPreview.length
        ? <>{tt(campaigns > 1 ? "lr2.campidNaming" : "lr2.campidNamingOne", { names: `${campidPreview.join(", ")}${campaigns > campidPreview.length ? ", …" : ""}` })}<br />{draft.provider === "tiktok"
          ? shape === "instant_page" ? tt("lpx.campidInstantPage", { names: campidPreview[0] }) : tt("lpx.campidTikTok", { names: campidPreview[0] })
          : tt("lr2.campidLink", { url: campidLink(draft, campidPreview[0]) })}</>
        : tt("lr2.campidEmpty")}</p>
      <label className="tk-check"><input type="checkbox" checked={draft.start_paused} onChange={(e) => update("start_paused", e.target.checked)} /> {tt("lv2.startPaused")}</label></section>
      <section className="rs-panel"><h2>5. {tt("lv2.settings")}</h2>{draft.provider === "tiktok" ? <><LaunchPresetPicker value={editorSettings} onSelect={(v) => updateTikTokSettings({ ...v, start_paused: draft.start_paused })} />{shape === "instant_page" && <InstantPageTemplatePicker value={draft.tiktok_settings.instant_page_template} onChange={template => update("tiktok_settings", { ...draft.tiktok_settings, instant_page_template: template })} />}<button className="btn btn-outline" onClick={() => setSettingsOpen(!settingsOpen)}>{settingsOpen ? tt("lv2.hideSettings") : tt("lv2.customize")}</button><p className="hint">{summarizeLaunchSettings(editorSettings).join(" · ")}</p>{settingsOpen && <LaunchSettingsDialog value={editorSettings} onChange={updateTikTokSettings} budgetUsd={campaigns ? draft.total_budget_cents / 100 / campaigns : 0} regionsEndpoint={staff ? "/api/admin/tiktok/regions" : "/api/producer/tiktok/regions"} onClose={closeSettings} />}</> : <div className="tk-field tk-row"><label>{tt("lv2.countries")} <input className="input" value={draft.meta_settings.countries.join(", ")} onChange={(e) => update("meta_settings", { ...draft.meta_settings, countries: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></label>{/* Posts already say which platform they belong to, so the control only
    appears when the draft carries an uploaded clip, and governs only those. */}
{hasClips && <label>{tt("lv2.placements")} <select className="select" value={draft.meta_settings.placements.join(",")} onChange={(e) => update("meta_settings", { ...draft.meta_settings, placements: e.target.value.split(",") as ("facebook" | "instagram")[] })}><option value="facebook,instagram">Facebook + Instagram</option><option value="facebook">Facebook</option><option value="instagram">Instagram</option></select></label>}
{hasClips && <span className="hint">{tt("lr2.placementsClipsOnly")}</span>}<label>{tt("lv2.goal")} <select className="select" value={draft.meta_settings.optimization_goal} onChange={(e) => update("meta_settings", { ...draft.meta_settings, optimization_goal: e.target.value as "LINK_CLICKS" | "LANDING_PAGE_VIEWS" })}><option value="LINK_CLICKS">Link clicks</option><option value="LANDING_PAGE_VIEWS">Landing page views</option></select></label><label>{tt("lv2.cta")} <select className="select" value={draft.meta_settings.call_to_action} onChange={(e) => update("meta_settings", { ...draft.meta_settings, call_to_action: e.target.value as "LEARN_MORE" | "WATCH_MORE" })}><option value="LEARN_MORE">Learn more</option><option value="WATCH_MORE">Watch more</option></select></label><label>{tt("lv2.bid")} <input className="input tk-num" type="number" min={0} step="0.01" value={draft.meta_settings.bid_cents == null ? "" : draft.meta_settings.bid_cents / 100} onChange={(e) => update("meta_settings", { ...draft.meta_settings, bid_cents: e.target.value === "" ? null : Math.round(Number(e.target.value) * 100), bid_strategy: e.target.value === "" ? "LOWEST_COST_WITHOUT_CAP" : "LOWEST_COST_WITH_BID_CAP" })} /></label><label>{tt("lv2.start")} <input className="input" type="datetime-local" value={localReady ? localDateTime(draft.meta_settings.start_time) : draft.meta_settings.start_time.slice(0, 16)} onChange={(e) => update("meta_settings", { ...draft.meta_settings, start_time: e.target.value ? new Date(e.target.value).toISOString() : "" })} /></label><label>{tt("lv2.end")} <input className="input" type="datetime-local" value={localReady ? localDateTime(draft.meta_settings.end_time) : draft.meta_settings.end_time.slice(0, 16)} onChange={(e) => update("meta_settings", { ...draft.meta_settings, end_time: e.target.value ? new Date(e.target.value).toISOString() : "" })} /></label><span className="hint">{tt("lv2.localTime")} ({localReady ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC"})</span></div>}</section>
      </fieldset><section className="rs-panel" aria-busy={busy}><h2>6. {tt("launchFeedback.reviewLaunch")}</h2>{!plan && <p className="hint">{tt("launchFeedback.launchHelp", { provider: draft.provider === "tiktok" ? "TikTok" : "Meta" })}</p>}{!workspace && !error && <p role="status">{tt("common.loading")}</p>}{workspace && !canEdit && <p className="note">{tt(staff && !producerId ? "launchFeedback.chooseProducer" : "launchFeedback.cannotEdit")}</p>}{issues.length > 0 && <div className="note note-warn launch-fix-first" role="alert"><strong>{tt("lr2.fixFirst")}</strong><ul>{issues.map((issue) => <li key={issue.code}>{tt(`lr2.issue.${issue.code}`, issue.vars)}</li>)}</ul></div>}<div className="rs-tool-row">{!plan && <button type="button" className="btn btn-primary" disabled={busy || !workspace} onClick={() => void prepareLaunch()}>{busy ? tt("launchFeedback.preparing") : tt("launchFeedback.launchOn", { provider: draft.provider === "tiktok" ? "TikTok" : "Meta" })}</button>}<button className="btn btn-outline" disabled={busy || !canEdit} onClick={() => void save(false)}>{tt("lv2.save")}</button><button className="btn btn-outline" disabled={busy || !canEdit} onClick={() => void save(true)}>{busy ? tt("common.loading") : tt("lv2.preview")}</button></div>{plan && <><p>{run?.mode !== "production" && <span className="pill pill-accent">{tt(run?.mode === "sandbox" ? "lv2.sandbox" : "lv2.demo")}</span>}</p><p>{planSummary(tt, plan, money)}</p>{draft.provider === "tiktok" && plan.tiktok_pixel && <p className="note" data-testid="tiktok-optimizes">{tt("lpx.factOptimizes")}: {tt("lpx.optimizes", { event: plan.tiktok_pixel.event, code: plan.tiktok_pixel.code, attribution: plan.tiktok_pixel.attribution })}</p>}{draft.provider === "tiktok" && planPixelNote(tt, plan.tiktok_pixel) && <p className="hint" data-testid="tiktok-pixel-unverified">{planPixelNote(tt, plan.tiktok_pixel)}</p>}{draft.provider === "tiktok" && shape === "instant_page" && draft.tiktok_settings.instant_page_template && <p className="note">{tt("salesLaunch.sales")}: {draft.tiktok_settings.instant_page_template.name} · {tt("tipTemplates.button")}: {draft.tiktok_settings.instant_page_template.button_text} · {tt(`tipTemplates.background.${draft.tiktok_settings.instant_page_template.background}`)}{draft.tiktok_settings.instant_page_template.hand_cursor ? ` · ${tt("tipTemplates.handCursor")}` : ""}</p>}{plan.warnings.length > 0 && <div className="note"><ul>{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}<div className="gtable" style={{ "--cols": "48px minmax(180px,2fr) minmax(140px,1fr) minmax(200px,2fr) 110px" } as React.CSSProperties}><div className="gt-head"><span>#</span><span>{tt("lv2.campaign")}</span><span>{tt("lv2.account")}</span><span>{tt("lv2.content")}</span><span>{tt("lv2.campaignBudget")}</span></div>{plan.rows.map((row) => <div className="gt-row" key={row.index}><span>{row.index}</span><span>{draft.name} · {row.index}{row.campid && <small className="gt-muted">{tt("mr2.campid")}: {row.campid}</small>}{row.tracking_url && <small className="gt-muted">{tt("mr2.trackingLink")}: <a href={row.tracking_url} target="_blank" rel="noreferrer">{row.tracking_url}</a></small>}</span><span>{connections.find((c) => c.id === row.connection_id)?.name ?? tt("lv2.account")}<small className="gt-muted">{row.advertiser_id}</small></span><span className="launch-content-cell">{(row.ad_sets?.length ? row.ad_sets.flatMap((set) => set.content.map((x) => ({ item: x, platform: set.platform }))) : row.content.map((x) => ({ item: x, platform: undefined })))
          .map(({ item, platform }, i) => { const line = adLine(item, row.tracking_url); return <div className="launch-preview-ad" key={`${platform ?? ""}:${item.kind}:${item.value}:${i}`}><AdCard {...cardFor(item, true)} {...(platform ? { platform, platforms: undefined } : {})} />{line && <small className="gt-muted launch-ad-title-line" data-testid="preview-ad-title">{line.title}{line.link ? <> · <a href={line.link} target="_blank" rel="noreferrer" title={line.link}>{shortLink(line.link)}</a></> : null}</small>}</div>; })}</span><span>{money(row.budget_cents)}{row.ad_sets && row.ad_sets.length > 1 && <small className="gt-muted">{row.ad_sets.map((set) => tt("lr2.adSetBudget", { platform: PLATFORM_WORD[set.platform], budget: money(set.daily_budget_cents ?? set.budget_cents) })).join(" · ")}</small>}</span></div>)}</div><p className="note">{tt("lv2.feeLine", feeLineVars(plan.total_budget_cents / 100))}</p>{draft.provider === "meta" && <p className="hint">{tt("lv2.destination")}: {draft.destination_url} · {draft.meta_settings.countries.join(", ")} · {campaignAdSets.map((set) => PLATFORM_WORD[set.platform]).join(" / ")} · {draft.meta_settings.optimization_goal} · {draft.meta_settings.call_to_action}</p>}<button className="btn btn-approve" disabled={busy} onClick={requestLaunch}>{busy ? tt("launchFeedback.submitting") : launchButtonLabel(tt, plan.campaign_count, draft.start_paused ? tt("lv2.paused") : tt("lv2.live"))}</button>{!canLaunch && <p className="hint">{tt("lv2.needsApprover")}</p>}</>}{error && <p className="note note-warn" role="alert" tabIndex={-1} ref={errorBox}>{error}</p>}</section>
    </>}
    {pickerOpen && <ContentPicker
      clipsBase={staff ? "/api/promote/clips" : "/api/producer/clips"}
      pagePostsUrl={staff ? "/api/promote/launch/meta-posts" : "/api/producer/launch/meta-posts"}
      producerId={staff ? producerId || run?.producer_id : undefined}
      library={(workspace?.library ?? []).filter((x) => x.kind === "video")}
      connections={connections} accountIds={draft.account_ids} placements={draft.meta_settings.placements}
      content={draft.content} canPost={canLaunch}
      onChange={(next) => update("content", next)} onClose={() => setPickerOpen(false)} onPostMeta={mergePostMeta} />}
    {confirmOpen && plan && <LaunchConfirmDialog adLine={draft.provider === "tiktok" ? adLine : undefined} name={draft.name} plan={plan} destination={draft.destination_url} startPaused={draft.start_paused} provider={draft.provider} mode={run?.mode ?? "fake"} accountNames={Object.fromEntries(connections.map(c => [c.id, c.name]))} cards={cards} pageDesign={draft.provider === "tiktok" && shape === "instant_page" ? draft.tiktok_settings.instant_page_template : undefined} destinationNote={draft.provider === "tiktok" ? tt("lpx.macroNote") : undefined} optimizes={draft.provider === "tiktok" && plan.tiktok_pixel ? tt("lpx.optimizes", { event: plan.tiktok_pixel.event, code: plan.tiktok_pixel.code, attribution: plan.tiktok_pixel.attribution }) : undefined} pixelNote={draft.provider === "tiktok" ? planPixelNote(tt, plan.tiktok_pixel) : undefined} staff={staff} note={note} onNoteChange={value => { setNote(value); setConfirmError(""); }} error={confirmError} onClose={closeConfirm} onConfirm={() => void launch()} />}
  </div>;
}
