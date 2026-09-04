// What every prompt module shares: the style anchor from docs/decisions.md,
// the adaptation rules (the same words in every writing pass so the first
// pass, an alternative and a rewrite cannot drift apart in register), the
// zod enums over the lib/types vocabularies, and the line formatter that
// renders a source line the same way in every user message.
//
// Prompt schemas use .nullable(), never .optional(): lib/llm.ts emits strict
// JSON schema where every key is required.

import { z } from "zod";
import { AD_ANGLES, TAGS, type ChangeType } from "@/lib/types";

/** Bumped when any prompt text or schema changes; stored on every AI-authored row. */
export const PROMPT_VERSION = "v1";

/** The decisions.md example pair. Every prompt quotes it. */
export const STYLE_ANCHOR = `STYLE ANCHOR (the product's own example; write like this)
  Source (zh):   你再这样下去，我以后不会再管你了。
  Literal (en):  If you continue like this, I won't care about you anymore.
  Studio (en):   Do this again and I'm done covering for you.
  为什么这样改编:  更直接，也更符合美式剧集中争吵场景的表达方式。
  Why (en):      More direct, and how an argument actually sounds in an American series.`;

export const ADAPTATION_RULES = `ADAPTATION RULES
- You write dialogue for an American viewer of a vertical short drama. You are not translating for a linguist: the test is whether the line sounds like something a person says in an American series, in this character's mouth, at this beat.
- Never invent a plot fact, a name, a relationship, a motive or a joke that is not in the source line, the scene context or the title bible. When the source is ambiguous, keep it ambiguous.
- Keep the speaker. One output line per source line; never merge, split, reorder or drop a line (a line that should not exist in English is change_type "cut" with text_en null — rare).
- Length: English runs 20-40% longer than Chinese by nature. Each line must still be readable in its time window (about 15 characters per second on screen, 17 at most). When the window is short, tighten; do not summarise.
- Honorifics and names: follow the bible. 沈总 / 王总 stay a name plus title ("Mr. Shen") unless the bible says otherwise; dropping or changing a name or title is always is_major.
- Register: contemporary American speech, contractions, no textbook English. Subtext over statement; a viewer should feel the beat, not be told it.
- change_type, one per line: keep (the literal already works), literal (near-literal, minor smoothing), rewrite (new phrasing, same meaning), tighten (shorter for the window), tone (same content, different emotional colour), cultural (an image, idiom or reference swapped for one an American knows), pacing (moved emphasis or rhythm for the cut), cut (nothing said in English), add (never in this version).
- tags: choose from the fixed list only; two or three that best explain the change.
- is_major: true when the line drops or changes a character's name or title, changes who is at fault, changes a plot fact, or reverses the emotional beat. Producers (制片方) read the is_major lines first.
- rationale_zh: one or two plain 简体中文 sentences written for the producer, explaining why this version serves an American audience. rationale_en: the same reason for the U.S. editor, not a translation of the Chinese.
- tone_note: only when the emotional colour moved (zh + en, a few words each); otherwise null.
- back_translation_zh: what the English says, rendered back into natural Chinese so the producer can judge the change without reading English. Faithful to the English, not a copy of the source.
- syllables_est: your best count of English syllables in text_en (0 for a cut).`;

export const CHANGE_TYPES = [
  "keep",
  "literal",
  "rewrite",
  "tighten",
  "tone",
  "cultural",
  "pacing",
  "cut",
  "add",
] as const satisfies readonly ChangeType[];

export const ChangeTypeSchema = z.enum(CHANGE_TYPES);
export const AdaptTagSchema = z.enum(TAGS);
export const AdAngleSchema = z.enum(AD_ANGLES);

/** The ms -> mm:ss.mmm rendering used in every prompt (and nowhere else — exports have their own). */
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "--:--";
  const total = Math.max(0, Math.round(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const frac = total % 1000;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(frac).padStart(3, "0")}`;
}

export type PromptLine = {
  seq: number;
  speaker: string | null;
  text_zh: string;
  start_ms: number | null;
  end_ms: number | null;
  /** The current English, when a pass needs to see it. */
  text_en?: string | null;
};

/** `[seq 12] 林晚 (00:01:23.400-00:01:25.100, 1.7s): 别啊…` — one shape for every pass. */
/** Viewers read ~17 chars/sec comfortably (QC errors above 20); the prompt
 * carries the budget per line so the model writes INSIDE the window and QC
 * stays a backstop, not a routine chore. */
export function charBudget(startMs: number, endMs: number): number {
  return Math.max(10, Math.floor(((endMs - startMs) / 1000) * 17));
}

export function renderLine(l: PromptLine): string {
  const who = l.speaker ?? "（未标注）";
  const timed = l.start_ms !== null && l.end_ms !== null;
  const window = timed
    ? ` (${fmtMs(l.start_ms)}-${fmtMs(l.end_ms)}, ${((l.end_ms! - l.start_ms!) / 1000).toFixed(1)}s, ≤${charBudget(l.start_ms!, l.end_ms!)} chars)`
    : "";
  const en = l.text_en !== undefined ? `\n    en: ${l.text_en ?? "(cut)"}` : "";
  return `[seq ${l.seq}] ${who}${window}: ${l.text_zh}${en}`;
}

export function renderLines(lines: PromptLine[]): string {
  return lines.map(renderLine).join("\n");
}

/** Quick English syllable estimate for a sanity check against the model's count. */
export function estimateSyllables(en: string | null): number {
  if (!en) return 0;
  return en
    .toLowerCase()
    .split(/[^a-z']+/)
    .filter(Boolean)
    .reduce((n, w) => {
      const groups = w.replace(/e$/, "").match(/[aeiouy]+/g);
      return n + Math.max(1, groups ? groups.length : 0);
    }, 0);
}

/** "the seqs the model must cover, once each" check shared by the passes that map line to line. */
export function checkSeqCoverage(expected: number[], got: number[]): string | null {
  const want = new Set(expected);
  const seen = new Set<number>();
  const problems: string[] = [];
  for (const s of got) {
    if (!want.has(s)) problems.push(`seq ${s} is not in the input`);
    else if (seen.has(s)) problems.push(`seq ${s} appears twice`);
    seen.add(s);
  }
  for (const s of expected) if (!seen.has(s)) problems.push(`seq ${s} is missing`);
  return problems.length ? `Output must cover every input seq exactly once:\n${problems.slice(0, 20).join("\n")}` : null;
}
