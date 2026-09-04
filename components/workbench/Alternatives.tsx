// The 2–3 alternative rewrites for the selected line, as a picker: the
// chosen one carries the filled check, clicking a row is "Use this" (POST
// choose), the head link asks for more (POST alternatives, up to three per
// call). Without ANTHROPIC_API_KEY the link gives way to the unavailable
// note; existing alternatives are still listed and choosable, because
// choosing is a data write, not an LLM call.

"use client";

import type { LineAlternative } from "@/lib/types";
import { useT } from "@/components/locale";
import { IconCheck } from "./icons";

export function Alternatives({
  alternatives,
  aiAvailable,
  frozen,
  busy,
  choosing,
  onChoose,
  onMore,
}: {
  alternatives: LineAlternative[];
  aiAvailable: boolean;
  frozen: boolean;
  /** A generate call is in flight. */
  busy: boolean;
  /** The alternative whose choose call is in flight. */
  choosing: string | null;
  onChoose: (alternativeId: string) => void;
  onMore: () => void;
}) {
  const { tt } = useT();
  return (
    <div className="picker">
      <div className="picker-head">
        <span>
          {tt("wb.alt.head")} <span className="n">{alternatives.length}</span>
        </span>
        {frozen ? null : aiAvailable ? (
          <button type="button" className="link" onClick={onMore} disabled={busy}>
            {busy ? <span className="spinner" /> : null} {alternatives.length ? tt("wb.alt.more") : tt("wb.alt.generate")}
          </button>
        ) : (
          <span className="n" title={tt("wb.ai.unavailable.hint")}>
            {tt("wb.ai.unavailable")}
          </span>
        )}
      </div>
      {alternatives.length === 0 ? (
        <div className="empty">
          <p>{aiAvailable ? tt("wb.alt.empty") : tt("wb.alt.emptyNoAi")}</p>
        </div>
      ) : (
        <ul className="picker-list">
          {alternatives.map((alt) => (
            <li key={alt.id}>
              <button
                type="button"
                className={alt.chosen ? "picker-item on" : "picker-item"}
                disabled={frozen || choosing !== null}
                onClick={() => onChoose(alt.id)}
                aria-pressed={alt.chosen}
                title={frozen ? tt("wb.frozen.hint") : tt("wb.alt.use")}
              >
                <span className="picker-check">
                  {choosing === alt.id ? <span className="spinner" /> : <IconCheck size={12} />}
                </span>
                <span className="picker-title bilingual-en" lang="en">
                  {alt.text_en}
                </span>
                <span className="picker-more kicker">{alt.chosen ? tt("wb.alt.chosen") : tt("wb.alt.use")}</span>
                <span className="picker-sub bilingual-zh" lang="zh-CN">
                  {alt.rationale_zh}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
