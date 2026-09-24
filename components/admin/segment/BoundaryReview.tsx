"use client";

// The boundary review screen (plan B3, decision 2026-09-23 #5): every
// boundary of the served review state as a card — lowest confidence and
// skeptic overrides first, then the band-conflict groups, then the rest
// collapsed as "accepted by reviewer and skeptic". Each decision is posted
// as it is made, from its own card, and lands in the run's decisions (there
// is no bulk accept: the review is mandatory, not a stamp); Apply is enabled
// once the route says the review is complete (every card that needs a
// person is settled, no re-judge outstanding) and no episode is outside the
// band, and hands the worker the override file to run apply_vision.py with.
// After the render the same screen becomes the join review.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, getJson, postJson } from "@/lib/api-client";
import { useT } from "@/components/locale";
import type { DecisionBody, RunDetailReply, RunReply } from "@/lib/segment/api-types";
import BoundaryCard, { type ReviewGeometry } from "./BoundaryCard";
import Elsewhere from "./Elsewhere";
import JoinReview from "./JoinReview";
import { applyReady, buildCards, fixedStartOf, fmtT, isRendered, isTerminal, orderCards, stageIndex, type ReviewCard } from "./model";
import { stagePill } from "./RunList";

const POLL_MS = 4000;

type Reply = Partial<RunReply> & { error?: string };

export default function BoundaryReview({ runId }: { runId: string }) {
  const { tt } = useT();
  const [data, setData] = useState<RunDetailReply | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restOpen, setRestOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getJson<RunDetailReply>(`/api/admin/films/runs/${encodeURIComponent(runId)}`);
      setData(next);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof ApiRequestError ? e.message : (e as Error).message);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while the run moves on its own (a re-judge, a render, a re-pin); a review waiting on a person needs no poll.
  const polling = !!data && !!data.stage_view && !isTerminal(data.run.stage) && !(data.run.stage === "review" && (data.stage_view.review?.rejudging ?? 0) === 0);
  useEffect(() => {
    if (!polling) return;
    timer.current = setTimeout(() => void load(), POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [polling, data, load]);

  const decide = useCallback(async (body: DecisionBody) => {
    setBusy(true);
    setActionError(null);
    try {
      const r = await postJson<Reply>(`/api/admin/films/runs/${encodeURIComponent(runId)}/decide`, body);
      if (r.error) setActionError(r.error);
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [runId, load]);

  const review = data?.stage_view?.review ?? null;
  const geometry: ReviewGeometry | null = useMemo(() => {
    if (!review) return null;
    const fixedStart = fixedStartOf(review);
    const plan = data?.stage_view?.plan;
    const delivered = plan ? plan.episodes.filter((e) => e.end <= fixedStart + 0.0015).length : 0;
    return { fixedStart, duration: review.duration, band: review.band, firstN: delivered + 1 };
  }, [review, data]);
  const cards = useMemo(() => (review ? buildCards(review) : []), [review]);
  const order = useMemo(() => (geometry ? orderCards(cards, geometry) : null), [cards, geometry]);
  const ready = useMemo(() => (geometry ? applyReady(cards, geometry) : null), [cards, geometry]);

  // There is no bulk accept: every card that needs a person (below the confidence gate, a skeptic override, a fault) is
  // decided on its own card, with its strips and clip in view (decision 5: the review is mandatory, not a stamp — and
  // accepting an override silently applies the skeptic's time, which the card says and a bar button would not).

  if (loadError) {
    return (
      <div className="sgm-actions">
        <p className="err" role="alert" style={{ margin: 0 }}>{tt("seg.run.loadFailed", { detail: loadError })}</p>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => void load()}>{tt("seg.refresh")}</button>
      </div>
    );
  }
  if (!data) return <p className="hint" role="status">{tt("seg.loading")}</p>;
  if (data.elsewhere) return <Elsewhere run={data.run} computer={data.elsewhere.name} />;

  const { run, stage_view: view } = data;
  const runHref = `/films/runs/${run.id}`;
  const rendered = isRendered(run.stage, run.mode);

  const head = (
    <div className="page-head">
      <div>
        <h1 lang="en">{rendered ? tt("seg.joins.pageTitle", { slug: run.slug }) : tt("seg.review.pageTitle", { slug: run.slug })}</h1>
        <p className="page-sub">{rendered ? tt("seg.joins.sub") : tt("seg.review.sub")}</p>
      </div>
      <div className="title-actions sgm-actions">
        <span className={`pill ${stagePill(run.stage)}`} data-stage={run.stage}>{tt(`seg.stage.${run.stage}`)}</span>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => void load()}>{tt("seg.refresh")}</button>
        <a className="btn btn-ghost btn-sm" href={runHref}>{tt("seg.review.backToRun")}</a>
      </div>
    </div>
  );

  if (rendered) {
    const episodes = view.plan?.episodes ?? [];
    const band = view.review?.band ?? geometry?.band ?? [95, 150];
    return (
      <div style={{ display: "grid", gap: 16 }}>
        {head}
        {run.error_text && <pre className="sgm-refusal" role="alert">{run.error_text}</pre>}
        {actionError && <p className="err" role="alert">{tt("seg.run.actionFailed", { detail: actionError })}</p>}
        <JoinReview joins={view.joins} episodes={episodes} boundaries={view.review?.boundaries ?? []} band={band} busy={busy} canMove={run.stage === "film_meta" || run.stage === "handoff"} done={run.stage === "done"} onMove={(d) => void decide(d)} />
      </div>
    );
  }

  if (!review || !geometry || !order || !ready) {
    const before = stageIndex(run.stage, run.mode) < stageIndex("review", run.mode);
    const problem = (view.watermark as { review_error?: string } | null)?.review_error ?? null;
    return (
      <div style={{ display: "grid", gap: 16 }}>
        {head}
        {run.error_text && <pre className="sgm-refusal" role="alert">{run.error_text}</pre>}
        {problem && <pre className="sgm-refusal" role="alert">{problem}</pre>}
        <p className="hint" role="status">{before ? <><span className="spinner" /> {tt("seg.review.notYet")}</> : tt("seg.review.noOptions")}</p>
      </div>
    );
  }

  const canDecide = run.stage === "review" && !busy;
  const groupOf = (list: ReviewCard[]) => list.map((c) => (
    <BoundaryCard key={c.key} card={c} cards={cards} review={geometry} busy={!canDecide} onDecide={(d) => void decide(d)} />
  ));
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {head}
      {run.error_text && <pre className="sgm-refusal" role="alert">{run.error_text}</pre>}
      {actionError && <p className="err" role="alert">{tt("seg.run.actionFailed", { detail: actionError })}</p>}
      {review.problems.length > 0 && <p className="note note-warn" role="alert">{review.problems.join(" · ")}</p>}
      {run.stage !== "review" && <p className="note note-info" role="status">{tt("seg.review.readOnly", { stage: tt(`seg.stage.${run.stage}`) })}</p>}
      <div className="sgm-review-head">
        <span className="pill pill-warning">{tt("seg.review.counts.attention", { n: order.attention.length })}</span>
        <span className={`pill ${order.conflicts.length ? "pill-error" : "pill-neutral"}`}>{tt("seg.review.counts.conflicts", { n: order.conflicts.length })}</span>
        <span className="pill pill-neutral">{tt("seg.review.counts.rest", { n: order.rest.length })}</span>
        {review.rejudging > 0 && <span className="pill pill-accent">{tt("seg.review.counts.rejudging", { n: review.rejudging })}</span>}
        <span className="hint" style={{ margin: 0 }}>{tt("seg.review.counts.total", { n: cards.length, span: fmtT(review.duration), lo: review.band[0], hi: review.band[1] })}</span>
      </div>

      {order.attention.length > 0 && (
        <section aria-label={tt("seg.review.group.attention")}>
          <h2 className="sgm-group-title">{tt("seg.review.group.attention")}</h2>
          <div className="sgm-cards">{groupOf(order.attention)}</div>
        </section>
      )}
      {order.conflicts.map((g, i) => (
        <section key={i} aria-label={tt("seg.review.group.conflict", { n: i + 1 })}>
          <h2 className="sgm-group-title">{tt("seg.review.group.conflict", { n: i + 1 })}</h2>
          <p className="hint">{tt("seg.review.group.conflictHint", { lo: review.band[0], hi: review.band[1] })}</p>
          <div className="sgm-cards">{groupOf(g)}</div>
        </section>
      ))}
      {order.rest.length > 0 && (
        <details className="sgm-collapsed" open={restOpen} onToggle={(e) => setRestOpen((e.target as HTMLDetailsElement).open)}>
          <summary>{tt("seg.review.group.rest", { n: order.rest.length })}</summary>
          {restOpen && <div className="sgm-cards">{groupOf(order.rest)}</div>}
        </details>
      )}
      {cards.length === 0 && <p className="hint">{tt("seg.review.noOptions")}</p>}

      <div className="sticky-bar">
        <span className="sticky-bar-note" role="status">
          {review.complete && ready.ok ? tt("seg.review.ready") : tt("seg.review.notReady", { undecided: review.missing.length, conflicts: ready.conflicts })}
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" disabled={!canDecide || !review.complete || !ready.ok} data-testid="apply-review" onClick={() => void decide({ kind: "apply_review" })}>{tt("seg.review.apply")}</button>
      </div>
    </div>
  );
}
