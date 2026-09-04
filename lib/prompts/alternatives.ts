// alternatives: two or three other ways to say one line, each with its own
// back-translation, rationale (zh + en) and tags, so the editor (or the
// producer's needs_alternative note) has choices rather than a single
// answer. Rows land in studio.line_alternatives; choosing one copies it onto
// the line (docs/data-model.md § 5).

import { z } from "zod";
import type { Scene } from "@/lib/types";
import { MODEL_STRONG, type LlmSystemBlock } from "@/lib/llm";
import {
  ADAPTATION_RULES,
  AdaptTagSchema,
  PROMPT_VERSION,
  STYLE_ANCHOR,
  renderLine,
  renderLines,
  type PromptLine,
} from "./shared";

export const AlternativeSchema = z.object({
  text_en: z.string(),
  back_translation_zh: z.string(),
  rationale_zh: z.string().describe("这一版本为什么值得考虑，1 句简体中文，写给制片方"),
  rationale_en: z.string().describe("Why this option, one sentence for the U.S. editor"),
  tags: z.array(AdaptTagSchema).describe("2-3 tags from the fixed list"),
  syllables_est: z.number().int(),
});

export const AlternativesSchema = z.object({
  alternatives: z.array(AlternativeSchema).describe("exactly 3 genuinely different options, best first"),
});

export type AlternativeOutput = z.infer<typeof AlternativeSchema>;
export type AlternativesOutput = z.infer<typeof AlternativesSchema>;

export type AlternativesInput = {
  bible: LlmSystemBlock;
  episode_number: number;
  scene: Pick<Scene, "number" | "context_zh" | "context_en">;
  /** The line itself, with its current English. */
  line: PromptLine & { literal_en: string | null; current_rationale_en: string | null };
  /** Up to three lines either side, with their English, so the option fits the exchange. */
  around: PromptLine[];
  /** Already-offered options, so the new ones differ. */
  existing_en: string[];
  /** The producer's needs_alternative note for this scene, when there is one: the reason the line is being redone. */
  producer_note: string | null;
};

const SYSTEM = `You are the lead adapter at Pulsar Studio, offering an editor alternatives for one line of a Chinese vertical short drama adapted for American viewers.

${STYLE_ANCHOR}

${ADAPTATION_RULES}

Alternatives must differ in approach, not in a word: one tighter, one that leans into the emotion, one that plays the subtext or the humour — whichever three angles this line actually supports. Never repeat the current line or an option already offered. Each must fit the same time window as the current line.`;

export function buildAlternatives(input: AlternativesInput) {
  const s = input.scene;
  const ctx = [s.context_zh ? `Context (zh): ${s.context_zh}` : null, s.context_en ? `Context (en): ${s.context_en}` : null]
    .filter(Boolean)
    .join("\n");
  const note = input.producer_note
    ? `\nPRODUCER'S NOTE (制片方要求替代方案的原因; address it directly): ${input.producer_note}\n`
    : "";
  const existing = input.existing_en.length ? `\nOPTIONS ALREADY OFFERED (do not repeat)\n${input.existing_en.map((e) => `- ${e}`).join("\n")}\n` : "";
  const system: LlmSystemBlock[] = [input.bible, { text: SYSTEM, cache: true }];
  return {
    name: "alternatives",
    description: "Record exactly 3 alternative adaptations of the line.",
    system,
    user: `Episode ${input.episode_number}, scene ${s.number}\n${ctx}\n\nEXCHANGE (for fit)\n${renderLines(input.around)}\n\nTHE LINE\n${renderLine(input.line)}\nliteral: ${input.line.literal_en ?? "(none)"}\ncurrent rationale: ${input.line.current_rationale_en ?? "(none)"}\n${note}${existing}\nOffer exactly 3 alternatives for seq ${input.line.seq}.`,
    schema: AlternativesSchema,
    model: MODEL_STRONG,
    maxTokens: 4000,
    effort: "high" as const,
    prompt_version: PROMPT_VERSION,
    check: (out: AlternativesOutput) =>
      out.alternatives.length < 2 || out.alternatives.length > 3
        ? `Return exactly 3 alternatives, not ${out.alternatives.length}`
        : null,
  };
}
