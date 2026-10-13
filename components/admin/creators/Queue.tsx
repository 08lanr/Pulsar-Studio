"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import { formatInZone, utcToZoned, zonedToUtc } from "@/lib/creators/time";
import type { CreatorPost, CreatorPostKind } from "@/lib/creators/types";
import { call, type MediaView } from "./api";

// The Queue tab (decision 2026-10-12): what goes out next, what failed and
// what is on Instagram, and the "New post" panel — media from the library in
// order, the type, a caption (with three written options on request) and a
// time in the account's own time zone. Post now and Schedule are the two
// buttons that reach Instagram; Post now asks first.

type Props = { accountId: string; handle: string; timezone: string; posts: CreatorPost[]; media: MediaView[]; canAdmin: boolean };

const KINDS: CreatorPostKind[] = ["image", "carousel", "reel"];
const pillOf: Record<CreatorPost["status"], string> = {
  draft: "pill-neutral", scheduled: "pill-accent", publishing: "pill-warning", published: "pill-success", failed: "pill-error", cancelled: "pill-neutral",
};

function Thumb({ m }: { m: MediaView | undefined }) {
  if (!m) return <span className="cr-thumb cr-thumb-empty" aria-hidden />;
  return m.kind === "image"
    ? <img className="cr-thumb" src={m.url} alt={m.description || m.filename} loading="lazy" />
    : <video className="cr-thumb" src={m.url} preload="metadata" muted aria-label={m.description || m.filename} />;
}

export default function Queue({ accountId, handle, timezone, posts, media, canAdmin }: Props) {
  const { tt } = useT();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const byId = useMemo(() => new Map(media.map(m => [m.id, m])), [media]);

  // While something is publishing, the row moves by itself: re-read every few seconds.
  const publishing = posts.some(p => p.status === "publishing");
  useEffect(() => {
    if (!publishing) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [publishing, router]);

  const act = async (post: CreatorPost, action: "now" | "retry" | "cancel") => {
    if (action === "now" && !window.confirm(tt("cr.queue.confirmNow", { handle }))) return;
    setBusy(post.id); setError(null);
    const r = await call(`/api/admin/creators/${accountId}/posts/${post.id}`, "POST", { action, revision: post.revision });
    setBusy(null);
    if (!r.ok) setError(r.error);
    router.refresh();
  };

  const upcoming = posts.filter(p => ["draft", "scheduled", "publishing"].includes(p.status))
    .sort((a, b) => (a.scheduled_at ?? "9").localeCompare(b.scheduled_at ?? "9"));
  const failed = posts.filter(p => p.status === "failed");
  const published = posts.filter(p => p.status === "published").sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? "")).slice(0, 30);

  const row = (p: CreatorPost) => (
    <div key={p.id} className="cr-post">
      <div className="cr-post-media">{p.media_ids.slice(0, 3).map(id => <Thumb key={id} m={byId.get(id)} />)}{p.media_ids.length > 3 && <span className="hint">+{p.media_ids.length - 3}</span>}</div>
      <div className="cr-post-body">
        <div className="cr-post-meta">
          <span className={`pill ${pillOf[p.status]}`}>{tt(`cr.post.${p.status}`)}</span>
          <span className="pill pill-neutral">{tt(`cr.kind.${p.kind}`)}</span>
          <span className="gt-muted">{tt("cr.queue.at", { time: formatInZone(p.published_at ?? p.scheduled_at, timezone), tz: timezone })}</span>
          <span className="gt-muted">{p.external_id}</span>
        </div>
        <p className="cr-caption">{p.caption || "—"}</p>
        {p.error && <p className="err">{p.error}</p>}
      </div>
      <div className="cr-post-actions">
        {p.permalink && <a className="btn btn-sm btn-outline" href={p.permalink} target="_blank" rel="noreferrer">{tt("cr.queue.open")}</a>}
        {canAdmin && ["draft", "scheduled"].includes(p.status) && <button type="button" className="btn btn-sm btn-primary" disabled={busy === p.id} onClick={() => void act(p, "now")}>{tt("cr.queue.postNow")}</button>}
        {canAdmin && p.status === "failed" && <button type="button" className="btn btn-sm btn-primary" disabled={busy === p.id} onClick={() => void act(p, "retry")}>{tt("cr.queue.retry")}</button>}
        {canAdmin && ["draft", "scheduled", "failed"].includes(p.status) && <button type="button" className="btn btn-sm btn-ghost" disabled={busy === p.id} onClick={() => void act(p, "cancel")}>{tt("cr.queue.cancel")}</button>}
      </div>
    </div>
  );

  const section = (title: string, list: CreatorPost[]) => (
    <section className="cr-section">
      <h2 className="section-title">{title} <span className="gt-muted">{list.length}</span></h2>
      {list.length ? <div className="cr-posts">{list.map(row)}</div> : <p className="hint">{tt("cr.queue.none")}</p>}
    </section>
  );

  return (
    <div>
      {canAdmin && (
        <div className="cr-toolbar">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(o => !o)}>{open ? tt("cr.queue.close") : tt("cr.queue.new")}</button>
        </div>
      )}
      {open && <NewPost accountId={accountId} handle={handle} timezone={timezone} media={media} onDone={() => { setOpen(false); router.refresh(); }} />}
      {error && <p className="err" role="alert">{error}</p>}
      {section(tt("cr.queue.upcoming"), upcoming)}
      {failed.length > 0 && section(tt("cr.queue.failed"), failed)}
      {section(tt("cr.queue.published"), published)}
    </div>
  );
}

function NewPost({ accountId, handle, timezone, media, onDone }: { accountId: string; handle: string; timezone: string; media: MediaView[]; onDone: () => void }) {
  const { tt } = useT();
  const [kind, setKind] = useState<CreatorPostKind>("image");
  const [picked, setPicked] = useState<string[]>([]);
  const [caption, setCaption] = useState("");
  const [notes, setNotes] = useState("");
  const [options, setOptions] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [when, setWhen] = useState(() => utcToZoned(new Date(Date.now() + 2 * 3600_000).toISOString(), timezone));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const usable = media.filter(m => kind === "image" ? m.kind === "image" : kind === "reel" ? m.kind === "video" : true);
  const max = kind === "carousel" ? 10 : 1;
  const toggle = (id: string) => setPicked(list => list.includes(id) ? list.filter(x => x !== id) : max === 1 ? [id] : list.length >= max ? list : [...list, id]);
  const switchKind = (k: CreatorPostKind) => { setKind(k); setPicked([]); setOptions([]); };

  const write = async () => {
    setBusy("write"); setError(null);
    const next = attempt + 1;
    const r = await call<{ options: string[]; note: string | null }>(`/api/admin/creators/${accountId}/captions`, "POST", { kind, media_ids: picked, notes: notes || null, attempt: next });
    setBusy(null);
    if (!r.ok) { setError(r.error); return; }
    setAttempt(next); setOptions(r.data.options); setNote(r.data.note);
  };

  const submit = async (mode: "draft" | "schedule" | "now") => {
    if (mode === "now" && !window.confirm(tt("cr.queue.confirmNow", { handle }))) return;
    const scheduled_at = mode === "schedule" ? zonedToUtc(when, timezone) : null;
    setBusy(mode); setError(null);
    const r = await call(`/api/admin/creators/${accountId}/posts`, "POST", { kind, media_ids: picked, caption, when: mode, scheduled_at });
    setBusy(null);
    if (!r.ok) { setError(r.error); return; }
    onDone();
  };

  return (
    <div className="card cr-new">
      <span className="label">{tt("cr.new.kind")}</span>
      <div className="seg" role="tablist">
        {KINDS.map(k => <button key={k} type="button" role="tab" aria-selected={kind === k} className={`seg-btn ${kind === k ? "on" : ""}`} onClick={() => switchKind(k)}>{tt(`cr.kind.${k}`)}</button>)}
      </div>
      <span className="label">{tt("cr.new.media")}</span>
      <p className="hint">{tt("cr.new.mediaHint")}</p>
      {usable.length ? (
        <div className="cr-pick">
          {usable.map(m => {
            const at = picked.indexOf(m.id);
            return (
              <button key={m.id} type="button" className={`cr-pick-item${at >= 0 ? " on" : ""}`} onClick={() => toggle(m.id)} title={m.description || m.filename} aria-pressed={at >= 0}>
                <Thumb m={m} />
                {at >= 0 && <span className="cr-pick-n">{at + 1}</span>}
              </button>
            );
          })}
        </div>
      ) : <p className="hint">{tt("cr.new.libraryEmpty")}</p>}

      <label className="label" htmlFor="cr-caption">{tt("cr.new.caption")}</label>
      <textarea id="cr-caption" className="textarea input" rows={4} maxLength={2200} value={caption} onChange={e => setCaption(e.target.value)} />
      <div className="cr-write">
        <input className="input" placeholder={tt("cr.new.notes")} value={notes} maxLength={500} onChange={e => setNotes(e.target.value)} />
        <button type="button" className="btn btn-sm btn-outline" disabled={!picked.length || busy !== null} onClick={() => void write()}>
          {busy === "write" ? tt("cr.new.writing") : attempt ? tt("cr.new.writeAgain") : tt("cr.new.write")}
        </button>
      </div>
      {note && <p className="hint">{note}</p>}
      {options.length > 0 && (
        <ul className="cr-options">
          {options.map(o => (
            <li key={o}><p className="cr-caption">{o}</p><button type="button" className="btn btn-sm btn-ghost" onClick={() => setCaption(o)}>{tt("cr.new.use")}</button></li>
          ))}
        </ul>
      )}

      <label className="label" htmlFor="cr-when">{tt("cr.new.when", { tz: timezone })}</label>
      <input id="cr-when" className="input input-inline" type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} />
      {error && <p className="err" role="alert">{error}</p>}
      <div className="form-actions cr-actions">
        <button type="button" className="btn btn-sm btn-ghost" disabled={!picked.length || busy !== null} onClick={() => void submit("draft")}>{tt("cr.new.draft")}</button>
        <button type="button" className="btn btn-sm btn-outline" disabled={!picked.length || busy !== null} onClick={() => void submit("schedule")}>{tt("cr.new.schedule")}</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!picked.length || busy !== null} onClick={() => void submit("now")}>{tt("cr.queue.postNow")}</button>
      </div>
    </div>
  );
}
