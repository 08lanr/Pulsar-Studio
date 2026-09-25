import { dashPath, fmtShare, fmtUsdCents, histSummary, share, type DashTotals } from "@/lib/crazydramas/stats-summary";
import { t, type Locale } from "@/lib/i18n";

// The dashboard's pieces (/crazydramas/stats, 2026-09-25): the path from landing to paying, what happened
// before the video started with the three timing histograms, and the breakdown tables (by phone, by series).
// Server components on the house chart classes; every bar carries its number in text and a tooltip.

const n0 = (v: number) => v.toLocaleString("en-US");

/** The path, one row per step: a bar as a share of the people who landed, the people, of seen, went on. */
export function PathView({ totals, locale }: { totals: DashTotals; locale: Locale }) {
  const steps = dashPath(totals);
  const top = Math.max(1, steps[0].people);
  return (
    <>
      <ul className="cds-path cdd-funnel" aria-label={t(locale, "cdd.path.title")}>
        <li className="cdd-funnel-head" aria-hidden>
          <span />
          <span />
          <span className="cds-path-count">{t(locale, "cdd.path.people")}</span>
          <span className="cds-path-share">{t(locale, "cdd.path.colShare")}</span>
          <span className="cds-path-share">{t(locale, "cdd.path.colPrev")}</span>
        </li>
        {steps.map((s) => (
          <li key={s.key} title={`${t(locale, `cdd.path.${s.key}`)}: ${n0(s.people)}`}>
            <span className="cds-path-label">{t(locale, `cdd.path.${s.key}`)}</span>
            <span className="cds-path-track" aria-hidden>
              <span className={`cds-path-fill${s.people === 0 ? " is-zero" : ""}${s.key === "landed" ? " cdd-soft" : ""}`} style={{ width: `${(s.people / top) * 100}%`, display: "block" }} />
            </span>
            <span className="cds-path-count">{n0(s.people)}</span>
            <span className="cds-path-share">{s.key === "landed" ? "" : fmtShare(s.of_seen)}</span>
            <span className="cds-path-share">{s.of_prev === null ? "" : fmtShare(s.of_prev)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** One line of "before the video starts": the count, its share, and what it means. */
function Fact({ label, n, note, sub }: { label: string; n: number; note: string | null; sub?: string }) {
  return (
    <li className="cdd-fact">
      <div>
        <span className="cdd-fact-label">{label}</span>
        {sub && <span className="cdd-fact-sub">{sub}</span>}
      </div>
      <strong className="cdd-fact-n">{n0(n)}</strong>
      <span className="cdd-fact-share">{note ?? ""}</span>
    </li>
  );
}

export function BeforeStart({ totals, locale }: { totals: DashTotals; locale: Locale }) {
  const landed = totals.opened + totals.unseen;
  const wait = totals.left_waiting > 0 ? `${Math.round(totals.left_waiting_seconds / totals.left_waiting)} s` : "–";
  return (
    <ul className="cdd-facts">
      <Fact label={t(locale, "cdd.before.unseen")} n={totals.unseen} note={t(locale, "cdd.before.of", { share: fmtShare(share(totals.unseen, landed)) })} sub={t(locale, "cdd.before.unseenSub")} />
      <Fact label={t(locale, "cdd.before.noEvents")} n={totals.no_events} note={t(locale, "cdd.before.ofSeen", { share: fmtShare(share(totals.no_events, totals.opened)) })} sub={t(locale, "cdd.before.noEventsSub")} />
      <Fact label={t(locale, "cdd.before.never")} n={totals.never_started} note={t(locale, "cdd.before.ofSeen", { share: fmtShare(share(totals.never_started, totals.opened)) })} />
      <Fact label={t(locale, "cdd.before.left")} n={totals.left_waiting} note={null} sub={t(locale, "cdd.before.leftSub", { wait })} />
      <Fact
        label={t(locale, "cdd.before.restarted")}
        n={totals.restarted}
        note={t(locale, "cdd.before.ofPlayed", { share: fmtShare(share(totals.restarted, totals.started_ep1)) })}
        sub={t(locale, "cdd.before.restartedSub", { muted: n0(totals.restarted_muted) })}
      />
      <Fact label={t(locale, "cdd.before.blocked")} n={totals.blocked} note={t(locale, "cdd.before.ofPlayed", { share: fmtShare(share(totals.blocked, totals.started_ep1)) })} sub={t(locale, "cdd.before.blockedSub")} />
      <Fact label={t(locale, "cdd.before.errors")} n={totals.errors} note={t(locale, "cdd.before.ofSeen", { share: fmtShare(share(totals.errors, totals.opened)) })} />
    </ul>
  );
}

/** A timing histogram as columns, one per bin (under 1 s, 1-2 s, ...), with its count on top and a summary line. */
export function HistView({ title, hist, edges, locale }: { title: string; hist: number[]; edges: number[]; locale: Locale }) {
  const h = histSummary(hist, edges);
  const max = Math.max(1, ...h.bins.map((b) => b.people));
  return (
    <figure className="cdd-hist">
      <figcaption>
        <strong>{title}</strong>
        <span>
          {h.n > 0
            ? t(locale, "cdd.hist.summary", { n: n0(h.n), median: h.median ?? "–", p75: h.p75 ?? "–", over5: fmtShare(h.over5) })
            : t(locale, "cdd.hist.none")}
        </span>
      </figcaption>
      {h.n > 0 && (
        <div className="cdd-hist-cols" role="list">
          {h.bins.map((b) => (
            <div key={b.label} className="cdd-hist-col" role="listitem" title={t(locale, "cdd.hist.tip", { label: b.label, n: n0(b.people) })}>
              <span className="cdd-hist-n">{b.people > 0 ? n0(b.people) : ""}</span>
              <span className="cdd-hist-bar-wrap" aria-hidden>
                <span className={`cdd-hist-bar${b.people === 0 ? " is-zero" : ""}`} style={{ height: `${(b.people / max) * 100}%` }} />
              </span>
              {/* "13–20", not "13–20s": the unit is said once, under the columns. */}
              <span className="cdd-hist-label">{b.label.replace(/s(\+?)$/, "$1")}</span>
            </div>
          ))}
        </div>
      )}
      {h.n > 0 && <div className="cdd-hist-axis">{t(locale, "cdd.hist.axis")}</div>}
    </figure>
  );
}

function Cell({ n, of }: { n: number; of: number }) {
  return (
    <td className="gt-num">
      {n0(n)}
      {n > 0 && of > 0 && <span className="cds-sub">{fmtShare(share(n, of))}</span>}
    </td>
  );
}

export type BreakdownRow = { key: string; name: string; sub?: string | null; href?: string | null; only?: string | null; totals: DashTotals };

/** One row per phone (or series): the path's main steps, the page and first-frame medians, sound and restarts. */
export function BreakdownTable({ rows, caption, edges, revenue = false, locale }: { rows: BreakdownRow[]; caption: string; edges: number[]; revenue?: boolean; locale: Locale }) {
  if (!rows.length) return null;
  const median = (hist: number[]) => histSummary(hist, edges).median ?? "–";
  return (
    <div className="an-scroll" tabIndex={0} role="region" aria-label={caption}>
      <table className="an-table cds-table cdd-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t(locale, "cdd.col.name")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdd.col.landed")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdd.col.unseen")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdd.col.seen")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdd.col.played")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdd.col.quarter")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdd.col.finished")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdd.col.ep2")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdd.col.paid")}</th>
            {revenue && <th scope="col" className="gt-num">{t(locale, "cdd.col.revenue")}</th>}
            <th scope="col" className="gt-num">{t(locale, "cdd.col.load")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdd.col.start")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdd.col.sound")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdd.col.restarted")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const x = r.totals;
            const landed = x.opened + x.unseen;
            return (
              <tr key={r.key}>
                <th scope="row" className="cds-title">
                  {r.href ? <a href={r.href}>{r.name}</a> : r.name}
                  {r.sub && <span className="cds-sub">{r.sub}</span>}
                  {r.only && (
                    <a className="cdd-only" href={r.only}>
                      {t(locale, "cdd.col.only")}
                    </a>
                  )}
                </th>
                <td className="gt-num">{n0(landed)}</td>
                <Cell n={x.unseen} of={landed} />
                <td className="gt-num">{n0(x.opened)}</td>
                <Cell n={x.started_ep1} of={x.opened} />
                <Cell n={x.ep1_25} of={x.opened} />
                <Cell n={x.finished_ep1} of={x.opened} />
                <Cell n={x.watched_ep2} of={x.opened} />
                <Cell n={x.buyers} of={x.opened} />
                {revenue && <td className="gt-num">{fmtUsdCents(x.revenue_cents)}</td>}
                <td className="gt-num">{median(x.load_hist)}</td>
                <td className="gt-num">{median(x.start_hist)}</td>
                <td className="gt-num">{x.ep1_sound_known > 0 ? fmtShare(share(x.ep1_sound_on, x.ep1_sound_known)) : "–"}</td>
                <Cell n={x.restarted} of={x.started_ep1} />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

