"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useT } from "@/components/locale";
import { call } from "@/components/tiktok/api";
import type { LaunchLibraryItem, LaunchWorkspace } from "@/lib/launch/types";

export default function ClipsLibrary({ titleId }: { titleId?: string }) {
  const { tt } = useT();
  const [clips, setClips] = useState<LaunchLibraryItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedTitle, setSelectedTitle] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [onlySelected, setOnlySelected] = useState(false);
  const [canDownload, setCanDownload] = useState(false);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setSelected({});
    void call<{ workspace: LaunchWorkspace }>("/api/producer/launch/workspace")
      .then(({ workspace }) => {
        if (!active) return;
        setClips(workspace.library.filter((x) => x.kind === "video" && (!titleId || x.title_id === titleId)));
        setCanDownload(workspace.can_edit);
      })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [titleId]);
  const titles = Array.from(new Map(clips.filter((clip) => clip.title_id).map((clip) => [clip.title_id!, clip.title_name])).entries());
  const visible = clips.filter((clip) => !selectedTitle || clip.title_id === selectedTitle);
  const chosen = visible.filter((clip) => selected[clip.id]);
  async function downloadZip(ids: string[]) {
    if (!ids.length || ids.length > 30) { setError(tt("lv2.clips.zipLimit")); return; }
    setDownloading(true); setError("");
    try {
      const response = await fetch("/api/producer/clips/download", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clip_ids: ids }) });
      if (!response.ok) { const failure = await response.json().catch(() => ({})) as { error?: string }; throw new Error(failure.error ?? `HTTP ${response.status}`); }
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = objectUrl; link.download = "studio-clips.zip"; document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setDownloading(false); }
  }
  return <div className="launch-flow">
    <div className="page-head"><div><h1>{tt("lv2.clips.title")}</h1><p className="page-sub">{tt("lv2.clips.sub")}</p></div><Link className="btn btn-primary" href="/producer/launch">{tt("lv2.launch.title")}</Link></div>
    <div className="note"><p>{tt("lv2.clips.steps")}</p></div>
    <div className="rs-tool-row">
      {!titleId && titles.length > 1 && <label className="field"><span className="label">{tt("clipsAcceptance.filterTitle")}</span><select className="select select-inline" value={selectedTitle} onChange={(e) => { setSelectedTitle(e.target.value); setSelected({}); setOnlySelected(false); }}><option value="">{tt("clipsAcceptance.allTitles")}</option>{titles.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>}
      <button className={`filter-chip${onlySelected ? " on" : ""}`} disabled={loading} onClick={() => setOnlySelected((x) => !x)}>{tt("lv2.clips.selected", { n: chosen.length })}</button>
      {canDownload && <><button className="btn btn-outline btn-sm" disabled={downloading || !chosen.length || chosen.length > 30} onClick={() => void downloadZip(chosen.map((c) => c.id))}>{tt("lv2.clips.downloadSelected")}</button><button className="btn btn-outline btn-sm" disabled={downloading || !visible.length || visible.length > 30} onClick={() => void downloadZip(visible.map((c) => c.id))}>{tt("lv2.clips.downloadAll")}</button></>}
    </div>
    {!loading && visible.length > 30 && <p className="note">{tt("clipsAcceptance.downloadLimit")}</p>}
    {loading && <p role="status">{tt("clipsAcceptance.loading")}</p>}
    {error && <p className="note note-warn" role="alert">{error}</p>}
    {!loading && !error && !clips.length && <div className="empty"><p>{tt("lv2.clips.empty")}</p><Link href="/producer/titles" className="btn btn-outline">{tt("lv2.clips.openTitles")}</Link></div>}
    {visible.filter((clip) => !onlySelected || selected[clip.id]).map((clip) => <section className="rs-panel" key={clip.id} style={{ marginBottom: 16 }}>
      <div className="page-head"><div><h2>{clip.title_name}</h2><p className="page-sub">{clip.label ?? clip.text ?? clip.value}</p></div><div className="rs-tool-row"><label className="filter-chip"><input type="checkbox" checked={!!selected[clip.id]} onChange={(e) => setSelected((x) => ({ ...x, [clip.id]: e.target.checked }))} /> {tt("lv2.clips.choose")}</label><button className="btn btn-outline btn-sm" onClick={() => setOpen((x) => ({ ...x, [clip.id]: !x[clip.id] }))}>{open[clip.id] ? tt("lv2.hide") : tt("clips.preview")}</button>{clip.media_url && <a className="btn btn-primary btn-sm" href={clip.media_url} download>{tt("clips.download")}</a>}</div></div>
      {open[clip.id] && clip.media_url && <video src={clip.media_url} controls playsInline preload="metadata" style={{ maxWidth: 270, width: "100%", aspectRatio: "9 / 16", objectFit: "contain" }} />}
      {clip.title_id && <p><Link href={`/producer/titles/${clip.title_id}/materials`}>{tt("lv2.clips.materials")}&nbsp;→</Link></p>}
    </section>)}
  </div>;
}
