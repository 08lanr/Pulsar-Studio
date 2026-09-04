"use client";

import { postForm } from "@/lib/api-client";

export type UploadRow = {
  id: string;
  number: number;
  subtitles: File | null;
  video: File | null;
};

export type IngestOutcome = {
  number: number;
  episode?: unknown;
  warnings: string[];
  summary?: { lines: number; scenes: number; has_timecodes: boolean };
  error?: string;
};

let rowSequence = 0;

export function newRow(number: number): UploadRow {
  rowSequence += 1;
  return { id: `episode-upload-${rowSequence}`, number, subtitles: null, video: null };
}

export function readyRows(rows: UploadRow[]) {
  return rows.filter((row) => row.subtitles && Number.isInteger(row.number) && row.number > 0);
}

export async function ingestRows(titleId: string, rows: UploadRow[]): Promise<IngestOutcome[]> {
  return Promise.all(
    readyRows(rows).map(async (row) => {
      const form = new FormData();
      form.set("episode_number", String(row.number));
      form.set("subtitles", row.subtitles as File);
      if (row.video) form.set("video", row.video);
      try {
        const result = await postForm<{
          episode?: unknown;
          warnings?: string[];
          summary?: { lines: number; scenes: number; has_timecodes: boolean };
          error?: string;
        }>(
          `/api/titles/${titleId}/ingest`,
          form
        );
        return {
          number: row.number,
          episode: result.episode,
          warnings: result.warnings ?? [],
          summary: result.summary,
          error: result.error,
        };
      } catch (error) {
        return {
          number: row.number,
          warnings: [],
          error: error instanceof Error ? error.message : "Upload failed",
        };
      }
    })
  );
}

export default function EpisodeUploader({
  rows,
  onChange,
  disabled = false,
}: {
  rows: UploadRow[];
  onChange: (rows: UploadRow[]) => void;
  disabled?: boolean;
}) {
  function update(id: string, patch: Partial<UploadRow>) {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function add() {
    const next = Math.max(0, ...rows.map((row) => row.number)) + 1;
    onChange([...rows, newRow(next)]);
  }

  return (
    <div className="group">
      {rows.map((row) => (
        <div key={row.id} className="card card-subtle">
          <div className="picker-row">
            <label className="field">
              <span className="field-label">Episode number</span>
              <input
                className="input"
                type="number"
                min={1}
                value={row.number}
                disabled={disabled}
                onChange={(event) => update(row.id, { number: Number(event.target.value) })}
              />
            </label>
            <label className="field">
              <span className="field-label">Subtitle or script <strong>Required</strong></span>
              <input
                className="input"
                type="file"
                accept=".srt,.vtt,.ass,.ssa,.txt,text/plain"
                disabled={disabled}
                onChange={(event) => update(row.id, { subtitles: event.target.files?.[0] ?? null })}
              />
              <span className="hint">SRT, VTT, ASS/SSA, or a speaker-prefixed text script.</span>
            </label>
            <label className="field">
              <span className="field-label">Video (optional)</span>
              <input
                className="input"
                type="file"
                accept="video/*"
                disabled={disabled}
                onChange={(event) => update(row.id, { video: event.target.files?.[0] ?? null })}
              />
            </label>
          </div>
          {rows.length > 1 && (
            <button
              className="btn btn-sm btn-ghost"
              type="button"
              disabled={disabled}
              onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
            >
              Remove
            </button>
          )}
        </div>
      ))}
      <button className="btn btn-sm btn-outline" type="button" disabled={disabled} onClick={add}>
        Add another episode
      </button>
    </div>
  );
}
