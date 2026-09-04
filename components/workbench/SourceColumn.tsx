// The Chinese source column: the selected scene's context, then every
// line of the episode grouped by scene. A line's left rule tells the
// editor what the adaptation did to it (.changed = a real rewrite,
// .flagged = a major change the partner will see first) and the selected
// line carries the arrow to the adapted column. Pinned to the Chinese
// font stack whatever the UI locale is.

"use client";

import { useEffect, useRef, useState } from "react";
import type { AdaptedLine, Line, Scene, SceneDecision } from "@/lib/types";
import { useT } from "@/components/locale";
import { IconChevron, IconPlay } from "./icons";
import { SceneHeader } from "./SceneHeader";
import { fmtTc, isChanged } from "./util";

export function SourceColumn({
  scenes,
  lines,
  adaptedByLine,
  decisions,
  selectedScene,
  selectedId,
  onSelect,
  onPlayLine,
}: {
  scenes: Scene[];
  lines: Line[];
  adaptedByLine: Map<string, AdaptedLine>;
  decisions: SceneDecision[];
  selectedScene: Scene | null;
  selectedId: string | null;
  onSelect: (line: Line) => void;
  onPlayLine: (line: Line) => void;
}) {
  const { tt } = useT();
  const [ctxOpen, setCtxOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the selected line in view when j/k or playback moves it.
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-line="${selectedId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const decisionFor = (sceneId: string) => decisions.find((d) => d.scene_id === sceneId) ?? null;

  return (
    <section className="ws-col bilingual-zh" lang="zh-CN">
      <div className="ws-col-head">
        <span lang="en">{tt("wb.source.head")}</span>
        <span className="sub">{tt("wb.lines.count", { n: lines.length })}</span>
      </div>
      <div className={ctxOpen ? "context open" : "context"}>
        <span className="context-label" lang="en">
          {tt("wb.context.label")}
        </span>
        <p className="context-body">{selectedScene?.context_zh ?? tt("wb.context.none")}</p>
        {selectedScene?.context_zh && (
          <button type="button" className="context-more" lang="en" onClick={() => setCtxOpen((v) => !v)}>
            {ctxOpen ? tt("wb.context.less") : tt("wb.context.more")}
          </button>
        )}
      </div>
      <div className="ws-col-body" ref={listRef}>
        {lines.length === 0 && (
          <div className="empty">
            <p>{tt("wb.lines.empty")}</p>
          </div>
        )}
        {scenes.map((scene) => {
          const sceneLines = lines.filter((l) => l.scene_id === scene.id);
          if (sceneLines.length === 0) return null;
          return (
            <div key={scene.id}>
              <SceneHeader scene={scene} decision={decisionFor(scene.id)} />
              <ul className="lines">
                {sceneLines.map((line) => {
                  const a = adaptedByLine.get(line.id);
                  const cls = [
                    "line",
                    line.id === selectedId ? "on" : "",
                    a && isChanged(a.change_type) ? "changed" : "",
                    a?.is_major ? "flagged" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <li
                      key={line.id}
                      className={cls}
                      data-line={line.id}
                      onClick={() => onSelect(line)}
                      aria-current={line.id === selectedId ? "true" : undefined}
                    >
                      <span className="line-tc">{fmtTc(line.start_ms)}</span>
                      <div className="line-body">
                        {line.speaker && <span className="line-speaker">{line.speaker}</span>}
                        <p className="line-text">{line.text_zh}</p>
                      </div>
                      <div className="line-actions">
                        <button
                          type="button"
                          className="icon-btn line-play"
                          aria-label={tt("wb.line.play")}
                          onClick={(e) => {
                            e.stopPropagation();
                            onPlayLine(line);
                          }}
                        >
                          <IconPlay />
                        </button>
                        <span className="line-arrow">
                          <IconChevron />
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
