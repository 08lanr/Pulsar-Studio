// Server-safe pieces of the launch workspace: the score dial, band pill,
// component bars, fact lines, experiment stage strip.

import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import type { Assessment, Band, Component, Fact } from "@/lib/research/assessment";
import { ASSESSMENT_VERSION } from "@/lib/research/assessment";
import type { ExperimentStage } from "@/lib/research/workspace";
import { WORKFLOW_STEPS, workflowStepForStage, type WorkflowStep } from "@/lib/research/workflow";
import { EvidenceTag } from "./ui";

export function ScoreDial({ score, band, locale, size = "lg" }: { score: number; band: Band; locale: Locale; size?: "lg" | "sm" }) {
  return (
    <div className={`ps-score ps-score-${size} band-${band}`}>
      <span className="sr-only">{t(locale, "ws.score.label")}: </span>
      <b>{score}</b><small>{t(locale, "ws.score.of")}</small>
    </div>
  );
}

export function BandPill({ band, locale }: { band: Band; locale: Locale }) {
  return <span className={`ws-band band-${band}`}>{t(locale, `ws.band.${band}`)}</span>;
}

export function FactLine({ f, locale }: { f: Fact; locale: Locale }) {
  return (
    <li className={f.ok === false ? "is-bad" : f.ok === null ? "is-unknown" : "is-ok"}>
      <span className="ws-fact-mark" aria-hidden>{f.ok === true ? "✓" : f.ok === false ? "✗" : "?"}</span>
      <span className="ws-fact-text">{t(locale, f.key, f.vars)}</span>
      {f.evidence && <EvidenceTag evidence={f.evidence} locale={locale} />}
      <span className="ws-fact-pts">{f.points > 0 ? `+${f.points}` : f.points === 0 ? "0" : f.points}</span>
    </li>
  );
}

export function ComponentCard({ c, locale }: { c: Component; locale: Locale }) {
  return (
    <section className="ws-component">
      <header>
        <h3>{t(locale, `ws.component.${c.key}`)}</h3>
        <span className="ws-component-pts">{t(locale, "ws.assess.pointsOf", { points: c.points, max: c.max })}</span>
      </header>
      <div className="ws-component-track"><span style={{ width: `${Math.round((c.points / c.max) * 100)}%` }} /></div>
      <ul className="ws-facts">{c.facts.map((f, i) => <FactLine key={i} f={f} locale={locale} />)}</ul>
      {c.raise.length > 0 && (
        <p className="ws-raise"><b>{t(locale, "ws.component.raise")}:</b> {c.raise.map((k) => t(locale, k)).join(" · ")}</p>
      )}
    </section>
  );
}

export function ComponentBars({ a, locale }: { a: Assessment; locale: Locale }) {
  return (
    <div className="ws-minibars" title={t(locale, "ws.score.note", { version: ASSESSMENT_VERSION })}>
      {a.components.map((c) => (
        <span key={c.key} className="ws-minibar" title={`${t(locale, `ws.component.${c.key}`)} ${c.points}/${c.max}`}>
          <i style={{ height: `${Math.max(6, Math.round((c.points / c.max) * 100))}%` }} />
        </span>
      ))}
    </div>
  );
}

export function WorkflowBadge({ step, locale }: { step: WorkflowStep; locale: Locale }) {
  return <span className={`wf-badge wf-step-${step}`}><span aria-hidden="true">{WORKFLOW_STEPS.indexOf(step) + 1}</span>{t(locale, `workflow.step.${step}`)}</span>;
}

export function StageStrip({ stage, locale, step }: { stage: ExperimentStage; locale: Locale; step?: WorkflowStep }) {
  const idx = WORKFLOW_STEPS.indexOf(step ?? workflowStepForStage[stage]);
  return (
    <ol className="ws-stages" aria-label={t(locale, "ws.exp.col.stage")}>
      {WORKFLOW_STEPS.map((s, i) => (
        <li key={s} aria-current={i === idx ? "step" : undefined} className={i < idx ? "is-done" : i === idx ? "is-current" : ""}>
          <i aria-hidden="true">{i + 1}</i>
          <span>{t(locale, `workflow.step.${s}`)}</span>
        </li>
      ))}
    </ol>
  );
}
