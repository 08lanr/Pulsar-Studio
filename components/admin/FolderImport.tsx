"use client";

// "Upload by folder" (decision 2026-09-24): the staff import desk's second
// way in. Choose a folder of finished episodes on this computer (ep1.mp4 …
// epN.mp4) in the system's folder dialog — or paste its address — check it — the episodes, the size, what
// stands in the way — name the title, and import; the card polls the
// import's progress and ends on "Upload to CrazyDramas" for the title. Admin
// only, like the route: the folder is a path on the server's own disk.

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, getJson, postJson } from "@/lib/api-client";
import { useT } from "@/components/locale";
import type { FolderImportProgress, FolderScan } from "@/lib/film-import/folder";

type Props = {
  canImport: boolean;
  producers: { id: string; name: string }[];
};

type Info = {
  scan: FolderScan;
  title: { id: string; external_id: string; name: string | null; crazydramas_slug: string | null } | null;
  progress: FolderImportProgress | null;
};

type StartReply = { title_id?: string; error?: string };
type PickReply = { folder?: string | null; error?: string };

const POLL_MS = 2000;

function running(p: FolderImportProgress | null | undefined): boolean {
  return !!p && p.step !== "done" && p.step !== "failed";
}

export default function FolderImport({ canImport, producers }: Props) {
  const { tt } = useT();
  const [producerId, setProducerId] = useState<string>(producers[0]?.id ?? "");
  const [folder, setFolder] = useState("");
  const [name, setName] = useState("");
  const [info, setInfo] = useState<Info | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const url = useCallback(
    (f: string) => `/api/admin/films/folder?folder=${encodeURIComponent(f)}${producerId ? `&producer_id=${encodeURIComponent(producerId)}` : ""}`,
    [producerId],
  );

  const read = useCallback(
    async (f: string, first: boolean) => {
      if (first) {
        setChecking(true);
        setError(null);
      }
      try {
        const next = await getJson<Info>(url(f));
        setInfo(next);
        if (first) setName(next.title?.name ?? next.scan.name);
      } catch (e) {
        if (first) {
          setInfo(null);
          setError(e instanceof ApiRequestError ? e.message : (e as Error).message);
        }
      } finally {
        if (first) setChecking(false);
      }
    },
    [url],
  );

  // While an import runs, the card follows it.
  useEffect(() => {
    if (!info || !running(info.progress)) return;
    timer.current = setTimeout(() => void read(info.scan.folder, false), POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [info, read]);

  // Another company changes whose title the folder would become: check again.
  useEffect(() => {
    if (info) void read(info.scan.folder, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the company changes
  }, [producerId]);

  // The system's folder dialog opens on this computer (the server's); the
  // chosen folder is checked at once. Cancel leaves everything as it was.
  async function choose() {
    setPicking(true);
    setError(null);
    try {
      const r = await postJson<PickReply>("/api/admin/films/folder/pick", { start: folder.trim() || null });
      if (r.error) setError(r.error);
      else if (r.folder) {
        setFolder(r.folder);
        await read(r.folder, true);
      }
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : (e as Error).message);
    } finally {
      setPicking(false);
    }
  }

  async function start() {
    if (!info) return;
    setBusy(true);
    setStartError(null);
    try {
      const r = await postJson<StartReply>("/api/admin/films/folder", { folder: info.scan.folder, display_title: name.trim() || null, producer_id: producerId });
      if (r.error) setStartError(r.error);
      await read(info.scan.folder, false);
    } catch (e) {
      setStartError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const size = (bytes: number) => (bytes >= 1024 ** 3 ? tt("fi.size.gb", { n: (bytes / 1024 ** 3).toFixed(2) }) : tt("fi.size.mb", { n: Math.max(1, Math.round(bytes / 1024 ** 2)) }));
  const p = info?.progress ?? null;
  const scan = info?.scan ?? null;
  const importable = !!scan && scan.problems.length === 0;
  const titleId = p?.title_id || info?.title?.id || null;

  return (
    <section className="card folder-import" id="folder" aria-label={tt("fo.title")} style={{ marginBottom: 20 }}>
      <div style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{tt("fo.title")}</h2>
        <p className="page-sub" style={{ margin: "4px 0 0" }}>{tt("fo.sub")}</p>
      </div>
      {!canImport ? (
        <p className="hint">{tt("fo.adminOnly")}</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
            <label className="field-row" style={{ display: "grid", gap: 4 }}>
              <span className="label">{tt("fi.company")}</span>
              <select className="select" value={producerId} onChange={(e) => setProducerId(e.target.value)} aria-label={tt("fi.company")}>
                <option value="">{tt("fi.company.pick")}</option>
                {producers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
            <button type="button" className="btn btn-primary" disabled={picking || checking} onClick={() => void choose()}>
              {picking ? <><span className="spinner" /> {tt("fo.picking")}</> : tt("fo.choose")}
            </button>
            <label className="field-row" style={{ display: "grid", gap: 4, flex: "1 1 360px", minWidth: 0 }}>
              <span className="label">{tt("fo.folder")}</span>
              <input
                className="input"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && folder.trim()) void read(folder, true);
                }}
                placeholder={tt("fo.folder.placeholder")}
                aria-label={tt("fo.folder")}
                spellCheck={false}
              />
            </label>
            <button type="button" className="btn btn-outline" disabled={!folder.trim() || checking} onClick={() => void read(folder, true)}>
              {checking ? <><span className="spinner" /> {tt("fo.checking")}</> : tt("fo.check")}
            </button>
          </div>
          {picking && <p className="hint" role="status" style={{ marginTop: 8 }}>{tt("fo.picking.hint")}</p>}
          {error && <p className="err" role="alert" style={{ marginTop: 8 }}>{tt("fo.checkFailed", { detail: error })}</p>}
          {scan && (
            <div className="folder-import-result" style={{ display: "grid", gap: 8, marginTop: 12 }}>
              <p style={{ margin: 0 }}>
                <strong lang="en">{scan.folder}</strong>
                <br />
                <span className="gt-muted">{scan.episodes.length ? tt("fo.found", { n: scan.episodes.length, size: size(scan.bytes) }) : null}</span>
              </p>
              {scan.problems.length > 0 && (
                <div className="note note-warn" role="alert">
                  <strong>{tt("fo.problems")}</strong>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{scan.problems.map((x) => <li key={x} lang="en">{x}</li>)}</ul>
                </div>
              )}
              {scan.ignored.length > 0 && <small className="gt-muted">{tt("fo.ignored", { n: scan.ignored.length, files: scan.ignored.slice(0, 6).join(", ") })}</small>}
              {importable && <small className="gt-muted">{scan.poster ? tt("fo.poster", { file: scan.poster }) : tt("fo.noPoster")}</small>}
              {info?.title && <small className="hint">{tt("fo.existing", { name: info.title.name ?? info.title.external_id })}</small>}
              {importable && (
                <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
                  <label className="field-row" style={{ display: "grid", gap: 4, flex: "1 1 280px", minWidth: 0 }}>
                    <span className="label">{tt("fo.name")}</span>
                    <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label={tt("fo.name")} lang="en" disabled={running(p)} />
                  </label>
                  {running(p) || busy ? (
                    <button type="button" className="btn btn-primary" disabled><span className="spinner" /> {tt("fi.action.importing")}</button>
                  ) : (
                    <button type="button" className="btn btn-primary" disabled={!producerId || !name.trim()} onClick={() => void start()}>
                      {info?.title ? tt("fo.update", { n: scan.episodes.length }) : tt("fo.import", { n: scan.episodes.length })}
                    </button>
                  )}
                </div>
              )}
              {!producerId && importable && <p className="hint" style={{ margin: 0 }}>{tt("fi.company.hint")}</p>}
              {p && running(p) && (
                <p className="hint" role="status" style={{ margin: 0 }}>
                  <span className="spinner" /> {p.step === "copy" && p.episode ? tt("fo.running", { n: p.episode, total: p.total }) : tt("fo.finishing")}
                </p>
              )}
              {p?.step === "failed" && p.error && <p className="err" role="alert" style={{ margin: 0 }}>{tt("fo.failed", { detail: p.error })}</p>}
              {startError && <p className="err" role="alert" style={{ margin: 0 }}>{tt("fo.startFailed", { detail: startError })}</p>}
              {p?.step === "done" && (
                <p className="hint" role="status" style={{ margin: 0 }}>
                  {tt("fo.done", { added: p.counts.added, updated: p.counts.updated, unchanged: p.counts.unchanged })}
                  {p.warnings.length ? <> · <span title={p.warnings.join("\n")}>{tt("fo.warnings", { n: p.warnings.length })}</span></> : null}
                </p>
              )}
              {p?.step === "done" && titleId && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <a className="btn btn-primary btn-sm" href={`/titles/${titleId}/crazydramas#cd-publish`}>{tt("fo.upload")}</a>
                  <a className="btn btn-outline btn-sm" href={`/titles/${titleId}`}>{tt("fo.open")}</a>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
