import { fmtShare, share, SURVEY_ANSWERS } from "@/lib/crazydramas/stats-summary";
import { t, type Locale } from "@/lib/i18n";

// The one-tap answers on the CrazyDramas stats pages (the kinds of phone are
// Dash.tsx's BreakdownTable; every ad, by campaign, is CampaignTable.tsx).
// Server components.

const n0 = (v: number) => v.toLocaleString("en-US");

/** One question's answers as bars, most-answered first, with how many saw it. */
export function SurveyView({ kind, shown, answers, locale }: { kind: keyof typeof SURVEY_ANSWERS; shown: number; answers: Record<string, number>; locale: Locale }) {
  const answered = Object.values(answers).reduce((a, n) => a + n, 0);
  const keys = [...SURVEY_ANSWERS[kind], ...Object.keys(answers).filter((k) => !(SURVEY_ANSWERS[kind] as readonly string[]).includes(k))];
  const max = Math.max(1, ...keys.map((k) => answers[k] ?? 0));
  return (
    <div className="cds-survey">
      <h3>{t(locale, `cds.survey.${kind}.q`)}</h3>
      <p className="cds-sub-line">{shown > 0 ? t(locale, "cds.survey.counts", { shown: n0(shown), answered: n0(answered) }) : t(locale, "cds.survey.notYet")}</p>
      {answered > 0 && (
        <ul className="cds-path cds-answers">
          {keys
            .sort((a, b) => (answers[b] ?? 0) - (answers[a] ?? 0))
            .map((k) => (
              <li key={k}>
                <span className="cds-path-label">{t(locale, `cds.survey.${kind}.${k}`)}</span>
                <span className="cds-path-track" aria-hidden>
                  <span className={`cds-path-fill${(answers[k] ?? 0) === 0 ? " is-zero" : ""}`} style={{ width: `${((answers[k] ?? 0) / max) * 100}%`, display: "block" }} />
                </span>
                <span className="cds-path-count">{n0(answers[k] ?? 0)}</span>
                <span className="cds-path-share">{fmtShare(share(answers[k] ?? 0, answered))}</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
