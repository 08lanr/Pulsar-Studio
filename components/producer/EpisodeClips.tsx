"use client";

// The "Ad clips" block under an episode on Materials (decision 2026-09-14):
// the derived state (cutting / n ready / failed / none), one row per clip
// with its time range, hook, moment and an inferred "why", and two fixed
// actions (Preview, Download). "Cut clips again" starts a forced run; while
// a run is going the block polls GET .../clips every 5 seconds, the same
// way the campaign page polls while generating.

import { useEffect, useState } from "react";
import { getJson, postJson } from "@/lib/api-client";
import { useT } from "@/components/locale";
import type { EpisodeClipsPayload } from "@/lib/clips/payload";

function mmss(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type Props = { titleId: string; episodeNumber: number; initial: EpisodeClipsPayload; canEdit: boolean; hasVideo: boolean; locale: "zh" | "en" };

export default function EpisodeClips({ titleId, episodeNumber, initial, canEdit, hasVideo, locale }: Props) {
  const { tt } = useT();
  const [data, setData] = useState<EpisodeClipsPayload>(initial);
  // router.refresh() re-renders the server tree but App Router keeps client
  // state, and useState ignores every value after mount — so a clip added by
  // another control (an uploaded ad) would never appear. Follow the prop.
  useEffect(() => setData(initial), [initial]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const url = `/api/producer/titles/${titleId}/episodes/${episodeNumber}/clips`;
  const cutting = data.state === "cutting";

  useEffect(() => {
    if (!cutting) return;
    const timer = setInterval(async () => {
      try { setData(await getJson<EpisodeClipsPayload>(url)); setStale(false); } catch { setStale(true); /* keep the last state; the next tick tries again */ }
    }, 5000);
    return () => clearInterval(timer);
  }, [cutting, url]);

  async function cutAgain() {
    setBusy(true); setError(null);
    try {
      const r = await postJson<{ error?: string }>(url, { force: true });
      if (r.error) throw new Error(r.error);
      setData({ ...data, state: "cutting", note: null });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  if (!hasVideo) return null;
  const ready = data.clips.filter((c) => c.render_status === "rendered");
  const pill = data.state === "ready" ? "pill-success" : data.state === "cutting" ? "pill-accent" : data.state === "failed" ? "pill-error" : "pill-neutral";
  const stateLabel = data.state === "ready" ? tt("clips.state.ready", { n: ready.length }) : tt(`clips.state.${data.state}`);

  return (
    <section className="ep-clips" aria-label={tt("clips.title")}>
      <header className="ep-clips-head">
        <strong>{tt("clips.title")}</strong>
        <span className={`pill ${pill}`} role="status">{stateLabel}</span>
        {data.state === "failed" && data.note && <span className="ep-clips-note">{data.note}</span>}
        {canEdit && <button type="button" className="btn btn-outline btn-sm" disabled={busy || cutting} onClick={cutAgain}>{busy ? tt("common.loading") : tt("clips.again")}</button>}
      </header>
      {error && <p className="err" role="alert">{error}</p>}
      {data.state === "none" && <p className="hint">{tt("clips.none.hint")}</p>}
      {data.state === "cutting" && <p className="hint">{tt("clips.cutting.hint")}{stale && <> {tt("clips.stale")}</>}</p>}
      {data.clips.length > 0 && (
        <ol className="ep-clip-list">
          {data.clips.map((c) => (
            <li className={`ep-clip ${c.render_status}`} key={c.id}>
              <span className="ep-clip-rank">{c.rank}</span>
              <div className="ep-clip-main">
                <div className="ep-clip-line">
                  {c.end_ms > c.start_ms && <span className="ep-clip-range">{mmss(c.start_ms)} – {mmss(c.end_ms)}</span>}
                  <span className="pill pill-neutral">{tt(`clips.moment.${c.moment}`)}</span>
                  {c.angle && <span className="pill pill-neutral">{tt(`angle.${c.angle}`)}</span>}
                  <span className="pill pill-neutral">{tt(`clips.source.${c.source}`)}</span>
                </div>
                {c.hook_en ? <blockquote lang="en"><span className="ep-clip-hooklabel">{tt("clips.hook")}</span> {c.hook_en}</blockquote> : <p className="ep-clip-nohook">{tt("clips.noHook")}</p>}
                <p className="ep-clip-why"><span className="ep-clip-evidence">{tt("clips.evidence.inferred")}</span> <span lang={locale === "zh" ? "zh" : "en"}>{locale === "zh" ? c.why_zh : c.why_en}</span></p>
                {c.render_status === "failed" && c.render_note && <p className="ep-clip-failed">{tt("clips.renderFailed")}: {c.render_note}</p>}
                {c.render_status === "rendered" && c.render_note && <p className="ep-clip-note">{c.render_note}</p>}
                {open[c.id] && c.download_url && <div className="ep-clip-player"><video src={c.download_url} controls preload="metadata" playsInline aria-label={tt("clips.previewLabel", { n: c.rank })} /><span>{tt("clips.previewHint")}</span></div>}
              </div>
              <span className="ep-clip-actions">
                {c.download_url ? (
                  <>
                    <button type="button" className="btn btn-outline btn-sm" aria-expanded={!!open[c.id]} onClick={() => setOpen((o) => ({ ...o, [c.id]: !o[c.id] }))}>{open[c.id] ? tt("clips.hidePreview") : tt("clips.preview")}</button>
                    <a className="btn btn-primary btn-sm" href={c.download_url} download>{tt("clips.download")}</a>
                  </>
                ) : (
                  <span className="hint">{c.render_status === "pending" ? tt("clips.state.cutting") : tt("clips.noFile")}</span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
