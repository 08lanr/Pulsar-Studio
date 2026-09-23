"use client";

// Intake (plan B2 stage 0, decision 2026-09-23 #6): a server-side picker
// over Downloads, the OneDrive "Mini Drama" folder or a typed path — never
// a browser upload of a multi-GB file — with ffprobe's answer beside each
// file. A landscape source and a cloud placeholder are refused here with
// the reason (the cut-only route has no reframe; a placeholder's bytes are
// not on this machine); under 720p is a warning. Then the company, bucket,
// slug (proposed from the file name, editable), mode (narrated shown
// disabled: the next phase), language and the few settings the worker
// honours. Start creates the run row and opens it.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiRequestError, getJson, postJson } from "@/lib/api-client";
import { useT } from "@/components/locale";
import { RUN_BUCKETS, RUN_MODES_OPEN, RUN_SLUG, type NewRunBody, type RunReply, type SourceEntry, type SourcesReply } from "@/lib/segment/api-types";
import { fmtT, slugFromFilename } from "./model";

type Props = { producers: { id: string; name: string }[] };

/** A picker root's key (`downloads`, `onedrive`, `workspace`, …) or `path` for a typed folder. */
type DirKind = string;

const LANGS = ["en", "zh", "ja", "ko", "th", "vi", "id", "es", "pt", "fr", "de"];

function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

export type SourceVerdict = { refusal: string | null; warning: string | null };

/** What the intake says about a listed file: refused (landscape, placeholder), warned (under 720p, unprobed), or fine. */
export function judgeSource(e: SourceEntry, tt: (k: string, v?: Record<string, string | number>) => string): SourceVerdict {
  if (e.placeholder) return { refusal: tt("seg.intake.refuse.placeholder"), warning: null };
  const p = e.probe;
  if (!p) return { refusal: null, warning: tt("seg.intake.warn.noProbe") };
  if (p.width > p.height) return { refusal: tt("seg.intake.refuse.landscape", { w: p.width, h: p.height }), warning: null };
  if (p.height < 720) return { refusal: null, warning: tt("seg.intake.warn.small", { w: p.width, h: p.height }) };
  return { refusal: null, warning: null };
}

export default function RunIntake({ producers }: Props) {
  const { tt } = useT();
  const [dirKind, setDirKind] = useState<DirKind>("downloads");
  const [typedPath, setTypedPath] = useState("");
  const [listing, setListing] = useState<SourcesReply | null>(null);
  const [roots, setRoots] = useState<{ key: string; label: string; exists: boolean }[]>([{ key: "downloads", label: "Downloads", exists: true }, { key: "onedrive", label: "OneDrive / Mini Drama", exists: true }]);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<SourceEntry | null>(null);
  const [producerId, setProducerId] = useState(producers[0]?.id ?? "");
  const [bucket, setBucket] = useState<(typeof RUN_BUCKETS)[number]>("low-quality");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [mode, setMode] = useState<(typeof RUN_MODES_OPEN)[number]>("by_eye_2min");
  const [lang, setLang] = useState("en");
  const [firstProof, setFirstProof] = useState(true);
  const [noDelogo, setNoDelogo] = useState(false);
  const [allowDirty, setAllowDirty] = useState(false);
  const [vision, setVision] = useState<"api" | "handoff">("api");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const list = useCallback(async (kind: DirKind, typed: string) => {
    const dir = kind === "path" ? typed.trim() : kind;
    if (!dir) return;
    setBusy(true);
    setListError(null);
    try {
      const r = await getJson<SourcesReply>(`/api/admin/films/sources?dir=${encodeURIComponent(dir)}&probe=1`);
      setListing(r);
      if (r.roots?.length) setRoots(r.roots.map((x) => ({ key: x.key, label: x.label, exists: x.exists })));
    } catch (e) {
      setListing(null);
      setListError(e instanceof ApiRequestError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (dirKind !== "path") void list(dirKind, "");
  }, [dirKind, list]);

  function pick(e: SourceEntry) {
    setSelected(e);
    if (!slugTouched) setSlug(e.suggested_slug || slugFromFilename(e.name));
  }

  /** Step into a sub-folder: it becomes the typed path and is listed. */
  function enter(folder: { name: string; path: string }) {
    setDirKind("path");
    setTypedPath(folder.path);
    setListing(null);
    void list("path", folder.path);
  }

  const verdict = useMemo(() => (selected ? judgeSource(selected, tt) : null), [selected, tt]);
  const slugOk = RUN_SLUG.test(slug);
  const canStart = !!selected && !!verdict && !verdict.refusal && slugOk && !!producerId && !submitting;

  async function start() {
    if (!selected || !canStart) return;
    setSubmitting(true);
    setSubmitError(null);
    const body: NewRunBody = {
      producer_id: producerId,
      source_path: selected.path,
      bucket,
      slug,
      mode,
      lang,
      settings: { allow_dirty: allowDirty || undefined, no_delogo: noDelogo || undefined, to_s: firstProof ? 900 : null, vision },
    };
    try {
      const r = await postJson<Partial<RunReply> & { error?: string }>("/api/admin/films/runs", body);
      if (r.run?.id) {
        window.location.href = `/films/runs/${r.run.id}`;
        return;
      }
      setSubmitError(r.error ?? tt("seg.intake.startFailed"));
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="sgm-intake">
      <section className="card" aria-label={tt("seg.intake.source")}>
        <h2 className="section-title">{tt("seg.intake.source")}</h2>
        <div className="seg" role="tablist" aria-label={tt("seg.intake.where")}>
          {roots.map((r) => (
            <button key={r.key} type="button" role="tab" aria-selected={dirKind === r.key} className={`seg-btn ${dirKind === r.key ? "on" : ""}`} disabled={!r.exists} title={r.exists ? undefined : tt("seg.intake.rootMissing")} onClick={() => { setDirKind(r.key); setListing(null); }}>
              {r.key === "downloads" ? tt("seg.intake.dir.downloads") : r.key === "onedrive" ? tt("seg.intake.dir.onedrive") : r.label}
            </button>
          ))}
          <button type="button" role="tab" aria-selected={dirKind === "path"} className={`seg-btn ${dirKind === "path" ? "on" : ""}`} onClick={() => { setDirKind("path"); setListing(null); }}>
            {tt("seg.intake.dir.path")}
          </button>
        </div>
        {dirKind === "path" && (
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input className="input" value={typedPath} onChange={(e) => setTypedPath(e.target.value)} placeholder={tt("seg.intake.pathPlaceholder")} aria-label={tt("seg.intake.dir.path")} spellCheck={false} />
            <button type="button" className="btn btn-outline" onClick={() => void list("path", typedPath)} disabled={!typedPath.trim() || busy}>{tt("seg.intake.list")}</button>
          </div>
        )}
        {busy && <p className="hint" role="status"><span className="spinner" /> {tt("seg.intake.listing")}</p>}
        {listError && <p className="err" role="alert">{tt("seg.intake.listFailed", { detail: listError })}</p>}
        {listing && (
          <div className="picker sgm-source-list">
            <div className="picker-head"><span title={listing.dir} style={{ overflowWrap: "anywhere" }}>{listing.dir}</span><span className="n">{listing.entries.length}</span></div>
            {listing.folders && listing.folders.length > 0 && (
              <ul className="picker-list" aria-label={tt("seg.intake.folders")}>
                {listing.folders.map((f) => (
                  <li key={f.path}>
                    <button type="button" className="picker-item" onClick={() => enter(f)} data-folder-name={f.name}>
                      <span className="picker-check" aria-hidden />
                      <span className="sgm-source-name gt-muted">{f.name}/</span>
                      <span className="sgm-source-facts">{tt("seg.intake.open")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {listing.entries.length === 0 && <p className="hint" style={{ padding: "8px 16px" }}>{tt("seg.intake.noFiles")}</p>}
            <ul className="picker-list">
              {listing.entries.map((e) => {
                const on = selected?.path === e.path;
                const v = judgeSource(e, tt);
                return (
                  <li key={e.path}>
                    <button type="button" className={`picker-item ${on ? "on" : ""}`} aria-pressed={on} onClick={() => pick(e)} data-source-name={e.name}>
                      <span className="picker-check" aria-hidden>{on ? "✓" : ""}</span>
                      <span className="sgm-source-name">
                        <span lang="en">{e.name}</span>
                        {v.refusal && <small className="err" style={{ display: "block" }}>{v.refusal}</small>}
                        {v.warning && <small className="hint" style={{ display: "block" }}>{v.warning}</small>}
                      </span>
                      <span className="sgm-source-facts">
                        {sizeText(e.bytes)}
                        {e.probe ? ` · ${e.probe.width}×${e.probe.height} · ${e.probe.fps} fps${e.probe.duration_s ? ` · ${fmtT(e.probe.duration_s)}` : ""}` : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <section className="card" aria-label={tt("seg.intake.run")}>
        <h2 className="section-title">{tt("seg.intake.run")}</h2>
        {selected ? (
          <p className="hint" style={{ marginBottom: 12, overflowWrap: "anywhere" }}>{tt("seg.intake.picked", { name: selected.name })}</p>
        ) : (
          <p className="hint" style={{ marginBottom: 12 }}>{tt("seg.intake.pickFirst")}</p>
        )}
        {verdict?.refusal && <p className="note note-warn" role="alert" style={{ marginBottom: 12 }}>{verdict.refusal}</p>}

        <label className="field field-key">
          <span className="label">{tt("seg.intake.company")}</span>
          <select className="select" value={producerId} onChange={(e) => setProducerId(e.target.value)}>
            <option value="">{tt("seg.intake.companyPick")}</option>
            {producers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">{tt("seg.intake.bucket")}</span>
          <select className="select" value={bucket} onChange={(e) => setBucket(e.target.value as (typeof RUN_BUCKETS)[number])}>
            {RUN_BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <label className="field field-key">
          <span className="label">{tt("seg.intake.slug")}</span>
          <input className="input" value={slug} onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }} lang="en" spellCheck={false} aria-invalid={slug.length > 0 && !slugOk} />
          <span className="hint">{tt("seg.intake.slugHint", { bucket })}</span>
          {slug.length > 0 && !slugOk && <span className="err">{tt("seg.intake.slugBad")}</span>}
        </label>
        <div className="field">
          <span className="label">{tt("seg.intake.mode")}</span>
          {RUN_MODES_OPEN.map((m) => (
            <label key={m} className="sgm-radio">
              <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
              <span>{tt(`seg.mode.${m}`)}<small>{tt(`seg.mode.${m}.hint`)}</small></span>
            </label>
          ))}
          <label className="sgm-radio" aria-disabled="true">
            <input type="radio" name="mode" value="narrated" disabled />
            <span>{tt("seg.mode.narrated")}<small>{tt("seg.mode.narrated.hint")}</small></span>
          </label>
        </div>
        <label className="field">
          <span className="label">{tt("seg.intake.lang")}</span>
          <input className="input" list="sgm-langs" value={lang} onChange={(e) => setLang(e.target.value.trim().toLowerCase())} spellCheck={false} />
          <datalist id="sgm-langs">{LANGS.map((l) => <option key={l} value={l} />)}</datalist>
          <span className="hint">{tt("seg.intake.langHint")}</span>
        </label>
        <div className="field">
          <span className="label">{tt("seg.intake.settings")}</span>
          <label className="sgm-radio"><input type="checkbox" checked={firstProof} onChange={(e) => setFirstProof(e.target.checked)} /><span>{tt("seg.intake.firstProof")}<small>{tt("seg.intake.firstProofHint")}</small></span></label>
          <label className="sgm-radio"><input type="checkbox" checked={noDelogo} onChange={(e) => setNoDelogo(e.target.checked)} /><span>{tt("seg.intake.noDelogo")}<small>{tt("seg.intake.noDelogoHint")}</small></span></label>
          <label className="sgm-radio"><input type="checkbox" checked={allowDirty} onChange={(e) => setAllowDirty(e.target.checked)} /><span>{tt("seg.intake.allowDirty")}<small>{tt("seg.intake.allowDirtyHint")}</small></span></label>
          <label className="sgm-radio"><input type="checkbox" checked={vision === "handoff"} onChange={(e) => setVision(e.target.checked ? "handoff" : "api")} /><span>{tt("seg.intake.visionHandoff")}<small>{tt("seg.intake.visionHandoffHint")}</small></span></label>
        </div>
        {submitError && <p className="err" role="alert">{tt("seg.intake.startFailedDetail", { detail: submitError })}</p>}
        <div className="form-actions" style={{ marginTop: 16 }}>
          <a className="btn btn-ghost" href="/films/runs">{tt("seg.cancel")}</a>
          <button type="button" className="btn btn-primary" disabled={!canStart} onClick={() => void start()}>
            {submitting ? <><span className="spinner" /> {tt("seg.intake.starting")}</> : tt("seg.intake.start")}
          </button>
        </div>
      </section>
    </div>
  );
}
