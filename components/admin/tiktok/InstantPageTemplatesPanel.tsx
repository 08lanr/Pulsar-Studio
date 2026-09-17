"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/locale";
import { call } from "@/components/tiktok/api";
import type { InstantPageTemplate } from "@/lib/types";

const endpoint = "/api/admin/tiktok/instant-page-templates";
type Draft = Pick<InstantPageTemplate, "name" | "button_text" | "background" | "hand_cursor"> & { id?: string };
const blank: Draft = { name: "", button_text: "Watch now", background: "white", hand_cursor: false };

export default function InstantPageTemplatesPanel({ isAdmin }: { isAdmin: boolean }) {
  const { tt } = useT();
  const [templates, setTemplates] = useState<InstantPageTemplate[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => { try { setTemplates((await call<{ templates: InstantPageTemplate[] }>(endpoint)).templates); setError(""); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function save() {
    if (!editing) return;
    setBusy(true); setError("");
    try { await call(endpoint, "POST", editing); setEditing(null); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (!window.confirm(tt("tipTemplates.deleteConfirm"))) return;
    setBusy(true); setError("");
    try { await call(`${endpoint}?id=${encodeURIComponent(id)}`, "DELETE"); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <section className="card pd-panel">
    <div className="pd-section-head tk-head-row"><h2 className="section-title">{tt("tipTemplates.title")} <span className="pd-count">{templates.length}</span></h2>{isAdmin && !editing && <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({ ...blank })}>{tt("tipTemplates.new")}</button>}</div>
    <p className="pd-muted">{tt("tipTemplates.explainer")}</p>
    {error && <p className="note note-warn" role="alert">{error}</p>}
    {!templates.length && !editing && <p className="pd-muted">{tt("tipTemplates.empty")}</p>}
    {!!templates.length && <ul className="pd-list tk-presets">{templates.map(template => <li key={template.id}><div><strong>{template.name}</strong><br /><small className="pd-muted">{template.button_text} · {tt(`tipTemplates.background.${template.background}`)}</small></div>{isAdmin && <span className="pd-actions"><button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => setEditing({ id: template.id, name: template.name, button_text: template.button_text, background: template.background, hand_cursor: template.hand_cursor })}>{tt("tkp.edit")}</button><button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => void remove(template.id)}>{tt("tkp.delete")}</button></span>}</li>)}</ul>}
    {editing && <form className="pd-revise tk-preset-form" onSubmit={e => { e.preventDefault(); void save(); }}><div className="field"><label className="label" htmlFor="tip-name">{tt("tipTemplates.name")}</label><input id="tip-name" className="input" required maxLength={60} value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></div><div className="field"><label className="label" htmlFor="tip-button">{tt("tipTemplates.button")}</label><input id="tip-button" className="input" required maxLength={40} value={editing.button_text} onChange={e => setEditing({ ...editing, button_text: e.target.value })} /></div><div className="field"><label className="label" htmlFor="tip-background">{tt("tipTemplates.background")}</label><select id="tip-background" className="select" value={editing.background} onChange={e => setEditing({ ...editing, background: e.target.value as Draft["background"] })}><option value="white">{tt("tipTemplates.background.white")}</option><option value="black">{tt("tipTemplates.background.black")}</option></select></div><label className="tk-check"><input type="checkbox" checked={editing.hand_cursor} onChange={e => setEditing({ ...editing, hand_cursor: e.target.checked })} /> {tt("tipTemplates.handCursor")}</label><div aria-label={tt("tipTemplates.preview")} style={{ width: 190, height: 270, border: "5px solid var(--border-strong)", borderRadius: 24, background: editing.background === "white" ? "#fff" : "#111", color: editing.background === "white" ? "#111" : "#fff", padding: 12, display: "flex", flexDirection: "column", justifyContent: "space-between", alignItems: "stretch", textAlign: "center" }}><strong style={{ fontSize: 12 }}>{editing.name || tt("tipTemplates.previewTitle")}</strong><span style={{ fontSize: 11, opacity: .7 }}>{tt("tipTemplates.previewBody")}</span><span style={{ display: "block", background: "#fe2c55", color: "white", borderRadius: 5, padding: "7px 3px", fontSize: 12, fontWeight: 700 }}>{editing.button_text || tt("tipTemplates.button")}{editing.hand_cursor && <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" style={{ marginLeft: 4, verticalAlign: "middle" }}><path d="M8 11V5a2 2 0 0 1 4 0v5-1a2 2 0 0 1 4 0v2a2 2 0 0 1 4 1v4c0 3-2 5-5 5h-3c-2 0-3-1-4-3l-3-4a2 2 0 0 1 3-3Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}</span></div><p className="hint">{tt("tipTemplates.previewNote")}</p><div className="pd-actions"><button className="btn btn-primary" disabled={busy || !editing.name.trim() || !editing.button_text.trim()}>{busy ? tt("common.loading") : tt("tkp.save")}</button><button className="btn btn-ghost" type="button" onClick={() => setEditing(null)}>{tt("admin.promote.revise.cancel")}</button></div></form>}
  </section>;
}
