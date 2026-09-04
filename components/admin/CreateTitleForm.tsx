"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/api-client";
import type { Producer, Title } from "@/lib/types";

export default function CreateTitleForm({ producers }: { producers: Producer[] }) {
  const router = useRouter();
  const [busy,setBusy]=useState(false); const [error,setError]=useState<string|null>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null);
    const form = new FormData(event.currentTarget);
    const result = await postJson<{title?:Title;error?:string}>("/api/titles", Object.fromEntries([...form.entries()].map(([k,v])=>[k,String(v)||null])));
    setBusy(false); if (!result.title) { setError(result.error || "Could not create title"); return; }
    router.push(`/titles/${result.title.id}`); router.refresh();
  }
  return <form className="card form-stack" onSubmit={submit}>
    {error && <p className="err">{error}</p>}
    <div className="picker-row"><label className="field"><span className="field-label">Chinese title *</span><input name="name_zh" className="input" required /></label><label className="field"><span className="field-label">English title</span><input name="name_en" className="input" /></label></div>
    <div className="picker-row"><label className="field"><span className="field-label">Producer *</span><select name="producer_id" className="select" required defaultValue=""><option value="" disabled>Select producer</option>{producers.map(p=><option key={p.id} value={p.id}>{p.name_en || p.name_zh}</option>)}</select></label><label className="field"><span className="field-label">Genre</span><input name="genre" className="input" /></label></div>
    <label className="field"><span className="field-label">Chinese synopsis</span><textarea name="synopsis_zh" className="textarea" rows={4} /></label>
    <label className="field"><span className="field-label">English synopsis</span><textarea name="synopsis_en" className="textarea" rows={4} /></label>
    <label className="field"><span className="field-label">Character notes and relationships</span><textarea name="character_notes" className="textarea" rows={5} /></label>
    <div className="title-actions"><button className="btn btn-primary" disabled={busy || !producers.length}>{busy ? <span className="spinner" /> : null}{busy ? "Creating…" : "Create title"}</button></div>
    {!producers.length && <p className="hint">Create a producer before adding a title.</p>}
  </form>;
}
