"use client";

// What happens after pressing Publish (overnight spec item 13, 2026-09-24):
// a progress view in the Publish step, four steps in the order they happen,
// each with its state and, when one fails, why in words:
//
//   1. Publish the episodes     "Publishing episodes… 4 of 12", then "12 of 12 published"
//   2. The series goes live     only when the series was a draft and the person ticked it
//   3. Check the public page    the PUBLIC read (POST …/public-check) every five seconds, for up to
//                               90 s: crazydramas' public pages trail a publish by up to a minute
//   4. Live                     the public page's link
//
// The episodes go in small batches (one each up to ten, then about a tenth of
// them per call), each a POST to Studio's own publish route with exactly its
// episodes — the same route and the same checks as before (verified,
// still on the episode, paid confirmed) — so the count moves as they go. The
// series goes live in its own call after them, and only when every episode
// went out. A draft series has no public page: steps 3 and 4 say so.

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/components/locale";
import type { CdSeriesState, PublishReply } from "@/lib/crazydramas/publish-types";
import { cdRoute, episodeList, refusalWords, sendJson } from "./request";

export type PublishPlan = {
  episodes: number[];
  /** Put the draft series live after the episodes. */
  publish_series: boolean;
  /** The paid episodes of the plan, confirmed in the dialog (or the paywall is live). */
  confirm_paid: boolean;
  series_was: CdSeriesState;
};

type StepState = "waiting" | "running" | "done" | "failed" | "skipped";

type PublicAnswer = { failed: boolean; url?: string; live?: boolean; episodes?: number[]; error?: string; retry_after_ms?: number };

/** How many episodes go in each call: one at a time up to ten, then about a tenth of them. */
export function batchSize(total: number): number {
  return total <= 10 ? 1 : Math.ceil(total / 10);
}

export function batches(numbers: readonly number[]): number[][] {
  const sorted = [...numbers].sort((a, b) => a - b);
  const size = batchSize(sorted.length);
  const out: number[][] = [];
  for (let i = 0; i < sorted.length; i += size) out.push(sorted.slice(i, i + size));
  return out;
}

/** The public page shows the run's work: the series answers and lists every episode this run published. */
export function publicShows(answer: Pick<PublicAnswer, "live" | "episodes">, published: readonly number[]): boolean {
  if (!answer.live) return false;
  const seen = new Set(answer.episodes ?? []);
  return published.every((n) => seen.has(n));
}

const POLL_MS = 5_000;
const PUBLIC_DEADLINE_MS = 90_000;

const ICON: Record<StepState, string> = { waiting: "○", running: "", done: "✓", failed: "✕", skipped: "–" };

export default function PublishProgress({ titleId, plan, onChanged, onClose, onSettled }: { titleId: string; plan: PublishPlan; onChanged: () => void; onClose: () => void; onSettled?: () => void }) {
  const { tt } = useT();
  const total = plan.episodes.length;
  const [published, setPublished] = useState<number[]>([]);
  const [notPublished, setNotPublished] = useState<number[]>([]);
  const [epState, setEpState] = useState<StepState>(total ? "waiting" : "skipped");
  const [epError, setEpError] = useState<string | null>(null);
  const [seriesState, setSeriesState] = useState<StepState>("waiting");
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [seriesLive, setSeriesLive] = useState(plan.series_was === "published");
  const [pubState, setPubState] = useState<StepState>("waiting");
  const [pubError, setPubError] = useState<string | null>(null);
  const [pubSeconds, setPubSeconds] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const started = useRef(false);
  const alive = useRef(true);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Step 3: poll the public page until it shows the run's episodes, or the deadline passes. */
  const checkPublic = useCallback(async (mustShow: readonly number[]) => {
    setPubState("running");
    setPubError(null);
    const began = Date.now();
    let lastError: string | null = null;
    while (alive.current) {
      const r = await sendJson<PublicAnswer>("POST", cdRoute(titleId, "public-check"), {});
      const elapsed = Date.now() - began;
      if (!alive.current) return;
      setPubSeconds(Math.round(elapsed / 1000));
      if (r.ok) {
        if (r.body.url) setUrl(r.body.url);
        if (!r.body.failed && publicShows(r.body, mustShow)) {
          setPubState("done");
          return;
        }
        lastError = r.body.failed ? r.body.error ?? null : null;
      } else if (r.status !== 429) {
        lastError = refusalWords(r.body, r.status);
      }
      if (elapsed >= PUBLIC_DEADLINE_MS) {
        setPubError(lastError);
        setPubState("failed");
        return;
      }
      const retry = !r.ok && r.status === 429 ? Number((r.body as { retry_after_ms?: number }).retry_after_ms ?? POLL_MS) : POLL_MS;
      await wait(Math.max(1_000, Math.min(POLL_MS, retry)));
    }
  }, [titleId]);

  const run = useCallback(async () => {
    const done: number[] = [];
    const missed: number[] = [];
    // 1. The episodes, a batch at a time.
    if (total) {
      setEpState("running");
      for (const batch of batches(plan.episodes)) {
        const r = await sendJson<PublishReply>("POST", cdRoute(titleId, "publish"), { episodes: batch, publish_series: false, ...(plan.confirm_paid ? { confirm_paid: true } : {}) });
        if (r.ok) {
          done.push(...(r.body.published ?? []), ...(r.body.already_published ?? []));
        } else {
          const b = r.body as { code?: string; published?: number[]; already_published?: number[]; not_published?: number[] };
          if (r.status === 409 && b.code === "episodes_changed") {
            // crazydramas published the others of the batch; these stopped being ready.
            done.push(...(b.published ?? []), ...(b.already_published ?? []));
            missed.push(...(b.not_published ?? []));
          } else {
            missed.push(...batch);
            if (alive.current) setEpError(refusalWords(r.body, r.status));
            // Nothing after a refusal: the rest are not sent (the reason is the same for them, or unknown).
            const rest = plan.episodes.filter((n) => !done.includes(n) && !missed.includes(n));
            missed.push(...rest);
            break;
          }
        }
        if (alive.current) setPublished([...new Set(done)].sort((a, b) => a - b));
      }
      const uniqueMissed = [...new Set(missed)].sort((a, b) => a - b);
      if (alive.current) {
        setPublished([...new Set(done)].sort((a, b) => a - b));
        setNotPublished(uniqueMissed);
        setEpState(uniqueMissed.length ? "failed" : "done");
      }
      onChangedRef.current();
    }

    // 2. The series, after every episode went out.
    let live = plan.series_was === "published";
    if (plan.publish_series && plan.series_was !== "published") {
      if (missed.length) {
        if (alive.current) setSeriesState("failed");
      } else {
        if (alive.current) setSeriesState("running");
        const r = await sendJson<PublishReply>("POST", cdRoute(titleId, "publish"), { episodes: [], publish_series: true });
        if (r.ok && (r.body.series_status ?? "published") === "published") {
          live = true;
          if (alive.current) {
            setSeriesLive(true);
            setSeriesState("done");
          }
        } else if (alive.current) {
          setSeriesError(r.ok ? tt("cdp.progress.series.status", { status: r.body.series_status ?? "?" }) : refusalWords(r.body, r.status));
          setSeriesState("failed");
        }
        onChangedRef.current();
      }
    } else if (alive.current) {
      setSeriesState("skipped");
    }

    // 3. The public page, only for a live series.
    if (live && alive.current) await checkPublic([...new Set(done)]);
    else if (alive.current) setPubState("skipped");
    if (alive.current) setFinished(true);
    onChangedRef.current();
    onSettledRef.current?.();
  }, [checkPublic, plan, titleId, total, tt]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, [run]);

  const again = async () => {
    setFinished(false);
    await checkPublic(published);
    if (alive.current) setFinished(true);
  };

  const n = published.length;
  const running = epState === "running" || seriesState === "running" || pubState === "running";
  const seriesIsLive = seriesLive || plan.series_was === "published";
  const liveDone = pubState === "done";

  const epLine = (() => {
    if (epState === "skipped") return tt("cdp.progress.ep.none");
    if (epState === "running") return tt("cdp.progress.ep.running", { n, total });
    if (epState === "done") return tt("cdp.progress.ep.done", { n, total });
    if (epState === "failed") return tt("cdp.progress.ep.failed", { n, total, list: episodeList(notPublished) });
    return tt("cdp.progress.ep.waiting", { total });
  })();
  const seriesLine = (() => {
    if (seriesState === "skipped") return plan.series_was === "published" ? tt("cdp.progress.series.already") : tt("cdp.progress.series.stays");
    if (seriesState === "running") return tt("cdp.progress.series.running");
    if (seriesState === "done") return tt("cdp.publish.seriesLive");
    if (seriesState === "failed") return notPublished.length && !seriesError ? tt("cdp.progress.series.blocked", { list: episodeList(notPublished) }) : tt("cdp.progress.series.failed", { reason: seriesError ?? "" });
    return tt("cdp.progress.series.waiting");
  })();
  const pubLine = (() => {
    if (pubState === "skipped") return seriesIsLive ? tt("cdp.progress.public.notRun") : tt("cdp.progress.public.draft");
    if (pubState === "running") return tt("cdp.progress.public.running", { s: pubSeconds });
    if (pubState === "done") return n ? tt("cdp.progress.public.done", { list: episodeList(published) }) : tt("cdp.progress.public.doneSeries");
    if (pubState === "failed") return tt("cdp.progress.public.late", { s: pubSeconds }) + (pubError ? ` ${tt("cdp.progress.public.error", { reason: pubError })}` : "");
    return tt("cdp.progress.public.waiting");
  })();
  // The one-line result, in the words the section always used.
  const summary = [
    n ? tt("cdp.publish.done", { list: episodeList(published) }) : total ? tt("cdp.publish.doneNone") : null,
    notPublished.length ? tt("cdp.publish.notDone", { list: episodeList(notPublished) }) : null,
    seriesState === "done" ? tt("cdp.publish.seriesLive") : null,
  ].filter(Boolean).join(" ");

  const steps: { key: string; label: string; state: StepState; line: string }[] = [
    { key: "episodes", label: tt("cdp.progress.step.episodes"), state: epState, line: epLine },
    { key: "series", label: tt("cdp.progress.step.series"), state: seriesState, line: seriesLine },
    { key: "public", label: tt("cdp.progress.step.public"), state: pubState, line: pubLine },
    { key: "live", label: tt("cdp.progress.step.live"), state: liveDone ? "done" : finished ? (seriesIsLive ? "failed" : "skipped") : "waiting", line: liveDone ? tt("cdp.progress.live.done") : finished && !seriesIsLive ? tt("cdp.progress.live.draft") : finished ? tt("cdp.progress.live.notYet") : tt("cdp.progress.live.waiting") },
  ];

  return (
    <section className="cdp-progress" aria-labelledby="cdp-progress-title" data-finished={finished ? "true" : "false"} data-live={liveDone ? "true" : "false"}>
      <header className="cdp-progress-head">
        <h4 id="cdp-progress-title">{running ? <><span className="spinner" /> {tt("cdp.progress.title")}</> : tt("cdp.progress.titleDone")}</h4>
        {finished && <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{tt("cdp.progress.close")}</button>}
      </header>
      {total > 0 && (
        <div className="cdp-bar" aria-hidden="true"><span className="track"><span style={{ width: `${Math.round((100 * n) / total)}%` }} /></span><small>{tt("cdp.progress.count", { n, total })}</small></div>
      )}
      <ol className="cdp-progress-steps">
        {steps.map((s, i) => (
          <li key={s.key} className={`cdp-progress-step is-${s.state}`} data-step={s.key} data-state={s.state}>
            <span className="cdp-progress-dot" aria-hidden="true">{s.state === "running" ? <span className="spinner" /> : ICON[s.state] || i + 1}</span>
            <span className="cdp-progress-text">
              <strong>{s.label}</strong>
              <span role={s.state === "failed" ? "alert" : undefined}>{s.line}</span>
              {s.key === "episodes" && epError && <small className="err">{tt("cdp.progress.ep.why", { reason: epError })}</small>}
              {s.key === "public" && pubState === "failed" && <button type="button" className="btn btn-outline btn-sm" onClick={() => void again()}>{tt("cdp.progress.public.again")}</button>}
              {s.key === "live" && liveDone && url && <a className="btn btn-primary btn-sm" href={url} target="_blank" rel="noreferrer">{tt("cdp.progress.live.open")}&nbsp;↗</a>}
              {s.key === "live" && liveDone && url && <small className="gt-muted"><code>{url}</code></small>}
            </span>
          </li>
        ))}
      </ol>
      {summary && <p className={notPublished.length ? "note note-warn" : "hint cdp-ok"} role="status">{summary}</p>}
    </section>
  );
}
