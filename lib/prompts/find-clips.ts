// find_clips: rank the 6-10 best moments of an episode to cut an ad from.
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

/**
 * The clip rule's own version (decision 2026-09-14): 20-30 s cuts, an
 * `opening` moment on episode 1. Keyed separately from PROMPT_VERSION so a
 * change here re-ranks clips without invalidating every other pass.
 */
export const CLIP_PROMPT_VERSION = "clips-v2";
export const CLIP_MIN_S = 20;
export const CLIP_MAX_S = 30;
export const CLIPS_MIN = 6;
export const CLIPS_MAX = 10;

export const ClipSchema = z.object({
  from_seq: z.number().int().describe("First line of the clip (input seq)"),
  to_seq: z.number().int().describe("Last line of the clip (input seq), >= from_seq"),
  hook_en: z.string().describe("The ad's hook line, under 12 words, zero context needed"),
  why_zh: z.string().describe("为什么这段能做广告，1-2 句简体中文，写给制片方"),
  why_en: z.string().describe("Why this moment could work as an ad, 1-2 sentences for the editor"),
  opening_text_en: z.string().describe("Suggested on-screen text for the first second"),
  cut_length_s: z.number().int().describe(`Recommended cut length in seconds, ${CLIP_MIN_S}-${CLIP_MAX_S}`),
  angle: AdAngleSchema,
  moment: z.enum(["opening", "peak"]).describe("opening = a trailer-style tease of how the story starts (episode 1 only); peak = a heartbreaking, shocking or high-stakes moment"),
});

export const FindClipsSchema = z.object({
  clips: z.array(ClipSchema).describe(`${CLIPS_MIN}-${CLIPS_MAX} clips, strongest first`),
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
  /** Episode 1 gets one trailer-style opening clip besides the peak moments. */
  wants_opening: boolean;
};

const SYSTEM = `You are the creative lead at Pulsar Studio choosing which moments of an episode to cut into TikTok and Meta ads for a Chinese vertical short drama adapted for U.S. viewers.

${STYLE_ANCHOR}

RULES
- A clip is a contiguous run of lines; give it as from_seq and to_seq from the input. Every ad is a single cut of ${CLIP_MIN_S}-${CLIP_MAX_S} seconds: prefer runs whose on-screen span is ${CLIP_MIN_S}-40 seconds; cut_length_s is what the editor keeps from the start of the run (${CLIP_MIN_S}-${CLIP_MAX_S} s). A shorter run is fine — the cut continues past the last line.
- Two kinds of moment. "peak": the crazy, heartbreaking, shocking or high-stakes moment — a reveal, a threat, a betrayal, a slap, a line that works with no setup. "opening": a trailer-style tease of how the story begins; only when the brief asks for one, and then exactly one clip, ranked where it belongs.
- Rank by ad value, not by drama value. Strongest first.
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
    user: `Episode ${input.episode_number}${input.episode_name_zh ? ` ${input.episode_name_zh}` : ""}\n\nSCENES\n${scenes}\n\nLINES\n${renderLines(input.lines)}\n\nRank the ${CLIPS_MIN}-${CLIPS_MAX} best clips.${input.wants_opening ? " This is the first episode: include exactly one \"opening\" clip that teases how the story starts; every other clip is a \"peak\"." : " Every clip is a \"peak\"; do not return an \"opening\" clip."}`,
    schema: FindClipsSchema,
    model: MODEL_FAST,
    maxTokens: 8000,
    effort: "medium" as const,
    prompt_version: `${PROMPT_VERSION}:${CLIP_PROMPT_VERSION}`,
    check: (out: FindClipsOutput) => {
      if (out.clips.length < CLIPS_MIN || out.clips.length > CLIPS_MAX) return `Return ${CLIPS_MIN}-${CLIPS_MAX} clips, not ${out.clips.length}`;
      const openings = out.clips.filter((c) => c.moment === "opening").length;
      if (input.wants_opening && openings !== 1) return `Return exactly one "opening" clip, not ${openings}`;
      if (!input.wants_opening && openings > 0) return `This is not the first episode: no "opening" clip`;
      for (const [i, c] of out.clips.entries()) {
        if (!seqs.has(c.from_seq) || !seqs.has(c.to_seq)) return `clip ${i + 1}: seq ${c.from_seq}-${c.to_seq} is not in the input`;
        if (c.from_seq > c.to_seq) return `clip ${i + 1}: from_seq must be <= to_seq`;
        if (c.cut_length_s < CLIP_MIN_S || c.cut_length_s > CLIP_MAX_S) return `clip ${i + 1}: cut_length_s must be ${CLIP_MIN_S}-${CLIP_MAX_S}`;
        const a = bySeq.get(c.from_seq)!;
        const b = bySeq.get(c.to_seq)!;
        if (a.start_ms !== null && b.end_ms !== null && b.end_ms - a.start_ms > 90_000)
          return `clip ${i + 1}: span is over 90 seconds; pick a tighter run`;
      }
      return null;
    },
  };
}
