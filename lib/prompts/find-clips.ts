// find_clips: rank the 8-12 best moments of an episode to cut an ad from.
// The model answers in line seqs, never in milliseconds — lib/jobs.ts maps
// from_seq/to_seq to the real cue timecodes, so a clip's range is always a
// range the footage actually has (the fixture quotes cues the same way).
// Each clip carries the hook, why it could work (zh + en), suggested opening
// text, a recommended cut length and an angle: together the brief a human
// editor cuts from.

import { z } from "zod";
import type { Scene } from "@/lib/types";
import { MODEL_FAST, type LlmSystemBlock } from "@/lib/llm";
import { AdAngleSchema, PROMPT_VERSION, STYLE_ANCHOR, fmtMs, renderLines, type PromptLine } from "./shared";

export const ClipSchema = z.object({
  from_seq: z.number().int().describe("First line of the clip (input seq)"),
  to_seq: z.number().int().describe("Last line of the clip (input seq), >= from_seq"),
  hook_en: z.string().describe("The ad's hook line, under 12 words, zero context needed"),
  why_zh: z.string().describe("为什么这段能做广告，1-2 句简体中文，写给制片方"),
  why_en: z.string().describe("Why this moment could work as an ad, 1-2 sentences for the editor"),
  opening_text_en: z.string().describe("Suggested on-screen text for the first second"),
  cut_length_s: z.number().int().describe("Recommended cut length in seconds, 9-25"),
  angle: AdAngleSchema,
});

export const FindClipsSchema = z.object({
  clips: z.array(ClipSchema).describe("8-12 clips, strongest first"),
});

export type ClipOutput = z.infer<typeof ClipSchema>;
export type FindClipsOutput = z.infer<typeof FindClipsSchema>;

export type FindClipsInput = {
  bible: LlmSystemBlock;
  episode_number: number;
  episode_name_zh: string | null;
  scenes: Pick<Scene, "number" | "start_ms" | "end_ms" | "context_en">[];
  /** Every timed line of the episode with its English when adapted. */
  lines: PromptLine[];
};

const SYSTEM = `You are the creative lead at Pulsar Studio choosing which moments of an episode to cut into TikTok and Meta ads for a Chinese vertical short drama adapted for U.S. viewers.

${STYLE_ANCHOR}

RULES
- A clip is a contiguous run of lines; give it as from_seq and to_seq from the input. Prefer runs whose on-screen span is 8-30 seconds; the cut_length_s is what you recommend the editor keep (9-25 s), which may be shorter than the span.
- Rank by ad value, not by drama value: a reveal, a question, a threat, a line that works with no setup. Strongest first.
- hook_en must be understandable with zero context. No honorifics that need China to parse.
- why_zh is for the producer (制片方): plain 简体中文. why_en is for the editor, written natively — not a translation.
- Angle from the fixed list only.
- Never describe footage or events that the lines and scene contexts do not establish.`;

export function buildFindClips(input: FindClipsInput) {
  const scenes = input.scenes
    .map((s) => `scene ${s.number} (${fmtMs(s.start_ms)}-${fmtMs(s.end_ms)}): ${s.context_en ?? "(no context)"}`)
    .join("\n");
  const seqs = new Set(input.lines.map((l) => l.seq));
  const bySeq = new Map(input.lines.map((l) => [l.seq, l]));
  const system: LlmSystemBlock[] = [input.bible, { text: SYSTEM, cache: true }];
  return {
    name: "find_clips",
    description: "Record the ranked clip suggestions for the episode.",
    system,
    user: `Episode ${input.episode_number}${input.episode_name_zh ? ` ${input.episode_name_zh}` : ""}\n\nSCENES\n${scenes}\n\nLINES\n${renderLines(input.lines)}\n\nRank the 8-12 best clips.`,
    schema: FindClipsSchema,
    model: MODEL_FAST,
    maxTokens: 8000,
    effort: "medium" as const,
    prompt_version: PROMPT_VERSION,
    check: (out: FindClipsOutput) => {
      if (out.clips.length < 8 || out.clips.length > 12) return `Return 8-12 clips, not ${out.clips.length}`;
      for (const [i, c] of out.clips.entries()) {
        if (!seqs.has(c.from_seq) || !seqs.has(c.to_seq)) return `clip ${i + 1}: seq ${c.from_seq}-${c.to_seq} is not in the input`;
        if (c.from_seq > c.to_seq) return `clip ${i + 1}: from_seq must be <= to_seq`;
        if (c.cut_length_s < 9 || c.cut_length_s > 25) return `clip ${i + 1}: cut_length_s must be 9-25`;
        const a = bySeq.get(c.from_seq)!;
        const b = bySeq.get(c.to_seq)!;
        if (a.start_ms !== null && b.end_ms !== null && b.end_ms - a.start_ms > 90_000)
          return `clip ${i + 1}: span is over 90 seconds; pick a tighter run`;
      }
      return null;
    },
  };
}
