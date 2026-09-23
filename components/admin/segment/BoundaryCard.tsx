"use client";

// One boundary of the review (plan B3): the chosen option's strip with
// the cut tile marked, the other options' strips in a row, the ±5 s proxy
// clip with the cut marked, the reviewer's ends_on / opens_on / why /
// confidence and the skeptic's verdict and reason, the two episode lengths
// against the band, and the actions — Accept, Move (another option or any
// legal candidate within ±30 s, shown as ticks; the lengths recompute as
// the tick moves and a band break is refused before it is sent) and Reject
// (re-judge with a typed reason). Plan B3's "remove boundary" is not
// offered: the pipeline needs a choice for every open boundary
// (`pick_cuts.py --choices`), so the decide route refuses it; a join is
// moved after the render instead.

import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/components/locale";
import type { BoundaryDecision, BoundaryView } from "@/lib/segment/api-types";
import { checkMove, cutTile, fmtLen, fmtT, inBand, isLegalTarget, neighbours, sameTime, timeKey, type ReviewCard } from "./model";

// ---- the strip with its cut tile marked ------------------------------------------------------------------------

export function StripImage({ src, tiles, cols, t, alt }: { src: string; tiles: readonly number[]; cols: number; t: number; alt: string }) {
  const tile = cutTile(tiles, t, cols);
  const style: React.CSSProperties = {
    left: `${(tile.col / cols) * 100}%`,
    top: `${(tile.row / tile.rows) * 100}%`,
    width: `${100 / cols}%`,
    height: `${100 / tile.rows}%`,
  };
  return (
    <span className="sgm-strip">
      {/* eslint-disable-next-line @next/next/no-img-element -- evidence served by our own route */}
      <img src={src} alt={alt} loading="lazy" />
      {tiles.length > 0 && <span className="sgm-tile-mark" style={style} aria-hidden />}
    </span>
  );
}

// ---- the proxy player with the cut marked ------------------------------------------------------------------------

export function ProxyPlayer({ src, cutAt, label }: { src: string | null; cutAt: number | null; label: string }) {
  const { tt } = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [failed, setFailed] = useState(false);
  const stopAt = useRef<number | null>(null);
  const cut = cutAt ?? (dur ? dur / 2 : null);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    setFailed(false);
    const onTime = () => {
      setPos(v.currentTime);
      if (stopAt.current !== null && v.currentTime >= stopAt.current) {
        v.pause();
        stopAt.current = null;
      }
    };
    const onMeta = () => setDur(v.duration || 0);
    const onError = () => setFailed(true);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("error", onError);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("error", onError);
    };
  }, [src]);

  function playTo() {
    const v = video.current;
    if (!v || cut === null) return;
    v.currentTime = Math.max(0, cut - 3);
    stopAt.current = cut;
    void v.play();
  }
  function playFrom() {
    const v = video.current;
    if (!v || cut === null) return;
    v.currentTime = cut;
    stopAt.current = Math.min(dur || cut + 3, cut + 3);
    void v.play();
  }
  function seekCut() {
    const v = video.current;
    if (!v || cut === null) return;
    v.pause();
    v.currentTime = cut;
  }

  if (!src) return <p className="hint" role="status">{tt("seg.review.noProxy")}</p>;
  return (
    <div className="sgm-player">
      <video ref={video} src={src} controls preload="metadata" aria-label={label} playsInline />
      {failed && <p className="hint" role="status">{tt("seg.review.proxyFailed")}</p>}
      <div className="sgm-cutbar" aria-hidden>
        <span className="played" style={{ width: dur ? `${Math.min(100, (pos / dur) * 100)}%` : 0 }} />
        {cut !== null && dur > 0 && <span className="cut" style={{ left: `${(cut / dur) * 100}%` }} />}
      </div>
      <div className="sgm-player-actions">
        <button type="button" className="btn btn-outline btn-sm" onClick={playTo}>{tt("seg.review.playTo")}</button>
        <button type="button" className="btn btn-outline btn-sm" onClick={seekCut}>{tt("seg.review.atCut")}</button>
        <button type="button" className="btn btn-outline btn-sm" onClick={playFrom}>{tt("seg.review.playFrom")}</button>
        <span className="hint" style={{ margin: 0 }}>{tt("seg.review.proxyHint")}</span>
      </div>
    </div>
  );
}

// ---- the ±30 s ticks ----------------------------------------------------------------------------------------------

export function CandidateTicks({ centre, options, candidates, current, picked, onPick, illegal }: {
  centre: number;
  options: readonly { key: string; t: number }[];
  candidates: readonly { t: number; line_after?: string | null }[];
  current: number;
  picked: number | null;
  onPick: (t: number) => void;
  /** Times the band refuses, for the colour. */
  illegal: (t: number) => boolean;
}) {
  const { tt } = useT();
  const from = centre - 30;
  const span = 60;
  const marks = useMemo(() => {
    const m = new Map<string, { t: number; opt: string | null; line: string }>();
    for (const c of candidates) if (Math.abs(c.t - centre) <= 30) m.set(timeKey(c.t), { t: c.t, opt: null, line: c.line_after ?? "" });
    for (const o of options) m.set(timeKey(o.t), { t: o.t, opt: o.key, line: m.get(timeKey(o.t))?.line ?? "" });
    return [...m.values()].sort((a, b) => a.t - b.t);
  }, [candidates, options, centre]);
  return (
    <div className="sgm-ticks" role="listbox" aria-label={tt("seg.review.ticks")}>
      <span className="axis" />
      {marks.map((m) => {
        const cls = ["sgm-tick", m.opt ? "opt" : "", sameTime(m.t, current) ? "on" : "", picked !== null && sameTime(m.t, picked) ? "picked" : "", illegal(m.t) ? "illegal" : ""].filter(Boolean).join(" ");
        const title = `${fmtT(m.t)}${m.opt ? ` · ${m.opt}` : ""}${m.line ? ` · ${m.line}` : ""}`;
        return <button key={m.t} type="button" role="option" aria-selected={picked !== null && sameTime(m.t, picked)} className={cls} style={{ left: `${((m.t - from) / span) * 100}%` }} title={title} aria-label={title} onClick={() => onPick(m.t)} />;
      })}
      <span className="lab" style={{ left: 0 }}>{fmtT(from)}</span>
      <span className="lab" style={{ left: "50%" }}>{fmtT(centre)}</span>
      <span className="lab" style={{ left: "100%" }}>{fmtT(centre + 30)}</span>
    </div>
  );
}

// ---- the card ---------------------------------------------------------------------------------------------------------

export type ReviewGeometry = { fixedStart: number; duration: number; band: [number, number]; firstN: number };

type Props = {
  card: ReviewCard;
  cards: readonly ReviewCard[];
  review: ReviewGeometry;
  busy: boolean;
  onDecide: (d: BoundaryDecision) => void;
};

type OptionView = BoundaryView["options"][number];

export default function BoundaryCard({ card, cards, review, busy, onDecide }: Props) {
  const { tt } = useT();
  const [panel, setPanel] = useState<"none" | "move" | "reject">("none");
  const [target, setTarget] = useState<number | null>(null);
  const [reason, setReason] = useState("");

  const v = card.view;
  const chosenOption: OptionView | null = v.options.find((o) => sameTime(o.t, card.current_t)) ?? null;
  const shownOption: OptionView = chosenOption ?? v.options.find((o) => o.is_dp_pick) ?? v.options[0];
  const others = v.options.filter((o) => o.key !== shownOption.key);
  const nb = neighbours(cards, card, review);
  const move = target !== null ? checkMove(cards, card, target, review) : null;
  const pick = v.record?.pick ?? null;
  const verdict = v.record?.verdict ?? null;
  const acceptable = !card.rejudging && !!v.record && (pick?.confidence ?? 0) > 0;

  const reasonPills = card.reasons.map((r) => (
    <span key={r} className={`pill ${r === "band" || r === "fault" || r === "no_record" ? "pill-error" : "pill-warning"}`}>{r === "low_confidence" && card.confidence !== null ? tt("seg.review.reason.low_confidence", { c: card.confidence.toFixed(2) }) : tt(`seg.review.reason.${r}`)}</span>
  ));
  const decisionPill = card.settled && card.decision ? (
    <span className="pill pill-success">{card.decision.action === "move" && typeof card.decision.to_s === "number" ? tt("seg.review.decided.move", { t: fmtT(card.decision.to_s) }) : tt("seg.review.decided.accept")}</span>
  ) : !card.required ? <span className="pill pill-neutral">{tt("seg.review.preAccepted")}</span> : null;

  function lengthBox(label: string, ep: { n: number; dur: number } | null) {
    const out = !!ep && !inBand(ep.dur, review.band);
    return (
      <div className={`sgm-length ${out ? "out" : ""}`}>
        <span className="k">{ep ? tt("seg.review.episodeN", { n: ep.n, label }) : label}</span>
        <span className="v">{ep ? fmtLen(ep.dur) : "—"}</span>
      </div>
    );
  }

  return (
    <article className="card sgm-card" data-boundary={card.key} data-status={v.status} data-required={card.required ? "1" : "0"} data-settled={card.settled ? "1" : "0"}>
      <div className="sgm-card-head">
        <h3>{tt("seg.review.boundaryAt", { t: fmtT(card.boundary_s) })}</h3>
        {!sameTime(card.current_t, card.boundary_s) && <span className="hint" style={{ margin: 0 }}>{tt("seg.review.cutNow", { t: fmtT(card.current_t) })}</span>}
        {reasonPills}
        {decisionPill}
        {card.applied && card.applied.t !== null && card.applied.source === "skeptic" && <span className="pill pill-accent">{tt("seg.review.skepticApplied", { t: fmtT(card.applied.t) })}</span>}
      </div>

      <div className="sgm-card-grid">
        <div style={{ display: "grid", gap: 12 }}>
          {shownOption.strip_url ? (
            <div>
              <StripImage src={shownOption.strip_url} tiles={shownOption.tiles} cols={shownOption.cols} t={shownOption.t} alt={tt("seg.review.stripAlt", { key: shownOption.key, t: fmtT(shownOption.t) })} />
              <p className="sgm-strip-caption">
                <span>{chosenOption ? tt("seg.review.chosenStrip", { key: shownOption.key, t: fmtT(shownOption.t) }) : tt("seg.review.nearestStrip", { key: shownOption.key, t: fmtT(shownOption.t) })}</span>
                <span lang="en">{shownOption.line_before ? `…${shownOption.line_before.slice(-40)}` : ""} | {shownOption.line_after ? `${shownOption.line_after.slice(0, 40)}…` : ""}</span>
              </p>
            </div>
          ) : (
            <p className="err">{tt("seg.review.noStrip")}</p>
          )}
          {others.length > 0 && (
            <div>
              <span className="label" style={{ margin: "0 0 6px" }}>{tt("seg.review.otherOptions")}</span>
              <div className="sgm-strips-row">
                {others.map((o) => (
                  <button key={o.key} type="button" className={`sgm-strip-option ${target !== null && sameTime(o.t, target) ? "on" : ""}`} onClick={() => { setPanel("move"); setTarget(o.t); }} title={tt("seg.review.moveToOption", { key: o.key, t: fmtT(o.t) })}>
                    {o.strip_url ? <StripImage src={o.strip_url} tiles={o.tiles} cols={o.cols} t={o.t} alt={tt("seg.review.stripAlt", { key: o.key, t: fmtT(o.t) })} /> : null}
                    <span className="sgm-strip-caption"><span>{o.key} · {fmtT(o.t)}{o.is_dp_pick ? ` · ${tt("seg.review.dpPick")}` : ""}</span></span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {(v.dialogue.before.length > 0 || v.dialogue.after.length > 0) && (
            <details className="sgm-collapsed">
              <summary>{tt("seg.review.dialogue")}</summary>
              <ul className="sgm-log" lang="en">
                {v.dialogue.before.map((l, i) => <li key={`b${i}`}><time>{fmtT(l.t)}</time> {l.text}</li>)}
                {v.dialogue.after.map((l, i) => <li key={`a${i}`}><time>{fmtT(l.t)}</time> {l.text}</li>)}
              </ul>
            </details>
          )}
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <ProxyPlayer src={v.proxy_url} cutAt={null} label={tt("seg.review.proxyLabel", { t: fmtT(card.current_t) })} />
          <div className="sgm-lengths">
            {lengthBox(tt("seg.review.before"), nb.before)}
            {lengthBox(tt("seg.review.after"), nb.after)}
          </div>
          <p className="hint" style={{ margin: 0 }}>{tt("seg.review.band", { lo: review.band[0], hi: review.band[1] })}</p>
          <dl className="sgm-verdict">
            {pick ? (
              <>
                <div><dt>{tt("seg.review.endsOn")}</dt><dd lang="en">{pick.ends_on}</dd></div>
                <div><dt>{tt("seg.review.opensOn")}</dt><dd lang="en">{pick.opens_on}</dd></div>
                <div><dt>{tt("seg.review.why")}</dt><dd lang="en">{pick.why}</dd></div>
                <div><dt>{tt("seg.review.confidence")}</dt><dd>{pick.confidence.toFixed(2)}{pick.payoff_in_episode ? ` · ${tt("seg.review.payoffIn")}` : ` · ${tt("seg.review.payoffOut")}`}</dd></div>
              </>
            ) : (
              <div><dt>{tt("seg.review.reviewer")}</dt><dd>{tt("seg.review.noRecord")}</dd></div>
            )}
            {verdict ? (
              <div>
                <dt>{tt("seg.review.skeptic")}</dt>
                <dd lang="en">
                  <strong>{verdict.agree ? tt("seg.review.agrees") : tt("seg.review.disagrees")}</strong>
                  {verdict.fault ? ` · ${verdict.fault}` : ""}
                  {typeof verdict.better_t === "number" ? ` · ${tt("seg.review.betterT", { t: fmtT(verdict.better_t) })}` : ""}
                  {verdict.reason ? ` — ${verdict.reason}` : ""}
                </dd>
              </div>
            ) : null}
            {card.guard && card.guard.rule ? (
              <div>
                <dt>{tt("seg.review.guard")}</dt>
                <dd lang="en"><strong>{tt(`seg.review.guardRule.${card.guard.rule}`)}</strong>{card.guard.detail ? ` — ${card.guard.detail}` : ""}</dd>
              </div>
            ) : null}
            {card.applied && card.applied.t === null ? <div><dt>{tt("seg.review.fault")}</dt><dd className="err">{card.applied.fault}</dd></div> : null}
            {card.rejudging ? <div><dt>{tt("seg.review.reason.rejudging")}</dt><dd>{tt("seg.review.rejudgingHint", { asked: v.rejudges_asked, done: v.rejudges_done })}</dd></div> : null}
          </dl>
        </div>
      </div>

      {panel === "move" && (
        <div className="sgm-move" data-testid="move-panel">
          <span className="label" style={{ margin: 0 }}>{tt("seg.review.moveTitle")}</span>
          <CandidateTicks centre={card.boundary_s} options={v.options} candidates={v.legal_cuts} current={card.current_t} picked={target} onPick={setTarget} illegal={(t) => !checkMove(cards, card, t, review).ok} />
          {target !== null && move && (
            <div style={{ display: "grid", gap: 6 }}>
              <span>{tt("seg.review.moveTo", { t: fmtT(target) })}{!isLegalTarget(card, target) ? ` · ${tt("seg.review.notLegal")}` : ""}</span>
              <div className="sgm-lengths">
                <div className={`sgm-length ${move.before !== null && !inBand(move.before, review.band) ? "out" : ""}`}><span className="k">{tt("seg.review.before")}</span><span className="v">{move.before !== null ? fmtLen(move.before) : "—"}</span></div>
                <div className={`sgm-length ${move.after !== null && !inBand(move.after, review.band) ? "out" : ""}`}><span className="k">{tt("seg.review.after")}</span><span className="v">{move.after !== null ? fmtLen(move.after) : "—"}</span></div>
              </div>
              {move.refusals.map((r) => <span key={r} className="err">{tt("seg.review.bandRefused", { detail: r })}</span>)}
            </div>
          )}
          <label>
            <span className="hint" style={{ margin: "0 0 4px" }}>{tt("seg.review.moveWhy")}</span>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="sgm-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || target === null || !move?.ok} onClick={() => target !== null && onDecide({ kind: "boundary", boundary_s: card.boundary_s, action: "move", to_t: target, reason: reason.trim() || null })}>{tt("seg.review.confirmMove")}</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setPanel("none"); setTarget(null); }}>{tt("seg.cancel")}</button>
          </div>
        </div>
      )}

      {panel === "reject" && (
        <div className="sgm-move" data-testid="reject-panel">
          <label>
            <span className="label" style={{ margin: "0 0 6px" }}>{tt("seg.review.rejectTitle")}</span>
            <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tt("seg.review.rejectPlaceholder")} />
          </label>
          <div className="sgm-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || reason.trim().length === 0} onClick={() => onDecide({ kind: "boundary", boundary_s: card.boundary_s, action: "reject", reason: reason.trim() })}>{tt("seg.review.confirmReject")}</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPanel("none")}>{tt("seg.cancel")}</button>
          </div>
        </div>
      )}

      <div className="sgm-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !acceptable} onClick={() => onDecide({ kind: "boundary", boundary_s: card.boundary_s, action: "accept" })}>{tt("seg.review.accept")}</button>
        <button type="button" className="btn btn-outline btn-sm" disabled={busy || card.rejudging} onClick={() => setPanel(panel === "move" ? "none" : "move")}>{tt("seg.review.move")}</button>
        <button type="button" className="btn btn-outline btn-sm" disabled={busy || card.rejudging} onClick={() => setPanel(panel === "reject" ? "none" : "reject")}>{tt("seg.review.reject")}</button>
        {!acceptable && !card.rejudging && <span className="hint" style={{ margin: 0 }}>{tt("seg.review.acceptRefused")}</span>}
      </div>
    </article>
  );
}
