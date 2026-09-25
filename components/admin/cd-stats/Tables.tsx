import { fmtShare, fmtUsdCents, share, SURVEY_ANSWERS, type AdRow, type DeviceRow } from "@/lib/crazydramas/stats-summary";
import { t, type Locale } from "@/lib/i18n";

// The CrazyDramas stats tables that say where people came from and why they
// stopped: every ad with what it cost and what it brought, the kinds of phone,
// and the one-tap answers. Server components; numbers right-aligned, a share
// under a count only when there is a count.

const n0 = (v: number) => v.toLocaleString("en-US");
const cents = (v: number | null) => (v == null ? "–" : v < 100 ? `${v}¢` : fmtUsdCents(v));

function Cell({ n, of }: { n: number; of: number }) {
  return (
    <td className="gt-num">
      {n0(n)}
      {n > 0 && of > 0 && <span className="cds-sub">{fmtShare(share(n, of))}</span>}
    </td>
  );
}

/** The ad whose episode 1 finishers cost least, among ads with at least 3 of them: the one to feed. */
export function bestAdKey(rows: AdRow[]): string | null {
  const ranked = rows.filter((r) => r.kind === "ad" && r.cost_per_finisher_cents != null && r.finished_ep1 >= 3).sort((a, b) => a.cost_per_finisher_cents! - b.cost_per_finisher_cents!);
  return ranked.length > 1 ? ranked[0].key : null;
}

function AdName({ row, locale }: { row: AdRow; locale: Locale }) {
  if (row.kind === "stored_copy") return <><strong>{t(locale, "cds.ads.storedCopy")}</strong><span className="cds-sub">{t(locale, "cds.ads.storedCopySub")}</span></>;
  if (row.kind === "no_ad") return <><strong>{t(locale, "cds.ads.noAd")}</strong><span className="cds-sub">{t(locale, "cds.ads.noAdSub")}</span></>;
  return (
    <>
      <strong>{row.spend ? row.spend.launch_name : t(locale, "cds.ads.notStudio")}</strong>
      <span className="cds-sub">
        {row.spend ? `${row.spend.campaign_name} · ` : ""}
        {t(locale, "cds.ads.adId", { id: row.ad ?? "–" })}
      </span>
    </>
  );
}

export function AdTableView({ rows, locale, caption }: { rows: AdRow[]; locale: Locale; caption: string }) {
  if (!rows.length) return <p className="rs-empty">{t(locale, "cds.ads.none")}</p>;
  const best = bestAdKey(rows);
  return (
    <div className="an-scroll" tabIndex={0} role="region" aria-label={caption}>
      <table className="an-table cds-table cds-ads">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t(locale, "cds.ads.col.ad")}</th>
            <th scope="col" className="gt-num">{t(locale, "cds.ads.col.spend")}</th>
            <th scope="col" className="gt-num">{t(locale, "cds.ads.col.clicks")}</th>
            <th scope="col" className="gt-num">{t(locale, "cds.ads.col.people")}</th>
            <th scope="col" className="gt-num">{t(locale, "cds.col.playedEp1")}</th>
            <th scope="col" className="gt-num">{t(locale, "cds.col.finishedEp1")}</th>
            <th scope="col" className="gt-num">{t(locale, "cds.col.watchedEp", { n: 2 })}</th>
            <th scope="col" className="gt-num">{t(locale, "cds.col.buyers")}</th>
            <th scope="col" className="gt-num">{t(locale, "cds.ads.col.perPerson")}</th>
            <th scope="col" className="gt-num">{t(locale, "cds.ads.col.perFinisher")}</th>
            <th scope="col" className="gt-num">{t(locale, "cds.ads.col.perEp2")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.key === best ? "cds-best" : undefined}>
              <th scope="row" className="cds-title">
                <AdName row={r} locale={locale} />
                {r.key === best && <span className="cds-badge">{t(locale, "cds.ads.best")}</span>}
              </th>
              <td className="gt-num">{r.spend?.spend_cents != null ? fmtUsdCents(r.spend.spend_cents) : "–"}</td>
              <td className="gt-num">{r.spend?.clicks != null ? n0(r.spend.clicks) : "–"}</td>
              <td className="gt-num">
                {n0(r.opened)}
                {r.spend?.clicks ? <span className="cds-sub">{t(locale, "cds.ads.ofClicks", { share: fmtShare(share(r.opened, r.spend.clicks)) })}</span> : null}
              </td>
              <Cell n={r.started_ep1} of={r.opened} />
              <Cell n={r.finished_ep1} of={r.opened} />
              <Cell n={r.watched_ep2} of={r.opened} />
              <Cell n={r.buyers} of={r.opened} />
              <td className="gt-num">{cents(r.cost_per_person_cents)}</td>
              <td className="gt-num"><strong>{cents(r.cost_per_finisher_cents)}</strong></td>
              <td className="gt-num">{cents(r.cost_per_ep2_cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
