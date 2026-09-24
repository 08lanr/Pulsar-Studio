"use client";

// "60-second ad" on a title's clips page (decision 2026-09-24,
// lib/clips/montage-run.ts): one button that picks a hook, two to four
// scenes and a cliff from the title's own clips and joins them; while it
// builds, the pieces it is joining and a poll of GET .../montage every three
// seconds; then each finished ad with Preview, Download and the way to
// Clips and Launch. The producer page (inside the Clips table, which reloads
// when an ad lands) and the staff page (/titles/[id]/clips) render it alike.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getJson, postJson } from "@/lib/api-client";
import { useT } from "@/components/locale";
import type { MontageRow, MontageStatus } from "@/lib/clips/montage-run";
import type { MontagePiece } from "@/lib/types";

const mmss = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
/** m:ss, with a tenth of a second when the edge is not on a whole second (the pieces are cut to the frame). */
const exact = (ms: number) => {
  const whole = ms % 1000 === 0;
  const s = (ms % 60000) / 1000;
  return `${Math.floor(ms / 60000)}:${whole ? String(s).padStart(2, "0") : s.toFixed(1).padStart(4, "0")}`;
};

type Props = {
  titleId: string;
  initial: MontageStatus | null;
  canBuild: boolean;
  /** Where the ads are listed and launched from: the staff desk or the producer portal. */
  staff?: boolean;
  /** Called when a new ad has landed (the producer's Clips table reloads). */
  onBuilt?: () => void;
};

type PostAnswer = { error?: string; code?: string; usable?: number; outcome?: "exists" | "started"; montage?: MontageRow; pieces?: MontagePiece[]; duration_ms?: number };

export default function AdMontage({ titleId, initial, canBuild, staff = false, onBuilt }: Props) {
  const { tt } = useT();
  const url = `/api/producer/titles/${titleId}/montage`;
  const [status, setStatus] = useState<MontageStatus | null>(initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [stale, setStale] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const building = status?.state === "building";

  const seen = useRef<number>(initial?.montages.length ?? -1);
  const load = useCallback(async () => {
    const next = await getJson<MontageStatus>(url);
    if (seen.current >= 0 && next.montages.length > seen.current) onBuilt?.();
    seen.current = next.montages.length;
    setStatus(next);
    return next;
  }, [url, onBuilt]);

  useEffect(() => { if (!initial) void load().catch(() => setStale(true)); }, [initial, load]);
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => { void load().then(() => setStale(false)).catch(() => setStale(true)); }, 3000);
    return () => clearInterval(timer);
  }, [building, load]);

  async function build() {
    setBusy(true); setMessage(null);
    try {
      const r = await postJson<PostAnswer>(url, {});
      if (r.error) {
        const text = r.code === "no_clips" || r.code === "too_few" ? tt(`montage.refused.${r.code}`, { n: r.usable ?? 0 }) : r.error;
        setMessage({ kind: "error", text });
        if (r.code === "conflict") await load().catch(() => undefined);
        return;
      }
      if (r.outcome === "exists") { setMessage({ kind: "info", text: tt("montage.exists") }); await load().catch(() => undefined); return; }
      setStatus((prev) => ({ state: "building", note: null, building: { started_at: new Date().toISOString(), pieces: r.pieces ?? [], duration_ms: r.duration_ms ?? null }, montages: prev?.montages ?? [] }));
    } catch (e) { setMessage({ kind: "error", text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  const montages = status?.montages ?? [];
  const state = status?.state ?? "none";
  const pill = state === "ready" ? "pill-success" : state === "building" ? "pill-accent" : state === "failed" ? "pill-error" : "pill-neutral";
  const stateLabel = state === "ready" ? tt("montage.state.ready", { n: montages.length }) : tt(`montage.state.${state}`);
  const clipsHref = staff ? `/clips?title=${encodeURIComponent(titleId)}` : `/producer/titles/${titleId}/clips`;
  const launchHref = staff ? "/promote/launches" : "/producer/launch";

  const pieceList = (pieces: readonly MontagePiece[]) => (
    <ol className="ad-montage-pieces" aria-label={tt("montage.pieces")}>
      {pieces.map((p, i) => (
        <li key={`${p.episode_id}-${p.start_ms}-${i}`}>
          <span className={`pill ${p.role === "scene" ? "pill-neutral" : "pill-accent"}`}>{tt(`montage.role.${p.role}`)}</span>
          <span className="ep-clip-range">{tt("montage.piece", { n: p.episode_number, from: exact(p.start_ms), to: exact(p.end_ms) })}</span>
        </li>
      ))}
    </ol>
  );

  return (
    <section className="ad-montage" aria-label={tt("montage.title")} data-montage-state={state}>
      <header className="ep-clips-head">
        <strong>{tt("montage.title")}</strong>
        <span className={`pill ${pill}`} role="status">{stateLabel}</span>
        {state === "failed" && status?.note && <span className="ep-clips-note">{status.note}</span>}
        {canBuild && <button type="button" className={`btn ${montages.length ? "btn-outline" : "btn-primary"} btn-sm`} disabled={busy || building} onClick={() => void build()}>
          {busy ? tt("common.loading") : montages.length ? tt("montage.buildAgain") : tt("montage.build")}
        </button>}
      </header>
      <p className="hint">{tt("montage.intro")}</p>
      {!canBuild && <p className="hint">{tt("montage.cannotBuild")}</p>}
      {message && <p className={message.kind === "error" ? "err" : "hint"} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
      {state === "none" && !message && <p className="hint">{tt("montage.none.hint")}</p>}
      {building && status?.building && (
        <div className="ad-montage-building">
          <p className="hint">{tt("montage.building.hint", { n: status.building.pieces.length, length: status.building.duration_ms ? mmss(status.building.duration_ms) : "—" })}{stale && <> {tt("clips.stale")}</>}</p>
          {pieceList(status.building.pieces)}
        </div>
      )}
      {montages.length > 0 && (
        <ol className="ep-clip-list">
          {montages.map((m) => (
            <li className="ep-clip rendered ad-montage-row" key={m.id} data-montage-id={m.id}>
              <span className="ep-clip-rank">{mmss(m.duration_ms ?? 0)}</span>
              <div className="ep-clip-main">
                <div className="ep-clip-line">
                  <span className="pill pill-accent">{tt("montage.pill")}</span>
                  <span className="ep-clip-range">{tt("montage.episodes", { list: m.episodes_label })}</span>
                  <span className="pill pill-neutral">{tt(`clips.source.${m.source}`)}</span>
                </div>
                {m.hook_en ? <blockquote lang="en"><span className="ep-clip-hooklabel">{tt("clips.hook")}</span> {m.hook_en}</blockquote> : <p className="ep-clip-nohook">{tt("clips.noHook")}</p>}
                {m.render_note && <p className="ep-clip-note">{m.render_note}</p>}
                {m.pieces && pieceList(m.pieces)}
                {open[m.id] && m.download_url && <div className="ep-clip-player"><video src={m.download_url} controls preload="metadata" playsInline aria-label={tt("montage.previewLabel")} /><span>{tt("clips.previewHint")}</span></div>}
              </div>
              <span className="ep-clip-actions ad-montage-actions">
                {m.download_url && <>
                  <button type="button" className="btn btn-outline btn-sm" aria-expanded={!!open[m.id]} onClick={() => setOpen((o) => ({ ...o, [m.id]: !o[m.id] }))}>{open[m.id] ? tt("clips.hidePreview") : tt("clips.preview")}</button>
                  <a className="btn btn-primary btn-sm" href={m.download_url} download>{tt("clips.download")}</a>
                </>}
                <Link className="btn btn-outline btn-sm" href={launchHref}>{tt("montage.useInLaunch")}</Link>
                {staff && <Link className="btn btn-outline btn-sm" href={clipsHref}>{tt("montage.openClips")}</Link>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
