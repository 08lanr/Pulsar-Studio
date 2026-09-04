// The U.S. English column. The scene context, then the diff card for the
// selected line: the editable adapted text (autosaved), the chips that
// say who wrote it and what kind of change it is, the rationale in both
// languages (zh first when the chrome is Chinese — the partner-facing
// text is the one staff should read the way the partner will), the tone
// note, the alternatives picker and the line tools. Under the card, the
// scene's other adapted lines as one-liners so the two columns stay
// aligned and a click moves the selection without leaving the column.

"use client";

import { useState } from "react";
import type { AdaptedLinePatch } from "@/lib/data";
import type { AdaptedLine, Line, LineAlternative, Scene, SceneDecision } from "@/lib/types";
import { TAG_LABELS } from "@/lib/types";
import { useT } from "@/components/locale";
import { Alternatives } from "./Alternatives";
import { IconAlert, IconSparkle } from "./icons";
import { LineTools } from "./LineTools";
import { useAutosave, type SaveState } from "./useAutosave";
import { fmtTc } from "./util";

export type AdaptedBusy = {
  alternatives: boolean;
  rewrite: boolean;
  choosing: string | null;
};

export function AdaptedColumn({
  scene,
  line,
  adapted,
  sceneLines,
  adaptedByLine,
  alternatives,
  decision,
  hasVersion,
  frozen,
  aiAvailable,
  busy,
  adaptedCount,
  totalLines,
  onSelect,
  onSaveText,
  onPatch,
  onChoose,
  onMoreAlternatives,
  onRewrite,
  onSaveState,
}: {
  scene: Scene | null;
  line: Line | null;
  adapted: AdaptedLine | null;
  sceneLines: Line[];
  adaptedByLine: Map<string, AdaptedLine>;
  alternatives: LineAlternative[];
  decision: SceneDecision | null;
  hasVersion: boolean;
  frozen: boolean;
  aiAvailable: boolean;
  busy: AdaptedBusy;
  adaptedCount: number;
  totalLines: number;
  onSelect: (line: Line) => void;
  onSaveText: (adaptedLineId: string, text: string) => Promise<void>;
  onPatch: (adaptedLineId: string, patch: AdaptedLinePatch) => void;
  onChoose: (adaptedLineId: string, alternativeId: string) => void;
  onMoreAlternatives: (adaptedLineId: string) => void;
  onRewrite: (adaptedLineId: string, instruction: string) => void;
  onSaveState: (s: SaveState) => void;
}) {
  const { tt, locale } = useT();
  const [ctxOpen, setCtxOpen] = useState(false);
  const editor = useAutosave({
    id: adapted?.id ?? "none",
    initial: adapted?.text_en ?? "",
    save: onSaveText,
    onState: onSaveState,
    disabled: frozen || !adapted,
  });
  const zhFirst = locale === "zh";

  const rationale = adapted
    ? zhFirst
      ? [adapted.rationale_zh, adapted.rationale_en]
      : [adapted.rationale_en, adapted.rationale_zh]
    : [];
  const tone = adapted
    ? zhFirst
      ? [adapted.tone_note_zh, adapted.tone_note_en]
      : [adapted.tone_note_en, adapted.tone_note_zh]
    : [];

  return (
    <section className="ws-col bilingual-en" lang="en">
      <div className="ws-col-head">
        <span>{tt("wb.adapted.head")}</span>
        <span className="sub">{tt("wb.adapted.count", { n: adaptedCount, total: totalLines })}</span>
      </div>
      <div className={ctxOpen ? "context open" : "context"}>
        <span className="context-label">{tt("wb.context.label")}</span>
        <p className="context-body">{scene?.context_en ?? tt("wb.context.none")}</p>
        {scene?.context_en && (
          <button type="button" className="context-more" onClick={() => setCtxOpen((v) => !v)}>
            {ctxOpen ? tt("wb.context.less") : tt("wb.context.more")}
          </button>
        )}
      </div>

      {decision?.decision === "needs_alternative" && (
        <div className="context">
          <div className="note note-warn">
            <span className="kicker">{tt("wb.decision.needs_alternative")}</span>
            {decision.note && (
              <p className="context-body open bilingual-zh" lang="zh-CN">
                {decision.note}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="ws-col-body">
        {!hasVersion ? (
          <div className="empty">
            <div className="empty-art">
              <IconSparkle size={24} />
            </div>
            <h3>{tt("wb.adapted.noVersion")}</h3>
            <p>{aiAvailable ? tt("wb.adapted.noVersion.hint") : tt("wb.adapted.manualHint")}</p>
          </div>
        ) : !line ? (
          <div className="empty">
            <p>{tt("wb.adapted.pick")}</p>
          </div>
        ) : !adapted ? (
          <div className="empty">
            <p>{tt("wb.adapted.noLine")}</p>
          </div>
        ) : (
          <>
            <div className="line on">
              <span className="line-tc">{fmtTc(adapted.start_ms ?? line.start_ms)}</span>
              <div className="line-body">
                {line.speaker && <span className="line-speaker">{line.speaker}</span>}
                <label className="field">
                  <span className="sr-only">{tt("wb.adapted.textLabel")}</span>
                  <textarea
                    className="textarea"
                    value={editor.value}
                    readOnly={frozen}
                    placeholder={adapted.change_type === "cut" ? tt("wb.change.cut.hint") : tt("wb.adapted.textLabel")}
                    onChange={(e) => editor.setValue(e.target.value)}
                    onBlur={() => void editor.flush()}
                    rows={3}
                  />
                </label>
                {line.literal_en && (
                  <p className="hint">
                    {tt("wb.adapted.literal")} {line.literal_en}
                  </p>
                )}
                {adapted.back_translation_zh && (
                  <p className="line-pinyin bilingual-zh" lang="zh-CN">
                    {tt("wb.adapted.backTranslation")} {adapted.back_translation_zh}
                  </p>
                )}
              </div>
              <div className="line-actions">
                <button
                  type="button"
                  className={adapted.is_major ? "icon-btn active" : "icon-btn"}
                  aria-pressed={adapted.is_major}
                  disabled={frozen}
                  title={adapted.is_major ? tt("wb.major.on") : tt("wb.major.off")}
                  onClick={() => onPatch(adapted.id, { is_major: !adapted.is_major })}
                >
                  <IconAlert />
                </button>
              </div>
            </div>

            <div className="rationale">
              <div className="rationale-row">
                <div className="tags">
                  <span className={adapted.authored_by === "ai" ? "pill pill-accent" : "pill pill-neutral"}>
                    {adapted.authored_by === "ai" ? tt("wb.author.ai") : tt("wb.author.editor")}
                  </span>
                  <span className={adapted.is_major ? "tag tag-warning" : "tag"}>{tt(`wb.change.${adapted.change_type}`)}</span>
                  {adapted.is_major && <span className="tag tag-warning">{tt("wb.major.tag")}</span>}
                  {adapted.tags.map((tag) => (
                    <span key={tag} className="tag tag-neutral">
                      {tt(TAG_LABELS[tag].key)}
                    </span>
                  ))}
                </div>
              </div>
              <div className="rationale-row">
                <span className="rationale-label">{tt("wb.rationale.why")}</span>
                {rationale.some(Boolean) ? (
                  rationale.map((text, i) =>
                    text ? (
                      <p
                        key={i}
                        className={`rationale-body ${(zhFirst ? i === 0 : i === 1) ? "bilingual-zh" : "bilingual-en"}`}
                        lang={(zhFirst ? i === 0 : i === 1) ? "zh-CN" : "en"}
                      >
                        {text}
                      </p>
                    ) : null
                  )
                ) : (
                  <p className="rationale-body">{tt("wb.rationale.none")}</p>
                )}
              </div>
              {tone.some(Boolean) && (
                <div className="rationale-row">
                  <span className="rationale-label">{tt("wb.rationale.tone")}</span>
                  {tone.map((text, i) =>
                    text ? (
                      <p
                        key={i}
                        className={`rationale-body ${(zhFirst ? i === 0 : i === 1) ? "bilingual-zh" : "bilingual-en"}`}
                        lang={(zhFirst ? i === 0 : i === 1) ? "zh-CN" : "en"}
                      >
                        {text}
                      </p>
                    ) : null
                  )}
                </div>
              )}
              <div className="rationale-row">
                <span className="rationale-label">{tt("wb.rationale.tags")}</span>
                {adapted.tags.length ? (
                  <div className="tags">
                    {adapted.tags.map((tag) => (
                      <span key={tag} className="tag tag-neutral">
                        {tt(TAG_LABELS[tag].key)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="rationale-body">{tt("wb.rationale.noTags")}</p>
                )}
              </div>
            </div>

            <div className="rationale">
              <Alternatives
                alternatives={alternatives}
                aiAvailable={aiAvailable}
                frozen={frozen}
                busy={busy.alternatives}
                choosing={busy.choosing}
                onChoose={(altId) => onChoose(adapted.id, altId)}
                onMore={() => onMoreAlternatives(adapted.id)}
              />
            </div>

            {sceneLines.length > 1 && (
              <>
                <div className="context">
                  <span className="context-label">{tt("wb.adapted.sceneLines")}</span>
                </div>
                <ul className="lines">
                  {sceneLines.map((l) => {
                    const a = adaptedByLine.get(l.id);
                    if (l.id === line.id) return null;
                    return (
                      <li key={l.id} className={a?.is_major ? "line flagged" : "line"} onClick={() => onSelect(l)}>
                        <span className="line-tc">{fmtTc(l.start_ms)}</span>
                        <div className="line-body">
                          <p className="line-text">
                            {a ? (a.text_en ?? tt("wb.change.cut.hint")) : tt("wb.adapted.noLine")}
                          </p>
                        </div>
                        <div className="line-actions">
                          {a && <span className="tag">{tt(`wb.change.${a.change_type}`)}</span>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </>
        )}
      </div>

      <LineTools
        aiAvailable={aiAvailable}
        frozen={frozen}
        hasLine={!!adapted}
        busy={busy.rewrite}
        adaptedCount={adaptedCount}
        totalLines={totalLines}
        onRewrite={(instruction) => adapted && onRewrite(adapted.id, instruction)}
      />
    </section>
  );
}
