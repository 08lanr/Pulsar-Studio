"use client";

// The runs desk (plan B1): one row per segmenting run — film, source,
// mode, stage with its progress or refusal, when it last moved — and a
// fixed action column that opens the run. Polls while any run is alive.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, getJson } from "@/lib/api-client";
import { useT } from "@/components/locale";
import type { RunsReply } from "@/lib/segment/api-types";
import type { FilmRun, FilmRunStage } from "@/lib/types";
import { isTerminal, isWaiting, progressText } from "./model";

const POLL_MS = 5000;

export function stagePill(stage: FilmRunStage): string {
  if (stage === "failed") return "pill-error";
  if (stage === "cancelled") return "pill-neutral";
  if (stage === "done") return "pill-success";
  if (isWaiting(stage)) return "pill-warning";
  if (stage === "queued") return "pill-neutral";
  return "pill-accent";
}

function baseName(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

function when(iso: string, locale: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale === "zh" ? "zh-CN" : "en-GB", { hour12: false });
}

export default function RunList() {
  const { tt, locale } = useT();
  const [runs, setRuns] = useState<FilmRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await getJson<RunsReply>("/api/admin/films/runs");
      setRuns(r.runs);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : (e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const anyAlive = useMemo(() => !!runs?.some((r) => !isTerminal(r.stage)), [runs]);
  useEffect(() => {
    if (!anyAlive) return;
    timer.current = setTimeout(() => void load(), POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [anyAlive, runs, load]);

  const cols = "minmax(200px,2fr) minmax(160px,1.6fr) 120px minmax(200px,2fr) 160px 96px";

  return (
    <section aria-label={tt("seg.list.title")}>
      <div style={{ display: "flex", gap: 16, alignItems: "center", justifyContent: "flex-end", marginBottom: 12 }}>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => void load()}>{tt("seg.refresh")}</button>
      </div>
      {error && <p className="err" role="alert">{tt("seg.list.loadFailed", { detail: error })}</p>}
      {!runs && !error && <p className="hint" role="status">{tt("seg.loading")}</p>}
      {runs && runs.length === 0 && <p className="hint">{tt("seg.list.empty")}</p>}
      {runs && runs.length > 0 && (
        <div className="gtable" role="region" aria-label={tt("seg.list.title")} tabIndex={0} style={{ "--cols": cols } as React.CSSProperties}>
          <div className="gt-head">
            <span>{tt("seg.col.film")}</span>
            <span>{tt("seg.col.source")}</span>
            <span>{tt("seg.col.mode")}</span>
            <span>{tt("seg.col.stage")}</span>
            <span>{tt("seg.col.updated")}</span>
            <span>{tt("seg.col.action")}</span>
          </div>
          {runs.map((run) => {
            const progress = progressText(run.stage_detail);
            return (
              <div className="gt-row" key={run.id} data-run-id={run.id} data-slug={run.slug} data-stage={run.stage}>
                <span style={{ display: "grid", gap: 2 }}>
                  <strong lang="en">{run.slug}</strong>
                  <small className="gt-muted">{run.bucket} · {run.lang}</small>
                </span>
                <span className="gt-muted" title={run.source_path} style={{ overflowWrap: "anywhere" }}>{baseName(run.source_path)}</span>
                <span className="gt-muted">{tt(`seg.mode.${run.mode}`)}</span>
                <span style={{ display: "grid", gap: 2 }}>
                  <span><span className={`pill ${stagePill(run.stage)}`}>{tt(`seg.stage.${run.stage}`)}</span></span>
                  {run.error_text ? <small className="err" title={run.error_text}>{run.error_text.split("\n")[0]}</small> : progress ? <small className="gt-muted">{progress}</small> : null}
                </span>
                <span className="gt-muted">{when(run.updated_at, locale)}</span>
                <span><a className="btn btn-outline btn-sm" href={`/films/runs/${run.id}`}>{tt("seg.action.open")}</a></span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
