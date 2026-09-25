import { fmtShare, share, SURVEY_ANSWERS, type DeviceRow } from "@/lib/crazydramas/stats-summary";
import { t, type Locale } from "@/lib/i18n";

// The CrazyDramas stats tables that say who the people were and why they
// stopped: the kinds of phone and the one-tap answers (every ad, by campaign,
// is CampaignTable.tsx). Server components; numbers right-aligned, a share
// under a count only when there is a count.

const n0 = (v: number) => v.toLocaleString("en-US");

function Cell({ n, of }: { n: number; of: number }) {
  return (
    <td className="gt-num">
      {n0(n)}
      {n > 0 && of > 0 && <span className="cds-sub">{fmtShare(share(n, of))}</span>}
    </td>
  );
}

export function DeviceTableView({ rows, locale }: { rows: DeviceRow[]; locale: Locale }) {
  if (!rows.length) return null;
  const caption = t(locale, "cds.dev.caption");
  return (
    <div className="an-scroll" tabIndex={0} role="region" aria-label={caption}>
      <table className="an-table cds-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t(locale, "cds.dev.col.kind")}</th>
            <th scope="col" className="gt-num">{t(locale, "cds.col.opened")}</th>
            <th scope="col" className="gt-num">{t(locale, "cds.dev.col.noEvents")}</th>
            <th scope="col" className="gt-num">{t(locale, "cds.dev.col.neverStarted")}</th>
            <th scope="col" className="gt-num">{t(locale, "cds.col.playedEp1")}</th>
            <th scope="col" className="gt-num">{t(locale, "cds.col.finishedEp1")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.device}>
              <th scope="row">{t(locale, `cds.dev.${d.device}`)}</th>
              <td className="gt-num">{n0(d.opened)}</td>
              <Cell n={d.no_events} of={d.opened} />
              <Cell n={d.never_started} of={d.opened} />
              <Cell n={d.started_ep1} of={d.opened} />
              <Cell n={d.finished_ep1} of={d.opened} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
