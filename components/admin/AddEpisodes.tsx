"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import EpisodeUploader, { ingestRows, newRow, readyRows, type IngestOutcome, type UploadRow } from "./EpisodeUploader";
import { useT } from "@/components/locale";
import { IconAlert, IconUpload } from "@/components/icons";

// "Add episodes" on the title page: the same uploader as /titles/new, sent
// straight to the ingest route, then router.refresh() so the server-rendered
// episode table picks the new rows up. Warnings stay on screen until the
// next upload — the ingest route's messages are the only place a bad
// subtitle file is explained.

type Props = { titleId: string; nextNumber: number };

export default function AddEpisodes({ titleId, nextNumber }: Props) {
  const { tt } = useT();
  const router = useRouter();
  const [rows, setRows] = useState<UploadRow[]>([newRow(nextNumber)]);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<IngestOutcome[]>([]);

  async function upload() {
    if (readyRows(rows).length === 0) return;
    setBusy(true);
    const out = await ingestRows(titleId, rows);
    setBusy(false);
    setOutcomes(out);
    const maxDone = out.reduce((m, o) => (o.episode ? Math.max(m, o.number) : m), nextNumber - 1);
    setRows([newRow(maxDone + 1)]);
    router.refresh();
  }

  return (
    <div className="card">
      <h3 className="field-group-title">{tt("admin.title.addEpisodes")}</h3>
      <p className="section-sub">{tt("admin.newTitle.episodesSub")}</p>
      <EpisodeUploader rows={rows} onChange={setRows} disabled={busy} />
      {outcomes.map((o) => (
        <div key={o.number} className="group">
          <div className="def-row">
            <span className="k">{tt("admin.episode.n", { n: o.number })}</span>
            <span className="v">{o.error ? tt("admin.newTitle.ingestFailed") : tt("admin.newTitle.ingestOk")}</span>
          </div>
          {o.summary && (
            <p className="note note-info">
              {tt("admin.newTitle.ingestSummary", { lines: o.summary.lines, scenes: o.summary.scenes })}
              {!o.summary.has_timecodes ? ` · ${tt("admin.newTitle.untimed")}` : ""}
            </p>
          )}
          {o.error && <p className="err">{o.error}</p>}
          {o.warnings.map((w, i) => (
            <p key={i} className="hint">
              <IconAlert size={12} /> {w}
            </p>
          ))}
        </div>
      ))}
      <div className="title-actions">
        <button type="button" className="btn btn-primary" onClick={upload} disabled={busy || readyRows(rows).length === 0}>
          {busy ? <span className="spinner" /> : <IconUpload />}
          {busy ? tt("admin.newTitle.uploading") : tt("admin.title.upload")}
        </button>
      </div>
      {readyRows(rows).length === 0 && !busy && <p className="hint">{tt("admin.newTitle.chooseFile")}</p>}
    </div>
  );
}
