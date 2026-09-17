"use client";

// Publishing a clip as a public post (plan §5.1). One dialog for both
// platforms: the account, the caption (the hook on line one, the title on line
// two, editable), one plain sentence naming what is about to happen in public,
// and Confirm. The work is detached on the server, so Confirm returns a
// `publishing` row and the table takes over the polling.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/components/locale";
import { call } from "@/components/tiktok/api";
import { publishedOn } from "@/components/launch/clip-state";
import type { ClipPost, ClipPostPlatform } from "@/lib/launch/clip-posts";
import type { LaunchConnection } from "@/lib/launch/types";

/** What the dialog needs of a clip; a `ClipLibraryRow` satisfies it. */
export type PostableClip = { id: string; label?: string; title_name: string; episode_label?: string | null };
type Props = {
  base: string; clip: PostableClip; platform: ClipPostPlatform;
  /** Every attempt on this clip, so "post again" is judged against the chosen account. */
  posts?: ClipPost[];
  connections: LaunchConnection[];
  onClose: () => void; onPosted: (post: ClipPost) => void;
};

export const defaultCaption = (clip: PostableClip) => `${clip.label ?? ""}\n${clip.title_name}`;

export default function PostClipDialog({ base, clip, platform, posts, connections, onClose, onPosted }: Props) {
  const { tt } = useT();
  const panel = useRef<HTMLDivElement>(null);
  const [connectionId, setConnectionId] = useState(connections.length === 1 ? connections[0].id : "");
  const [caption, setCaption] = useState(() => defaultCaption(clip));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab" || !panel.current) return;
      const controls = Array.from(panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled)"));
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [onClose]);

  const chosen = connections.find((c) => c.id === connectionId) ?? null;
  const destination = chosen?.name ?? "";
  // A second post is only a second post on the account that already holds one.
  // The heading names the platform and never moves under the reader; only the
  // warning and the confirm button change once the chosen account is known.
  const again = !!chosen && !!publishedOn(posts, platform, chosen.id);
  const heading = tt(platform === "facebook" ? "clipsPosting.postToFacebook" : "clipsPosting.postToInstagram");

  async function confirm() {
    if (busy) return;
    if (!chosen) { setError(tt("clipsPosting.noConnection")); return; }
    setBusy(true); setError("");
    try {
      const answer = await call<{ post: ClipPost }>(`${base}/${encodeURIComponent(clip.id)}/post`, "POST", {
        platform, connection_id: chosen.id, caption, ...(again ? { again: true } : {}),
      });
      onPosted(answer.post);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return createPortal(<div className="launch-dialog-backdrop launch-confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="launch-dialog launch-confirm-dialog clips-post-dialog" style={{ width: "min(560px, 100%)", maxWidth: 560 }} ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="clip-post-title">
      <h2 id="clip-post-title">{heading}</h2>
      <p className="clips-post-clip"><span className="label">{tt("clipsPosting.dialog.clip")}</span><strong>{clip.label || clip.title_name}</strong><small>{clip.title_name}{clip.episode_label ? ` · ${clip.episode_label}` : ""}</small></p>
      {!connections.length && <p className="note note-warn" role="alert">{tt(platform === "instagram" ? "clipsPosting.noInstagram" : "clipsPosting.noConnection")}</p>}
      {connections.length > 0 && <label className="tk-field clips-post-field">{tt("clipsPosting.dialog.account")}
        <select className="select" value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
          <option value="">{tt("lv2.choose")}</option>
          {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>}
      <label className="tk-field clips-post-field">{tt("clipsPosting.dialog.caption")}
        <textarea className="input" rows={4} value={caption} onChange={(event) => setCaption(event.target.value)} />
        <span className="hint">{tt("clipsPosting.dialog.captionCount", { n: caption.length })}</span>
      </label>
      {again && <p className="note note-warn">{tt("clipsPosting.dialog.again")}</p>}
      {chosen && <p className="note">{tt("clipsPosting.dialog.publicWarning", { name: destination })}</p>}
      {error && <p className="note note-warn" role="alert">{error}</p>}
      <div className="rs-tool-row">
        <button type="button" className="btn btn-outline" disabled={busy} onClick={onClose}>{tt("common.cancel")}</button>
        <button type="button" className="btn btn-primary" disabled={busy || !chosen || !caption.trim()} onClick={() => void confirm()}>{busy ? tt("common.loading") : tt(again ? "clipsPosting.postAgain" : "clipsPosting.dialog.confirm")}</button>
      </div>
    </div>
  </div>, document.body);
}
