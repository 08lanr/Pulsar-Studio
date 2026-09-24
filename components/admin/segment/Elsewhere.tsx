"use client";

// A run started on another computer (decision 2026-09-24, "two computers,
// one database"): its film folder, pictures and worker are on that disk, so
// this Studio shows where it is and how far it got, and nothing to decide.

import { useT } from "@/components/locale";
import type { FilmRun } from "@/lib/types";
import { stagePill } from "./RunList";
import RunTimeline from "./RunTimeline";

export default function Elsewhere({ run, computer }: { run: FilmRun; computer: string }) {
  const { tt } = useT();
  return (
    <div style={{ display: "grid", gap: 16 }} data-testid="run-elsewhere">
      <div className="page-head">
        <div>
          <h1 lang="en">{run.slug}</h1>
          <p className="page-sub">{tt("seg.elsewhere.sub", { computer })}</p>
        </div>
        <div className="title-actions sgm-actions">
          <span className={`pill ${stagePill(run.stage)}`} data-stage={run.stage}>{tt(`seg.stage.${run.stage}`)}</span>
          <a className="btn btn-ghost btn-sm" href="/films/runs">{tt("seg.run.back")}</a>
        </div>
      </div>
      <p className="note note-info" role="status">{tt("seg.elsewhere.note", { computer })}</p>
      <div className="sgm-layout">
        <aside className="card"><RunTimeline run={run} /></aside>
      </div>
    </div>
  );
}
