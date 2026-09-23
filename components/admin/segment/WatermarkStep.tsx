"use client";

// The watermark decision (plan B2 stage 1): the detector's evidence strip
// (`watermark-found.png`, four scenes with the box drawn) and the temporal
// median beside it, the measured box in source pixels, and three answers —
// accept the box, re-detect inside a region drawn over the median image
// (typed in source pixels, sent as fractions of the frame, which is what
// `watermark.py --region` takes), or "no logo" (the render then runs
// `--no-delogo`). The README's rule is LOOK before trusting a box; this
// screen is where the looking happens.

import { useState } from "react";
import { useT } from "@/components/locale";
import type { WatermarkDecision, WatermarkJson } from "@/lib/segment/api-types";

type Props = {
  view: WatermarkJson | null;
  busy: boolean;
  onDecide: (decision: WatermarkDecision) => void;
};

type Box = { x: number; y: number; w: number; h: number };

function boxStyle(box: Box, video: { w: number; h: number }): React.CSSProperties {
  return {
    left: `${(box.x / video.w) * 100}%`,
    top: `${(box.y / video.h) * 100}%`,
    width: `${(box.w / video.w) * 100}%`,
    height: `${(box.h / video.h) * 100}%`,
  };
}

/** The evidence URL of one of the two images, by its file name. */
function imageUrl(view: WatermarkJson, name: string): string | null {
  const i = view.images.findIndex((rel) => rel.endsWith(name));
  return i >= 0 ? view.image_urls[i] ?? null : null;
}

/** Source pixels → fractions of the frame, 4 decimals, as the route wants them. */
export function regionFractions(box: Box, video: { w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return { x: r(box.x / video.w), y: r(box.y / video.h), w: r(box.w / video.w), h: r(box.h / video.h) };
}

export default function WatermarkStep({ view, busy, onDecide }: Props) {
  const { tt } = useT();
  const [redraw, setRedraw] = useState(false);
  const [region, setRegion] = useState<Box>(() => view?.box ?? { x: 0, y: 0, w: 200, h: 200 });
  const video = view?.video ?? null;
  const regionOk = region.w > 0 && region.h > 0 && !!video && region.x + region.w <= video.w && region.y + region.h <= video.h;
  const found = view ? imageUrl(view, "watermark-found.png") : null;
  const median = view ? imageUrl(view, "watermark-median.png") : null;

  function set(k: keyof Box, v: string) {
    const n = Math.max(0, Math.floor(Number(v) || 0));
    setRegion((r) => ({ ...r, [k]: n }));
  }

  if (!view || (!view.box && !found && !median)) {
    return <p className="hint" role="status"><span className="spinner" /> {tt("seg.wm.detecting")}</p>;
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <p className="hint">{tt("seg.wm.look")}</p>
      <div className="sgm-wm-images">
        {found && (
          <figure className="sgm-wm-figure">
            <span className="sgm-wm-frame">
              {/* eslint-disable-next-line @next/next/no-img-element -- evidence served by our own route */}
              <img src={found} alt={tt("seg.wm.foundAlt")} />
            </span>
            <figcaption>{tt("seg.wm.found")}</figcaption>
          </figure>
        )}
        {median && (
          <figure className="sgm-wm-figure">
            <span className="sgm-wm-frame">
              {/* eslint-disable-next-line @next/next/no-img-element -- evidence served by our own route */}
              <img src={median} alt={tt("seg.wm.medianAlt")} />
              {video && view.box && !redraw && <span className="sgm-wm-box" style={boxStyle(view.box, video)} aria-hidden />}
              {video && redraw && regionOk && <span className="sgm-wm-box" style={boxStyle(region, video)} aria-hidden />}
            </span>
            <figcaption>{tt("seg.wm.median")}</figcaption>
          </figure>
        )}
      </div>
      <div className="def-row">
        <span className="k">{tt("seg.wm.box")}</span>
        <span className="v">{view.box ? `x ${view.box.x} · y ${view.box.y} · w ${view.box.w} · h ${view.box.h}${video ? ` (${video.w}×${video.h})` : ""}${view.parts ? ` · ${tt("seg.wm.parts", { n: view.parts })}` : ""}` : tt("seg.wm.noBox")}</span>
      </div>
      {view.unmark?.fit ? <p className="hint">{tt("seg.wm.unmarkFit")}</p> : null}
      {redraw && (
        <div className="sgm-move">
          <span className="label" style={{ margin: 0 }}>{tt("seg.wm.regionLabel")}</span>
          <div className="sgm-region-form">
            {(["x", "y", "w", "h"] as (keyof Box)[]).map((k) => (
              <label key={k}>
                <span className="hint" style={{ margin: 0 }}>{k}</span>
                <input className="input" type="number" min={0} value={region[k]} onChange={(e) => set(k, e.target.value)} aria-label={tt(`seg.wm.${k}`)} />
              </label>
            ))}
          </div>
          {!regionOk && <p className="err">{video ? tt("seg.wm.regionBad") : tt("seg.wm.noVideoSize")}</p>}
          <div className="sgm-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !regionOk || !video} onClick={() => video && onDecide({ kind: "watermark", region: regionFractions(region, video) })}>{tt("seg.wm.redetect")}</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRedraw(false)}>{tt("seg.cancel")}</button>
          </div>
        </div>
      )}
      {!redraw && (
        <div className="sgm-actions">
          <button type="button" className="btn btn-primary" disabled={busy || !view.box} onClick={() => onDecide({ kind: "watermark", accept: true })}>{tt("seg.wm.accept")}</button>
          <button type="button" className="btn btn-outline" disabled={busy || !video} onClick={() => setRedraw(true)}>{tt("seg.wm.redraw")}</button>
          <button type="button" className="btn btn-outline" disabled={busy} onClick={() => onDecide({ kind: "watermark", no_delogo: true })}>{tt("seg.wm.noLogo")}</button>
        </div>
      )}
    </div>
  );
}
