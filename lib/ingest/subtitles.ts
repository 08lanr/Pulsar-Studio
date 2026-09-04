// SRT / WebVTT / ASS parsers → one cue shape.
//
// Producers deliver whatever their subtitling tool exported, so the parsers
// are lenient about everything that carries no meaning (BOM, CRLF, comma vs
// dot milliseconds, hour-less timestamps, cue ids, VTT settings, ASS
// override blocks) and strict about nothing except the timing line. Anything
// odd is reported as a warning rather than an exception: an operator ingesting
// a 60-episode title needs to see "cue 41 overlaps cue 40" and move on, not
// have episode 17 refuse to load.

import {
  cleanCueText,
  formatMs,
  normalizeNewlines,
  parseTimestamp,
  splitSpeaker,
  stripBom,
} from "./text";

export type SubtitleFormat = "srt" | "vtt" | "ass";

export type Cue = {
  /** 1-based position among the cues kept (empty cues are dropped). */
  index: number;
  start_ms: number;
  end_ms: number;
  /** Clean dialogue; multi-line cue text joined with "\n". */
  text: string;
  speaker?: string;
  /** The cue text exactly as it appeared in the file, tags included. */
  raw?: string;
};

export type ParsedSubtitles = {
  format: SubtitleFormat;
  cues: Cue[];
  warnings: string[];
};

type RawCue = {
  start_ms: number;
  end_ms: number;
  text: string;
  /** Speaker the format itself declared (ASS Name field, VTT voice tag). */
  speaker?: string;
};

const TIMING_RE = /^(\S+)\s*-->\s*(\S+)/;

/** SRT and WebVTT share the "blank-line separated blocks" shape. */
function parseBlockCues(text: string, warnings: string[], skipBlockPrefixes: string[]): RawCue[] {
  const out: RawCue[] = [];
  const blocks = text.split(/\n[ \t]*\n+/);
  for (const block of blocks) {
    const lines = block.split("\n");
    while (lines.length && lines[0].trim() === "") lines.shift();
    if (!lines.length) continue;
    if (skipBlockPrefixes.some((p) => lines[0].startsWith(p))) continue;

    const timingAt = lines.findIndex((l) => TIMING_RE.test(l));
    if (timingAt < 0) {
      // A stray id or a bare line of text with no timing: not a cue.
      const preview = lines[0].trim().slice(0, 30);
      warnings.push(`block without a timing line skipped: "${preview}"`);
      continue;
    }
    const m = lines[timingAt].match(TIMING_RE)!;
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2]);
    if (start === null || end === null) {
      warnings.push(`unreadable timestamp skipped: "${lines[timingAt].trim()}"`);
      continue;
    }
    out.push({ start_ms: start, end_ms: end, text: lines.slice(timingAt + 1).join("\n") });
  }
  return out;
}

function parseSrt(text: string, warnings: string[]): RawCue[] {
  return parseBlockCues(text, warnings, []);
}

function parseVtt(text: string, warnings: string[]): RawCue[] {
  // The header block is "WEBVTT" plus optional metadata up to the first
  // blank line; NOTE / STYLE / REGION blocks carry no cues.
  const body = text.replace(/^WEBVTT[^\n]*\n(?:[^\n]+\n)*/, "");
  return parseBlockCues(body, warnings, ["NOTE", "STYLE", "REGION"]);
}

// SSA v4 / ASS v4+ default event columns, used when the [Events] section has
// no Format line (it always should, but exporters are sloppy).
const ASS_DEFAULT_FORMAT = [
  "layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text",
];

function parseAss(text: string, warnings: string[]): RawCue[] {
  const out: RawCue[] = [];
  let inEvents = false;
  let columns = ASS_DEFAULT_FORMAT;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      inEvents = /^\[events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;

    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const body = line.slice(sep + 1).trim();

    if (key === "format") {
      columns = body.split(",").map((c) => c.trim().toLowerCase());
      continue;
    }
    if (key !== "dialogue") continue; // Comment: and anything else is not spoken

    const parts = body.split(",");
    const textIdx = columns.indexOf("text");
    // Text is the last column and may itself contain commas: rejoin the tail.
    if (textIdx === columns.length - 1 && parts.length > columns.length) {
      parts.splice(textIdx, parts.length - textIdx, parts.slice(textIdx).join(","));
    }
    const field = (name: string): string => {
      const i = columns.indexOf(name);
      return i >= 0 && i < parts.length ? parts[i].trim() : "";
    };

    const start = parseTimestamp(field("start"));
    const end = parseTimestamp(field("end"));
    if (start === null || end === null) {
      warnings.push(`unreadable ASS timestamp skipped: "${line.slice(0, 40)}"`);
      continue;
    }
    // "Name" per the spec; some tools write "Actor".
    const speaker = field("name") || field("actor") || undefined;
    const dialogue = (textIdx >= 0 && textIdx < parts.length ? parts[textIdx] : "")
      .replace(/\\[Nn]/g, "\n")
      .replace(/\\h/g, " ");
    out.push({ start_ms: start, end_ms: end, text: dialogue, speaker });
  }

  if (!out.length) warnings.push("no Dialogue lines found in [Events]");
  return out;
}

/**
 * Clean every raw cue, drop the empty ones and check the timeline. The
 * speaker declared by the format wins; the text heuristic runs only when
 * the format said nothing, so an ASS Name field is never second-guessed.
 */
function finalize(rawCues: RawCue[], format: SubtitleFormat, warnings: string[]): ParsedSubtitles {
  const cues: Cue[] = [];
  let prev: Cue | undefined;

  rawCues.forEach((rc, i) => {
    const fileIndex = i + 1;
    const at = formatMs(rc.start_ms);

    const cleaned = cleanCueText(rc.text);
    let text = cleaned.text;
    let speaker = rc.speaker?.trim() || cleaned.speaker;
    if (!speaker) {
      const split = splitSpeaker(text);
      text = split.text;
      speaker = split.speaker;
    }
    if (!text) {
      warnings.push(`cue ${fileIndex} (${at}): empty after stripping tags, dropped`);
      return;
    }

    if (rc.end_ms <= rc.start_ms) {
      warnings.push(`cue ${fileIndex} (${at}): zero or negative duration`);
    }
    if (prev) {
      if (rc.start_ms < prev.start_ms) {
        warnings.push(`cue ${fileIndex} (${at}): starts before cue ${prev.index} (${formatMs(prev.start_ms)})`);
      }
      if (rc.start_ms < prev.end_ms) {
        warnings.push(`cue ${fileIndex} (${at}): overlaps cue ${prev.index} (ends ${formatMs(prev.end_ms)})`);
      }
    }

    const cue: Cue = {
      index: cues.length + 1,
      start_ms: rc.start_ms,
      end_ms: rc.end_ms,
      text,
      raw: rc.text,
    };
    if (speaker) cue.speaker = speaker;
    cues.push(cue);
    prev = cue;
  });

  return { format, cues, warnings };
}

/** Parse subtitle text in the given format. BOM and CRLF are handled here. */
export function parseSubtitles(input: string, format: SubtitleFormat): ParsedSubtitles {
  const text = normalizeNewlines(stripBom(input));
  const warnings: string[] = [];
  const raw =
    format === "srt" ? parseSrt(text, warnings)
    : format === "vtt" ? parseVtt(text, warnings)
    : parseAss(text, warnings);
  return finalize(raw, format, warnings);
}

/**
 * Content sniffing for subtitle text. Returns null when the text looks like
 * neither (a script document, or garbage) — the caller decides what that means.
 */
export function sniffSubtitleFormat(input: string): SubtitleFormat | null {
  const text = normalizeNewlines(stripBom(input));
  const head = text.slice(0, 4000);
  if (/^\s*WEBVTT/.test(head)) return "vtt";
  if (/^\s*\[script info\]/im.test(head) || /^Dialogue:\s*\d+,\d+:\d{2}:\d{2}/m.test(text)) return "ass";
  if (/\d{1,2}:\d{2}[,.]\d{1,3}\s*-->\s*\d/.test(head)) return "srt";
  return null;
}
