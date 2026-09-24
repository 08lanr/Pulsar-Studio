"use client";

// The CrazyDramas hub (overnight spec item 10, 2026-09-24): one row per film
// or title — every workspace film, every Studio title, every series live on
// crazydramas.com that matches neither — with where it stands in Studio,
// where it stands on crazydramas, its episodes and ONE button for the next
// step: Import → Upload to CrazyDramas → Publish → Open on site. The rows are
// decided on the server (lib/crazydramas/hub.ts, `buildHub`); this screen
// puts them into words and runs the buttons:
//
//   Import             starts the import here (the staff desk imports for the company picked above the
//                      table) and shows its progress line on the row until it settles
//   Upload / Publish   open "Upload to CrazyDramas" in place, under the row: the series form, the
//                      uploads, the publish step (Publish opens its dialog at once)
//   Open on site       the public page, in a new tab
//
// Films that cannot be imported yet fold into one "Not ready (n)" line with
// their reasons. Staff may read CrazyDramas' catalog now instead of waiting
// for the hourly sweep. Everyone who may not act reads the same rows, with
// the reason in one line.

import "@/app/crazydramas-publish.css";
import "@/app/crazydramas-hub.css";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiRequestError, getJson, postJson } from "@/lib/api-client";
import { useT } from "@/components/locale";
import type { Hub, HubAction, HubInStudio, HubOnCd, HubRow } from "@/lib/crazydramas/hub";
import type { FilmListing, ImportProgress } from "@/lib/film-import/import";
import CrazydramasPublish from "../CrazydramasPublish";
import { filmReasonText, importProgressText, importResultText } from "../film-import-words";

type Props = {
  hub: Hub;
  portal: "admin" | "producer";
  /** A staff administrator, or the company's approver. */
  canAct: boolean;
  /** Why not, when not. */
  reason?: "preview" | "readOnly" | "notAdmin" | null;
  /** Staff: the companies a film can be imported for, and the one picked first. */
  producers?: { id: string; name: string }[];
  defaultProducerId?: string | null;
};

type Open = { titleId: string; mode: "upload" | "publish" } | null;

const POLL_MS = 2000;

function isRunning(p: ImportProgress | null | undefined): boolean {
  return !!p && p.step !== "done" && p.step !== "failed";
}

export default function CrazydramasHub({ hub, portal, canAct, reason = null, producers = [], defaultProducerId = null }: Props) {
  const { tt } = useT();
  const router = useRouter();
  const [open, setOpen] = useState<Open>(null);
  const [producerId, setProducerId] = useState<string>(defaultProducerId ?? producers[0]?.id ?? "");
  const [importing, setImporting] = useState<Record<string, ImportProgress | "starting">>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sweep, setSweep] = useState<{ busy: boolean; note: string | null; error: boolean }>({ busy: false, note: null, error: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const titleHref = (id: string) => (portal === "admin" ? `/titles/${id}` : `/producer/titles/${id}`);
  const sectionHref = (id: string) => `${titleHref(id)}/crazydramas`;
  const addEpisodesHref = (id: string) => (portal === "admin" ? `/titles/${id}` : `/producer/titles/${id}/materials`);
  const importPage = portal === "admin" ? "/films/import" : "/producer/films/import";
  const listUrl = portal === "admin" ? `/api/admin/films?producer_id=${encodeURIComponent(producerId)}` : "/api/producer/films";

  // While an import started here runs, read the company's listing every two seconds for its progress line.
  const watching = Object.entries(importing).filter(([, p]) => p === "starting" || isRunning(p as ImportProgress)).map(([ref]) => ref);
  const poll = useCallback(async () => {
    try {
      const listing = await getJson<FilmListing>(listUrl);
      const next: Record<string, ImportProgress | "starting"> = {};
      let settled = false;
      for (const ref of Object.keys(importing)) {
        const film = listing.films.find((f) => f.source_ref === ref);
        if (film?.progress) {
          next[ref] = film.progress;
          if (!isRunning(film.progress)) settled = true;
        } else next[ref] = importing[ref];
      }
      setImporting(next);
      if (settled) router.refresh();
    } catch {
      /* the next poll tries again */
    }
  }, [importing, listUrl, router]);

  useEffect(() => {
    if (!watching.length) return;
    timer.current = setTimeout(() => void poll(), POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [watching.length, poll]);

  async function startImport(row: HubRow, ref: string) {
    setErrors((e) => ({ ...e, [row.key]: "" }));
    setImporting((x) => ({ ...x, [ref]: "starting" }));
    try {
      const body: Record<string, unknown> = { source_ref: ref, mode: "import", attach_transcript: true };
      if (portal === "admin") body.producer_id = producerId;
      const r = await postJson<{ error?: string }>(portal === "admin" ? "/api/admin/films/import" : "/api/producer/films/import", body);
      if (r.error) throw new Error(r.error);
    } catch (e) {
      setImporting((x) => {
        const next = { ...x };
        delete next[ref];
        return next;
      });
      setErrors((er) => ({ ...er, [row.key]: tt("fi.startFailed", { detail: e instanceof ApiRequestError ? e.message : (e as Error).message }) }));
    }
  }

  async function readNow() {
    setSweep({ busy: true, note: null, error: false });
    try {
      const res = await fetch("/api/admin/crazydramas/sweep", { method: "POST", headers: { "Content-Type": "application/json", accept: "application/json" }, body: "{}", cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; catalog?: number | null; errors?: number };
      if (!res.ok) setSweep({ busy: false, note: data.error ?? `HTTP ${res.status}`, error: true });
      else {
        setSweep({ busy: false, note: data.catalog == null ? tt("cdh.read.catalogFailed") : tt("cdh.read.done", { n: data.catalog }), error: data.catalog == null });
        router.refresh();
      }
    } catch (e) {
      setSweep({ busy: false, note: (e as Error).message, error: true });
    }
  }

  const needsCompany = portal === "admin" && canAct && hub.rows.some((r) => r.action.kind === "import");

  function inStudioCell(s: HubInStudio, row: HubRow) {
    switch (s.code) {
      case "not_imported":
        return <span className="gt-muted">{tt("cdh.studio.not_imported")}</span>;
      case "imported":
        return (
          <span className="cdh-stack">
            <span>{tt("cdh.studio.imported", { n: s.episodes })}</span>
            {s.update && <a className="cdh-sub-link" href={importPage}>{tt("cdh.studio.update")}&nbsp;→</a>}
          </span>
        );
      case "made_in_studio":
        return <span>{tt("cdh.studio.made_in_studio", { n: s.episodes })}</span>;
      case "not_in_studio":
        return <span className="gt-muted">{row.kind === "series" ? tt("cdh.studio.not_in_studio") : "—"}</span>;
    }
  }

  function onCdCell(c: HubOnCd) {
    const chip = (tone: string, text: string, hint?: string | null) => (
      <span className={`tw-chip tw-chip-cd ${tone}`}>
        <i aria-hidden="true" />
        {text}
        {hint && <small> · {hint}</small>}
      </span>
    );
    switch (c.code) {
      case "live": {
        const words = c.match !== null && c.of ? tt("cdh.cd.liveMatch", { n: c.match, of: c.of }) : tt("cdh.cd.live", { n: c.episodes });
        const tone = c.state === "live_partial" || c.state === "live_differs" || c.state === "local_newer" || (c.match !== null && c.of !== null && c.match < c.of) ? "is-warn" : "is-live";
        return chip(tone, words, c.cms ? tt("cdh.cd.cms") : null);
      }
      case "draft": {
        const hint = [
          c.publishable ? tt("cdh.cd.draft.ready", { n: c.publishable }) : null,
          c.uploading ? tt("cdh.cd.draft.uploading", { n: c.uploading }) : null,
          c.failed ? tt("cdh.cd.draft.failed", { n: c.failed }) : null,
          c.cms ? tt("cdh.cd.cms") : null,
        ].filter(Boolean).join(" · ");
        return chip(c.failed ? "is-bad" : "is-wait", tt("cdh.cd.draft", { n: c.uploaded, of: c.of }), hint || null);
      }
      case "not_uploaded":
        return chip("is-none", tt(c.certain ? "cdh.cd.not_uploaded" : "cdh.cd.not_live"));
      case "archived":
        return chip("is-warn", tt("cdh.cd.archived"), c.cms ? tt("cdh.cd.cms") : null);
      case "not_checked":
        return chip("is-wait", tt("cdh.cd.not_checked"));
      case "no_slug":
        return chip("is-none", tt("cdh.cd.no_slug"));
      case "check_failed":
        return chip("is-bad", tt("cdh.cd.check_failed"));
      case "elsewhere":
        return chip("is-bad", tt("cdh.cd.elsewhere"));
      case "before_import":
        // Only staff have "Read CrazyDramas now"; the company is told the hourly read will say.
        return c.read ? chip("is-none", tt("cdh.cd.before_import")) : chip("is-wait", tt(portal === "admin" ? "cdh.cd.before_import_unread" : "cdh.cd.before_import_unreadProducer"));
    }
  }

  function actionCell(row: HubRow) {
    const a: HubAction = row.action;
    const ref = row.source_ref ?? "";
    const imp = importing[ref];
    const importBusy = imp === "starting" || isRunning(imp as ImportProgress | undefined) || isRunning(row.progress);
    const toggle = (titleId: string, mode: "upload" | "publish") => setOpen((o) => (o?.titleId === titleId ? null : { titleId, mode }));
    const isOpen = !!row.title_id && open?.titleId === row.title_id;
    switch (a.kind) {
      case "import":
        if (importBusy) return <button type="button" className="btn btn-outline btn-sm" disabled><span className="spinner" /> {tt("fi.action.importing")}</button>;
        return (
          <button type="button" className="btn btn-primary btn-sm" disabled={needsCompany && !producerId} onClick={() => void startImport(row, a.source_ref)}>
            {tt("cdh.action.import")}
          </button>
        );
      case "upload":
        return <button type="button" className={`btn btn-sm ${isOpen ? "btn-outline" : "btn-primary"}`} aria-expanded={isOpen} aria-controls={`cdh-panel-${a.title_id}`} onClick={() => toggle(a.title_id, "upload")}>{isOpen ? tt("cdh.action.close") : tt("cdh.action.upload")}</button>;
      case "uploading":
        return <button type="button" className="btn btn-outline btn-sm" aria-expanded={isOpen} aria-controls={`cdh-panel-${a.title_id}`} onClick={() => toggle(a.title_id, "upload")}>{isOpen ? tt("cdh.action.close") : <><span className="spinner" /> {tt("cdh.action.uploading", { n: a.n, of: a.of })}</>}</button>;
      case "publish":
        return <button type="button" className={`btn btn-sm ${isOpen ? "btn-outline" : "btn-primary"}`} aria-expanded={isOpen} aria-controls={`cdh-panel-${a.title_id}`} onClick={() => toggle(a.title_id, "publish")}>{isOpen ? tt("cdh.action.close") : a.n > 0 ? tt("cdh.action.publish", { n: a.n }) : tt("cdh.action.publishSeries")}</button>;
      case "open_site":
        return <a className="btn btn-outline btn-sm" href={a.url} target="_blank" rel="noreferrer">{tt("cdh.action.open_site")}&nbsp;↗</a>;
      case "check":
        return <a className="btn btn-outline btn-sm" href={sectionHref(a.title_id)}>{tt("cdh.action.check")}</a>;
      case "add_episodes":
        return <a className="btn btn-outline btn-sm" href={addEpisodesHref(a.title_id)}>{tt("cdh.action.add_episodes")}</a>;
      case "none":
        return row.title_id ? <a className="btn btn-outline btn-sm" href={sectionHref(row.title_id)}>{tt("cdh.action.view")}</a> : <span className="gt-muted">—</span>;
    }
  }

  function subLine(row: HubRow) {
    if (!row.sub) return null;
    if (row.sub_kind === "source_title") return tt("fi.sourceTitle", { name: row.sub });
    if (row.sub_kind === "slug") return row.sub;
    return row.sub;
  }

  return (
    <section className="cdh" aria-label={tt("cdh.title")}>
      <div className="cdh-tools">
        {needsCompany && (
          <label className="cdh-company">
            <span className="label">{tt("cdh.importFor")}</span>
            <select className="select" value={producerId} onChange={(e) => setProducerId(e.target.value)} aria-label={tt("cdh.importFor")}>
              <option value="">{tt("fi.company.pick")}</option>
              {producers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <span className="spacer" />
        {portal === "admin" && (
          <button type="button" className="btn btn-outline btn-sm" disabled={sweep.busy} onClick={() => void readNow()}>
            {sweep.busy ? <><span className="spinner" /> {tt("cdh.read.busy")}</> : tt("cdh.read.now")}
          </button>
        )}
      </div>
      {sweep.note && <p className={sweep.error ? "note note-warn" : "hint"} role="status">{sweep.note}</p>}
      {!canAct && reason && <p className="note note-info">{tt(`cdh.readOnly.${reason}`)}</p>}
      {!hub.workspace && <p className="note note-info">{tt("cdh.noWorkspace")}</p>}
      {portal === "admin" && !hub.catalog_read && <p className="hint">{tt("cdh.catalogNotRead")}</p>}

      {hub.rows.length === 0 ? (
        <p className="hint">{tt("cdh.empty")}</p>
      ) : (
        <div className="cdh-list" role="table" aria-label={tt("cdh.title")}>
          <div className="cdh-head" role="row">
            <span role="columnheader" aria-hidden="true" />
            <span role="columnheader">{tt("cdh.col.film")}</span>
            <span role="columnheader">{tt("cdh.col.studio")}</span>
            <span role="columnheader">{tt("cdh.col.cd")}</span>
            <span role="columnheader">{tt("cdh.col.episodes")}</span>
            <span role="columnheader">{tt("cdh.col.next")}</span>
          </div>
          {hub.rows.map((row) => {
            const imp = row.source_ref ? importing[row.source_ref] : undefined;
            const progress = imp && imp !== "starting" ? imp : row.progress;
            const result = progress ? importResultText(tt, progress) : null;
            const isOpen = !!row.title_id && open?.titleId === row.title_id;
            const sub = subLine(row);
            return (
              <Fragment key={row.key}>
                <div className={`cdh-row${isOpen ? " is-open" : ""}`} role="row" data-row={row.key} data-kind={row.kind} data-action={row.action.kind} data-source-ref={row.source_ref ?? undefined} data-title-id={row.title_id ?? undefined}>
                  <span className="cdh-poster" role="cell" aria-hidden="true">
                    {/* eslint-disable-next-line @next/next/no-img-element -- our own routes (or crazydramas' public poster), no optimisation */}
                    {row.poster && <img src={row.poster} alt="" loading="lazy" />}
                  </span>
                  <span className="cdh-name" role="cell">
                    {row.title_id ? <a href={titleHref(row.title_id)} lang={row.lang}><strong>{row.name}</strong></a> : <strong lang={row.lang}>{row.name}</strong>}
                    {sub && <small className="gt-muted" lang={row.sub_kind === "name_zh" ? "zh-CN" : "en"}>{row.sub_kind === "slug" ? <code>{sub}</code> : sub}</small>}
                    {row.company && portal === "admin" && <small className="gt-muted">{row.company}</small>}
                    {progress && isRunning(progress) && <small className="hint" role="status"><span className="spinner" /> {importProgressText(tt, progress)}</small>}
                    {result && <small className={result.error ? "err" : "hint"} role="status">{result.text}</small>}
                    {errors[row.key] && <small className="err" role="alert">{errors[row.key]}</small>}
                  </span>
                  <span className="cdh-studio" role="cell"><span className="cdh-label">{tt("cdh.col.studio")}</span>{inStudioCell(row.in_studio, row)}</span>
                  <span className="cdh-cd" role="cell"><span className="cdh-label">{tt("cdh.col.cd")}</span>{onCdCell(row.on_cd)}</span>
                  <span className="cdh-eps gt-num" role="cell"><span className="cdh-label">{tt("cdh.col.episodes")}</span>{row.episodes ?? "—"}</span>
                  <span className="cdh-action" role="cell">{actionCell(row)}</span>
                </div>
                {isOpen && row.title_id && (
                  <div className="cdh-panel" id={`cdh-panel-${row.title_id}`} role="region" aria-label={tt("cdh.panel", { name: row.name })}>
                    <CrazydramasPublish
                      titleId={row.title_id}
                      portal={portal}
                      canAct={canAct}
                      reason={reason}
                      coverUrl={row.cover_url}
                      autoOpen={open?.mode === "publish" ? "publish" : null}
                      onChanged={() => router.refresh()}
                    />
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      )}

      {hub.not_ready.length > 0 && (
        <details className="fi-not-ready cdh-not-ready" data-count={hub.not_ready.length}>
          <summary>{tt("fi.notReady", { n: hub.not_ready.length })} <small className="gt-muted">{tt("fi.notReady.hint")}</small></summary>
          <ul>
            {hub.not_ready.map((f) => (
              <li key={f.key} data-source-ref={f.source_ref} data-state={f.state}>
                <strong lang="en">{f.name}</strong>
                <small className="gt-muted">{f.source_ref}</small>
                <span className="pill pill-neutral">{tt(`fi.state.${f.state}`)}</span>
                {filmReasonText(tt, f.reason) && <small className="gt-muted">{filmReasonText(tt, f.reason)}</small>}
                {f.note && <small className="gt-muted cdh-not-ready-note" lang="en">{f.note}</small>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
