"use client";

// The stage track of one run (plan B2): every stage the mode walks, done
// / active / ahead, the active stage's progress line, a "waiting for you"
// mark when the worker waits for a person, and the stage a failed run
// stopped at (`stage_detail.failed_stage`). The vertical .timeline of the
// workbench rail; nothing new.

import { useT } from "@/components/locale";
import type { FilmRun } from "@/lib/types";
import { isWaiting, progressText, stageIndex, stepsFor, waitingFor } from "./model";

export default function RunTimeline({ run }: { run: FilmRun }) {
  const { tt } = useT();
  const steps = stepsFor(run.mode);
  const active = stageIndex(run.stage, run.mode);
  const failed = run.stage === "failed" || run.stage === "cancelled";
  const detail = run.stage_detail && typeof run.stage_detail === "object" && !Array.isArray(run.stage_detail) ? (run.stage_detail as Record<string, unknown>) : null;
  const stoppedAt = failed ? (typeof detail?.failed_stage === "string" ? detail.failed_stage : typeof detail?.cancelled_from === "string" ? detail.cancelled_from : null) : null;
  const failedAt = stoppedAt ? steps.indexOf(stoppedAt as (typeof steps)[number]) : -1;
  const progress = progressText(run.stage_detail);
  const waiting = waitingFor(run.stage_detail) !== null || (!failed && isWaiting(run.stage, run.stage_detail));
  return (
    <ol className="timeline" aria-label={tt("seg.timeline")}>
      {steps.map((s, i) => {
        const done = !failed ? i < active : failedAt >= 0 && i < failedAt;
        const on = !failed ? i === active : i === failedAt;
        const cls = ["tl-step", done ? "done" : "", on ? "active" : ""].filter(Boolean).join(" ");
        return (
          <li key={s} className={cls} data-stage={s} aria-current={on ? "step" : undefined}>
            <span className="tl-dot" aria-hidden>{done ? "✓" : i + 1}</span>
            <span>
              <span className="tl-title">
                {tt(`seg.stage.${s}`)}
                {on && !failed && waiting ? <> <span className="pill pill-warning">{tt("seg.waiting")}</span></> : null}
              </span>
              {on && !failed && progress ? <span className="tl-body" role="status">{progress}</span> : null}
              {on && failed ? <span className="tl-body">{tt(`seg.stage.${run.stage}`)}</span> : null}
              {!on ? <span className="tl-body">{tt(`seg.stageHint.${s}`)}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
