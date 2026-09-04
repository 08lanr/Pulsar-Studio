// The adapted script as a spreadsheet, one row per adapted line joined to its
// source line. Excel on Windows only reads UTF-8 correctly when the file
// starts with a BOM, and the partner's team lives in Excel, so the BOM is
// unconditional. Row ends are CRLF (RFC 4180); every field is quoted so a
// full-width comma or an embedded newline in a rationale cannot shift a
// column. Ids in the sheet are external ids only.

import type { VersionSnapshot } from "@/lib/types";
import { clockTime } from "./time";

export type CsvRow = {
  seq: number;
  start: string;
  end: string;
  speaker: string;
  text_zh: string;
  text_en: string;
  back_translation_zh: string;
  change_type: string;
  tags: string;
  rationale_zh: string;
  rationale_en: string;
  /** ln_ of the anchor source line. */
  line_id: string;
  /** rw_ */
  adapted_line_id: string;
  /** sc_ */
  scene_id: string;
};

export const CSV_COLUMNS: (keyof CsvRow)[] = [
  "seq",
  "start",
  "end",
  "speaker",
  "text_zh",
  "text_en",
  "back_translation_zh",
  "change_type",
  "tags",
  "rationale_zh",
  "rationale_en",
  "line_id",
  "adapted_line_id",
  "scene_id",
];

export const CSV_BOM = "\uFEFF";

export function csvField(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(rows: CsvRow[], columns: (keyof CsvRow)[] = CSV_COLUMNS): string {
  const head = columns.map(csvField).join(",");
  const body = rows.map((r) => columns.map((c) => csvField(r[c])).join(","));
  return CSV_BOM + [head, ...body].join("\r\n") + "\r\n";
}

/**
 * Rows from a frozen snapshot: every adapted line joined to its anchor
 * source line by uuid (the uuid stays inside; the row prints external ids).
 * A merged line's absorbed Chinese is appended to text_zh so the sheet reads
 * whole. Source lines with no adaptation (an unadapted scene in a draft
 * export) still appear with the English columns empty.
 */
export function csvRowsFromSnapshot(snapshot: VersionSnapshot): CsvRow[] {
  const rows: CsvRow[] = [];
  for (const scene of snapshot.scenes) {
    const src = new Map(scene.lines.map((l) => [l.id, l]));
    const covered = new Set<string>();
    for (const a of scene.adapted_lines) {
      const anchor = a.line_id ? src.get(a.line_id) : undefined;
      if (anchor) covered.add(anchor.id);
      const merged = a.merges.flatMap((id) => {
        const m = src.get(id);
        return m ? [m] : [];
      });
      merged.forEach((m) => covered.add(m.id));
      rows.push({
        seq: a.seq,
        start: clockTime(a.start_ms ?? anchor?.start_ms),
        end: clockTime(a.end_ms ?? anchor?.end_ms),
        speaker: anchor?.speaker ?? "",
        text_zh: [anchor?.text_zh ?? "", ...merged.map((m) => m.text_zh)].filter(Boolean).join(" / "),
        text_en: a.text_en ?? "",
        back_translation_zh: a.back_translation_zh ?? "",
        change_type: a.change_type,
        tags: a.tags.join(";"),
        rationale_zh: a.rationale_zh ?? "",
        rationale_en: a.rationale_en ?? "",
        line_id: anchor?.external_id ?? "",
        adapted_line_id: a.external_id,
        scene_id: scene.external_id,
      });
    }
    for (const l of scene.lines) {
      if (covered.has(l.id)) continue;
      rows.push({
        seq: l.seq,
        start: clockTime(l.start_ms),
        end: clockTime(l.end_ms),
        speaker: l.speaker ?? "",
        text_zh: l.text_zh,
        text_en: "",
        back_translation_zh: "",
        change_type: "",
        tags: "",
        rationale_zh: "",
        rationale_en: "",
        line_id: l.external_id,
        adapted_line_id: "",
        scene_id: scene.external_id,
      });
    }
  }
  return rows.sort((a, b) => a.seq - b.seq);
}
