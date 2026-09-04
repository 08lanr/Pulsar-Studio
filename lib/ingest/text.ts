// Text helpers shared by every ingest parser: BOM/newline normalisation,
// timestamp parsing, formatting-tag removal and the speaker heuristic.
//
// They live apart from the format parsers because the same rules must give
// the same answer whether a line arrived as an SRT cue, an ASS Dialogue or a
// bare script line — a producer's reviewer sees the speaker column and would
// notice if "张伟：" was stripped in one file and kept in the next.

/**
 * Drop a leading UTF-8 byte-order mark. Subtitle files reach us from
 * producers on Windows, where Notepad and PowerShell's `Set-Content
 * -Encoding utf8` both prepend one; an SRT whose first cue index reads
 * "﻿1" would otherwise fail the very first block. Same reason as the
 * sibling's lib/atomic-write.ts.
 */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** CRLF and lone CR both become LF so every parser can split on "\n". */
export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/**
 * "hh:mm:ss,mmm" / "mm:ss.mmm" / "h:mm:ss.cc" (ASS centiseconds) → ms.
 * Hours are optional (WebVTT allows it), the separator may be a comma or a
 * dot, and a fraction shorter than three digits is right-padded, so ".5" is
 * 500 ms and ASS's ".50" is also 500 ms. Returns null when the shape is not
 * a timestamp at all.
 */
export function parseTimestamp(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const ms = m[4] ? Number(m[4].padEnd(3, "0")) : 0;
  return ((h * 60 + min) * 60 + sec) * 1000 + ms;
}

/** ms → "hh:mm:ss.mmm" for warnings and the CLI. */
export function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const frac = total % 1000;
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(frac, 3)}`;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
  "&lrm;": "",
  "&rlm;": "",
};

/**
 * Remove presentation markup and return clean dialogue text. Handles ASS
 * override blocks ({\an8}, {\i1}), HTML-style tags (<i>, <b>, <font>, <c>,
 * <ruby>) and the entities WebVTT requires. A WebVTT voice tag <v Name> is
 * the one tag that carries meaning: its name is returned as the speaker.
 * Lines are trimmed, blank lines dropped, the rest joined with "\n".
 */
export function cleanCueText(raw: string): { text: string; speaker?: string } {
  let speaker: string | undefined;
  let s = raw;

  const voice = s.match(/<v(?:\.[^\s>]*)?\s+([^>]+)>/);
  if (voice) speaker = voice[1].trim() || undefined;

  s = s
    .replace(/\{[^{}]*\}/g, "")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e);

  const text = s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");

  return speaker ? { text, speaker } : { text };
}

const CJK_RE = /[㐀-鿿豈-﫿]/;
// A CJK speaker is at most 6 characters of CJK/Latin letters (no digits, no
// spaces): "张伟", "王医生", "小A". A Latin speaker is at most 24 chars and
// must start with a letter: "Zhang Wei", "Mr. Li". Anything else — "12" in
// "12:30", "http" in a URL, "时间是12" — is dialogue, not a name.
const CJK_NAME_RE = /^[㐀-鿿豈-﫿A-Za-z·]{1,6}$/;
const LATIN_NAME_RE = /^[A-Za-z][A-Za-z0-9 .'\-]{0,23}$/;

/** Is this candidate short and name-shaped enough to be a speaker label? */
export function isPlausibleSpeaker(candidate: string): boolean {
  const n = candidate.trim();
  if (!n) return false;
  if (CJK_RE.test(n)) return CJK_NAME_RE.test(n);
  return LATIN_NAME_RE.test(n);
}

const COLON_PREFIX_RE = /^([^\n:：\[\]【】（）()]{1,24})[:：]\s*([\s\S]+)$/;
const BRACKET_PREFIX_RE = /^[\[【（(]([^\]】）)\n]{1,24})[\]】）)]\s*([\s\S]+)$/;

/**
 * Speaker heuristic on the text itself: a leading "名字：" / "名字:" /
 * "[名字]" / "（名字）" becomes the speaker and is removed. Deliberately
 * conservative — see isPlausibleSpeaker — so dialogue that merely contains a
 * colon or a parenthetical stage direction ("（笑）") stays intact. The
 * remainder must be non-empty: "（张伟愣住）" on its own is a direction, not
 * an empty line spoken by 张伟愣住.
 */
export function splitSpeaker(text: string): { text: string; speaker?: string } {
  const t = text.trim();
  const m = t.match(COLON_PREFIX_RE) ?? t.match(BRACKET_PREFIX_RE);
  if (!m) return { text: t };
  const name = m[1].trim();
  const rest = m[2].trim();
  // "http://…" passes the Latin name rule; the "//" after the colon gives it away.
  if (!rest || rest.startsWith("//") || !isPlausibleSpeaker(name)) return { text: t };
  return { text: rest, speaker: name };
}
