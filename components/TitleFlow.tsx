import "@/app/crazydramas-hub.css";
import { t, type Locale } from "@/lib/i18n";
import type { FlowStep } from "@/lib/titles/flow";

// The per-film flow strip on the title pages (lib/titles/flow.ts): six steps,
// each with a one-line "what it is" (so Segment — the series' episodes — and
// Ad clips — short clips for ads — read as the different things they are),
// its state in words, and the way to its page. Server-rendered.

const DOT: Record<FlowStep["state"], string> = { done: "✓", next: "", later: "", skip: "–" };

export default function TitleFlow({ locale, steps }: { locale: Locale; steps: readonly FlowStep[] }) {
  return (
    <ol className="title-flow" aria-label={t(locale, "flow.label")}>
      {steps.map((s, i) => {
        const body = (
          <>
            <span className="title-flow-top">
              <span className="title-flow-dot" aria-hidden="true">{DOT[s.state] || i + 1}</span>
              <span className="title-flow-name">{t(locale, `flow.step.${s.id}`)}</span>
            </span>
            <span className="title-flow-what">{t(locale, `flow.what.${s.id}`)}</span>
            <span className="title-flow-state">{t(locale, `flow.state.${s.state}`)}</span>
          </>
        );
        return (
          <li key={s.id} className={`title-flow-step is-${s.state}`} data-step={s.id} data-state={s.state} aria-current={s.state === "next" ? "step" : undefined}>
            {s.href && s.state !== "skip" ? <a href={s.href}>{body}</a> : body}
          </li>
        );
      })}
    </ol>
  );
}
