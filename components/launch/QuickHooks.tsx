"use client";

// "Quick hook ads" on a title's clips page (decision 2026-10-01,
// lib/clips/quick-hook-run.ts): up to three lines of text to draw on the
// picture (offered from the clips' own opening text and hooks, editable),
// one button that makes every bait × body × text, a poll of
// GET .../quick-hooks every three seconds while it builds, then each finished
// variant with its code (H2-B1-X3: which bait, body and text), Preview,
// Download and the way to Launch. The producer page (inside the Clips table,
// which reloads when a variant lands) and the staff page render it alike.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getJson, postJson } from "@/lib/api-client";
import { useT } from "@/components/locale";
import { OVERLAY_MAX_CHARS, QUICK_HOOK_DEFAULTS, overlayIssue } from "@/lib/clips/quick-hook";
import type { QuickHookStatus } from "@/lib/clips/quick-hook-run";

const mmss = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const exact = (ms: number) => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(1).padStart(4, "0")}`;

type Props = {
  titleId: string;
  initial: QuickHookStatus | null;
  canBuild: boolean;
  staff?: boolean;
  /** Called when a new variant has landed (the producer's Clips table reloads). */
  onBuilt?: () => void;
};

type PostAnswer = { error?: string; code?: string; usable?: number; outcome?: "exists" | "started"; total?: number; codes?: string[]; count?: number };

export default function QuickHooks({ titleId, initial, canBuild, staff = false, onBuilt }: Props) {
  const { tt } = useT();
  const url = `/api/producer/titles/${titleId}/quick-hooks`;
  const [status, setStatus] = useState<QuickHookStatus | null>(initial);
  const [texts, setTexts] = useState<string[]>(() => {
    const s = initial?.suggestions ?? [];
    return Array.from({ length: QUICK_HOOK_DEFAULTS.textsMax }, (_, i) => s[i] ?? "");
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [stale, setStale] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const building = status?.state === "building";

  const seen = useRef<number>(initial?.ads.length ?? -1);
  const load = useCallback(async () => {
    const next = await getJson<QuickHookStatus>(url);
    if (seen.current >= 0 && next.ads.length > seen.current) onBuilt?.();
    seen.current = next.ads.length;
    setStatus(next);
    return next;
  }, [url, onBuilt]);

  useEffect(() => {
    if (initial) return;
    void load().then((s) => setTexts((t) => (t.some(Boolean) ? t : Array.from({ length: QUICK_HOOK_DEFAULTS.textsMax }, (_, i) => s.suggestions[i] ?? "")))).catch(() => setStale(true));
  }, [initial, load]);
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => { void load().then(() => setStale(false)).catch(() => setStale(true)); }, 3000);
    return () => clearInterval(timer);
  }, [building, load]);

  const written = texts.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
  const issues = texts.map((t) => (t.trim() ? overlayIssue(t) : null));
  const ready = written.length > 0 && issues.every((i) => !i);

  async function build() {
    setBusy(true); setMessage(null);
    try {
      const r = await postJson<PostAnswer>(url, { texts: written });
      if (r.error) {
        const text = r.code === "no_clips" || r.code === "too_few" || r.code === "no_text" ? tt(`quickHook.refused.${r.code}`, { n: r.usable ?? 0 }) : r.error;
        setMessage({ kind: "error", text });
        if (r.code === "conflict") await load().catch(() => undefined);
        return;
      }
      if (r.outcome === "exists") { setMessage({ kind: "info", text: tt("quickHook.exists", { n: r.count ?? 0 }) }); await load().catch(() => undefined); return; }
      setStatus((prev) => ({ state: "building", note: null, note_code: null, building: { started_at: new Date().toISOString(), total: r.total ?? 0, done: 0, codes: r.codes ?? [] }, suggestions: prev?.suggestions ?? [], ads: prev?.ads ?? [] }));
    } catch (e) { setMessage({ kind: "error", text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  const ads = status?.ads ?? [];
  const state = status?.state ?? "none";
  const pill = state === "ready" ? "pill-success" : state === "building" ? "pill-accent" : state === "failed" ? "pill-error" : "pill-neutral";
  const stateLabel = state === "ready" ? tt("quickHook.state.ready", { n: ads.length }) : tt(`quickHook.state.${state}`);
  const launchHref = staff ? "/promote/launches" : "/producer/launch";

  return (
    <section className="ad-montage quick-hooks" aria-label={tt("quickHook.title")} data-quick-hook-state={state}>
      <header className="ep-clips-head">
        <strong>{tt("quickHook.title")}</strong>
        <span className={`pill ${pill}`} role="status">{stateLabel}</span>
        {state === "failed" && status?.note && <span className="ep-clips-note">{status.note_code ? tt(`quickHook.failed.${status.note_code}`) : status.note}</span>}
      </header>
      <p className="hint">{tt("quickHook.intro")}</p>
      {!canBuild && <p className="hint">{tt("quickHook.cannotBuild")}</p>}
      {canBuild && (
        <div className="quick-hook-texts">
          {texts.map((t, i) => (
            <label key={i} className="quick-hook-text">
              <span>{tt("quickHook.textLabel", { n: i + 1 })}</span>
              <input className="input" type="text" lang="en" value={t} maxLength={OVERLAY_MAX_CHARS + 20} placeholder={tt(i === 0 ? "quickHook.textPlaceholder" : "quickHook.textOptional")}
                onChange={(e) => { const v = e.target.value; setTexts((all) => all.map((x, j) => (j === i ? v : x))); }} aria-invalid={!!issues[i]} />
              {issues[i] && <small className="err">{tt("quickHook.textIssue", { max: OVERLAY_MAX_CHARS })}</small>}
            </label>
          ))}
          <div className="quick-hook-actions">
            <button type="button" className={`btn ${ads.length ? "btn-outline" : "btn-primary"} btn-sm`} disabled={busy || building || !ready} onClick={() => void build()}>
              {busy ? tt("common.loading") : tt("quickHook.build")}
            </button>
            <span className="hint">{tt("quickHook.buildHint", { max: QUICK_HOOK_DEFAULTS.variantsMax })}</span>
          </div>
        </div>
      )}
      {message && <p className={message.kind === "error" ? "err" : "hint"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
      {building && status?.building && (
        <p className="hint">{tt("quickHook.building.hint", { done: status.building.done, total: status.building.total })}{stale && <> {tt("clips.stale")}</>}</p>
      )}
      {ads.length > 0 && (
        <ol className="ep-clip-list">
          {ads.map((a) => (
            <li className="ep-clip rendered ad-montage-row" key={a.id} data-quick-hook-id={a.id} data-quick-hook-code={a.code ?? ""}>
              <span className="ep-clip-rank">{mmss(a.duration_ms ?? 0)}</span>
              <div className="ep-clip-main">
                <div className="ep-clip-line">
                  <span className="pill pill-accent">{a.code ?? tt("quickHook.pill")}</span>
                  <span className="ep-clip-range">{tt("montage.episodes", { list: a.episodes_label })}</span>
                  <span className="pill pill-neutral">{tt(`clips.source.${a.source}`)}</span>
                </div>
                {a.opening_text_en && <blockquote lang="en"><span className="ep-clip-hooklabel">{tt("quickHook.onScreen")}</span> {a.opening_text_en}</blockquote>}
                {a.hook_en && <p className="hint" lang="en"><span className="ep-clip-hooklabel">{tt("quickHook.adText")}</span> {a.hook_en}</p>}
                {a.pieces && <ol className="ad-montage-pieces" aria-label={tt("montage.pieces")}>
                  {a.pieces.map((p, i) => (
                    <li key={`${p.episode_id}-${p.start_ms}-${i}`}>
                      <span className={`pill ${p.role === "hook" ? "pill-accent" : "pill-neutral"}`}>{tt(p.role === "hook" ? "quickHook.role.bait" : "quickHook.role.body")}</span>
                      <span className="ep-clip-range">{tt("montage.piece", { n: p.episode_number, from: exact(p.start_ms), to: exact(p.end_ms) })}</span>
                    </li>
                  ))}
                </ol>}
                {open[a.id] && a.download_url && <div className="ep-clip-player"><video src={a.download_url} controls preload="metadata" playsInline aria-label={tt("quickHook.previewLabel")} /><span>{tt("clips.previewHint")}</span></div>}
              </div>
              <span className="ep-clip-actions ad-montage-actions">
                {a.download_url && <>
                  <button type="button" className="btn btn-outline btn-sm" aria-expanded={!!open[a.id]} onClick={() => setOpen((o) => ({ ...o, [a.id]: !o[a.id] }))}>{open[a.id] ? tt("clips.hidePreview") : tt("clips.preview")}</button>
                  <a className="btn btn-primary btn-sm" href={a.download_url} download>{tt("clips.download")}</a>
                </>}
                <Link className="btn btn-outline btn-sm" href={launchHref}>{tt("montage.useInLaunch")}</Link>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
