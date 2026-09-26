"use client";

// One campaign's launch, step by step, on its Monitor row while it is being
// prepared or after it failed before finishing (decision 2026-09-26 "Launch
// progress on the Monitor"). The steps come from `lib/launch/progress.ts`,
// which reads only the checkpoints the driver wrote; this component draws
// them and nothing else. A failure's words sit under the step that failed
// (the Monitor's own `failure(...)` block, hint and Retry included), and a
// step that has not moved for longer than its limit turns amber with how long
// and what it is waiting on.

import type { ReactNode } from "react";
import type { LaunchProgress as Progress, ProgressStep } from "@/lib/launch/progress";

type Tt = (key: string, vars?: Record<string, string | number>) => string;

const minutes = (ms: number) => Math.max(1, Math.floor(ms / 60_000));

function Icon({ status, stuck }: { status: ProgressStep["status"]; stuck: boolean }) {
  if (status === "done") return <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 8.2 3 3 6-6.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (status === "failed") return <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
  if (status === "current") return stuck
    ? <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 4.2v4.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="8" cy="11.4" r="1" fill="currentColor" /></svg>
    : <i className="lpg-spin" aria-hidden="true" />;
  return null;
}

export default function LaunchProgress({ progress, tt, failure, onCheckNow, checking = false }: {
  progress: Progress; tt: Tt;
  /** The Monitor's failure block for this campaign (hint, provider's words, Retry). */
  failure: ReactNode;
  onCheckNow?: () => void; checking?: boolean;
}) {
  const { steps, stuck } = progress;
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const tone = progress.failed ? "failed" : stuck ? "stuck" : "active";
  return <div className={`lpg lpg-${tone}`} data-testid="launch-progress" data-step={progress.current ?? ""} data-tone={tone}>
    <div className="lpg-head">
      <strong>{tt("lpg.title")}</strong>
      <span className="lpg-count">{tt("lpg.stepOf", { done: progress.done, total: progress.total })}</span>
      {onCheckNow && !progress.failed && <button type="button" className="lm-row-button lpg-check" disabled={checking} onClick={onCheckNow}>{tt("lpg.checkNow")}</button>}
    </div>
    <div className="lpg-bar" role="progressbar" aria-label={tt("lpg.title")} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}><i style={{ width: `${pct}%` }} /></div>
    {progress.queued && <p className="lpg-queued">{tt("lpg.queued")}</p>}
    <ol className="lpg-steps">
      {steps.map((step) => {
        const isStuck = step.status === "current" && !!stuck;
        // Counts belong to the step being worked on; a done step says only that it is done.
        const meta: string[] = step.status === "todo" || step.status === "done" ? [] : step.counts.map((c) => tt(`lpg.count.${c.key}`, { done: c.done, of: c.of }));
        if (step.status === "done" && step.outcome) meta.push(tt(`lpg.outcome.${step.outcome}`));
        if (step.status === "current" && progress.elapsed_ms !== null)
          meta.push(progress.elapsed_ms < 60_000 ? tt("lpg.forLess") : tt("lpg.for", { n: minutes(progress.elapsed_ms) }));
        return <li key={step.key} className={`lpg-step is-${step.status}${isStuck ? " is-stuck" : ""}`} data-step={step.key} data-status={isStuck ? "stuck" : step.status}>
          <div className="lpg-line">
            <span className="lpg-icon"><Icon status={step.status} stuck={isStuck} /></span>
            <span className="lpg-label">{tt(step.label)}<span className="sr-only"> · {tt(`lpg.status.${step.status}`)}</span></span>
            {meta.length > 0 && <span className="lpg-meta">{meta.join(" · ")}</span>}
          </div>
          {isStuck && stuck && <div className="lpg-note lpg-note-stuck" role="status" data-testid="launch-stuck">
            <p>{tt("lpg.stuck", { n: minutes(stuck.wait_ms), what: tt(stuck.what), usual: tt(stuck.usual) })}</p>
            {stuck.reason && <p className="lpg-reason">{stuck.reason}</p>}
          </div>}
          {step.status === "current" && !isStuck && progress.waiting?.reason && <p className="lpg-reason lpg-wait">{progress.waiting.reason}</p>}
          {step.status === "failed" && <div className="lpg-note lpg-note-failed">{failure}</div>}
        </li>;
      })}
    </ol>
  </div>;
}
