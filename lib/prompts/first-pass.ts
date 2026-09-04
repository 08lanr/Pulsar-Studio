// first_pass: the AI adaptation of one scene, line by line. For every
// source line: the literal English (the diff baseline the workbench shows),
// the Studio line, its Chinese back-translation for the producer, the
// rationale in both languages, an optional tone note, the change type,
// tags, the is_major flag and a syllable count. One scene per call so the
// job is keyed and retried per scene (docs/data-model.md § 5).

import { z } from "zod";
import type { Scene } from "@/lib/types";
import { MODEL_STRONG, type LlmSystemBlock } from "@/lib/llm";
import {
  ADAPTATION_RULES,
  AdaptTagSchema,
  ChangeTypeSchema,
  PROMPT_VERSION,
  STYLE_ANCHOR,
  checkSeqCoverage,
  fmtMs,
  renderLines,
  type PromptLine,
} from "./shared";

export const AdaptedLineSchema = z.object({
  seq: z.number().int().describe("The input seq this line answers"),
  literal_en: z.string().describe("A faithful literal translation; the baseline the diff is shown against"),
  text_en: z.string().nullable().describe("The Studio line for the American viewer; null only when change_type is cut"),
  back_translation_zh: z.string().nullable().describe("text_en rendered back into natural 简体中文; null when cut"),
  key_phrase_en: z
    .string()
    .nullable()
    .describe("the EXACT substring of text_en that carries the change the rationale explains; null for keep/literal/cut"),
  rationale_zh: z.string().describe("为什么这样改编，写给制片方，1-2 句简体中文"),
  rationale_en: z.string().describe("Why this version, for the U.S. editor"),
  tone_note_zh: z.string().nullable().describe("语气变化，几个字；没有变化则 null"),
  tone_note_en: z.string().nullable().describe("The tone shift in a few words; null when unchanged"),
  change_type: ChangeTypeSchema,
  tags: z.array(AdaptTagSchema).describe("2-3 tags from the fixed list"),
  is_major: z.boolean(),
  syllables_est: z.number().int().describe("English syllables in text_en; 0 when cut"),
});

export const FirstPassSchema = z.object({
  lines: z.array(AdaptedLineSchema).describe("One entry per input line, in seq order"),
});

export type FirstPassLine = z.infer<typeof AdaptedLineSchema>;
export type FirstPassOutput = z.infer<typeof FirstPassSchema>;

export type FirstPassInput = {
  bible: LlmSystemBlock;
  episode_number: number;
  scene: Pick<Scene, "number" | "start_ms" | "end_ms" | "context_zh" | "context_en">;
  lines: PromptLine[];
  /** The tail of the previous scene's adaptation, so a scene break does not reset the voice. */
  previous_tail: { speaker: string | null; text_zh: string; text_en: string | null }[];
  /** Lines the editor already rewrote by hand; the model adapts them anyway (for continuity) but they are not written back. */
  has_timecodes: boolean;
};

const SYSTEM = `You are the lead adapter at Pulsar Studio. You turn the dialogue of a Chinese vertical short drama into the lines American viewers will hear and read, scene by scene, and you explain every choice to the producer (制片方) in Chinese and to the U.S. editor in English.

${STYLE_ANCHOR}

${ADAPTATION_RULES}

Output discipline: one entry per input line, same seq, in order. The literal_en is a real literal translation (what a careful translator would write), so the editor can see the distance between literal and Studio. When the literal already works in an American mouth, say change_type "keep" and text_en equals literal_en.`;

export function buildFirstPass(input: FirstPassInput) {
  const s = input.scene;
  const header = `Episode ${input.episode_number}, scene ${s.number}${
    s.start_ms !== null ? ` (${fmtMs(s.start_ms)}-${fmtMs(s.end_ms)})` : ""
  }`;
  const ctx = [
    s.context_zh ? `Context (zh): ${s.context_zh}` : null,
    s.context_en ? `Context (en): ${s.context_en}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const tail = input.previous_tail.length
    ? `END OF PREVIOUS SCENE (already adapted; match its voice)\n${input.previous_tail
        .map((l) => `${l.speaker ?? "?"}: ${l.text_zh}\n    en: ${l.text_en ?? "(cut)"}`)
        .join("\n")}\n\n`
    : "";
  const windowNote = input.has_timecodes
    ? "Each line shows its on-screen window and a HARD budget: text_en must stay within the given character count (letters and punctuation, spaces excluded) so it reads at ≤17 chars/sec. Cutting a beat to fit is better than overrunning — never exceed the budget."
    : "This script has no timecodes: treat every line as a normal spoken beat and keep lengths natural.";
  const system: LlmSystemBlock[] = [input.bible, { text: SYSTEM, cache: true }];
  const expected = input.lines.map((l) => l.seq);
  return {
    name: "first_pass",
    description: "Record the adaptation of every line in the scene.",
    system,
    user: `${header}\n${ctx}\n\n${tail}LINES TO ADAPT (${input.lines.length})\n${renderLines(input.lines)}\n\n${windowNote} Adapt every line.`,
    schema: FirstPassSchema,
    model: MODEL_STRONG,
    maxTokens: 24000,
    effort: "high" as const,
    prompt_version: PROMPT_VERSION,
    check: (out: FirstPassOutput) => {
      const cover = checkSeqCoverage(expected, out.lines.map((l) => l.seq));
      if (cover) return cover;
      for (const l of out.lines) {
        if (l.change_type === "cut" && l.text_en) return `seq ${l.seq}: change_type cut must have text_en null`;
        if (l.change_type !== "cut" && !l.text_en) return `seq ${l.seq}: text_en is empty but change_type is ${l.change_type}`;
        if (l.change_type === "add") return `seq ${l.seq}: change_type add is not allowed in this version`;
      }
      return null;
    },
  };
}
