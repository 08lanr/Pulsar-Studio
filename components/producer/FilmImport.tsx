"use client";

// The import desk (decision 2026-09-22, "the workspace import"; spec §3.7):
// one row per film under the pipeline's workspace — poster, the display
// title (editable until it is imported), the source title, episodes, size,
// pixel size, language and the state with its reason — and a fixed action
// column: Import, Update N changed, or Open. The transcript checkbox applies
// to the next import. While an import runs the row shows the job's progress
// line and the list polls every two seconds; when it finishes the row shows
// the counts. The producer page renders this in Chinese, the staff desk in
// English with a company picker (staff may not act in the producer portal).

import "@/app/crazydramas-hub.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, getJson, postJson } from "@/lib/api-client";
import { useT } from "@/components/locale";
import type { FilmListing, FilmRow, ImportProgress, ImportStarted } from "@/lib/film-import/import";
import { CrazydramasChip, type CrazydramasChipReading } from "./CrazydramasChip";
import { filmReasonText, importProgressText, importResultText, isNotReady } from "./film-import-words";

type Props = {
  /** Which routes and title links to use. */
  portal: "producer" | "admin";
  canImport: boolean;
  /** Staff: the companies to import for. */
  producers?: { id: string; name: string }[];
  /**
   * The crazydramas chip of each imported title, by title id (plan A4.3;
   * `crazydramasStatesByTitle`). A film with no film-meta slug reads "Not
   * linked: add a crazydramas slug" whether or not it is imported.
   */
  crazydramas?: Record<string, CrazydramasChipReading>;
};

type StartReply = Partial<ImportStarted> & { error?: string; code?: string };

const POLL_MS = 2000;

/** Chip states of an imported title that is not on crazydramas yet, whose row offers "Upload to crazydramas" (phase 5). `not_uploaded` / `draft` are the token-read split of `not_live` (publish spec §7). */
const NOT_ON_CRAZYDRAMAS: ReadonlySet<string> = new Set(["not_checked", "not_live", "not_uploaded", "draft"]);

function running(p: ImportProgress | null): boolean {
  return !!p && p.step !== "done" && p.step !== "failed";
}

function sizeText(tt: (k: string, v?: Record<string, string | number>) => string, bytes: number): string {
  if (bytes >= 1024 ** 3) return tt("fi.size.gb", { n: (bytes / 1024 ** 3).toFixed(2) });
  return tt("fi.size.mb", { n: Math.max(1, Math.round(bytes / 1024 ** 2)) });
}

export default function FilmImport({ portal, canImport, producers = [], crazydramas = {} }: Props) {
  const { tt, locale } = useT();
  const [producerId, setProducerId] = useState<string>(producers[0]?.id ?? "");
  const [listing, setListing] = useState<FilmListing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [startError, setStartError] = useState<Record<string, string>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const listUrl = portal === "admin" ? `/api/admin/films${producerId ? `?producer_id=${encodeURIComponent(producerId)}` : ""}` : "/api/producer/films";
  const importUrl = portal === "admin" ? "/api/admin/films/import" : "/api/producer/films/import";
  const posterUrl = (ref: string) => `${portal === "admin" ? "/api/admin/films/poster" : "/api/producer/films/poster"}?ref=${encodeURIComponent(ref)}`;
  const openUrl = (titleId: string) => (portal === "admin" ? `/titles/${titleId}` : `/producer/titles/${titleId}`);
  /** The list the desk is showing now: an answer for another company (the picker moved while it was in flight) is dropped, not shown under the new name. */
  const current = useRef(listUrl);

  const load = useCallback(async () => {
    const url = listUrl;
    try {
      const next = await getJson<FilmListing>(url);
      if (current.current !== url) return;
      setListing(next);
      setLoadError(null);
    } catch (e) {
      if (current.current !== url) return;
      setLoadError(e instanceof ApiRequestError ? e.message : (e as Error).message);
    }
  }, [listUrl]);

  useEffect(() => {
    current.current = listUrl;
    setListing(null);
    void load();
  }, [load, listUrl]);

  const anyRunning = useMemo(() => !!listing?.films.some((f) => running(f.progress)), [listing]);
  useEffect(() => {
    if (!anyRunning) return;
    timer.current = setTimeout(() => void load(), POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [anyRunning, listing, load]);

  async function start(film: FilmRow, mode: "import" | "update") {
    setBusy((b) => ({ ...b, [film.source_ref]: true }));
    setStartError((e) => ({ ...e, [film.source_ref]: "" }));
    try {
      const body: Record<string, unknown> = { source_ref: film.source_ref, mode, attach_transcript: attach };
      const typed = titles[film.source_ref]?.trim();
      if (mode === "import" && typed && typed !== film.display_title) body.display_title = typed;
      if (portal === "admin") body.producer_id = producerId;
      const r = await postJson<StartReply>(importUrl, body);
      if (r.error) setStartError((e) => ({ ...e, [film.source_ref]: r.error! }));
      await load();
    } catch (e) {
      setStartError((er) => ({ ...er, [film.source_ref]: (e as Error).message }));
    } finally {
      setBusy((b) => ({ ...b, [film.source_ref]: false }));
    }
  }

  const reasonText = (film: Pick<FilmRow, "reason">) => filmReasonText(tt, film.reason);
  const progressText = (p: ImportProgress) => importProgressText(tt, p);
  const resultText = (p: ImportProgress) => importResultText(tt, p);

  const statePill: Record<FilmRow["state"], string> = {
    READY: "pill-success",
    IMPORTED: "pill-neutral",
    K_CHANGED: "pill-warning",
    RENDERING: "pill-accent",
    NOT_DELIVERED: "pill-neutral",
    NO_MANIFEST: "pill-neutral",
  };

  function action(film: FilmRow) {
    const p = film.progress;
    if (running(p) || busy[film.source_ref]) {
      return <button type="button" className="btn btn-outline btn-sm" disabled><span className="spinner" /> {tt("fi.action.importing")}</button>;
    }
    const open = film.imported ? <a className="btn btn-outline btn-sm" href={openUrl(film.imported.title_id)}>{tt("fi.action.open")}</a> : null;
    if (film.state === "IMPORTED") return open;
    if (!canImport || (portal === "admin" && !producerId)) return open ?? <span className="gt-muted">—</span>;
    if (film.state === "K_CHANGED") {
      const label = film.changed.length ? tt("fi.action.update", { n: film.changed.length }) : tt("fi.action.updatePlan");
      return <button type="button" className="btn btn-primary btn-sm" onClick={() => void start(film, "update")}>{label}</button>;
    }
    if (film.state === "READY") {
      if (film.imported) return <button type="button" className="btn btn-primary btn-sm" onClick={() => void start(film, "update")}>{tt("fi.action.updatePlan")}</button>;
      return <button type="button" className="btn btn-primary btn-sm" onClick={() => void start(film, "import")}>{tt("fi.action.import")}</button>;
    }
    return open ?? <span className="gt-muted">—</span>;
  }

  /** The crazydramas cell of a row: the chip for an imported title with the way into its series check (the section, or the staff mirror), the words for what is known before that. */
  function crazydramasCell(film: FilmRow) {
    if (!film.crazydramas_slug) return <CrazydramasChip state="not_linked" context="import" locale={locale} />;
    const known = film.imported ? crazydramas[film.imported.title_id] : undefined;
    if (known && film.imported) {
      // Not on crazydramas yet (phase 5, publish spec §1): the row's way into "Upload to crazydramas" on the section (or its staff mirror).
      const notYet = NOT_ON_CRAZYDRAMAS.has(known.state);
      return (
        <span style={{ display: "grid", gap: 4, justifyItems: "start" }}>
          <CrazydramasChip {...known} locale={locale} />
          {notYet ? (
            <a className="btn btn-outline btn-sm film-import-cd-upload" style={{ whiteSpace: "nowrap" }} href={`${openUrl(film.imported.title_id)}/crazydramas#cd-publish`}>{tt("cdp.import.upload")}</a>
          ) : (
            <a className="pf-cell-link" href={`${openUrl(film.imported.title_id)}/crazydramas`}>{tt("pf.cell.crazydramas.open")}&nbsp;→</a>
          )}
        </span>
      );
    }
    return <small className="gt-muted">{tt("cd.import.slug", { slug: film.crazydramas_slug })}</small>;
  }

  const cols = "56px minmax(220px,2fr) 70px 90px 130px 70px minmax(160px,1.4fr) 190px 150px";
  // Films that can be imported, are imported or are importing get a row; the rest fold into "Not ready (n)" below.
  const rows = listing ? listing.films.filter((f) => !isNotReady(f)) : [];
  const notReady = listing ? listing.films.filter(isNotReady) : [];

  return (
    <section className="film-import" aria-label={tt("fi.title")}>
      <div className="staff-titles-filters" style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        {portal === "admin" && (
          <label className="field-row" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="label">{tt("fi.company")}</span>
            <select className="select" value={producerId} onChange={(e) => setProducerId(e.target.value)} aria-label={tt("fi.company")}>
              <option value="">{tt("fi.company.pick")}</option>
              {producers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        {canImport && (
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
            <span>{tt("fi.transcript")}</span>
          </label>
        )}
        <button type="button" className="btn btn-outline btn-sm" style={{ marginLeft: "auto" }} onClick={() => void load()}>{tt("fi.refresh")}</button>
      </div>
      {portal === "admin" && !producerId && <p className="hint">{tt("fi.company.hint")}</p>}
      {loadError && <p className="err" role="alert">{tt("fi.loadFailed", { detail: loadError })}</p>}
      {!listing && !loadError && <p className="hint" role="status">{tt("fi.loading")}</p>}
      {listing && !listing.configured && <p className="note note-info">{tt("fi.notConfigured")}</p>}
      {listing && listing.configured && listing.films.length === 0 && <p className="hint">{tt("fi.empty")}</p>}
      {listing && listing.configured && listing.films.length > 0 && rows.length === 0 && <p className="hint">{tt("fi.noneReady")}</p>}
      {listing && listing.configured && rows.length > 0 && (
        <div className="gtable film-import-table" role="region" aria-label={tt("fi.title")} tabIndex={0} style={{ "--cols": cols } as React.CSSProperties}>
          <div className="gt-head">
            <span />
            <span>{tt("fi.col.film")}</span>
            <span className="gt-num">{tt("fi.col.episodes")}</span>
            <span className="gt-num">{tt("fi.col.size")}</span>
            <span>{tt("fi.col.video")}</span>
            <span>{tt("fi.col.language")}</span>
            <span>{tt("fi.col.state")}</span>
            <span>{tt("pf.col.crazydramas")}</span>
            <span>{tt("fi.col.action")}</span>
          </div>
          {rows.map((film) => {
            const p = film.progress;
            const editable = canImport && !film.imported && film.state === "READY" && !running(p);
            const reason = reasonText(film);
            const result = p ? resultText(p) : null;
            const cover = film.imported?.cover_url ?? (film.poster_ref ? posterUrl(film.poster_ref) : null);
            return (
              <div className="gt-row" key={film.source_ref} data-source-ref={film.source_ref} data-state={film.state}>
                <span className="film-import-poster" style={{ width: 40, aspectRatio: "3 / 4", borderRadius: 4, overflow: "hidden", background: "var(--surface-3)" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- served by our own routes with a session cookie, not proxied */}
                  {cover && <img src={cover} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                </span>
                <span className="film-import-name" style={{ display: "grid", gap: 2 }}>
                  {editable ? (
                    <input
                      className="input"
                      value={titles[film.source_ref] ?? film.display_title}
                      onChange={(e) => setTitles((x) => ({ ...x, [film.source_ref]: e.target.value }))}
                      aria-label={tt("fi.titleInput")}
                      lang="en"
                    />
                  ) : (
                    <strong lang="en">{film.imported?.name ?? film.display_title}</strong>
                  )}
                  <small className="gt-muted">
                    {film.source_title ? tt("fi.sourceTitle", { name: film.source_title }) : film.folder}
                    {film.warnings.length ? <> · <span title={film.warnings.join("\n")}>{tt("fi.warnings", { n: film.warnings.length })}</span></> : null}
                  </small>
                  {p && running(p) && <small className="hint" role="status"><span className="spinner" /> {progressText(p)}</small>}
                  {result && <small className={result.error ? "err" : "hint"} role="status">{result.text}{!result.error && p?.result?.flags.length ? <> · <span title={p.result.flags.join("\n")}>{tt("fi.result.flags", { n: p.result.flags.length })}</span></> : null}</small>}
                  {startError[film.source_ref] && <small className="err" role="alert">{tt("fi.startFailed", { detail: startError[film.source_ref] })}</small>}
                </span>
                <span className="gt-num" data-label={tt("fi.col.episodes")}>{film.episodes}</span>
                <span className="gt-num" data-label={tt("fi.col.size")}>{sizeText(tt, film.bytes)}</span>
                <span className="gt-muted" data-label={tt("fi.col.video")}>{film.video ? tt("fi.video.facts", { w: film.video.width, h: film.video.height, fps: film.video.fps }) : "—"}</span>
                <span className="gt-muted" data-label={tt("fi.col.language")}>{film.language ?? "—"}</span>
                <span style={{ display: "grid", gap: 2 }}>
                  <span><span className={`pill ${statePill[film.state]}`}>{tt(`fi.state.${film.state}`)}</span></span>
                  {reason && <small className="gt-muted">{reason}</small>}
                </span>
                <span className="film-import-cd">{crazydramasCell(film)}</span>
                <span className="film-import-action">{action(film)}</span>
              </div>
            );
          })}
        </div>
      )}
      {notReady.length > 0 && (
        <details className="fi-not-ready" data-count={notReady.length}>
          <summary>{tt("fi.notReady", { n: notReady.length })} <small className="gt-muted">{tt("fi.notReady.hint")}</small></summary>
          <ul>
            {notReady.map((film) => (
              <li key={film.source_ref} data-source-ref={film.source_ref} data-state={film.state}>
                <strong lang="en">{film.display_title}</strong>
                <small className="gt-muted">{film.folder}</small>
                <span className={`pill ${statePill[film.state]}`}>{tt(`fi.state.${film.state}`)}</span>
                {reasonText(film) && <small className="gt-muted">{reasonText(film)}</small>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
