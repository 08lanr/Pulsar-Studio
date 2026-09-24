"use client";

// Step 3 of a Meta launch (plan §5.2). The bare id box is now one of three
// tabs behind a single "Choose content" button:
//
//   Studio clips   — the producer's finished clips with their posting state.
//                    A posted clip is added by its post id and carries a human
//                    label; an unposted clip offers the two post buttons right
//                    here and is added the moment the post finishes.
//   From the Page  — posts and Reels made outside Studio, read through the
//                    selected ad account.
//   Paste an id    — the box that used to be the only way in.
//
// Nothing in here shows a raw id first: every entry carries `label`
// (title · hook) with the id beneath it in small text.

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/components/locale";
import { call } from "@/components/tiktok/api";
import PostClipDialog from "@/components/launch/PostClipDialog";
import { postOn, publishedOn, shortDate } from "@/components/launch/clip-state";
import type { ClipLibraryRow, ClipPost, ClipPostPlatform, MetaPagePost, MetaPagePostList } from "@/lib/launch/clip-posts";
import type { LaunchConnection, LaunchContent, LaunchLibraryItem } from "@/lib/launch/types";

/** A workspace library item, with the clip-post fields once they are there. */
export type PickerClip = LaunchLibraryItem & Partial<Omit<ClipLibraryRow, keyof LaunchLibraryItem>>;
type Tab = "clips" | "page" | "paste";
type Props = {
  clipsBase: string; pagePostsUrl: string; producerId?: string;
  library: PickerClip[]; connections: LaunchConnection[]; accountIds: string[];
  placements: ("facebook" | "instagram")[]; content: LaunchContent[]; canPost: boolean;
  onChange: (content: LaunchContent[]) => void; onClose: () => void;
  /** What this dialog read from the Page, so the launch screen can preview the posts it holds. */
  onPostMeta?: (posts: Record<string, MetaPagePost>) => void;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const PLATFORMS: ClipPostPlatform[] = ["facebook", "instagram"];
const platformWord = (platform: ClipPostPlatform) => (platform === "facebook" ? "Facebook" : "Instagram");
const same = (a: LaunchContent, b: LaunchContent) => a.kind === b.kind && a.value === b.value;
export const contentLabel = (item: LaunchContent) => item.label ?? item.value;

export default function ContentPicker({ clipsBase, pagePostsUrl, producerId, library, connections, accountIds, placements, content, canPost, onChange, onClose, onPostMeta }: Props) {
  const { tt, locale } = useT();
  const [tab, setTab] = useState<Tab>("clips");
  const [clips, setClips] = useState<PickerClip[]>(library);
  const [pageAccount, setPageAccount] = useState(accountIds[0] ?? connections[0]?.id ?? "");
  const [pagePosts, setPagePosts] = useState<MetaPagePostList | null>(null);
  const [pageBusy, setPageBusy] = useState(false);
  const [pageError, setPageError] = useState("");
  const [pasteKind, setPasteKind] = useState<ClipPostPlatform>("facebook");
  const [pasteValue, setPasteValue] = useState("");
  const [opening, setOpening] = useState<{ clip: PickerClip; platform: ClipPostPlatform } | null>(null);
  const [adding, setAdding] = useState<string[]>([]);

  useEffect(() => { setClips(library); }, [library]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [onClose]);

  const wantsInstagram = placements.includes("instagram");
  const has = useCallback((item: LaunchContent) => content.some((x) => same(x, item)), [content]);
  const add = useCallback((items: LaunchContent[]) => {
    const fresh = items.filter((item) => item.value && !content.some((x) => same(x, item)));
    if (fresh.length) onChange([...content, ...fresh]);
  }, [content, onChange]);
  const remove = (item: LaunchContent) => onChange(content.filter((x) => !same(x, item)));

  /** The entries one clip contributes: its Facebook post, plus Instagram when the placements ask for it. */
  const fileEntry = useCallback((clip: PickerClip): LaunchContent => ({
    kind: "video", value: clip.value, label: `${clip.title_name} · ${clip.label ?? clip.value}`,
    creative_id: clip.creative_id, title_id: clip.title_id, text: clip.text, headline: clip.headline,
  }), []);
  const entriesFor = useCallback((clip: PickerClip): LaunchContent[] => {
    const out: LaunchContent[] = [];
    const label = `${clip.title_name} · ${clip.label ?? clip.value}`;
    const facebook = publishedOn(clip.posts, "facebook");
    if (facebook?.external_post_id) out.push({ kind: "facebook_post", value: facebook.external_post_id, label, clip_id: clip.id, post_id: facebook.id, title_id: clip.title_id });
    const instagram = publishedOn(clip.posts, "instagram");
    if (wantsInstagram && instagram?.external_post_id) out.push({ kind: "instagram_post", value: instagram.external_post_id, label, clip_id: clip.id, post_id: instagram.id, title_id: clip.title_id });
    return out;
  }, [wantsInstagram]);

  // A clip posted from inside this dialog joins the draft as soon as its post
  // settles; until then the row shows the state and this list holds its id.
  const publishing = useMemo(() => clips.flatMap((c) => (c.posts ?? []).filter((p) => p.status === "publishing").map((p) => p.id)), [clips]);
  const publishingKey = publishing.join(",");
  useEffect(() => {
    if (!publishingKey) return;
    let active = true;
    const tick = async () => {
      for (const id of publishingKey.split(",")) {
        try {
          const { post } = await call<{ post: ClipPost }>(`${clipsBase}/posts/${encodeURIComponent(id)}`);
          if (!active) return;
          setClips((current) => current.map((clip) => (clip.posts?.some((p) => p.id === post.id) ? { ...clip, posts: clip.posts!.map((p) => (p.id === post.id ? post : p)) } : clip)));
        } catch { /* try again on the next tick */ }
      }
    };
    const timer = window.setInterval(() => { void tick(); }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [publishingKey, clipsBase]);

  // Clips whose post finished while the dialog was open are added once.
  useEffect(() => {
    if (!adding.length) return;
    const settled = clips.filter((clip) => adding.includes(clip.id) && entriesFor(clip).length);
    if (!settled.length) return;
    add(settled.flatMap(entriesFor));
    setAdding((current) => current.filter((id) => !settled.some((clip) => clip.id === id)));
  }, [clips, adding, entriesFor, add]);

  const loadPagePosts = useCallback(async (connectionId: string) => {
    if (!connectionId) return;
    setPageBusy(true); setPageError(""); setPagePosts(null);
    // A staff session names the company it is acting for; a producer session is always its own.
    const query = new URLSearchParams({ connection_id: connectionId, ...(producerId ? { producer_id: producerId } : {}) });
    try {
      const listed = await call<MetaPagePostList>(`${pagePostsUrl}?${query}`);
      setPagePosts(listed);
      // The launch screen previews a chosen post from this listing; nothing new
      // is stored on the draft for it.
      onPostMeta?.(Object.fromEntries([...listed.facebook, ...listed.instagram].map(post => [post.id, post])));
    }
    catch (e) { setPageError(errorText(e)); }
    finally { setPageBusy(false); }
  }, [pagePostsUrl, producerId, onPostMeta]);
  useEffect(() => { if (tab === "page" && pageAccount && !pagePosts && !pageBusy && !pageError) void loadPagePosts(pageAccount); }, [tab, pageAccount, pagePosts, pageBusy, pageError, loadPagePosts]);

  // Each state cell says which platform it speaks for; in a flex row there is no
  // column header above it to do that job.
  function clipState(clip: PickerClip, platform: ClipPostPlatform) {
    const post = postOn(clip.posts, platform);
    if (!post) return <span className="clips-state clips-state-idle">{tt("clipsPosting.state.notPosted")}</span>;
    if (post.status === "publishing") return <span className="clips-state clips-state-busy">{tt("clipsPosting.state.publishing")}<small>{tt(`clipsPosting.step.${post.step}`)}</small></span>;
    if (post.status === "failed") return <span className="clips-state clips-state-bad">{tt("clipsPosting.state.failed", { reason: post.error ?? "—" })}</span>;
    return <span className="clips-state clips-state-good">{tt("clipsPosting.state.posted", { date: shortDate(post.published_at ?? post.updated_at, locale) })}</span>;
  }

  const metaConnections = connections.filter((c) => c.provider === "meta" && c.enabled);
  const postable = (clip: PickerClip, platform: ClipPostPlatform) =>
    metaConnections.filter((c) => c.page_id && (platform === "facebook" || c.instagram_id));

  return createPortal(<div className="launch-dialog-backdrop launch-confirm-backdrop content-picker-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="launch-dialog launch-confirm-dialog content-picker" style={{ width: "min(980px, 100%)", maxWidth: 980 }} role="dialog" aria-modal="true" aria-labelledby="content-picker-title">
      <h2 id="content-picker-title">{tt("contentPicker.title")}</h2>
      <div className="seg content-picker-tabs" role="tablist">
        {(["clips", "page", "paste"] as Tab[]).map((value) => <button type="button" role="tab" aria-selected={tab === value} key={value}
          className={`seg-btn${tab === value ? " on" : ""}`} onClick={() => setTab(value)}>{tt(`contentPicker.tab.${value}`)}</button>)}
      </div>

      {tab === "clips" && <div className="content-picker-body">
        {!clips.length && <p className="hint">{tt("contentPicker.clipsEmpty")}</p>}
        {clips.map((clip) => {
          const entries = entriesFor(clip);
          const chosen = entries.length > 0 && entries.every(has);
          return <div className="content-pick-row" key={clip.id} data-clip-id={clip.id}>
            <span className="clips-poster">{clip.media_url ? <video src={clip.media_url} poster={clip.thumbnail_url ?? undefined} preload="metadata" playsInline muted /> : <span className="gt-muted">—</span>}</span>
            <span className="content-pick-name"><strong>{clip.title_name}</strong><small>{clip.montage ? `${tt("montage.pill")} · ` : ""}{clip.label ?? clip.value}</small></span>
            {PLATFORMS.map((platform) => <span className="content-pick-state" key={platform}>
              <small>{platformWord(platform)}</small>{clipState(clip, platform)}
            </span>)}
            <span className="content-pick-actions">
              {entries.length > 0
                ? <button type="button" className={`btn btn-sm ${chosen ? "btn-primary" : "btn-outline"}`} onClick={() => (chosen ? entries.forEach(remove) : add(entries))}>{chosen ? `✓ ${tt("contentPicker.added")}` : tt("contentPicker.add")}</button>
                : <>
                  <button type="button" className={`btn btn-sm ${has(fileEntry(clip)) ? "btn-primary" : "btn-outline"}`} onClick={() => (has(fileEntry(clip)) ? remove(fileEntry(clip)) : add([fileEntry(clip)]))}>{has(fileEntry(clip)) ? `✓ ${tt("contentPicker.added")}` : tt("contentPicker.useFile")}</button>
                  <button type="button" className="btn btn-outline btn-sm" disabled={!canPost || !postable(clip, "facebook").length} title={!canPost ? tt("clipsPosting.cannotPost") : !postable(clip, "facebook").length ? tt("clipsPosting.noConnection") : undefined} onClick={() => setOpening({ clip, platform: "facebook" })}>{tt("clipsPosting.postToFacebook")}</button>
                  <button type="button" className="btn btn-outline btn-sm" disabled={!canPost || !postable(clip, "instagram").length} title={!canPost ? tt("clipsPosting.cannotPost") : !postable(clip, "instagram").length ? tt("clipsPosting.noInstagram") : undefined} onClick={() => setOpening({ clip, platform: "instagram" })}>{tt("clipsPosting.postToInstagram")}</button>
                </>}
              {entries.length > 1 && chosen && <small className="content-pick-note">{tt("contentPicker.instagramAdded")}</small>}
            </span>
          </div>;
        })}
      </div>}

      {tab === "page" && <div className="content-picker-body">
        <label className="tk-field clips-post-field">{tt("contentPicker.pageAccount")}
          <select className="select" value={pageAccount} onChange={(event) => { setPageAccount(event.target.value); setPagePosts(null); setPageError(""); }}>
            <option value="">{tt("lv2.choose")}</option>
            {metaConnections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {!pageAccount && <p className="hint">{tt("contentPicker.chooseAccount")}</p>}
        {pageBusy && <p role="status">{tt("common.loading")}</p>}
        {pageError && <p className="note note-warn" role="alert">{pageError}</p>}
        {pagePosts?.notes?.length ? <p className="note note-warn">{pagePosts.notes.join(" · ")}</p> : null}
        {pagePosts && PLATFORMS.map((platform) => {
          const list = platform === "facebook" ? pagePosts.facebook : pagePosts.instagram;
          return <section key={platform}>
            <h3>{tt(platform === "facebook" ? "contentPicker.facebookPosts" : "contentPicker.instagramPosts")}</h3>
            {!list.length && <p className="hint">{tt("contentPicker.pageEmpty")}</p>}
            {list.map((post) => {
              const item: LaunchContent = { kind: platform === "facebook" ? "facebook_post" : "instagram_post", value: post.id, label: post.caption.split("\n")[0].slice(0, 60) || post.id };
              return <div className="content-pick-row" key={`${platform}:${post.id}`}>
                <span className="clips-poster">{post.thumbnail_url ? <span className="clips-thumb" role="presentation" style={{ backgroundImage: `url(${JSON.stringify(post.thumbnail_url)})` }} /> : <span className="gt-muted">—</span>}</span>
                <span className="content-pick-name"><strong>{item.label}</strong><small>{post.id}</small></span>
                <span>{shortDate(post.created_at, locale)}</span>
                <span>{post.permalink ? <a href={post.permalink} target="_blank" rel="noreferrer">{tt("clipsPosting.openPost")}</a> : "—"}</span>
                <span className="content-pick-actions"><button type="button" className={`btn btn-sm ${has(item) ? "btn-primary" : "btn-outline"}`} onClick={() => (has(item) ? remove(item) : add([item]))}>{has(item) ? `✓ ${tt("contentPicker.added")}` : tt("contentPicker.add")}</button></span>
              </div>;
            })}
          </section>;
        })}
      </div>}

      {tab === "paste" && <div className="content-picker-body">
        <p className="hint">{tt("contentPicker.pasteHint")}</p>
        <div className="tk-field tk-row">
          <select className="select" value={pasteKind} onChange={(event) => setPasteKind(event.target.value as ClipPostPlatform)} aria-label={tt("lv2.postType")}>
            <option value="facebook">{tt("lr2.kind.facebook_post")}</option>
            <option value="instagram">{tt("lr2.kind.instagram_post")}</option>
          </select>
          <input className="input" value={pasteValue} onChange={(event) => setPasteValue(event.target.value)} aria-label={tt("lv2.postId")}
            placeholder={pasteKind === "facebook" ? "pageID_postID" : tt("lr2.pasteMediaId")} />
          <button type="button" className="btn btn-outline" disabled={!pasteValue.trim()} onClick={() => {
            const value = pasteValue.trim();
            if (!value) return;
            // A pasted reference is still named by what it is, so no card, row or
            // dialog anywhere downstream has to lead with the id.
            const kind = pasteKind === "facebook" ? "facebook_post" as const : "instagram_post" as const;
            add([{ kind, value, label: tt(`lr2.kind.${kind}`) }]);
            setPasteValue("");
          }}>{tt("lv2.addPost")}</button>
        </div>
      </div>}

      <section className="content-picker-chosen">
        <h3>{tt("contentPicker.selected")} <span className="pd-count">{content.length}</span></h3>
        {!content.length && <p className="hint">{tt("contentPicker.chosen", { n: 0 })}</p>}
        {content.map((item) => <div className="content-chosen-row" key={`${item.kind}:${item.value}`} data-content-id={item.value}>
          <span className="content-pick-name"><strong>{contentLabel(item)}</strong><small>{item.value}</small></span>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => remove(item)}>{tt("contentPicker.remove")}</button>
        </div>)}
      </section>

      <div className="rs-tool-row"><button type="button" className="btn btn-primary" onClick={onClose}>{tt("contentPicker.done")}</button></div>
    </div>

    {opening && <PostClipDialog base={clipsBase} clip={{ id: opening.clip.id, label: opening.clip.label, title_name: opening.clip.title_name, episode_label: opening.clip.episode_label }}
      platform={opening.platform} posts={opening.clip.posts} connections={postable(opening.clip, opening.platform)}
      onClose={() => setOpening(null)}
      onPosted={(post) => {
        setClips((current) => current.map((clip) => (clip.id === post.clip_id ? { ...clip, posts: [post, ...(clip.posts ?? []).filter((p) => p.id !== post.id)] } : clip)));
        setAdding((current) => (current.includes(post.clip_id) ? current : [...current, post.clip_id]));
        setOpening(null);
      }} />}
  </div>, document.body);
}
