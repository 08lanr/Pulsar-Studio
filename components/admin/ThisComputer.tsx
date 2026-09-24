"use client";

// The "This computer" card (decision 2026-09-24, "two computers, one
// database"), on Import films and on New film run. Two people run their own
// Studio on the one live database; this card is what differs per computer:
// its name, its films folder (connect, change, disconnect), the pipeline
// beside it (download, update), whether it can cut films (each check with
// its fix, the Python packages installed by a button), and — live mode, on
// Import films — the cloud copy of the films imported here, behind this
// computer's own switch. Reads and writes /api/admin/computer; polls while a
// setup task or an upload runs. Editors read it; administrators act.

import "@/app/computer.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, postJson } from "@/lib/api-client";
import { useT } from "@/components/locale";
import type { Check, ComputerSummary } from "@/lib/computer-setup";
import { COMPUTER_CHANGED } from "./computer-events";

type Props = {
  canEdit: boolean;
  /** "all" on Import films; "cut" on New film run (no cloud section). */
  sections?: "all" | "cut";
  /** The Supabase project's ref, for the storage-settings link (public: it is in the project URL). */
  supabaseRef?: string | null;
};

const LINKS: Partial<Record<Check["key"], string>> = {
  git: "https://git-scm.com/downloads",
  python: "https://www.python.org/downloads/",
  ffmpeg: "https://ffmpeg.org/download.html",
  ffprobe: "https://ffmpeg.org/download.html",
  bash: "https://git-scm.com/downloads",
};

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

export default function ThisComputer({ canEdit, sections = "all", supabaseRef = null }: Props) {
  const { tt } = useT();
  const [data, setData] = useState<ComputerSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState("");
  const [editingFolder, setEditingFolder] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (check = false) => {
    try {
      const next = await getJson<ComputerSummary & { error?: string }>(`/api/admin/computer${check ? "?check=1" : ""}`);
      if (next.error) setError(next.error);
      else {
        setData(next);
        setError(null);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const moving = !!data && ((data.task !== null && data.task.finished_at === null) || data.cloud.running);
  useEffect(() => {
    if (!moving) return;
    timer.current = setTimeout(() => void load(), 2000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [moving, data, load]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<ComputerSummary & { error?: string }>("/api/admin/computer", body);
      if (r.error) setError(r.error);
      else {
        setData(r);
        if (body.action === "connect") setEditingFolder(false);
        if (body.action === "connect" || body.action === "disconnect") window.dispatchEvent(new Event(COMPUTER_CHANGED));
        if (body.action === "rename") setName(null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <section className="card tc" aria-label={tt("tc.title")}>
        <h2 className="section-title">{tt("tc.title")}</h2>
        {error ? <p className="err" role="alert">{error}</p> : <p className="hint" role="status">{tt("tc.loading")}</p>}
      </section>
    );
  }

  const { films, pipeline, readiness, task, cloud } = data;
  const can = canEdit && data.settings_on;
  const taskRunning = task !== null && task.finished_at === null;
  const failing = readiness.checks.filter((c) => !c.ok);
  const showFolderForm = can && (editingFolder || !films.folder);

  const checkFix = (c: Check) => {
    if (c.key === "films") return null;
    if (c.key === "pipeline" && (pipeline.state === "missing") && can) {
      return <button type="button" className="btn btn-outline btn-sm" disabled={busy || taskRunning} onClick={() => void act({ action: "pipeline_download" })}>{tt("tc.pipeline.download")}</button>;
    }
    if (c.key === "packages" && can && readiness.checks.find((x) => x.key === "python")?.ok) {
      return <button type="button" className="btn btn-outline btn-sm" disabled={busy || taskRunning} onClick={() => void act({ action: "install_packages" })}>{tt("tc.packages.install")}</button>;
    }
    const href = LINKS[c.key];
    return href ? <a className="tc-link" href={href} target="_blank" rel="noreferrer">{tt(`tc.fix.${c.key}`)}&nbsp;→</a> : null;
  };

  return (
    <section className="card tc" aria-label={tt("tc.title")} data-testid="this-computer">
      <div className="tc-head">
        <div>
          <h2 className="section-title" style={{ margin: 0 }}>{tt("tc.title")}</h2>
          <p className="hint" style={{ margin: "4px 0 0" }}>{tt("tc.sub")}</p>
        </div>
        {name === null ? (
          <div className="tc-name">
            <strong data-testid="computer-name">{data.computer.name}</strong>
            {can && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setName(data.computer.name)}>{tt("tc.rename")}</button>}
          </div>
        ) : (
          <form className="tc-name" onSubmit={(e) => { e.preventDefault(); void act({ action: "rename", name }); }}>
            <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label={tt("tc.nameLabel")} autoFocus />
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !name.trim()}>{tt("tc.save")}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setName(null)}>{tt("tc.cancel")}</button>
          </form>
        )}
      </div>

      {error && <p className="err" role="alert">{error}</p>}
      {!data.settings_on && <p className="note note-info">{tt("tc.settingsOff")}</p>}

      {/* The films folder */}
      <div className="tc-row">
        <span className="tc-label">{tt("tc.films.label")}</span>
        <div className="tc-body">
          {films.folder ? (
            <p className="tc-line">
              <code className="tc-path">{films.folder}</code>
              <span className="gt-muted">
                {films.exists ? tt("tc.films.count", { n: films.films }) : tt("tc.films.missing")}
                {" · "}
                {films.source === "computer" ? tt("tc.films.fromComputer") : tt("tc.films.fromServer")}
              </span>
              {can && !editingFolder && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setFolder(films.folder ?? ""); setEditingFolder(true); }}>{tt("tc.films.change")}</button>}
              {can && films.source === "computer" && !editingFolder && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act({ action: "disconnect" })}>{tt("tc.films.disconnect")}</button>}
            </p>
          ) : (
            <p className="tc-line gt-muted">{tt("tc.films.none")}</p>
          )}
          {showFolderForm && (
            <form className="tc-folder" onSubmit={(e) => { e.preventDefault(); void act({ action: "connect", folder }); }}>
              <input className="input" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={films.suggested} aria-label={tt("tc.films.inputLabel")} spellCheck={false} />
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !folder.trim()}>{tt("tc.films.connect")}</button>
              {!folder.trim() && <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void act({ action: "connect", folder: films.suggested })}>{tt("tc.films.useSuggested")}</button>}
              {editingFolder && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingFolder(false)}>{tt("tc.cancel")}</button>}
              <span className="hint tc-hint">{tt("tc.films.hint", { suggested: films.suggested })}</span>
            </form>
          )}
        </div>
      </div>

      {/* The pipeline */}
      <div className="tc-row">
        <span className="tc-label">{tt("tc.pipeline.label")}</span>
        <div className="tc-body">
          <p className="tc-line">
            <span>{tt(`tc.pipeline.${pipeline.state}`, { sha: pipeline.sha?.slice(0, 7) ?? "" })}</span>
            {pipeline.state !== "no_films_folder" && pipeline.state !== "missing" && <code className="tc-path">{pipeline.folder}</code>}
            {pipeline.behind ? <span className="pill pill-warning">{tt("tc.pipeline.behind", { n: pipeline.behind })}</span> : null}
            {pipeline.dirty && <span className="gt-muted">{tt("tc.pipeline.dirty")}</span>}
          </p>
          {can && (
            <div className="tc-actions">
              {pipeline.state === "missing" && <button type="button" className="btn btn-primary btn-sm" disabled={busy || taskRunning} onClick={() => void act({ action: "pipeline_download" })}>{tt("tc.pipeline.download")}</button>}
              {(pipeline.state === "ready" || pipeline.state === "no_scripts") && <button type="button" className="btn btn-outline btn-sm" disabled={busy || taskRunning || pipeline.dirty} onClick={() => void act({ action: "pipeline_update" })}>{tt("tc.pipeline.update")}</button>}
            </div>
          )}
        </div>
      </div>

      {task && (
        <div className="tc-task" role="status" data-testid="setup-task">
          <p className="tc-line">
            {taskRunning ? <span className="spinner" /> : null}
            <strong>{tt(`tc.task.${task.kind}.${taskRunning ? "running" : task.ok ? "done" : "failed"}`)}</strong>
          </p>
          {task.message && <p className="err" style={{ margin: 0 }}>{task.message}</p>}
          {taskRunning && task.lines.length > 0 && <pre className="tc-tail">{task.lines.slice(-6).join("\n")}</pre>}
        </div>
      )}

      {/* Can this computer cut films? */}
      <div className="tc-row">
        <span className="tc-label">{tt("tc.ready.label")}</span>
        <div className="tc-body">
          <p className="tc-line">
            <span className={`pill ${readiness.can_cut ? "pill-success" : "pill-warning"}`} data-testid="can-cut">{readiness.can_cut ? tt("tc.ready.yes") : tt("tc.ready.no", { n: failing.length })}</span>
            {!readiness.can_cut && <span className="gt-muted">{readiness.can_import ? tt("tc.ready.importOk") : tt("tc.ready.importNo")}</span>}
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void load(true)}>{tt("tc.ready.again")}</button>
          </p>
          {!readiness.can_cut && (
            <ul className="tc-checks">
              {readiness.checks.map((c) => (
                <li key={c.key} className={c.ok ? "ok" : "bad"} data-check={c.key}>
                  <span className="tc-mark" aria-hidden>{c.ok ? "✓" : "✗"}</span>
                  <span>{tt(c.key === "ffmpeg" && !c.ok && c.detail ? "tc.check.ffmpeg.filters" : `tc.check.${c.key}.${c.ok ? "ok" : "bad"}`, { detail: c.detail ?? "" })}</span>
                  {!c.ok && checkFix(c)}
                </li>
              ))}
            </ul>
          )}
          {!readiness.can_cut && readiness.checks.find((c) => c.key === "packages" && !c.ok) && <p className="hint tc-hint">{tt("tc.packages.hint")}</p>}
        </div>
      </div>

      {/* The cloud copy of the films imported here (live mode, Import films only) */}
      {sections === "all" && cloud.available && (
        <div className="tc-row">
          <span className="tc-label">{tt("tc.cloud.label")}</span>
          <div className="tc-body">
            <p className="tc-line">
              <span className={`pill ${cloud.on ? "pill-success" : "pill-neutral"}`} data-testid="cloud-switch">{cloud.on ? tt("tc.cloud.on") : tt("tc.cloud.off")}</span>
              {can && <button type="button" className={`btn btn-sm ${cloud.on ? "btn-ghost" : "btn-primary"}`} disabled={busy} onClick={() => void act({ action: "cloud", on: !cloud.on })}>{cloud.on ? tt("tc.cloud.turnOff") : tt("tc.cloud.turnOn")}</button>}
              {can && cloud.on && <button type="button" className="btn btn-outline btn-sm" disabled={busy || cloud.running} onClick={() => void act({ action: "cloud_sync" })}>{tt("tc.cloud.now")}</button>}
              {cloud.running && <span className="gt-muted"><span className="spinner" /> {tt("tc.cloud.running")}</span>}
            </p>
            <p className="hint tc-hint">{cloud.on ? tt("tc.cloud.hintOn") : tt("tc.cloud.hintOff")}</p>
            {cloud.error && <p className="err">{tt("tc.cloud.error", { detail: cloud.error })}</p>}
            {cloud.titles.length > 0 && (
              <ul className="tc-cloud">
                {cloud.titles.map((t) => (
                  <li key={t.title_id} data-title-id={t.title_id}>
                    <strong lang="en">{t.name}</strong>
                    <span className={t.in_cloud === t.files ? "tc-done" : "gt-muted"}>{tt("tc.cloud.count", { n: t.in_cloud, of: t.files })}</span>
                    {t.uploading && <span className="gt-muted"><span className="spinner" /> {tt("tc.cloud.uploading", { file: t.uploading })}</span>}
                    {t.waiting_here > 0 && !t.uploading && <span className="gt-muted">{cloud.on ? tt("tc.cloud.waiting", { n: t.waiting_here }) : tt("tc.cloud.waitingOff", { n: t.waiting_here })}</span>}
                    {t.elsewhere > 0 && <span className="gt-muted">{tt("tc.cloud.elsewhere", { n: t.elsewhere })}</span>}
                    {t.too_big.length > 0 && (
                      <span className="tc-warn">
                        {tt("tc.cloud.tooBig", { n: t.too_big.length, largest: mb(Math.max(...t.too_big.map((x) => x.bytes))) })}
                        {supabaseRef && <> <a className="tc-link" href={`https://supabase.com/dashboard/project/${supabaseRef}/storage/buckets`} target="_blank" rel="noreferrer">{tt("tc.cloud.openStorage")}&nbsp;→</a></>}
                      </span>
                    )}
                    {t.failed.length > 0 && <span className="err">{tt("tc.cloud.failed", { n: t.failed.length, detail: t.failed[0].message })}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
