import Info from "@/components/admin/cd-stats/Info";
import { earlyExits, endLabel, fmtShare, landingSplit, share, type EarlyExits } from "@/lib/crazydramas/stats-summary";
import type { CdStatsDrop, CdStatsPlayback } from "@/lib/crazydramas/stats-types";
import { t, type Locale } from "@/lib/i18n";

// The Playback tab's own pieces (2026-09-25, the playback report): why views ended early, where the start's
// time goes, and the latest early endings one by one with what happened in each. Server components; every
// bar has its number beside it in text.

const n0 = (v: number) => v.toLocaleString("en-US");
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const FAMILIES = ["problem", "choice", "unknown"] as const;

/** Why views ended early: one bar split into what went wrong / chose to stop / unknown, then every reason. */
export function EndsCard({ exits, locale }: { exits: EarlyExits; locale: Locale }) {
  if (!exits.total) return <p className="cdx-empty">{t(locale, "cdp.ends.none")}</p>;
  const max = Math.max(1, ...exits.reasons.map((r) => r.people));
  return (
    <>
      <div className="cdp-split" role="img" aria-label={FAMILIES.map((f) => `${t(locale, `cdp.family.${f}`)} ${exits.families[f]}`).join(", ")}>
        {FAMILIES.map((f) =>
          exits.families[f] > 0 ? <span key={f} className={`cdp-seg cdp-${f}`} style={{ flexGrow: exits.families[f] }} title={`${t(locale, `cdp.family.${f}`)}: ${n0(exits.families[f])}`} /> : null,
        )}
      </div>
      <ul className="cdp-legend">
        {FAMILIES.map((f) => (
          <li key={f}>
            <span className={`cdp-dot cdp-${f}`} aria-hidden />
            {t(locale, `cdp.family.${f}`)} <strong>{fmtShare(share(exits.families[f], exits.total))}</strong> <span className="cdx-muted">({n0(exits.families[f])})</span>
          </li>
        ))}
      </ul>
      <ul className="cds-path cdp-reasons">
        {exits.reasons.map((r) => (
          <li key={r.key}>
            <span className="cds-path-label">
              <span className={`cdp-dot cdp-${r.family}`} aria-hidden /> {t(locale, `cdp.end.${r.key}`)}
            </span>
            <span className="cds-path-track" aria-hidden>
              <span className={`cds-path-fill cdp-fill-${r.family}`} style={{ width: `${(r.people / max) * 100}%`, display: "block" }} />
            </span>
            <span className="cds-path-count">{n0(r.people)}</span>
            <span className="cds-path-share">{fmtShare(share(r.people, exits.total))}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Where the start's time goes on the episode the page opened on: the page, the player, the video; overall and by phone. */
export function StartSplit({ rows, locale }: { rows: { key: string; name: string; play: CdStatsPlayback }[]; locale: Locale }) {
  const split = rows.map((r) => ({ ...r, s: landingSplit(r.play) })).filter((r) => r.s);
  if (!split.length) return <p className="cdx-empty">{t(locale, "cdp.split.none")}</p>;
  const max = Math.max(...split.map((r) => r.s!.page + r.s!.player + r.s!.video));
  return (
    <>
      <ul className="cdp-legend">
        {(["page", "player", "video"] as const).map((k) => (
          <li key={k}>
            <span className={`cdp-dot cdp-part-${k}`} aria-hidden />
            {t(locale, `cdp.split.${k}`)} <Info text={t(locale, `cdp.split.${k}Info`)} label={t(locale, "cdx.about", { what: t(locale, `cdp.split.${k}`) })} />
          </li>
        ))}
      </ul>
      <ul className="cdp-bars">
        {split.map((r) => {
          const s = r.s!;
          const total = s.page + s.player + s.video;
          return (
            <li key={r.key}>
              <span className="cdp-bar-name">{r.name}</span>
              <span className="cdp-bar" style={{ width: `${(total / max) * 100}%` }} title={`${t(locale, "cdp.split.page")} ${sec(s.page)} · ${t(locale, "cdp.split.player")} ${sec(s.player)} · ${t(locale, "cdp.split.video")} ${sec(s.video)}`}>
                <span className="cdp-part-page" style={{ flexGrow: s.page }} />
                <span className="cdp-part-player" style={{ flexGrow: s.player }} />
                <span className="cdp-part-video" style={{ flexGrow: s.video }} />
              </span>
              <span className="cdp-bar-total">
                {sec(total)} <span className="cdx-muted">({sec(s.page)} + {sec(s.player)} + {sec(s.video)})</span>
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });

/** What happened in one view, in words: "0.9 s started · 2.7 s phone paused it · ...". */
function Timeline({ steps, locale }: { steps: [number, string, number][]; locale: Locale }) {
  if (!steps.length) return <span className="cdx-muted">{t(locale, "cdp.drops.noSteps")}</span>;
  return (
    <ol className="cdp-steps">
      {steps.map(([ms, code, pos], i) => (
        <li key={i}>
          <span className="cdp-step-t">{sec(ms)}</span> {t(locale, `cdp.step.${code}`)}
          {["pause_phone", "stall", "hidden", "pause_viewer"].includes(code) && pos > 0 && <span className="cdx-muted"> {t(locale, "cdp.drops.at", { s: pos.toFixed(1) })}</span>}
        </li>
      ))}
    </ol>
  );
}

/** The latest early endings, one row each; the ending opens what happened, step by step. */
export function DropsList({ drops, titleOf, locale }: { drops: CdStatsDrop[]; titleOf: (id: string) => string; locale: Locale }) {
  if (!drops.length) return <p className="cdx-empty">{t(locale, "cdp.drops.none")}</p>;
  return (
    <div className="an-scroll" tabIndex={0} role="region" aria-label={t(locale, "cdp.drops.title")}>
      <table className="an-table cds-table cdx-table cdp-drops">
        <thead>
          <tr>
            <th scope="col">{t(locale, "cdp.drops.when")}</th>
            <th scope="col">{t(locale, "cdp.drops.viewer")}</th>
            <th scope="col">{t(locale, "cdp.drops.what")}</th>
            <th scope="col">{t(locale, "cdp.drops.ended")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdx.col.frame")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdp.col.freezes")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdp.col.phonePaused")}</th>
            <th scope="col" className="gt-num">{t(locale, "cdp.drops.watched")}</th>
          </tr>
        </thead>
        <tbody>
          {drops.map((d, i) => (
            <tr key={`${d.code}-${d.at}-${i}`}>
              <td className="cdp-nowrap">{when(d.at)}</td>
              <td className="cdp-nowrap">
                <code>{d.code}</code>
                <span className="cds-sub">{t(locale, `cds.dev.${d.device}`)}</span>
              </td>
              <td className="cds-title-cell">
                {titleOf(d.drama_id)}
                <span className="cds-sub">{t(locale, "cdp.drops.ep", { n: d.episode })}</span>
              </td>
              <td>
                <details className="cdp-detail">
                  <summary>{t(locale, `cdp.end.${endLabel(d.ended)}`)}</summary>
                  <Timeline steps={d.timeline} locale={locale} />
                  <p className="cdx-muted cdp-facts">
                    {[d.quality, d.conn, d.bw_kbps ? `${(d.bw_kbps / 1000).toFixed(1)} Mbit/s` : null].filter(Boolean).join(" · ")}
                  </p>
                </details>
              </td>
              <td className="gt-num">{d.first_frame_ms === null ? "–" : sec(d.first_frame_ms)}</td>
              <td className="gt-num">{d.stalls ? `${d.stalls} · ${sec(d.stall_ms)}` : "0"}</td>
              <td className="gt-num">{d.phone_pauses}</td>
              <td className="gt-num">
                {d.watched_s.toFixed(0)} s<span className="cds-sub">{t(locale, "cdp.drops.onScreen", { s: d.on_screen_s.toFixed(0) })}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

