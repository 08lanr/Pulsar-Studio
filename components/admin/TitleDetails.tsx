"use client";

// The Title details card (decision 2026-09-24 "Rename a title, choose its
// poster"): the title's name and poster, changed in one place and carried to
// the crazydramas web address (while it may still change) and to the title's
// own series on crazydramas. Choose poster opens the device's file window.
// A series already live asks once more before viewers see the change.

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useT } from "@/components/locale";
import type { DetailsResult } from "@/lib/titles/details";

type Props = {
  titleId: string;
  name: string;
  coverUrl: string | null;
  slug: string | null;
  canEdit: boolean;
};

type Reply = DetailsResult & { error?: string };
type Pending = { kind: "name" } | { kind: "poster"; file: File };

async function send(url: string, init: RequestInit): Promise<Reply> {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => ({}))) as Reply;
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export default function TitleDetails({ titleId, name: initialName, coverUrl, slug, canEdit }: Props) {
  const { tt } = useT();
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [saved, setSaved] = useState(initialName);
  const [cover, setCover] = useState(coverUrl);
  const [busy, setBusy] = useState<"name" | "poster" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ pending: Pending; note: string } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  function report(r: Reply, pending: Pending) {
    const parts: string[] = [];
    if (pending.kind === "name") {
      parts.push(tt("td.renamed", { name: r.title.name_en ?? "" }));
      if (r.slug.to && r.slug.to !== r.slug.from) parts.push(tt("td.slugMoved", { slug: r.slug.to }));
      if (r.slug.note) parts.push(r.slug.note);
    } else {
      parts.push(tt("td.posterSaved"));
    }
    if (r.crazydramas === "updated") parts.push(tt("td.cdUpdated"));
    if (r.crazydramas === "no_series") parts.push(pending.kind === "poster" ? tt("td.cdLaterPoster") : tt("td.cdLaterName"));
    if (r.crazydramas === "not_sent") parts.push(tt("td.cdNotSent", { detail: r.crazydramas_note ?? "" }));
    setMessage(parts.join(" "));
    setConfirm(r.crazydramas === "confirm_live" ? { pending, note: r.crazydramas_note ?? "" } : null);
    router.refresh();
  }

  async function run(pending: Pending, confirmLive = false) {
    setBusy(pending.kind);
    setError(null);
    setMessage(null);
    try {
      let r: Reply;
      if (pending.kind === "name") {
        r = await send(`/api/admin/titles/${titleId}/details`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), confirm_live: confirmLive }) });
        setSaved(r.title.name_en ?? name.trim());
        setName(r.title.name_en ?? name.trim());
      } else {
        const form = new FormData();
        form.append("file", pending.file);
        if (confirmLive) form.append("confirm_live", "true");
        r = await send(`/api/admin/titles/${titleId}/details`, { method: "POST", body: form });
        setCover(URL.createObjectURL(pending.file));
      }
      report(r, pending);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card title-details" id="details" aria-label={tt("td.title")} style={{ marginBottom: 20 }}>
      <h2 style={{ margin: "0 0 12px" }}>{tt("td.title")}</h2>
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 8, justifyItems: "start" }}>
          <div style={{ width: 150, aspectRatio: "3 / 4", borderRadius: 8, overflow: "hidden", background: "var(--surface-2, #eee)", display: "grid", placeItems: "center" }}>
            {cover ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local media route, not an optimisable asset
              <img src={cover} alt={tt("td.poster")} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <span className="gt-muted" style={{ padding: 8, textAlign: "center" }}>{tt("td.noPoster")}</span>
            )}
          </div>
          {canEdit && (
            <>
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                style={{ display: "none" }}
                aria-label={tt("td.choosePoster")}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void run({ kind: "poster", file });
                }}
              />
              <button type="button" className="btn btn-outline btn-sm" disabled={busy !== null} onClick={() => fileInput.current?.click()}>
                {busy === "poster" ? <><span className="spinner" /> {tt("td.saving")}</> : tt("td.choosePoster")}
              </button>
            </>
          )}
        </div>
        <div style={{ display: "grid", gap: 8, flex: "1 1 320px", minWidth: 0 }}>
          <label className="field-row" style={{ display: "grid", gap: 4 }}>
            <span className="label">{tt("td.name")}</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name.trim() && name.trim() !== saved) void run({ kind: "name" });
                }}
                disabled={!canEdit || busy !== null}
                aria-label={tt("td.name")}
                lang="en"
                style={{ flex: "1 1 260px", minWidth: 0 }}
              />
              {canEdit && (
                <button type="button" className="btn btn-primary" disabled={busy !== null || !name.trim() || name.trim() === saved} onClick={() => void run({ kind: "name" })}>
                  {busy === "name" ? <><span className="spinner" /> {tt("td.saving")}</> : tt("td.saveName")}
                </button>
              )}
            </div>
          </label>
          {slug && <small className="gt-muted">{tt("td.address", { slug })}</small>}
          <small className="hint">{tt("td.hint")}</small>
          {message && <p className="hint" role="status" style={{ margin: 0 }}>{message}</p>}
          {confirm && (
            <div className="note note-warn" role="alert">
              <p style={{ margin: "0 0 8px" }}>{confirm.note}</p>
              <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void run(confirm.pending, true)}>{tt("td.confirmLive")}</button>
            </div>
          )}
          {error && <p className="err" role="alert" style={{ margin: 0 }}>{tt("td.failed", { detail: error })}</p>}
          {!canEdit && <p className="hint" style={{ margin: 0 }}>{tt("td.adminOnly")}</p>}
        </div>
      </div>
    </section>
  );
}
