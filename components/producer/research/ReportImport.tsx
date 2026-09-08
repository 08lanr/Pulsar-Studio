"use client";

// CSV report import: pick a file → server preview (validation, duplicate
// detection, title matching; nothing written) → confirm → commit. Row
// errors are listed with their row number; duplicates are skipped unless
// the producer ticks "also import duplicates". Batches can be reverted.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import type { ImportPreview } from "@/lib/research/reports";
import type { ReportBatch } from "@/lib/research/types";

export default function ReportImport({ batches, canAct }: { batches: ReportBatch[]; canAct: boolean }) {
  const { tt } = useT();
  const router = useRouter();
  const [filename, setFilename] = useState("");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFilename(f.name);
    setText(await f.text());
    setPreview(null);
    setMessage(null);
    setError(null);
  }

  async function doPreview() {
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/producer/research/reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preview: true, filename, text }) });
      const body = (await res.json().catch(() => ({}))) as { preview?: ImportPreview; error?: string };
      if (!res.ok || !body.preview) throw new Error(body.error || `HTTP ${res.status}`);
      setPreview(body.preview);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doCommit() {
    if (!preview || busy) return;
    const rows = preview.rows.filter((r) => r.ok && r.data && (allowDuplicates || !r.duplicate)).map((r) => r.data!);
    if (rows.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/producer/research/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commit: true, filename, column_map: preview.column_map, rows, skipped_count: preview.rows.length - rows.length }),
      });
      const body = (await res.json().catch(() => ({}))) as { batch?: ReportBatch; error?: string };
      if (!res.ok || !body.batch) throw new Error(body.error || `HTTP ${res.status}`);
      setMessage(tt("research.reports.imported", { n: body.batch.row_count }));
      setPreview(null);
      setText("");
      setFilename("");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revert(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/producer/research/reports/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const importable = preview ? preview.rows.filter((r) => r.ok && (allowDuplicates || !r.duplicate)).length : 0;

  return (
    <div className="rs-form" style={{ maxWidth: "none" }}>
      <fieldset disabled={!canAct || busy}>
        <legend>{tt("research.reports.choose")}</legend>
        {!canAct && <p className="hint">{tt("research.reports.readOnly")}</p>}
        <div className="rs-tool-row" style={{ alignItems: "center" }}>
          <input aria-label={tt("research.reports.choose")} type="file" accept=".csv,text/csv" onChange={onFile} />
          <button type="button" className="btn btn-outline btn-sm" onClick={doPreview} disabled={!text}>{tt("research.reports.preview")}</button>
          {preview && (
            <>
              <label className="filter-chip" style={{ cursor: "pointer" }}><input type="checkbox" checked={allowDuplicates} onChange={(e) => setAllowDuplicates(e.target.checked)} /> {tt("research.reports.allowDuplicates")}</label>
              <button type="button" className="btn btn-primary btn-sm" onClick={doCommit} disabled={importable === 0}>{tt("research.reports.commit", { n: importable })}</button>
            </>
          )}
        </div>
        {message && <p role="status" className="note note-success" style={{ marginTop: 10 }}>{message}</p>}
        {error && <p role="alert" className="note note-warn" style={{ marginTop: 10 }}>{error}</p>}
      </fieldset>

      {preview && (
        <section className="rs-panel">
          <div className="rs-panel-head">
            <div>
              <h3>{filename}</h3>
              <p>
                {tt("research.reports.valid", { n: preview.valid })} · {tt("research.reports.invalid", { n: preview.invalid })} · {tt("research.reports.duplicates", { n: preview.duplicates })} · {tt("research.reports.unmatched", { n: preview.unmatched_titles })}
                {preview.missing_columns.length > 0 && <> · <span className="ev ev-inferred">{tt("research.reports.missingColumns", { cols: preview.missing_columns.join(", ") })}</span></>}
              </p>
            </div>
          </div>
          <div className="gtable gtable-flush rs-table" style={{ ["--cols" as string]: "48px minmax(0,1.6fr) 100px 150px 100px 100px minmax(0,2fr)" }}>
            <div className="gt-head"><span>{tt("research.reports.row")}</span><span>{tt("research.col.title")}</span><span>{tt("research.col.platform")}</span><span>{tt("research.reports.period")}</span><span>{tt("research.reports.metric")}</span><span className="gt-num">{tt("research.reports.value")}</span><span>{tt("research.sources.status")}</span></div>
            {preview.rows.slice(0, 200).map((r) => (
              <div className="gt-row" key={r.row} style={{ opacity: r.ok ? 1 : 0.85 }}>
                <span className="gt-muted">{r.row}</span>
                <span className="rs-title-name">{r.data?.title_name ?? "–"}{r.data && !r.data.title_id && <small className="gt-muted"> · {tt("ux.unlinked")}</small>}</span>
                <span>{r.data?.platform ?? "–"}</span>
                <span>{r.data ? `${r.data.period_start} → ${r.data.period_end}` : "–"}</span>
                <span>{r.data ? tt(`research.metric.${r.data.metric}`) : "–"}</span>
                <span className="gt-num">{r.data ? `${r.data.value}${r.data.currency ? ` ${r.data.currency}` : ""}` : "–"}</span>
                <span>
                  {r.errors.map((e, i) => <span key={i} className="ev ev-inferred" style={{ color: "var(--error)" }}>{e}</span>)}
                  {r.duplicate && <span className="state state-stale">{tt("ux.duplicate")}</span>}
                  {r.warnings.filter((w) => !w.startsWith("duplicate")).map((w, i) => <small key={i} className="gt-muted"> {w}</small>)}
                  {r.ok && !r.duplicate && r.warnings.length === 0 && <span className="state state-available">{tt("ux.valid")}</span>}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rs-panel">
        <div className="rs-panel-head"><div><h3>{tt("research.reports.batches")}</h3></div></div>
        {batches.length === 0 ? (
          <div className="rs-empty">{tt("research.reports.none")}</div>
        ) : (
          <div className="gtable gtable-flush rs-table" style={{ ["--cols" as string]: "minmax(0,2fr) 170px 80px 80px 120px" }}>
            <div className="gt-head"><span>{tt("research.reports.file")}</span><span>{tt("research.reports.when")}</span><span className="gt-num">{tt("research.reports.rows")}</span><span className="gt-num">{tt("research.reports.skipped")}</span><span /></div>
            {batches.map((b) => (
              <div className="gt-row" key={b.id}>
                <span className="rs-title-name">{b.filename}</span>
                <span className="gt-muted">{b.imported_at.slice(0, 16).replace("T", " ")} UTC</span>
                <span className="gt-num">{b.row_count}</span>
                <span className="gt-num">{b.skipped_count}</span>
                <span>{b.reverted_at ? <span className="state state-unavailable">{tt("research.reports.reverted")}</span> : <button type="button" className="btn btn-outline btn-sm" onClick={() => revert(b.id)} disabled={!canAct || busy}>{tt("research.reports.revert")}</button>}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
