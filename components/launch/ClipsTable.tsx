"use client";

// The one Clips table (plan §5.1, docs/meta-organic-plan.md): the staff tab at
// /clips and the producer page at /producer/clips render this same component so
// the two can never drift. Every column is the clip as a person reads it — a
// poster, a title, a hook — and the two platform cells are the posting state in
// plain words, never an id. Filters live in the URL so a filtered view is a
// link. While a post is publishing the row polls its own post row every three
// seconds until it settles; errors render in the row, never in an alert().

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useT } from "@/components/locale";
import { call } from "@/components/tiktok/api";
import PostClipDialog from "@/components/launch/PostClipDialog";
import AdMontage from "@/components/launch/AdMontage";
import UploadAds from "@/components/launch/UploadAds";
import { postOn, publishedOn, shortDate } from "@/components/launch/clip-state";
import type { ClipLibraryRow, ClipPost, ClipPostPlatform } from "@/lib/launch/clip-posts";
import type { MontageStatus } from "@/lib/clips/montage-run";
import type { LaunchConnection, LaunchTitleOption, LaunchWorkspace } from "@/lib/launch/types";

/** On one title's page: its 60-second ad panel (components/launch/AdMontage.tsx) above the table, which reloads when an ad lands. */
type MontagePanel = { canBuild: boolean; initial: MontageStatus | null };
type Props = { staff?: boolean; titleId?: string; montage?: MontagePanel };
type PostedFilter = "any" | "not_posted" | "posted" | "failed";
type Opening = { clip: ClipLibraryRow; platform: ClipPostPlatform };

const POSTED_FILTERS: PostedFilter[] = ["any", "not_posted", "posted", "failed"];
const FILTER_KEY: Record<PostedFilter, string> = {
  any: "clipsPosting.filter.any", not_posted: "clipsPosting.filter.notPosted",
  posted: "clipsPosting.filter.posted", failed: "clipsPosting.filter.failed",
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const duration = (ms: number | null) => {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export default function ClipsTable({ staff = false, titleId, montage }: Props) {
  const { tt, locale } = useT();
  const router = useRouter();
  const pathname = usePathname() ?? (staff ? "/clips" : "/producer/clips");
  const params = useSearchParams();
  const base = staff ? "/api/promote/clips" : "/api/producer/clips";
  const workspaceBase = staff ? "/api/promote/launches" : "/api/producer/launch";

  const producer = (staff && params?.get("producer")) || "";
  const title = params?.get("title") ?? "";
  const episode = params?.get("episode") ?? "";
  const state = (POSTED_FILTERS.includes((params?.get("state") ?? "") as PostedFilter) ? params!.get("state") : "any") as PostedFilter;
  const querySearch = params?.get("q") ?? "";

  const [rows, setRows] = useState<ClipLibraryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [search, setSearch] = useState(querySearch);
  const [opening, setOpening] = useState<Opening | null>(null);
  const [canPost, setCanPost] = useState(false);
  const [titles, setTitles] = useState<LaunchTitleOption[]>([]);
  const [canDownload, setCanDownload] = useState(false);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [zipping, setZipping] = useState(false);
  const [producers, setProducers] = useState<{ id: string; name_zh: string; name_en: string | null }[]>([]);
  const [accounts, setAccounts] = useState<Record<string, LaunchConnection[]>>({});
  const request = useRef(0);
  const options = useRef({ producer: "", titles: new Map<string, string>(), episodes: new Map<string, { titleId: string; title: string; number: string }>() });

  const replaceQuery = useCallback((patch: Record<string, string>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); }
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [params, pathname, router]);

  // The search box is typed into, so it reaches the URL a beat later; the
  // other filters are single choices and go straight in.
  useEffect(() => {
    if (search === querySearch) return;
    const timer = window.setTimeout(() => replaceQuery({ q: search }), 300);
    return () => window.clearTimeout(timer);
  }, [search, querySearch, replaceQuery]);
  useEffect(() => { setSearch((current) => (current === querySearch ? current : querySearch)); }, [querySearch]);

  const listUrl = useMemo(() => {
    const query = new URLSearchParams();
    if (staff && producer) query.set("producer_id", producer);
    if (titleId) query.set("title_id", titleId);
    else if (title) query.set("title_id", title);
    if (episode) query.set("episode_id", episode);
    if (state !== "any") query.set("posted", state);
    const encoded = query.toString();
    return encoded ? `${base}?${encoded}` : base;
  }, [base, staff, producer, title, titleId, episode, state]);

  const load = useCallback(async () => {
    const sequence = ++request.current;
    try {
      const answer = await call<{ clips: ClipLibraryRow[] }>(listUrl);
      if (sequence !== request.current) return;
      setRows(answer.clips ?? []);
      setError("");
    } catch (e) {
      if (sequence === request.current) setError(errorText(e));
    } finally {
      if (sequence === request.current) setLoading(false);
    }
  }, [listUrl]);
  useEffect(() => { setLoading(true); void load(); }, [load]);

  // Capabilities and the producers list come from the launch workspace, which
  // already answers "may this person launch" — the same rule as posting.
  useEffect(() => {
    let active = true;
    void call<{ workspace: LaunchWorkspace }>(`${workspaceBase}/workspace${staff && producer ? `?producer_id=${encodeURIComponent(producer)}` : ""}`)
      .then(({ workspace }) => {
        if (!active) return;
        setCanPost(workspace.can_launch);
        setCanDownload(workspace.can_edit);
        if (workspace.producers?.length) setProducers(workspace.producers);
        setTitles(workspace.titles ?? []);
        if (!staff && workspace.producer_id) setAccounts((current) => ({ ...current, [workspace.producer_id]: workspace.connections.filter((c) => c.provider === "meta" && c.enabled) }));
      })
      .catch((e) => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [workspaceBase, staff, producer]);

  // A staff desk shows several producers at once, so the Meta accounts behind
  // the two post buttons are read once per producer that has a row here.
  const producerIds = useMemo(() => [...new Set(rows.map((r) => r.producer_id))].filter(Boolean), [rows]);
  useEffect(() => {
    if (!staff) return;
    let active = true;
    for (const id of producerIds.slice(0, 12)) {
      if (accounts[id]) continue;
      void call<{ workspace: LaunchWorkspace }>(`${workspaceBase}/workspace?producer_id=${encodeURIComponent(id)}`)
        .then(({ workspace }) => { if (active) setAccounts((current) => ({ ...current, [id]: workspace.connections.filter((c) => c.provider === "meta" && c.enabled) })); })
        .catch(() => { if (active) setAccounts((current) => ({ ...current, [id]: [] })); });
    }
    return () => { active = false; };
  }, [staff, producerIds, accounts, workspaceBase]);

  // Publishing runs in the background; the row follows its own post row.
  const publishing = useMemo(() => rows.flatMap((r) => (r.posts ?? []).filter((p) => p.status === "publishing").map((p) => p.id)), [rows]);
  const publishingKey = publishing.join(",");
  useEffect(() => {
    if (!publishingKey) return;
    let active = true;
    const tick = async () => {
      for (const id of publishingKey.split(",")) {
        try {
          const { post } = await call<{ post: ClipPost }>(`${base}/posts/${encodeURIComponent(id)}`);
          if (!active) return;
          setRows((current) => current.map((row) => (row.posts?.some((p) => p.id === post.id) ? { ...row, posts: row.posts.map((p) => (p.id === post.id ? post : p)) } : row)));
        } catch { /* a transient read failure just waits for the next tick */ }
      }
    };
    const timer = window.setInterval(() => { void tick(); }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [publishingKey, base]);

  if (options.current.producer !== producer) options.current = { producer, titles: new Map(), episodes: new Map() };
  for (const row of rows) {
    if (row.title_id) options.current.titles.set(row.title_id, row.title_name);
    // A 60-second ad names several episodes and an uploaded ad names none, so
    // neither adds an option to the Episode filter.
    if (row.episode_id && !row.montage && !row.uploaded && row.episode_label) options.current.episodes.set(row.episode_id, { titleId: row.title_id, title: row.title_name, number: row.episode_label });
  }
  const titleOptions = [...options.current.titles.entries()];
  // `episode_label` is the bare number, so across several titles the list would
  // read 1 2 4 1 2 …: one title chosen narrows it to that title's episodes, and
  // otherwise every option names its title too.
  const chosenTitle = titleId || title;
  const episodeOptions = [...options.current.episodes.entries()]
    .filter(([, item]) => !chosenTitle || item.titleId === chosenTitle)
    .sort((a, b) => a[1].title.localeCompare(b[1].title) || Number(a[1].number) - Number(b[1].number))
    .map(([id, item]) => [id, chosenTitle ? tt("clipsPosting.episodeN", { n: item.number }) : `${item.title} · ${tt("clipsPosting.episodeN", { n: item.number })}`] as const);

  const needle = search.trim().toLowerCase();
  const visible = needle ? rows.filter((row) => `${row.label} ${row.title_name} ${row.episode_label ?? ""}`.toLowerCase().includes(needle)) : rows;
  const filtered = !!(producer || title || episode || search.trim() || state !== "any");
  const selectedIds = visible.filter((row) => chosen[row.id]).map((row) => row.id);

  function applyPost(post: ClipPost) {
    setRows((current) => current.map((row) => (row.id === post.clip_id
      ? { ...row, posts: [post, ...(row.posts ?? []).filter((p) => p.id !== post.id)] }
      : row)));
  }
  // The producer's bulk download, kept from the card list this table replaced.
  async function downloadZip(ids: string[]) {
    if (!ids.length || ids.length > 30) { setError(tt("lv2.clips.zipLimit")); return; }
    setZipping(true); setError("");
    try {
      const response = await fetch("/api/producer/clips/download", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clip_ids: ids }) });
      if (!response.ok) { const failure = await response.json().catch(() => ({})) as { error?: string }; throw new Error(failure.error ?? `HTTP ${response.status}`); }
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = objectUrl; link.download = "studio-clips.zip"; document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (e) { setError(errorText(e)); }
    finally { setZipping(false); }
  }
  async function retry(row: ClipLibraryRow, post: ClipPost) {
    setBusy(post.id); setRowError((x) => ({ ...x, [row.id]: "" }));
    try { applyPost((await call<{ post: ClipPost }>(`${base}/posts/${encodeURIComponent(post.id)}/retry`, "POST")).post); }
    catch (e) { setRowError((x) => ({ ...x, [row.id]: errorText(e) })); }
    finally { setBusy(""); }
  }

  function platformCell(row: ClipLibraryRow, platform: ClipPostPlatform) {
    const post = postOn(row.posts, platform);
    if (!post) return <span className="clips-state clips-state-idle">{tt("clipsPosting.state.notPosted")}</span>;
    if (post.status === "publishing") return <span className="clips-state clips-state-busy">{tt("clipsPosting.state.publishing")}<small>{tt(`clipsPosting.step.${post.step}`)}</small></span>;
    if (post.status === "failed") return <span className="clips-state clips-state-bad">
      {tt("clipsPosting.state.failed", { reason: post.error ?? "—" })}
      <button type="button" className="btn btn-outline btn-sm" disabled={!!busy || !canPost} onClick={() => void retry(row, post)}>{tt("clipsPosting.retry")}</button>
    </span>;
    const when = shortDate(post.published_at ?? post.updated_at, locale);
    return <span className="clips-state clips-state-good">
      {post.permalink
        ? <a href={post.permalink} target="_blank" rel="noreferrer">{tt("clipsPosting.state.posted", { date: when })}</a>
        : tt("clipsPosting.state.posted", { date: when })}
    </span>;
  }

  function postButton(row: ClipLibraryRow, platform: ClipPostPlatform) {
    const connections = accounts[row.producer_id];
    const usable = (connections ?? []).filter((c) => c.page_id && (platform === "facebook" || c.instagram_id));
    const hint = !canPost ? tt("clipsPosting.cannotPost")
      : connections && !connections.some((c) => c.page_id) ? tt("clipsPosting.noConnection")
      : connections && !usable.length ? tt("clipsPosting.noInstagram") : "";
    // "Post again" only once every usable account already carries a live post;
    // the dialog decides per chosen account whether this really is a second one.
    const everywhere = usable.length > 0 && usable.every((c) => publishedOn(row.posts, platform, c.id));
    return <button type="button" className="btn btn-outline btn-sm" title={hint || undefined}
      disabled={!!busy || !!hint || (!!connections && !usable.length)}
      onClick={() => setOpening({ clip: row, platform })}>
      {everywhere ? tt("clipsPosting.postAgain") : tt(platform === "facebook" ? "clipsPosting.postToFacebook" : "clipsPosting.postToInstagram")}
    </button>;
  }

  // Staff previewing the producer portal see every company's clips, so the
  // producer column appears whenever the rows span more than one.
  const showProducer = staff || new Set(visible.map((row) => row.producer_id)).size > 1;
  const columns = showProducer
    ? "64px minmax(96px,0.9fr) minmax(104px,1.1fr) 62px minmax(140px,1.6fr) 56px 74px minmax(124px,1fr) minmax(124px,1fr) 236px"
    : "88px minmax(110px,1.2fr) 66px minmax(150px,1.6fr) 56px 74px minmax(130px,1fr) minmax(130px,1fr) 236px";

  return <div className="launch-flow clips-desk">
    <div className="page-head">
      <div><h1>{tt("lv2.clips.title")}</h1><p className="page-sub">{tt(staff ? "clipsPosting.staffSub" : "clipsPosting.sub")}</p></div>
      <div className="rs-tool-row"><Link className="btn btn-primary" href={staff ? "/promote/launches" : "/producer/launch"}>{tt("lv2.launch.title")}</Link></div>
    </div>
    <div className="note"><p>{tt("lv2.clips.steps")}</p></div>
    {titleId && montage && <div className="card pd-panel ad-montage-card"><AdMontage titleId={titleId} initial={montage.initial} canBuild={montage.canBuild} staff={staff} onBuilt={() => void load()} /></div>}
    {canPost && (titleId || titles.length > 0) && <div className="card pd-panel upload-ads-card">
      <h2 className="section-title">{tt("uc.cta")}</h2>
      <UploadAds titles={titles} titleId={titleId} onUploaded={() => void load()} />
    </div>}

    <div className="clips-filters" role="group" aria-label={tt("clipsPosting.filters")}>
      {staff && <label><span>{tt("clipsPosting.filter.producer")}</span>
        <select className="select" value={producer} onChange={(e) => replaceQuery({ producer: e.target.value, title: "", episode: "" })}>
          <option value="">{tt("clipsPosting.filter.all")}</option>
          {producers.map((p) => <option key={p.id} value={p.id}>{p.name_en || p.name_zh}</option>)}
        </select></label>}
      {!titleId && <label><span>{tt("clipsPosting.filter.title")}</span>
        <select className="select" value={title} onChange={(e) => replaceQuery({ title: e.target.value, episode: "" })}>
          <option value="">{tt("clipsPosting.filter.all")}</option>
          {titleOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>}
      <label><span>{tt("clipsPosting.filter.episode")}</span>
        <select className="select" value={episode} onChange={(e) => replaceQuery({ episode: e.target.value })}>
          <option value="">{tt("clipsPosting.filter.all")}</option>
          {episodeOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select></label>
      <label><span>{tt("clipsPosting.filter.state")}</span>
        <select className="select" value={state} onChange={(e) => replaceQuery({ state: e.target.value === "any" ? "" : e.target.value })}>
          {POSTED_FILTERS.map((value) => <option key={value} value={value}>{tt(FILTER_KEY[value])}</option>)}
        </select></label>
      <label><span>{tt("clipsPosting.filter.search")}</span>
        <input className="input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
      <span className="clips-filter-count">{loading ? tt("common.loading") : tt("clipsPosting.count", { n: visible.length })}</span>
      {filtered && <button type="button" className="btn btn-outline btn-sm" onClick={() => { setSearch(""); router.replace(pathname, { scroll: false }); }}>{tt("clipsPosting.filter.clear")}</button>}
    </div>

    {!staff && canDownload && <div className="rs-tool-row">
      <button type="button" className="btn btn-outline btn-sm" disabled={zipping || !selectedIds.length || selectedIds.length > 30} onClick={() => void downloadZip(selectedIds)}>{tt("lv2.clips.downloadSelected")}</button>
      <button type="button" className="btn btn-outline btn-sm" disabled={zipping || !visible.length || visible.length > 30} onClick={() => void downloadZip(visible.map((row) => row.id))}>{tt("lv2.clips.downloadAll")}</button>
      <span className="clips-filter-count">{tt("contentPicker.chosen", { n: selectedIds.length })}</span>
    </div>}
    {!staff && !loading && visible.length > 30 && <p className="note">{tt("clipsAcceptance.downloadLimit")}</p>}

    {error && <p className="note note-warn" role="alert">{error}</p>}
    {loading && <p role="status">{tt("clipsAcceptance.loading")}</p>}
    {!loading && !error && !visible.length && <div className="empty"><p>{tt(filtered ? "clipsPosting.noMatches" : "lv2.clips.empty")}</p>{!filtered && <Link href={staff ? "/titles" : "/producer/titles"} className="btn btn-outline">{tt("lv2.clips.openTitles")}</Link>}</div>}

    {!!visible.length && <div className="gtable clips-table" style={{ "--cols": columns } as React.CSSProperties}>
      <div className="gt-head">
        <span>{tt("clipsPosting.col.preview")}</span>
        {showProducer && <span>{tt("clipsPosting.col.producer")}</span>}
        <span>{tt("clipsPosting.col.title")}</span>
        <span>{tt("clipsPosting.col.episode")}</span>
        <span>{tt("clipsPosting.col.hook")}</span>
        <span>{tt("clipsPosting.col.duration")}</span>
        <span>{tt("clipsPosting.col.rendered")}</span>
        <span>Facebook</span>
        <span>Instagram</span>
        <span><span className="sr-only">{tt("clipsPosting.col.actions")}</span></span>
      </div>
      {visible.map((row) => <div className="gt-row clips-row" key={row.id} data-clip-id={row.id}>
        <span className="clips-poster">
          {!staff && canDownload && <input type="checkbox" aria-label={tt("lv2.clips.choose")} checked={!!chosen[row.id]} onChange={(event) => setChosen((x) => ({ ...x, [row.id]: event.target.checked }))} />}
          {row.media_url
            ? <video src={row.media_url} poster={row.thumbnail_url ?? undefined} controls playsInline preload="metadata" />
            : <span className="gt-muted">—</span>}
        </span>
        {showProducer && <span>{row.producer_name}</span>}
        <span><strong>{row.title_name}</strong></span>
        <span>{row.montage ? row.montage.episodes : row.episode_label ?? "—"}</span>
        <span className="clips-hook">{row.montage && <span className="pill pill-accent clips-montage-pill">{tt("montage.pill")}</span>}{row.uploaded && <span className="pill pill-accent clips-montage-pill">{tt("uc.pill")}</span>}{row.text?.trim() ? row.label : <span className="gt-muted" title={row.external_id}>{tt("clipsPosting.noHook")}</span>}</span>
        <span className="gt-num">{duration(row.duration_ms)}</span>
        <span>{shortDate(row.rendered_at, locale)}</span>
        <span data-platform="facebook">{platformCell(row, "facebook")}</span>
        <span data-platform="instagram">{platformCell(row, "instagram")}</span>
        <span className="clips-actions">
          {postButton(row, "facebook")}
          {postButton(row, "instagram")}
          {row.media_url && <a className="btn btn-outline btn-sm" href={row.media_url} download>{tt("clipsPosting.download")}</a>}
          {rowError[row.id] && <span className="note note-warn clips-row-error" role="alert">{rowError[row.id]}</span>}
        </span>
      </div>)}
    </div>}

    {opening && <PostClipDialog
      base={base} clip={opening.clip} platform={opening.platform} posts={opening.clip.posts}
      connections={(accounts[opening.clip.producer_id] ?? []).filter((c) => c.page_id && (opening.platform === "facebook" || c.instagram_id))}
      onClose={() => setOpening(null)}
      onPosted={(post) => { applyPost(post); setOpening(null); }} />}
  </div>;
}
