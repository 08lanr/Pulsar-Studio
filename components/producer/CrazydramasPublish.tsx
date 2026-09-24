"use client";

// "Upload to crazydramas" (phase 5, publish spec §1–10; crazydramas
// docs/STUDIO_API.md is the contract), under the series check on the
// title's CrazyDramas section and on its staff mirror. Three steps, draft
// first and publish explicitly:
//
//   1. Series details   the form, prefilled — the slug Studio picked (SlugField), the tagline,
//                       description and genres it drafted from the transcript, the poster from
//                       the title's cover (PosterField); "Create draft series" (SeriesForm)
//   2. Upload episodes  all, or a range, in the background, per-episode progress (UploadProgress)
//   3. Publish          exactly the ticked episodes; paid ones need their own confirm (PublishDialog)
//
// Everything is read from GET /api/titles/[id]/crazydramas/publish, polled
// every two seconds while an episode is on its way. Pressing Publish shows
// the progress (PublishProgress): the episodes, the series, the public page,
// Live with its link. A series made in the
// crazydramas CMS is shown read-only with the hand-over note; when real
// writes are off the banner names the setting that is missing (never a
// value) and every write control is off. Only the title's approver (or a
// staff administrator on the staff mirror) acts; everyone else is told why.

import "@/app/crazydramas-publish.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/components/locale";
import type { CdSeriesState, PublishEpisode, PublishState, SeriesReply, UploadsReply } from "@/lib/crazydramas/publish-types";
import { fmtPriceCents } from "./CrazydramasChip";
import PublishDialog, { publishable, ReplaceDialog, UnpublishDialog } from "./crazydramas/PublishDialog";
import PublishProgress, { type PublishPlan } from "./crazydramas/PublishProgress";
import { cdRoute, episodeList, refusalWords, sendJson } from "./crazydramas/request";
import SeriesForm from "./crazydramas/SeriesForm";
import SlugField from "./crazydramas/SlugField";
import UploadProgress, { isActive } from "./crazydramas/UploadProgress";

export type CrazydramasPublishProps = {
  titleId: string;
  /** Which staff link to name when a staff session previews the producer portal. */
  portal: "producer" | "admin";
  /** The title's approver in the producer portal, or a staff administrator on the staff mirror. */
  canAct: boolean;
  /** Why not, when not: a staff preview of the portal, or a role that only reads. */
  reason?: "preview" | "readOnly" | "notAdmin" | null;
  /** Studio's own cover of the title (mediaUrl of cover_path), the preview beside the poster field. */
  coverUrl: string | null;
  /** Open the Publish dialog as soon as the state is read, when something can be published (the CrazyDramas hub's Publish button). */
  autoOpen?: "publish" | null;
  /** After anything changed (a publish, an upload settling): the hub reads its rows again. */
  onChanged?: () => void;
};

const POLL_MS = 2000;

const STATE_PILL: Record<CdSeriesState, string> = {
  not_linked: "pill-neutral",
  not_uploaded: "pill-neutral",
  draft: "pill-accent",
  published: "pill-success",
  cms_managed: "pill-neutral",
  linked_elsewhere: "pill-warning",
};

type Note = { text: string; error: boolean } | null;

export default function CrazydramasPublish({ titleId, portal, canAct, reason = null, coverUrl, autoOpen = null, onChanged }: CrazydramasPublishProps) {
  const { tt } = useT();
  const router = useRouter();
  const [state, setState] = useState<PublishState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [dialog, setDialog] = useState<null | { kind: "publish" } | { kind: "unpublish" } | { kind: "replace"; n: number }>(null);
  const [progress, setProgress] = useState<{ key: number; plan: PublishPlan } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const autoOpened = useRef(false);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const load = useCallback(async () => {
    const r = await sendJson<PublishState>("GET", cdRoute(titleId, "publish"));
    if (!alive.current) return null;
    if (!r.ok) {
      setLoadError(refusalWords(r.body, r.status));
      return null;
    }
    setLoadError(null);
    setState(r.body);
    return r.body;
  }, [titleId]);

  // Poll while the uploader holds any episode; stop when every episode has settled.
  const schedule = useCallback((s: PublishState | null) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!s) return;
    const running = s.uploading === true || s.episodes.some(isActive);
    if (!running) return;
    timer.current = setTimeout(() => {
      void load().then((next) => {
        schedule(next);
        // An episode settling changes what the series check above says; the server page reads it again.
        if (next && !next.episodes.some(isActive) && next.uploading !== true) router.refresh();
      });
    }, POLL_MS);
  }, [load, router]);

  // Everyone who reads the title reads the state (the route decides); only the approver or a staff administrator gets the controls.
  useEffect(() => {
    alive.current = true;
    void load().then(schedule);
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load, schedule]);

  const reload = useCallback(async () => {
    const next = await load();
    schedule(next);
    router.refresh();
    changed.current?.();
  }, [load, schedule, router]);

  // The hub's Publish button: open the dialog once, when the state says something can go live.
  useEffect(() => {
    if (autoOpen !== "publish" || autoOpened.current || !state || !canAct || !state.writes_enabled) return;
    autoOpened.current = true;
    if (state.episodes.some(publishable)) setDialog({ kind: "publish" });
  }, [autoOpen, state, canAct]);

  async function upload(episodes: number[] | "all", replace = false) {
    setBusy(true);
    setNote(null);
    try {
      const r = await sendJson<UploadsReply>("POST", cdRoute(titleId, "uploads"), { episodes, ...(replace ? { replace: true } : {}) });
      if (!r.ok) {
        setNote({ text: tt("cdp.upload.refused", { reason: refusalWords(r.body, r.status) }), error: true });
      } else {
        const queued = r.body.queued ?? [];
        const skipped = r.body.skipped ?? [];
        const text = [
          queued.length ? tt("cdp.upload.queued", { list: episodeList(queued) }) : tt("cdp.upload.queuedNone"),
          ...skipped.map((x) => tt("cdp.upload.skipped", { reason: x.reason.replace(/[.。]\s*$/, "") })),
        ].join(" ");
        setNote({ text, error: queued.length === 0 && skipped.length > 0 });
      }
    } finally {
      setBusy(false);
      setDialog(null);
      await reload();
    }
  }

  async function cancel(episode?: number) {
    setBusy(true);
    setNote(null);
    try {
      const r = await sendJson<{ cancelled: unknown }>("POST", cdRoute(titleId, "uploads/cancel"), episode ? { episode } : {});
      if (!r.ok) setNote({ text: tt("cdp.cancel.refused", { reason: refusalWords(r.body, r.status) }), error: true });
      else {
        const c = r.body.cancelled;
        const list = Array.isArray(c) ? c.filter((x): x is number => typeof x === "number") : typeof c === "number" ? [c] : episode ? [episode] : [];
        setNote({ text: c === false || (Array.isArray(c) && c.length === 0) ? tt("cdp.cancel.nothing") : list.length ? tt("cdp.cancel.done", { list: episodeList(list) }) : tt("cdp.cancel.doneAll"), error: false });
      }
    } finally {
      setBusy(false);
      await reload();
    }
  }

  function seriesSaved(reply: SeriesReply) {
    setState((s) => (s ? { ...s, series: reply.series, series_state: s.series_state === "not_uploaded" ? "draft" : s.series_state } : s));
    void reload();
  }

  if (!canAct) {
    // Read-only: why not, in portal words, and — when the route lets this session read it — where the series and each episode stand.
    const s = state;
    const listed = s && (s.series_state === "draft" || s.series_state === "published");
    return (
      <section id="cd-publish" className="card cdp" aria-labelledby="cdp-title" data-series-state={s?.series_state} data-read-only="true">
        <header className="cdp-head">
          <h2 id="cdp-title">{tt("cdp.title")}</h2>
          {s && <span className={`pill ${STATE_PILL[s.series_state]}`} data-cdp-state={s.series_state}>{tt(`cdp.state.${s.series_state}`)}</span>}
        </header>
        <p className="hint">
          {reason === "preview" ? (
            <>{tt("cdp.readOnly.preview")} <a href={`/titles/${titleId}/crazydramas#cd-publish`}>{tt("cd.check.preview.link")}&nbsp;→</a></>
          ) : reason === "notAdmin" ? tt("cdp.readOnly.notAdmin") : tt(portal === "admin" ? "cdp.readOnly.notAdmin" : "cdp.readOnly.role")}
        </p>
        {s?.series_state === "linked_elsewhere" && <p className="note note-warn">{tt("cdp.linkedElsewhere")}</p>}
        {s?.series_state === "cms_managed" && <CmsManaged state={s} />}
        {listed && <UploadProgress episodes={s.episodes} seriesReady canWrite={false} busy={false} onUpload={() => undefined} onCancel={() => undefined} onReplace={() => undefined} />}
      </section>
    );
  }

  if (!state) {
    return (
      <section id="cd-publish" className="card cdp" aria-labelledby="cdp-title" aria-busy={!loadError}>
        <header className="cdp-head"><h2 id="cdp-title">{tt("cdp.title")}</h2></header>
        {loadError ? (
          <p className="note note-warn" role="alert">{tt("cdp.loadFailed", { detail: loadError })} <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load().then(schedule)}>{tt("cdp.retryLoad")}</button></p>
        ) : (
          <p className="hint" role="status"><span className="spinner" /> {tt("cdp.loading")}</p>
        )}
      </section>
    );
  }

  const s = state;
  const writes = s.writes_enabled;
  const studioSeries = s.series_state === "draft" || s.series_state === "published";
  const canWrite = writes && !busy && !publishing;
  const ready = s.episodes.filter(publishable);
  const live = s.episodes.filter((e) => e.is_published);
  const replaceEpisode = dialog?.kind === "replace" ? s.episodes.find((e) => e.n === dialog.n) ?? null : null;

  return (
    <section id="cd-publish" className="card cdp" aria-labelledby="cdp-title" data-series-state={s.series_state}>
      <header className="cdp-head">
        <h2 id="cdp-title">{tt("cdp.title")}</h2>
        <span className={`pill ${STATE_PILL[s.series_state]}`} data-cdp-state={s.series_state}>{tt(`cdp.state.${s.series_state}`)}</span>
      </header>
      <p className="hint cdp-intro">{tt("cdp.intro")}</p>

      {!writes && (
        <p className="note note-warn cdp-writes-off" role="status">
          <strong>{tt("cdp.writesOff.title")}</strong> {s.writes_disabled_reason ? tt("cdp.writesOff.reason", { reason: s.writes_disabled_reason }) : tt("cdp.writesOff.noReason")}
        </p>
      )}

      {s.series_state === "not_linked" && (
        // No slug yet: Studio picks one from the title as the section opens and checks it on crazydramas (decision
        // 2026-09-23 "Upload automation"); a crazydramas that does not answer is said in words, with Retry.
        <div className="cdp-step cdp-slug-setup">
          <p className="hint">{tt("cdp.notLinked")}</p>
          <SlugField titleId={titleId} slug={null} editable auto onSaved={() => void reload()} />
        </div>
      )}

      {s.series_state === "linked_elsewhere" && <p className="note note-warn">{tt("cdp.linkedElsewhere")}</p>}

      {s.series_state === "cms_managed" && <CmsManaged state={s} />}

      {(s.series_state === "not_uploaded" || studioSeries) && (
        <>
          <div className="cdp-step">
            <h3><span className="cdp-step-n">1</span> {tt("cdp.step.series")}</h3>
            {s.series_state === "published" ? (
              // A live series' details stay folded: changing them changes what viewers see.
              <details className="cdp-live-form">
                <summary>{tt("cdp.series.liveEdit")}</summary>
                <p className="hint">{tt("cdp.series.liveHint")}</p>
                <SeriesForm titleId={titleId} seriesState={s.series_state} defaults={s.form_defaults} series={s.series} canWrite={writes} coverUrl={coverUrl} onSaved={seriesSaved} onSlugSaved={() => void reload()} onChanged={() => void reload()} />
              </details>
            ) : (
              <SeriesForm titleId={titleId} seriesState={s.series_state} defaults={s.form_defaults} series={s.series} canWrite={writes} coverUrl={coverUrl} onSaved={seriesSaved} onSlugSaved={() => void reload()} onChanged={() => void reload()} />
            )}
          </div>

          <div className="cdp-step">
            <h3><span className="cdp-step-n">2</span> {tt("cdp.step.upload")}</h3>
            <p className="hint">{tt("cdp.upload.hint")}</p>
            <UploadProgress
              episodes={s.episodes}
              seriesReady={studioSeries}
              canWrite={writes}
              busy={busy}
              onUpload={(eps) => void upload(eps)}
              onCancel={(ep) => void cancel(ep)}
              onReplace={(n) => setDialog({ kind: "replace", n })}
            />
          </div>

          <div className="cdp-step">
            <h3><span className="cdp-step-n">3</span> {tt("cdp.step.publish")}</h3>
            <p className="hint">
              {studioSeries ? tt("cdp.publish.state", { ready: ready.length, live: live.length }) : tt("cdp.publish.needSeries")}
              {!s.paywall_live && <> {tt("cdp.publish.paywallNote")}</>}
            </p>
            <div className="cdp-actions">
              <button type="button" className="btn btn-primary" disabled={!canWrite || !studioSeries || (ready.length === 0 && !(s.series_state === "draft" && live.length > 0))} onClick={() => setDialog({ kind: "publish" })}>
                {tt("cdp.publish.open")}
              </button>
              <button type="button" className="btn btn-outline" disabled={!canWrite || !studioSeries || (live.length === 0 && s.series_state !== "published")} onClick={() => setDialog({ kind: "unpublish" })}>
                {tt("cdp.unpublish.open")}
              </button>
            </div>
          </div>
        </>
      )}

      {progress && (
        <PublishProgress key={progress.key} titleId={titleId} plan={progress.plan} onChanged={() => void reload()} onClose={() => setProgress(null)} onSettled={() => setPublishing(false)} />
      )}

      {note && <p className={note.error ? "note note-warn" : "hint cdp-ok"} role={note.error ? "alert" : "status"}>{note.text}</p>}

      {dialog?.kind === "publish" && (
        <PublishDialog
          seriesState={s.series_state}
          episodes={s.episodes}
          paywallLive={s.paywall_live}
          onClose={() => setDialog(null)}
          onStart={(plan) => {
            setDialog(null);
            setNote(null);
            setPublishing(true);
            setProgress((p) => ({ key: (p?.key ?? 0) + 1, plan }));
          }}
        />
      )}
      {dialog?.kind === "unpublish" && (
        <UnpublishDialog
          titleId={titleId}
          seriesState={s.series_state}
          episodes={s.episodes}
          onClose={() => setDialog(null)}
          onDone={(r) => {
            setDialog(null);
            setNote({ text: [r.unpublished.length ? tt("cdp.unpublish.done", { list: episodeList(r.unpublished) }) : null, r.series_draft ? tt("cdp.unpublish.seriesDraft") : null].filter(Boolean).join(" ") || tt("cdp.unpublish.doneNone"), error: false });
            void reload();
          }}
        />
      )}
      {replaceEpisode && (
        <ReplaceDialog episode={replaceEpisode} busy={busy} onClose={() => setDialog(null)} onConfirm={() => void upload([replaceEpisode.n], true)} />
      )}
    </section>
  );
}

/** A series made in the crazydramas CMS (spec §5): its facts, read-only, and how it could be handed over. Studio never writes to it. */
function CmsManaged({ state }: { state: PublishState }) {
  const { tt } = useT();
  const series = state.series;
  const slug = series?.slug ?? state.form_defaults.slug ?? "";
  const episodes: PublishEpisode[] = [...state.episodes].sort((a, b) => a.n - b.n);
  const onCd = episodes.filter((e) => e.cd_status).length;
  const published = episodes.filter((e) => e.is_published).length;
  return (
    <div className="cdp-cms">
      <p className="note note-info cdp-handover">{tt("cdp.cms.note")}</p>
      {series && (
        <dl className="tw-facts cdp-cms-facts">
          <div><dt>{tt("cd.series.title")}</dt><dd lang="en">{series.title}</dd></div>
          <div><dt>{tt("cdp.cms.status")}</dt><dd>{series.status}</dd></div>
          <div><dt>{tt("cdp.form.free")}</dt><dd>{series.free_episode_count}</dd></div>
          <div><dt>{tt("cd.series.price")}</dt><dd>{fmtPriceCents(series.series_price_cents)}</dd></div>
          <div><dt>{tt("cd.series.iap")}</dt><dd>{series.iap_product_id ? <code>{series.iap_product_id}</code> : tt("cd.series.iap.unset")}</dd></div>
          <div><dt>{tt("cdp.cms.episodes")}</dt><dd>{tt("cdp.cms.episodes.value", { on: onCd, live: published })}</dd></div>
        </dl>
      )}
      {slug && (
        <details className="cdp-sql">
          <summary>{tt("cdp.cms.sql")}</summary>
          <code>{`update dramas set managed_by = 'studio' where slug = '${slug}';`}</code>
        </details>
      )}
    </div>
  );
}
