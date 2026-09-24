"use client";

// Pulsar-wide launch presets (overlord's ad group presets; decision
// 2026-09-16): the house shapes a producer can pick. Admins create, edit and
// delete; the editor is the same one the producer sees when customizing.

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/locale";
import { defaultSalesLaunchSettings, defaultTikTokLaunchSettings, normalizeLaunchSettings, summarizeLaunchSettings, type LaunchSettings } from "@/lib/tiktok/settings";
import type { LaunchPreset } from "@/lib/types";
import { call } from "@/components/tiktok/api";
import LaunchSettingsEditor from "@/components/tiktok/LaunchSettingsEditor";

export default function PresetsPanel({ isAdmin }: { isAdmin: boolean }) {
  const { tt } = useT();
  const [presets, setPresets] = useState<LaunchPreset[]>([]);
  const [editing, setEditing] = useState<{ id?: string; name: string; note: string; settings: LaunchSettings } | null>(null);
  const [budget, setBudget] = useState(500);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { try { setPresets((await call<{ presets: LaunchPreset[] }>("/api/admin/tiktok/presets")).presets); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!editing) return;
    setBusy("save"); setError(null);
    try {
      await call("/api/admin/tiktok/presets", "POST", { id: editing.id, name: editing.name, note: editing.note || null, settings: editing.settings });
      setEditing(null);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const remove = async (p: LaunchPreset) => {
    if (!window.confirm(tt("tkp.deleteConfirm", { name: p.name }))) return;
    setBusy(p.id); setError(null);
    try { await call(`/api/admin/tiktok/presets?id=${p.id}`, "DELETE"); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  return <section className="card pd-panel">
    <div className="pd-section-head tk-head-row">
      <h2 className="section-title">{tt("tkp.title")} <span className="pd-count">{presets.length + 2}</span></h2>
      {isAdmin && !editing && <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({ name: "", note: "", settings: defaultTikTokLaunchSettings() })}>{tt("tkp.new")}</button>}
    </div>
    <p className="pd-muted">{tt("tkp.sub")}</p>
    {error && <p className="note note-warn" role="alert">{error}</p>}
    <ul className="pd-list tk-presets"><li><div><strong>{tt("lpx.defaultPreset")}</strong><br /><small className="pd-muted">{summarizeLaunchSettings(defaultTikTokLaunchSettings()).join(" · ")}</small></div></li><li><div><strong>{tt("salesLaunch.defaultPreset")}</strong><br /><small className="pd-muted">{summarizeLaunchSettings(defaultSalesLaunchSettings()).join(" · ")}</small></div></li>{presets.map((p) => <li key={p.id}>
      <div><strong>{p.name}</strong>{p.note && <> · <span className="pd-muted">{p.note}</span></>}<br /><small className="pd-muted">{summarizeLaunchSettings(normalizeLaunchSettings(p.settings)).join(" · ")}</small></div>
      {isAdmin && <span className="pd-actions"><button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => setEditing({ id: p.id, name: p.name, note: p.note ?? "", settings: normalizeLaunchSettings(p.settings) })}>{tt("tkp.edit")}</button><button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => void remove(p)}>{busy === p.id ? tt("common.loading") : tt("tkp.delete")}</button></span>}
    </li>)}</ul>
    {editing && <form className="pd-revise tk-preset-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="pd-row">
        <div className="field"><label className="label" htmlFor="tkp-name">{tt("tkp.name")}</label><input id="tkp-name" className="input" required maxLength={60} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
        <div className="field"><label className="label" htmlFor="tkp-budget">{tt("tkp.exampleBudget")}</label><input id="tkp-budget" className="input" type="number" min={20} value={budget} onChange={(e) => setBudget(Number(e.target.value) || 0)} /></div>
      </div>
      <div className="field"><label className="label" htmlFor="tkp-note">{tt("ws.accounts.note")}</label><input id="tkp-note" className="input" maxLength={400} value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></div>
      <LaunchSettingsEditor value={editing.settings} onChange={(s) => setEditing({ ...editing, settings: s })} budgetUsd={budget} regionsEndpoint="/api/admin/tiktok/regions" />
      <div className="pd-actions"><button className="btn btn-primary" disabled={busy === "save" || !editing.name.trim()}>{busy === "save" ? tt("common.loading") : tt("tkp.save")}</button><button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>{tt("admin.promote.revise.cancel")}</button></div>
    </form>}
  </section>;
}
