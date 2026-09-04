// A script document (剧本) with no timecodes → ordered lines.
//
// This is the degraded ingest path from docs/decisions.md A1: the producer
// sent a script instead of a subtitle file, so the workbench gets lines and
// scenes but no player and no VTT export. The rules are deliberately small:
// one line per non-blank line, the same speaker heuristic the subtitle
// parsers use, and headings (第X集 / 第X场 / SCENE ...) turned into scene
// breaks rather than kept as dialogue a model would try to adapt.

import { normalizeNewlines, splitSpeaker, stripBom } from "./text";

export type ScriptLine = {
  seq: number;
  text: string;
  speaker?: string;
  /** True when a heading immediately preceded this line: a new scene starts here. */
  scene_break?: boolean;
};

export type ParsedScript = {
  hasTimecodes: false;
  lines: ScriptLine[];
  /** The headings that were dropped, with the seq of the line that follows each. */
  headings: Array<{ seq: number; text: string }>;
  warnings: string[];
};

const CN_NUM = "[一二三四五六七八九十百千零〇两\\d]+";
const HEADING_RE = new RegExp(
  `^(?:第\\s*${CN_NUM}\\s*[集场幕话]|场景\\s*${CN_NUM}|SCENE\\b|SC\\.\\s*\\d|INT\\.|EXT\\.|INT\\/EXT)`,
  "i"
);
// Markdown hashes and bracket decorations around a heading: "## 第一场", "【第二场】".
const HEADING_DECOR_RE = /^[#*\s【\[（(]+|[】\]）)\s]+$/g;
const SEPARATOR_RE = /^[-=_*＊—～~·\s]{3,}$/;

/** Is this line a scene / episode heading rather than dialogue? */
export function isSceneHeading(line: string): boolean {
  const bare = line.replace(HEADING_DECOR_RE, "");
  return HEADING_RE.test(bare);
}

export function parseScriptText(input: string): ParsedScript {
  const text = normalizeNewlines(stripBom(input));
  const lines: ScriptLine[] = [];
  const headings: ParsedScript["headings"] = [];
  const warnings: string[] = [];
  let pendingHeading: string | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || SEPARATOR_RE.test(line)) continue;

    if (isSceneHeading(line)) {
      // Consecutive headings ("第一集" then "第一场") collapse into one break.
      pendingHeading = pendingHeading ? `${pendingHeading} / ${line}` : line;
      continue;
    }

    const { text: body, speaker } = splitSpeaker(line);
    const seq = lines.length + 1;
    const out: ScriptLine = { seq, text: body };
    if (speaker) out.speaker = speaker;
    if (pendingHeading !== null) {
      out.scene_break = true;
      headings.push({ seq, text: pendingHeading });
      pendingHeading = null;
    }
    lines.push(out);
  }

  if (pendingHeading !== null) warnings.push(`trailing heading with no lines after it: "${pendingHeading}"`);
  if (!lines.length) warnings.push("no dialogue lines found");

  return { hasTimecodes: false, lines, headings, warnings };
}
