// Subtitle QC — the export preflight (2026-09-04, prioritized from the
// product review): the checks a professional subtitle house runs before
// delivery, as pure functions over the rows we already have. ERRORS block
// finalize; WARNINGS ship but are shown (and the finalize call can override
// them explicitly). Thresholds follow common streaming-house English
// subtitle guidelines (Netflix-style timed-text specs, rounded for 竖屏).

import type { AdaptedLine, Line } from "@/lib/types";

export type QcSeverity = "error" | "warning";

export type QcIssue = {
  severity: QcSeverity;
  /** Stable code the UI maps to a localized label: qc.<code>. */
  code:
    | "missing_translation"
    | "empty_line"
    | "reading_speed"
    | "line_too_long"
    | "too_many_lines"
    | "cue_too_short"
    | "cue_too_long"
    | "overlap"
    | "tiny_gap"
    | "missing_rationale"
    | "name_inconsistent";
  /** Source line uuid the issue anchors to (click-to-jump in the UI). */
  line_id: string;
  seq: number;
  start_ms: number | null;
  /** Numbers the label interpolates: measured value and the limit. */
  value?: number;
  limit?: number;
  detail?: string;
};

export type QcReport = {
  errors: QcIssue[];
  warnings: QcIssue[];
  /** Lines checked (merged-away lines excluded). */
  lines: number;
};

// English subtitle limits (streaming-house conventions).
const MAX_CPS = 20; // characters/second reading speed — error above
const WARN_CPS = 17; // warn above
const MAX_LINE_CHARS = 42; // per rendered line
const MAX_LINES = 2;
const MIN_CUE_MS = 700;
const MAX_CUE_MS = 7000;
const MIN_GAP_MS = 80; // ~2 frames at 24fps

export function runQc(input: {
  lines: Line[];
  adapted: AdaptedLine[];
  /** name_en per character id, for consistency checks. */
  characterNames?: Map<string, string | null>;
}): QcReport {
  const issues: QcIssue[] = [];
  const src = input.lines.filter((l) => !l.merged_into_id).sort((a, b) => a.seq - b.seq);
  const byLine = new Map(input.adapted.filter((a) => a.line_id).map((a) => [a.line_id as string, a]));

  const push = (i: Omit<QcIssue, "seq" | "start_ms"> & { line: Line }) => {
    const { line, ...rest } = i;
    issues.push({ ...rest, seq: line.seq, start_ms: line.start_ms });
  };

  let prevEnd: number | null = null;
  let prevId: string | null = null;
  for (const line of src) {
    const a = byLine.get(line.id);

    // Coverage: every source line needs an adapted row; non-cut rows need text.
    if (!a) {
      push({ severity: "error", code: "missing_translation", line_id: line.id, line });
      continue;
    }
    const text = a.change_type === "cut" ? null : a.text_en;
    if (a.change_type !== "cut" && (!text || !text.trim())) {
      push({ severity: "error", code: "empty_line", line_id: line.id, line });
      continue;
    }
    if (a.change_type !== "keep" && a.change_type !== "literal" && !a.rationale_zh) {
      push({ severity: "warning", code: "missing_rationale", line_id: line.id, line });
    }

    if (text) {
      // Shape: rendered line count and width.
      const rendered = text.split("\n");
      if (rendered.length > MAX_LINES) {
        push({ severity: "error", code: "too_many_lines", line_id: line.id, line, value: rendered.length, limit: MAX_LINES });
      }
      const widest = Math.max(...rendered.map((r) => r.length));
      if (widest > MAX_LINE_CHARS) {
        push({ severity: "warning", code: "line_too_long", line_id: line.id, line, value: widest, limit: MAX_LINE_CHARS });
      }

      // Timing-dependent checks only when the cue is timed.
      if (line.start_ms !== null && line.end_ms !== null && line.end_ms > line.start_ms) {
        const dur = line.end_ms - line.start_ms;
        const cps = (text.replace(/\s/g, "").length * 1000) / dur;
        if (cps > MAX_CPS) {
          push({ severity: "error", code: "reading_speed", line_id: line.id, line, value: Math.round(cps), limit: MAX_CPS });
        } else if (cps > WARN_CPS) {
          push({ severity: "warning", code: "reading_speed", line_id: line.id, line, value: Math.round(cps), limit: WARN_CPS });
        }
        if (dur < MIN_CUE_MS) {
          push({ severity: "warning", code: "cue_too_short", line_id: line.id, line, value: dur, limit: MIN_CUE_MS });
        }
        if (dur > MAX_CUE_MS) {
          push({ severity: "warning", code: "cue_too_long", line_id: line.id, line, value: dur, limit: MAX_CUE_MS });
        }
      }
    }

    // Sequence: overlaps and hairline gaps against the previous timed cue.
    if (line.start_ms !== null && prevEnd !== null) {
      if (line.start_ms < prevEnd) {
        push({ severity: "error", code: "overlap", line_id: line.id, line, value: prevEnd - line.start_ms, detail: prevId ?? undefined });
      } else if (line.start_ms - prevEnd > 0 && line.start_ms - prevEnd < MIN_GAP_MS) {
        push({ severity: "warning", code: "tiny_gap", line_id: line.id, line, value: line.start_ms - prevEnd, limit: MIN_GAP_MS });
      }
    }
    if (line.end_ms !== null) {
      prevEnd = line.end_ms;
      prevId = line.id;
    }
  }

  // Name consistency: the same character must keep one English spelling
  // across the adapted text (e.g. "Xiang Yuan" never drifting to "Xiangyuan").
  if (input.characterNames) {
    for (const [, name] of input.characterNames) {
      if (!name || name.split(/\s+/).length < 2) continue;
      const squashed = name.replace(/\s+/g, "");
      for (const line of src) {
        const a = byLine.get(line.id);
        const text = a?.text_en;
        if (!text) continue;
        if (text.includes(squashed) && !text.includes(name)) {
          push({ severity: "warning", code: "name_inconsistent", line_id: line.id, line, detail: name });
        }
      }
    }
  }

  return {
    errors: issues.filter((i) => i.severity === "error"),
    warnings: issues.filter((i) => i.severity === "warning"),
    lines: src.length,
  };
}
