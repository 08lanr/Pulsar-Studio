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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, getJson, postJson } from "@/lib/api-client";
import { useT } from "@/components/locale";
import type { FilmListing, FilmRow, ImportProgress, ImportStarted } from "@/lib/film-import/import";

type Props = {
  /** Which routes and title links to use. */
  portal: "producer" | "admin";
  canImport: boolean;
  /** Staff: the companies to import for. */
  producers?: { id: string; name: string }[];
};

type StartReply = Partial<ImportStarted> & { error?: string; code?: string };

const POLL_MS = 2000;

function running(p: ImportProgress | null): boolean {
  return !!p && p.step !== "done" && p.step !== "failed";
}

function sizeText(tt: (k: string, v?: Record<string, string | number>) => string, bytes: number): string {
  if (bytes >= 1024 ** 3) return tt("fi.size.gb", { n: (bytes / 1024 ** 3).toFixed(2) });
  return tt("fi.size.mb", { n: Math.max(1, Math.round(bytes / 1024 ** 2)) });
}

export default function FilmImport({ portal, canImport, producers = [] }: Props) {
  const { tt } = useT();
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

  const load = useCallback(async () => {
    try {
      const next = await getJson<FilmListing>(listUrl);
      setListing(next);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof ApiRequestError ? e.message : (e as Error).message);
    }
  }, [listUrl]);

  useEffect(() => {
    setListing(null);
    void load();
  }, [load]);

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

  function reasonText(film: FilmRow): string | null {
    const r = film.reason;
    if (!r) return null;
    switch (r.code) {
      case "bad_delivered":
        return tt("fi.reason.bad_delivered", { file: r.file, detail: r.detail });
      case "part_file":
        return tt("fi.reason.part_file", { file: r.file });
      case "recent_write":
        return tt("fi.reason.recent_write", { file: r.file, seconds: r.seconds_ago });
      case "episode_gap":
        return tt("fi.reason.episode_gap", { missing: r.missing.join(", ") || "—" });
      case "count_mismatch":
        return tt("fi.reason.count_mismatch", { planned: r.planned, found: r.found });
      case "placeholder":
        return tt("fi.reason.placeholder", { file: r.file });
      case "files_changed":
        return tt("fi.reason.files_changed", { n: r.episodes.length, episodes: r.episodes.join(", ") });
      default:
        return tt(`fi.reason.${r.code}`);
    }
  }

  function progressText(p: ImportProgress): string {
    switch (p.step) {
      case "episodes":
        return tt("fi.progress.episodes", { n: p.episode ?? 0, total: p.total, what: tt(`fi.progress.what.${p.what ?? "link"}`) });
      case "transcripts":
        return tt("fi.progress.transcripts", { n: p.episode ?? 0, total: p.total });
      case "done":
      case "failed":
        return "";
      default:
        return tt(`fi.progress.${p.step}`);
    }
  }

  function resultText(p: ImportProgress): { text: string; error: boolean } | null {
    if (p.step === "failed") return { text: tt("fi.result.failed", { detail: p.error ?? "" }), error: true };
    if (p.step === "done" && p.result) {
      const c = p.result.counts;
      const parts = [tt("fi.result.done", { added: c.added, updated: c.updated, unchanged: c.unchanged, flagged: c.flagged })];
      if (c.transcripts) parts.push(tt("fi.result.transcripts", { n: c.transcripts }));
      if (p.result.changed_during_import) parts.push(tt("fi.result.changed"));
      return { text: parts.join(" "), error: false };
    }
    return null;
  }

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

  const cols = "56px minmax(220px,2fr) 70px 90px 130px 70px minmax(160px,1.4fr) 150px";

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
        <span className="spacer" />
        <button type="button" className="btn btn-outline btn-sm" onClick={() => void load()}>{tt("fi.refresh")}</button>
      </div>
      {portal === "admin" && !producerId && <p className="hint">{tt("fi.company.hint")}</p>}
      {loadError && <p className="err" role="alert">{tt("fi.loadFailed", { detail: loadError })}</p>}
      {!listing && !loadError && <p className="hint" role="status">{tt("fi.loading")}</p>}
      {listing && !listing.configured && <p className="note note-info">{tt("fi.notConfigured")}</p>}
      {listing && listing.configured && listing.films.length === 0 && <p className="hint">{tt("fi.empty")}</p>}
      {listing && listing.configured && listing.films.length > 0 && (
        <div className="gtable film-import-table" role="region" aria-label={tt("fi.title")} tabIndex={0} style={{ "--cols": cols } as React.CSSProperties}>
          <div className="gt-head">
            <span />
            <span>{tt("fi.col.film")}</span>
            <span>{tt("fi.col.episodes")}</span>
            <span>{tt("fi.col.size")}</span>
            <span>{tt("fi.col.video")}</span>
            <span>{tt("fi.col.language")}</span>
            <span>{tt("fi.col.state")}</span>
            <span>{tt("fi.col.action")}</span>
          </div>
          {listing.films.map((film) => {
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
                <span className="gt-num">{film.episodes}</span>
                <span className="gt-num">{sizeText(tt, film.bytes)}</span>
                <span className="gt-muted">{film.video ? tt("fi.video.facts", { w: film.video.width, h: film.video.height, fps: film.video.fps }) : "—"}</span>
                <span className="gt-muted">{film.language ?? "—"}</span>
                <span style={{ display: "grid", gap: 2 }}>
                  <span><span className={`pill ${statePill[film.state]}`}>{tt(`fi.state.${film.state}`)}</span></span>
                  {reason && <small className="gt-muted">{reason}</small>}
                </span>
                <span className="film-import-action">{action(film)}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
