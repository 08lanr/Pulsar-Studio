// The player region: the video (native controls hidden, our own bar) or,
// with no video attached, the same frame carrying an empty state — the
// time display still follows line clicks because the timecodes drive the
// script whether or not footage exists. Under the frame: the current
// scene's context in both languages, the scene counter and the per-scene
// staff status control. The <video> ref is owned by the Workbench so line
// clicks and the space key can seek and toggle from outside.

"use client";

import { useState, type RefObject } from "react";
import type { Scene, SceneStatus } from "@/lib/types";
import { useT } from "@/components/locale";
import { IconCheck, IconEdit, IconPause, IconPlay } from "./icons";
import { fmtTc } from "./util";

export function Player({
  videoRef,
  videoUrl,
  currentMs,
  durationMs,
  playing,
  onTogglePlay,
  onSeek,
  sceneMarks,
  scene,
  sceneIndex,
  sceneTotal,
  frozen,
  busy,
  canMarkReady,
  readyWhy,
  onSceneStatus,
}: {
  videoRef: RefObject<HTMLVideoElement>;
  videoUrl: string | null;
  currentMs: number;
  durationMs: number | null;
  playing: boolean;
  onTogglePlay: () => void;
  onSeek: (ms: number) => void;
  /** Scene starts, for the scrubber marks. */
  sceneMarks: number[];
  scene: Scene | null;
  sceneIndex: number;
  sceneTotal: number;
  frozen: boolean;
  busy: boolean;
  canMarkReady: boolean;
  readyWhy: string | null;
  onSceneStatus: (sceneId: string, status: SceneStatus) => void;
}) {
  const { tt } = useT();
  const [ctxOpen, setCtxOpen] = useState(false);
  const pos = durationMs && durationMs > 0 ? Math.min(100, (currentMs / durationMs) * 100) : 0;

  function scrubClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!durationMs) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    onSeek(Math.round(frac * durationMs));
  }

  return (
    <div className="player player--vertical">
      <div className="player-frame">
        {videoUrl ? (
          <>
            <video ref={videoRef} src={videoUrl} playsInline preload="metadata" />
            {!playing && (
              <button type="button" className="player-play" onClick={onTogglePlay} aria-label={tt("wb.player.play")}>
                <IconPlay size={20} />
              </button>
            )}
          </>
        ) : (
          <div className="empty">
            <div className="empty-art">
              <IconPlay size={24} />
            </div>
            <p>{tt("wb.player.noVideo")}</p>
          </div>
        )}
      </div>
      <div className="player-bar">
        <button
          type="button"
          className="icon-btn"
          onClick={onTogglePlay}
          disabled={!videoUrl}
          aria-label={playing ? tt("wb.player.pause") : tt("wb.player.play")}
        >
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        {/* --pos is the one genuinely dynamic value here; the class draws the fill from it. */}
        <div
          className="player-scrub"
          style={{ ["--pos" as string]: `${pos}%` }}
          onClick={scrubClick}
          role="slider"
          aria-valuemin={0}
          aria-valuemax={durationMs ?? 0}
          aria-valuenow={currentMs}
          aria-label={tt("wb.player.scrub")}
        >
          <span />
          {durationMs
            ? sceneMarks.map((ms) => (
                <i key={ms} className="mark" style={{ ["--at" as string]: `${(ms / durationMs) * 100}%` }} />
              ))
            : null}
        </div>
        <span className="player-time">
          <b>{fmtTc(currentMs)}</b> / {fmtTc(durationMs)}
        </span>
      </div>
      <div className="player-ctx">
        <span className="k">
          {scene ? tt("wb.scene.counter", { n: sceneIndex + 1, total: sceneTotal }) : tt("wb.scene.none")}
        </span>
        {scene && (
          <>
            <div className={ctxOpen ? "context open" : "context"}>
              {scene.context_zh && (
                <p className="context-body bilingual-zh" lang="zh-CN">
                  {scene.context_zh}
                </p>
              )}
              {scene.context_en && (
                <p className="context-body bilingual-en" lang="en">
                  {scene.context_en}
                </p>
              )}
              {!scene.context_zh && !scene.context_en && (
                <p className="context-body">{tt("wb.context.none")}</p>
              )}
              {(scene.context_zh || scene.context_en) && (
                <button type="button" className="context-more" onClick={() => setCtxOpen((v) => !v)}>
                  {ctxOpen ? tt("wb.context.less") : tt("wb.context.more")}
                </button>
              )}
            </div>
            <div className="title-actions">
              {scene.status === "approved" ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={frozen || busy}
                  onClick={() => onSceneStatus(scene.id, "draft")}
                  title={frozen ? tt("wb.frozen.hint") : undefined}
                >
                  <IconEdit />
                  {tt("wb.scene.markDraft")}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  disabled={frozen || busy || !canMarkReady}
                  onClick={() => onSceneStatus(scene.id, "approved")}
                  title={frozen ? tt("wb.frozen.hint") : readyWhy ?? undefined}
                >
                  {busy ? <span className="spinner" /> : <IconCheck />}
                  {tt("wb.scene.approve")}
                </button>
              )}
            </div>
            {scene.status !== "approved" && !frozen && readyWhy && <p className="hint action-hint">{readyWhy}</p>}
          </>
        )}
      </div>
    </div>
  );
}
