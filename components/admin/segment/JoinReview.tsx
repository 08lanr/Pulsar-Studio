"use client";

// Join review (plan B3, after the render): the built episodes' joins, one
// per pair — the last 2 s of k and the first 2 s of k+1 back to back, cut by
// the evidence route from Studio's own hardlinks of the built `eps/epNN.mp4`
// files (`work/joins/`), so the clip shows the join as cut_episodes.py
// encoded it, delogo included, never the source — with "Move this join",
// which picks a nearby legal candidate and asks the worker for
// `cut_episodes.py --repin OLD=NEW` (only the two episodes it touches
// re-render; the join's clip is remade once the files are newer). The run's
// DELIVERED is then refreshed and a re-import updates the title's hashes.

import { useState } from "react";
import { useT } from "@/components/locale";
import type { BoundaryView, JoinDecision, StageView } from "@/lib/segment/api-types";
import { CandidateTicks, ProxyPlayer } from "./BoundaryCard";
import { fmtLen, fmtT, inBand, sameTime, timeKey } from "./model";

type Props = {
  joins: StageView["joins"];
  episodes: NonNullable<StageView["plan"]>["episodes"];
  /** The reviewed boundaries, whose legal cuts within ±30 s are the ticks a join may move to. */
  boundaries: BoundaryView[];
  band: [number, number];
  busy: boolean;
  /** The render is done and the worker can take a re-pin. */
  canMove: boolean;
  /** The run is done (the film imported): its joins no longer move, and the page says so instead of "once the render has finished". */
  done?: boolean;
  onMove: (d: JoinDecision) => void;
};

type Cut = { t: number; line_after?: string | null };

/** The legal cuts within ±30 s of the join, gathered from the reviewed boundaries' lists (one boundary's list covers its own ±30 s). */
function cutsNear(boundaries: BoundaryView[], at: number): Cut[] {
  const seen = new Map<string, Cut>();
  for (const b of boundaries) for (const c of b.legal_cuts) if (Math.abs(c.t - at) <= 30) seen.set(timeKey(c.t), { t: c.t, line_after: c.line_after });
  return [...seen.values()].sort((a, b) => a.t - b.t);
}

export default function JoinReview({ joins, episodes, boundaries, band, busy, canMove, done = false, onMove }: Props) {
  const { tt } = useT();
  const [open, setOpen] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);

  function lengthsIf(k: number, t: number): { before: { n: number; dur: number } | null; after: { n: number; dur: number } | null } {
    const before = episodes.find((e) => e.n === k) ?? null;
    const after = episodes.find((e) => e.n === k + 1) ?? null;
    return {
      before: before ? { n: before.n, dur: Math.round((t - before.start) * 1000) / 1000 } : null,
      after: after ? { n: after.n, dur: Math.round((after.end - t) * 1000) / 1000 } : null,
    };
  }

  if (joins.length === 0) return <p className="hint" role="status">{tt("seg.joins.none")}</p>;

  return (
    <div className="sgm-joins">
      <p className="hint">{tt("seg.joins.hint")}</p>
      {joins.map((j) => {
        const k = j.index;
        const isOpen = open === k;
        const cur = lengthsIf(k, j.end);
        const trial = target !== null && isOpen ? lengthsIf(k, target) : null;
        const cuts = cutsNear(boundaries, j.end);
        const refusals: string[] = [];
        if (trial?.before && !inBand(trial.before.dur, band)) refusals.push(`episode ${trial.before.n}: ${fmtLen(trial.before.dur)}`);
        if (trial?.after && !inBand(trial.after.dur, band)) refusals.push(`episode ${trial.after.n}: ${fmtLen(trial.after.dur)}`);
        const legal = target !== null && cuts.some((c) => sameTime(c.t, target));
        return (
          <article className="card sgm-card" key={k} data-join={k}>
            <div className="sgm-card-head">
              <h3>{tt("seg.joins.title", { k, next: k + 1, t: fmtT(j.end) })}</h3>
              {cur.before ? <span className={`pill ${inBand(cur.before.dur, band) ? "pill-neutral" : "pill-error"}`}>{tt("seg.review.episodeShort", { n: cur.before.n })} {fmtLen(cur.before.dur)}</span> : null}
              {cur.after ? <span className={`pill ${inBand(cur.after.dur, band) ? "pill-neutral" : "pill-error"}`}>{tt("seg.review.episodeShort", { n: cur.after.n })} {fmtLen(cur.after.dur)}</span> : null}
            </div>
            <ProxyPlayer src={j.proxy_url} cutAt={null} label={tt("seg.joins.playerLabel", { k })} />
            {isOpen ? (
              <div className="sgm-move" data-testid="join-move-panel">
                <span className="label" style={{ margin: 0 }}>{tt("seg.joins.moveTitle")}</span>
                {cuts.length === 0 && <p className="hint" style={{ margin: 0 }}>{tt("seg.joins.noCuts")}</p>}
                <CandidateTicks centre={j.end} options={[]} candidates={cuts} current={j.end} picked={target} onPick={setTarget} illegal={(t) => { const l = lengthsIf(k, t); return (!!l.before && !inBand(l.before.dur, band)) || (!!l.after && !inBand(l.after.dur, band)); }} />
                {trial && target !== null && (
                  <div className="sgm-lengths">
                    <div className={`sgm-length ${trial.before && !inBand(trial.before.dur, band) ? "out" : ""}`}><span className="k">{tt("seg.review.before")}</span><span className="v">{trial.before ? fmtLen(trial.before.dur) : "—"}</span></div>
                    <div className={`sgm-length ${trial.after && !inBand(trial.after.dur, band) ? "out" : ""}`}><span className="k">{tt("seg.review.after")}</span><span className="v">{trial.after ? fmtLen(trial.after.dur) : "—"}</span></div>
                  </div>
                )}
                {refusals.map((r) => <span key={r} className="err">{tt("seg.review.bandRefused", { detail: r })}</span>)}
                <div className="sgm-actions">
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy || target === null || refusals.length > 0 || !legal || sameTime(target, j.end)} onClick={() => target !== null && onMove({ kind: "join", join_index: k, to_t: target })}>{tt("seg.joins.confirmMove")}</button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setOpen(null); setTarget(null); }}>{tt("seg.cancel")}</button>
                </div>
              </div>
            ) : (
              <div className="sgm-actions">
                <button type="button" className="btn btn-outline btn-sm" disabled={busy || !canMove} onClick={() => { setOpen(k); setTarget(null); }}>{tt("seg.joins.move")}</button>
                {!canMove && <span className="hint" style={{ margin: 0 }}>{tt(done ? "seg.joins.imported" : "seg.joins.notYet")}</span>}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
