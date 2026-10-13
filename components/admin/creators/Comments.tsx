"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import { formatInZone } from "@/lib/creators/time";
import type { CreatorComment } from "@/lib/creators/types";
import { call } from "./api";

// The Comments tab (decision 2026-10-12): every comment with Studio's decision
// and why, the drafted reply (editable) and when it goes out; Send now, Save
// reply and Skip. A flagged comment has no send button: Studio never answers it.

const FILTERS = ["all", "drafted", "flagged", "sent", "skipped", "failed"] as const;
type Filter = (typeof FILTERS)[number];
const pill: Record<CreatorComment["decision"], string> = { pending: "pill-neutral", reply: "pill-accent", skip: "pill-neutral", flag: "pill-warning" };
const matches = (c: CreatorComment, f: Filter) => f === "all" || (f === "flagged" ? c.decision === "flag" && c.status !== "skipped" : c.status === f);

export default function Comments({ accountId, handle, timezone, comments, autoReply, canAdmin }: { accountId: string; handle: string; timezone: string; comments: CreatorComment[]; autoReply: boolean; canAdmin: boolean }) {
  const { tt } = useT();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);

  const check = async () => {
    setBusy(true); setLine(null);
    const r = await call<{ read: { read: number; added: number }; decided: { drafted: number; flagged: number } }>(`/api/admin/creators/${accountId}/comments`, "POST");
    setBusy(false);
    setLine(r.ok ? tt("cr.com.checked", { read: r.data.read.read, added: r.data.read.added, drafted: r.data.decided.drafted, flagged: r.data.decided.flagged }) : r.error);
    router.refresh();
  };
  const shown = comments.filter(c => matches(c, filter));

  return (
    <div>
      <div className="cr-toolbar">
        <nav className="tabs cr-filter" aria-label={tt("cr.tab.comments")}>
          {FILTERS.map(f => (
            <button key={f} type="button" className={`tab${f === filter ? " on" : ""}`} aria-pressed={f === filter} onClick={() => setFilter(f)}>
              {tt(`cr.com.filter.${f}`)} <span className="n">{comments.filter(c => matches(c, f)).length}</span>
            </button>
          ))}
        </nav>
        {canAdmin && <button type="button" className="btn btn-sm btn-outline" disabled={busy} onClick={() => void check()}>{busy ? tt("cr.com.checking") : tt("cr.com.check")}</button>}
      </div>
      {line && <p className="hint" role="status">{line}</p>}
      {!autoReply && <p className="note note-warn">{tt("cr.com.autoOff")}</p>}
      {shown.length ? <div className="cr-comments">{shown.map(c => <Row key={c.id} c={c} accountId={accountId} handle={handle} timezone={timezone} canAdmin={canAdmin} />)}</div> : <p className="hint">{tt("cr.com.none")}</p>}
    </div>
  );
}

function Row({ c, accountId, handle, timezone, canAdmin }: { c: CreatorComment; accountId: string; handle: string; timezone: string; canAdmin: boolean }) {
  const { tt } = useT();
  const router = useRouter();
  const [reply, setReply] = useState(c.reply_text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = c.status !== "sent" && !c.reply_ig_id;
  const answerable = open && c.decision !== "flag" && !c.parent_ig_id;

  const act = async (action: "send" | "edit" | "skip") => {
    if (action === "send" && !window.confirm(tt("cr.com.confirmSend", { handle }))) return;
    setBusy(true); setError(null);
    const body = action === "skip" ? { action, revision: c.revision } : { action, revision: c.revision, reply_text: reply };
    const r = await call(`/api/admin/creators/${accountId}/comments/${c.id}`, "POST", body);
    setBusy(false);
    if (!r.ok) setError(r.error);
    router.refresh();
  };

  return (
    <div className="card cr-comment">
      <div className="cr-post-meta">
        <strong>@{c.username || "?"}</strong>
        <span className="gt-muted">{formatInZone(c.commented_at, timezone)}</span>
        {c.parent_ig_id && <span className="pill pill-neutral">{tt("cr.com.thread")}</span>}
        <span className={`pill ${pill[c.decision]}`}>{tt(`cr.com.decision.${c.decision}`)}</span>
        {c.status !== "new" && <span className="pill pill-neutral">{tt(`cr.com.filter.${c.status}`)}</span>}
      </div>
      <p className="cr-comment-text">{c.text}</p>
      {c.reason && <p className="hint">{c.reason}</p>}
      {c.decision === "flag" && open && <p className="hint">{tt("cr.com.flagNote")}</p>}
      {c.status === "sent" && c.reply_text && <p className="cr-reply">↳ {c.reply_text}</p>}
      {answerable && canAdmin && (
        <>
          <textarea className="textarea input" rows={2} maxLength={150} value={reply} onChange={e => setReply(e.target.value)} aria-label={tt("cr.com.saveEdit")} />
          <div className="cr-actions">
            {c.reply_due_at && c.status === "drafted" && <span className="hint">{tt("cr.com.due", { at: formatInZone(c.reply_due_at, timezone) })}</span>}
            <button type="button" className="btn btn-sm btn-primary" disabled={busy || !reply.trim()} onClick={() => void act("send")}>{tt("cr.com.send")}</button>
            <button type="button" className="btn btn-sm btn-outline" disabled={busy || !reply.trim() || reply === (c.reply_text ?? "")} onClick={() => void act("edit")}>{tt("cr.com.saveEdit")}</button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void act("skip")}>{tt("cr.com.skip")}</button>
          </div>
        </>
      )}
      {!answerable && open && canAdmin && c.status !== "skipped" && (
        <div className="cr-actions"><button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void act("skip")}>{tt("cr.com.skip")}</button></div>
      )}
      {c.error && <p className="err">{c.error}</p>}
      {error && <p className="err" role="alert">{error}</p>}
    </div>
  );
}
