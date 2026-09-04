// The one ingest entry point. The upload route and scripts/ingest-episode.ts
// both call ingestEpisodeFile() and nothing else, so a file that parses on
// the command line parses identically in the app.
//
// The output shapes mirror docs/data-model.md: `lines` is studio.lines
// (seq, start_ms, end_ms, text_zh) plus the speaker name that becomes a
// studio.characters row; `scenes` is studio.scenes (number, start_ms,
// end_ms) plus the seq range each covers. Timecodes are null, never 0, when
// the source is a script document — the caller decides how to degrade.

import { parseScriptText } from "./script-text";
import { segmentScenes, type Scene, type SegmentOptions } from "./scenes";
import { parseSubtitles, sniffSubtitleFormat, type SubtitleFormat } from "./subtitles";
import { splitSpeaker, stripBom } from "./text";

export type IngestFormat = SubtitleFormat | "txt";

export type IngestLine = {
  seq: number;
  start_ms: number | null;
  end_ms: number | null;
  text_zh: string;
  speaker: string | null;
};

export type IngestResult = {
  format: IngestFormat;
  hasTimecodes: boolean;
  lines: IngestLine[];
  scenes: Scene[];
  warnings: string[];
};

export type { Scene, SegmentOptions } from "./scenes";
export type { Cue, ParsedSubtitles, SubtitleFormat } from "./subtitles";
export type { ParsedScript, ScriptLine } from "./script-text";

const EXT_FORMATS: Record<string, IngestFormat> = {
  srt: "srt",
  vtt: "vtt",
  ass: "ass",
  ssa: "ass",
};

/**
 * Extension first, then content. A .srt/.vtt/.ass/.ssa extension is trusted;
 * anything else (.txt, .md, no extension, a misnamed download) is sniffed,
 * and text that is neither subtitle format is a script document.
 */
export function detectFormat(text: string, filename: string): IngestFormat {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const byExt = EXT_FORMATS[ext];
  if (byExt) return byExt;
  return sniffSubtitleFormat(text) ?? "txt";
}

// Bracket-stamped transcripts — "[00:00:01.00] 台词" (ASR exports, cutting
// notes) — are scripts to the sniffer but carry a start time per line. When
// most lines open with a stamp, lift it: start from the stamp, end from the
// next line's start (capped at 7s; the last line gets 2.5s), stamp stripped
// from the text. The episode then counts as timed and subtitles work.
const STAMP_RE = /^[\[（(]\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:[.,](\d{1,3}))?\s*[\]）)]\s*/;

export function liftStamp(text: string): { ms: number; rest: string } | null {
  const m = text.match(STAMP_RE);
  if (!m) return null;
  const [, a, b, c, frac] = m;
  const h = c !== undefined ? Number(a) : 0;
  const min = c !== undefined ? Number(b) : Number(a);
  const sec = c !== undefined ? Number(c) : Number(b);
  if (min > 59 || sec > 59) return null;
  const fms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
  const rest = text.slice(m[0].length).trim();
  if (!rest) return null;
  return { ms: ((h * 60 + min) * 60 + sec) * 1000 + fms, rest };
}

export const MAX_DERIVED_CUE_MS = 7000;
export const LAST_CUE_MS = 2500;

function timeStampedLines(lines: IngestLine[], warnings: string[]): boolean {
  const stamps = lines.map((l) => liftStamp(l.text_zh));
  const stamped = stamps.filter(Boolean).length;
  if (stamped < 2 || stamped / lines.length < 0.6) return false;
  for (let i = 0; i < lines.length; i++) {
    const stamp = stamps[i];
    if (!stamp) continue;
    // The stamp hid the "名字：" prefix from the script parser's speaker
    // split; with it lifted, split again.
    const sp = splitSpeaker(stamp.rest);
    lines[i].text_zh = sp.text;
    if (!lines[i].speaker && sp.speaker) lines[i].speaker = sp.speaker;
    lines[i].start_ms = stamp.ms;
    const next = stamps.slice(i + 1).find(Boolean);
    const until = next && next.ms > stamp.ms ? next.ms : stamp.ms + LAST_CUE_MS;
    lines[i].end_ms = Math.min(until, stamp.ms + MAX_DERIVED_CUE_MS);
  }
  warnings.push(`timecodes read from per-line [hh:mm:ss] stamps; end times derived from the following line`);
  return true;
}

function decode(input: string | Uint8Array): string {
  // TextDecoder drops the BOM on bytes; stripBom covers strings that kept it.
  const s = typeof input === "string" ? input : new TextDecoder("utf-8").decode(input);
  return stripBom(s);
}

export function ingestEpisodeFile(
  input: string | Uint8Array,
  filename: string,
  opts: SegmentOptions = {}
): IngestResult {
  const text = decode(input);
  const format = detectFormat(text, filename);

  if (format === "txt") {
    const parsed = parseScriptText(text);
    const lines: IngestLine[] = parsed.lines.map((l) => ({
      seq: l.seq,
      start_ms: null,
      end_ms: null,
      text_zh: l.text,
      speaker: l.speaker ?? null,
    }));
    const warnings = [...parsed.warnings];
    const timed = timeStampedLines(lines, warnings);
    const scenes = segmentScenes(
      parsed.lines.map((l, i) => ({
        seq: l.seq,
        start_ms: lines[i].start_ms,
        end_ms: lines[i].end_ms,
        scene_break: l.scene_break,
      })),
      opts
    );
    return { format, hasTimecodes: timed, lines, scenes, warnings };
  }

  const parsed = parseSubtitles(text, format);
  const lines: IngestLine[] = parsed.cues.map((c) => ({
    seq: c.index,
    start_ms: c.start_ms,
    end_ms: c.end_ms,
    text_zh: c.text,
    speaker: c.speaker ?? null,
  }));
  const scenes = segmentScenes(
    parsed.cues.map((c) => ({ seq: c.index, start_ms: c.start_ms, end_ms: c.end_ms })),
    opts
  );
  return { format, hasTimecodes: true, lines, scenes, warnings: parsed.warnings };
}
