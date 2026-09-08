// Server-safe pieces of the launch workspace: the score dial, band pill,
// component bars, fact lines, experiment stage strip.

import type { Locale } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import type { Assessment, Band, Component, Fact } from "@/lib/research/assessment";
import { ASSESSMENT_VERSION } from "@/lib/research/assessment";
import type { ExperimentStage } from "@/lib/research/workspace";
import { EvidenceTag } from "./ui";

export function ScoreDial({ score, band, locale, size = "lg" }: { score: number; band: Band; locale: Locale; size?: "lg" | "sm" }) {
  const deg = Math.round((score / 100) * 360);
  return (
    <div className={`ws-dial ws-dial-${size} band-${band}`} style={{ ["--deg" as string]: `${deg}deg` }} role="img" aria-label={`${t(locale, "ws.score.label")} ${score} ${t(locale, "ws.score.of")}`}>
      <div className="ws-dial-inner">
        <b>{score}</b>
        {size === "lg" && <small>{t(locale, "ws.score.of")}</small>}
      </div>
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
        <h4>{t(locale, `ws.component.${c.key}`)}</h4>
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

const STAGES: ExperimentStage[] = ["brief", "concepts", "batch", "budget", "submitted", "results", "decide"];

export function StageStrip({ stage, locale }: { stage: ExperimentStage; locale: Locale }) {
  const idx = STAGES.indexOf(stage);
  return (
    <ol className="ws-stages" aria-label={t(locale, "ws.exp.col.stage")}>
      {STAGES.map((s, i) => (
        <li key={s} className={i < idx ? "is-done" : i === idx ? "is-current" : ""}>
          <i>{i < idx ? "✓" : i + 1}</i>
          <span>{t(locale, `ws.exp.stage.${s}`)}</span>
        </li>
      ))}
    </ol>
  );
}
