"use client";

// Step 3 of "Upload to crazydramas" (publish spec §1d, §2, §3, §10): the
// dialogs that change what viewers see. Publish lists exactly the episodes
// that go live — ticked one by one from the verified ones, split into free
// and paid — and whether the draft series goes live with them; publishing
// any paid episode shows the paywall warning and needs its own confirm
// until CRAZYDRAMAS_PAYWALL_LIVE=1 (paid episodes can be streamed free
// until the paywall fix is live on crazydramas); pressing Publish closes it
// and the section shows the progress (PublishProgress). Unpublish hides the ticked
// episodes and may set the series back to draft. Replace sends a re-cut
// over an episode crazydramas already holds, after the viewer-impact
// warning of plan A6. Each dialog is the side panel the launch dialogs use.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/components/locale";
import type { CdSeriesState, PublishEpisode, UnpublishBody, UnpublishReply } from "@/lib/crazydramas/publish-types";
import type { PublishPlan } from "./PublishProgress";
import { cdRoute, episodeList, refusalWords, sendJson } from "./request";
import { rowStage } from "./UploadProgress";

function Shell({ id, title, lede, onClose, children, footer }: { id: string; title: string; lede: ReactNode; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const { tt } = useT();
  const panel = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Focus once when the panel appears (the parent re-renders while it polls; focus must not jump back on each), Escape closes.
  useEffect(() => {
    if (!mounted) return;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mounted]);
  if (!mounted) return null;
  return createPortal(
    <div className="launch-dialog-backdrop cdp-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close.current(); }}>
      <div className="launch-dialog cdp-dialog" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-lede`}>
        <header>
          <h2 id={`${id}-title`}>{title}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label={tt("cdp.dialog.close")}>×</button>
        </header>
        <p id={`${id}-lede`} className="cdp-lede">{lede}</p>
        <div className="cdp-dialog-body">{children}</div>
        <div className="cdp-dialog-footer">{footer}</div>
      </div>
    </div>,
    document.body
  );
}

/** An episode crazydramas holds ready and verified that viewers cannot see yet. */
export function publishable(e: PublishEpisode): boolean {
  return !e.is_published && rowStage(e) === "verified";
}

type PublishProps = {
  seriesState: CdSeriesState;
  episodes: readonly PublishEpisode[];
  paywallLive: boolean;
  onClose: () => void;
  /**
   * The person pressed Publish: the dialog closes and the section runs the
   * plan with its progress view (PublishProgress: the episodes a batch at a
   * time, then the series, then the public page).
   */
  onStart: (plan: PublishPlan) => void;
};

export default function PublishDialog({ seriesState, episodes, paywallLive, onClose, onStart }: PublishProps) {
  const { tt } = useT();
  const candidates = useMemo(() => [...episodes].filter(publishable).sort((a, b) => a.n - b.n), [episodes]);
  const alreadyLive = episodes.filter((e) => e.is_published).length;
  // Free ones start ticked, paid ones never do: a paid episode goes live only when someone ticks it.
  const [picked, setPicked] = useState<Set<number>>(() => new Set(candidates.filter((e) => e.is_free).map((e) => e.n)));
  const [withSeries, setWithSeries] = useState(seriesState === "draft");
  const [confirmPaid, setConfirmPaid] = useState(false);

  const chosen = candidates.filter((e) => picked.has(e.n));
  const free = chosen.filter((e) => e.is_free).map((e) => e.n);
  const paid = chosen.filter((e) => !e.is_free).map((e) => e.n);
  const needsConfirm = paid.length > 0 && !paywallLive;
  const seriesGoesLive = seriesState === "draft" && withSeries;
  const nothingLive = seriesGoesLive && chosen.length === 0 && alreadyLive === 0;
  const canSend = (chosen.length > 0 || seriesGoesLive) && (!needsConfirm || confirmPaid) && !nothingLive;

  const toggle = (n: number) => setPicked((s) => {
    const next = new Set(s);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    return next;
  });

  function send() {
    if (!canSend) return;
    onStart({ episodes: chosen.map((e) => e.n), publish_series: seriesGoesLive, confirm_paid: paid.length > 0 && (confirmPaid || paywallLive), series_was: seriesState });
  }

  const lede = tt("cdp.publish.lede");
  return (
    <Shell
      id="cdp-publish"
      title={tt("cdp.publish.title")}
      lede={lede}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={onClose}>{tt("cdp.dialog.cancel")}</button>
          <button type="button" className="btn btn-primary" disabled={!canSend} onClick={send}>
            {chosen.length ? (chosen.length === 1 ? tt("cdp.publish.goOne") : tt("cdp.publish.go", { n: chosen.length })) : tt("cdp.publish.goSeries")}
          </button>
        </>
      }
    >
      {candidates.length === 0 ? (
        <p className="hint">{tt("cdp.publish.noneReady")}</p>
      ) : (
        <fieldset className="cdp-picks">
          <legend className="label">{tt("cdp.publish.pick")}</legend>
          <div className="cdp-pick-tools">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set(candidates.filter((e) => e.is_free).map((e) => e.n)))}>{tt("cdp.publish.pickFree")}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set(candidates.map((e) => e.n)))}>{tt("cdp.publish.pickAll")}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set())}>{tt("cdp.publish.pickNone")}</button>
          </div>
          <ul className="cdp-pick-list">
            {candidates.map((e) => (
              <li key={e.n}>
                <label>
                  <input type="checkbox" checked={picked.has(e.n)} onChange={() => toggle(e.n)} data-episode={e.n} />
                  <span>{tt("cd.episodeN", { n: e.n })}</span>
                  <span className={`pill ${e.is_free ? "pill-neutral" : "pill-warning"}`}>{tt(e.is_free ? "cd.access.free" : "cd.access.paid")}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}

      <dl className="cdp-summary" aria-live="polite">
        <div>
          <dt>{tt("cdp.publish.goesLive")}</dt>
          <dd data-testid="cdp-goes-live">{chosen.length ? tt("cdp.publish.list", { list: episodeList(chosen.map((e) => e.n)) }) : tt("cdp.publish.noEpisodes")}</dd>
        </div>
        <div>
          <dt>{tt("cdp.publish.split")}</dt>
          <dd>{tt("cdp.publish.splitValue", { free: free.length, paid: paid.length })}{paid.length ? <> · {tt("cdp.publish.paidList", { list: episodeList(paid) })}</> : null}</dd>
        </div>
        <div>
          <dt>{tt("cdp.publish.series")}</dt>
          <dd>{seriesState === "published" ? tt("cdp.publish.series.live") : seriesGoesLive ? tt("cdp.publish.series.goes") : tt("cdp.publish.series.stays")}</dd>
        </div>
      </dl>

      {seriesState === "draft" && (
        <label className="cdp-check">
          <input type="checkbox" checked={withSeries} onChange={(e) => setWithSeries(e.target.checked)} />
          <span>{tt("cdp.publish.withSeries")}</span>
        </label>
      )}
      {nothingLive && <p className="hint">{tt("cdp.publish.needEpisode")}</p>}

      {paid.length > 0 && (paywallLive ? (
        <p className="note note-info">{tt("cdp.publish.paywallLive")}</p>
      ) : (
        <div className="note note-warn cdp-paid" role="alert">
          <strong>{tt("cdp.publish.paidWarn.title")}</strong>
          <p>{tt("cdp.publish.paidWarn", { list: episodeList(paid) })}</p>
          <label className="cdp-check">
            <input type="checkbox" checked={confirmPaid} onChange={(e) => setConfirmPaid(e.target.checked)} />
            <span>{tt("cdp.publish.paidConfirm")}</span>
          </label>
        </div>
      ))}
      <p className="hint">{tt("cdp.publish.progressHint")}</p>
    </Shell>
  );
}

type UnpublishProps = {
  titleId: string;
  seriesState: CdSeriesState;
  episodes: readonly PublishEpisode[];
  onClose: () => void;
  onDone: (result: { unpublished: number[]; series_draft: boolean }) => void;
};

export function UnpublishDialog({ titleId, seriesState, episodes, onClose, onDone }: UnpublishProps) {
  const { tt } = useT();
  const live = useMemo(() => [...episodes].filter((e) => e.is_published).sort((a, b) => a.n - b.n), [episodes]);
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [withSeries, setWithSeries] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const chosen = live.filter((e) => picked.has(e.n)).map((e) => e.n);
  const canSend = !busy && (chosen.length > 0 || (withSeries && seriesState === "published"));

  async function send() {
    if (!canSend) return;
    setBusy(true);
    setRefusal(null);
    try {
      const body: UnpublishBody = { ...(chosen.length ? { episodes: chosen } : {}), ...(withSeries ? { unpublish_series: true } : {}) };
      const r = await sendJson<UnpublishReply>("POST", cdRoute(titleId, "unpublish"), body);
      if (!r.ok) return setRefusal(refusalWords(r.body, r.status));
      onDone({ unpublished: r.body.unpublished ?? chosen, series_draft: withSeries });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell
      id="cdp-unpublish"
      title={tt("cdp.unpublish.title")}
      lede={tt("cdp.unpublish.lede")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={onClose}>{tt("cdp.dialog.cancel")}</button>
          <button type="button" className="btn btn-primary" disabled={!canSend} onClick={() => void send()}>
            {busy ? <><span className="spinner" /> {tt("cdp.unpublish.busy")}</> : tt("cdp.unpublish.go")}
          </button>
        </>
      }
    >
      {live.length === 0 ? (
        <p className="hint">{tt("cdp.unpublish.none")}</p>
      ) : (
        <fieldset className="cdp-picks">
          <legend className="label">{tt("cdp.unpublish.pick")}</legend>
          <ul className="cdp-pick-list">
            {live.map((e) => (
              <li key={e.n}>
                <label>
                  <input type="checkbox" checked={picked.has(e.n)} onChange={() => setPicked((s) => { const next = new Set(s); if (next.has(e.n)) next.delete(e.n); else next.add(e.n); return next; })} data-episode={e.n} />
                  <span>{tt("cd.episodeN", { n: e.n })}</span>
                  <span className={`pill ${e.is_free ? "pill-neutral" : "pill-warning"}`}>{tt(e.is_free ? "cd.access.free" : "cd.access.paid")}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {seriesState === "published" && (
        <label className="cdp-check">
          <input type="checkbox" checked={withSeries} onChange={(e) => setWithSeries(e.target.checked)} />
          <span>{tt("cdp.unpublish.withSeries")}</span>
        </label>
      )}
      <p className="note note-warn">{chosen.length ? tt("cdp.unpublish.warn", { list: episodeList(chosen) }) : tt("cdp.unpublish.warnNone")}</p>
      {refusal && <p className="note note-warn" role="alert">{refusal}</p>}
    </Shell>
  );
}

type ReplaceProps = {
  episode: PublishEpisode;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

/** The re-cut path (spec §10): only for an episode crazydramas holds ready or errored; the viewer impact first. */
export function ReplaceDialog({ episode, busy, onClose, onConfirm }: ReplaceProps) {
  const { tt } = useT();
  return (
    <Shell
      id="cdp-replace"
      title={tt("cdp.replace.title", { n: episode.n })}
      lede={tt("cdp.replace.lede")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={onClose}>{tt("cdp.dialog.cancel")}</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onConfirm}>{tt("cdp.replace.go", { n: episode.n })}</button>
        </>
      }
    >
      <ul className="cdp-impact">
        <li>{tt(episode.is_published ? "cdp.replace.impact.old" : "cdp.replace.impact.oldDraft")}</li>
        {episode.is_published && <li>{tt("cdp.replace.impact.unchecked")}</li>}
        <li>{tt("cdp.replace.impact.progress")}</li>
        <li>{tt("cdp.replace.impact.kept")}</li>
      </ul>
    </Shell>
  );
}
