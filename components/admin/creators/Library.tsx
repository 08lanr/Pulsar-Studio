"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import { call, type MediaView } from "./api";

// The Library tab (decision 2026-10-12): add pictures and videos (a PNG or
// WebP becomes a JPEG on the way in; the same file twice is added once), and
// say what is in each, which is what the caption writer reads.

export default function Library({ accountId, media }: { accountId: string; media: MediaView[] }) {
  const { tt } = useT();
  const router = useRouter();
  const [files, setFiles] = useState<FileList | null>(null);
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);

  const upload = async () => {
    if (!files?.length) return;
    const form = new FormData();
    for (const f of Array.from(files)) form.append("file", f);
    form.set("description", description);
    form.set("tags", tags);
    setBusy(true); setLines([]);
    const r = await call<{ results: { name: string; ok: boolean; created?: boolean; warnings?: string[]; error?: string }[] }>(`/api/admin/creators/${accountId}/media`, "POST", form);
    setBusy(false);
    if (!r.ok) { setLines([r.error]); return; }
    setLines(r.data.results.flatMap(x => x.ok
      ? [tt(x.created ? "cr.lib.added" : "cr.lib.dupe", { name: x.name }), ...(x.warnings ?? [])]
      : [`${x.name}: ${x.error}`]));
    setDescription(""); setTags("");
    router.refresh();
  };

  return (
    <div>
      <div className="card cr-new">
        <label className="label" htmlFor="cr-files">{tt("cr.lib.upload")}</label>
        <input id="cr-files" type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" onChange={e => setFiles(e.target.files)} />
        <p className="hint">{tt("cr.lib.uploadHint")}</p>
        <label className="label" htmlFor="cr-desc">{tt("cr.lib.description")}</label>
        <textarea id="cr-desc" className="textarea input" rows={2} maxLength={1000} value={description} onChange={e => setDescription(e.target.value)} />
        <label className="label" htmlFor="cr-tags">{tt("cr.lib.tags")}</label>
        <input id="cr-tags" className="input" value={tags} onChange={e => setTags(e.target.value)} />
        <div className="form-actions cr-actions">
          <button type="button" className="btn btn-sm btn-primary" disabled={!files?.length || busy} onClick={() => void upload()}>{busy ? tt("cr.lib.adding") : tt("cr.lib.add")}</button>
        </div>
        {lines.map(l => <p key={l} className="hint" role="status">{l}</p>)}
      </div>
      {media.length ? <div className="cr-library">{media.map(m => <Item key={m.id} accountId={accountId} m={m} />)}</div> : <p className="hint">{tt("cr.lib.empty")}</p>}
    </div>
  );
}

function Item({ accountId, m }: { accountId: string; m: MediaView }) {
  const { tt } = useT();
  const router = useRouter();
  const [description, setDescription] = useState(m.description);
  const [tags, setTags] = useState(m.tags.join(", "));
  const [state, setState] = useState<"idle" | "busy" | "saved" | string>("idle");
  const dirty = description !== m.description || tags !== m.tags.join(", ");
  const save = async () => {
    setState("busy");
    const r = await call(`/api/admin/creators/${accountId}/media/${m.id}`, "PATCH", { revision: m.revision, description, tags: tags.split(",").map(t => t.trim()).filter(Boolean) });
    setState(r.ok ? "saved" : r.error);
    if (r.ok) router.refresh();
  };
  return (
    <div className="card cr-item">
      {m.kind === "image"
        ? <img className="cr-item-media" src={m.url} alt={m.description || m.filename} loading="lazy" />
        : <video className="cr-item-media" src={m.url} controls preload="metadata" />}
      <div className="cr-item-meta">
        <span className="gt-muted">{m.external_id}</span>
        <span className="gt-muted">{m.width && m.height ? `${m.width}×${m.height}` : ""}{m.duration_s ? ` · ${Math.round(m.duration_s)} s` : ""}</span>
        <span className="gt-muted">{tt("cr.lib.usedIn", { n: m.used_in })}</span>
      </div>
      <textarea className="textarea input" rows={3} aria-label={tt("cr.lib.description")} placeholder={tt("cr.lib.description")} maxLength={1000} value={description} onChange={e => setDescription(e.target.value)} />
      <input className="input" aria-label={tt("cr.lib.tags")} placeholder={tt("cr.lib.tags")} value={tags} onChange={e => setTags(e.target.value)} />
      <div className="cr-actions">
        <button type="button" className="btn btn-sm btn-outline" disabled={!dirty || state === "busy"} onClick={() => void save()}>{tt("cr.lib.save")}</button>
        {state === "saved" && <span className="hint" role="status">{tt("cr.lib.saved")}</span>}
        {state !== "idle" && state !== "busy" && state !== "saved" && <span className="err" role="alert">{state}</span>}
      </div>
    </div>
  );
}
