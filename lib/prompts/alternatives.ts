// alternatives: other ways to say one line, each with its own
// back-translation, rationale (zh + en) and tags, so the producer has choices
// rather than a single answer. The default batch is TWO takes that pull in
// different directions (their tags name the direction); a follow-up call may
// ask for ONE more take along a specific tag the producer tapped ("take it
// another direction", decisions.md 2026-09-04). Rows land in
// studio.line_alternatives; choosing one copies it onto the line
// (docs/data-model.md § 5).

import { z } from "zod";
import { TAG_LABELS, type AdaptTag, type Scene } from "@/lib/types";
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
  tags: z.array(AdaptTagSchema).describe("1-3 tags from the fixed list; the FIRST tag names the direction this take leans into"),
  syllables_est: z.number().int(),
});

export const AlternativesSchema = z.object({
  alternatives: z.array(AlternativeSchema).describe("the requested number of genuinely different options, best first"),
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
  /** How many takes to write. Default 2. */
  count?: number;
  /** When set, every take must lean into this tag (the producer tapped it). */
  direction?: AdaptTag | null;
  /** Per-line knowledge blocks (lib/memory), appended after the cached system blocks. */
  knowledge?: LlmSystemBlock[];
};

export const DEFAULT_ALTERNATIVES = 2;

const SYSTEM = `You are the lead adapter at Pulsar Studio, offering an editor alternatives for one line of a Chinese vertical short drama adapted for American viewers.

${STYLE_ANCHOR}

${ADAPTATION_RULES}

Alternatives must differ in approach, not in a word: each take leans into a DIFFERENT direction from the tag list (tighter, more emotional, more direct, softened, more casual, cultural swap, idiom, pacing, clarity, humor), and the first tag on each take names that direction. Never repeat the current line, an option already offered, or a direction the current line already takes. Each must fit the same time window as the current line.

When the request names ONE direction, write exactly one take that commits to it fully — that tag comes first on the take — and do not hedge toward the current line.`;

export function buildAlternatives(input: AlternativesInput) {
  const s = input.scene;
  const ctx = [s.context_zh ? `Context (zh): ${s.context_zh}` : null, s.context_en ? `Context (en): ${s.context_en}` : null]
    .filter(Boolean)
    .join("\n");
  const note = input.producer_note
    ? `\nPRODUCER'S NOTE (制片方要求替代方案的原因; address it directly): ${input.producer_note}\n`
    : "";
  const existing = input.existing_en.length ? `\nOPTIONS ALREADY OFFERED (do not repeat)\n${input.existing_en.map((e) => `- ${e}`).join("\n")}\n` : "";
  const direction = input.direction ?? null;
  const count = direction ? 1 : input.count ?? DEFAULT_ALTERNATIVES;
  const ask = direction
    ? `Offer exactly 1 alternative for seq ${input.line.seq} that leans into "${TAG_LABELS[direction].en}" (${direction}); put "${direction}" first in its tags.`
    : `Offer exactly ${count} alternatives for seq ${input.line.seq}, each in a different direction.`;
  const system: LlmSystemBlock[] = [input.bible, { text: SYSTEM, cache: true }, ...(input.knowledge ?? [])];
  return {
    name: "alternatives",
    description: `Record exactly ${count} alternative adaptation${count === 1 ? "" : "s"} of the line.`,
    system,
    user: `Episode ${input.episode_number}, scene ${s.number}\n${ctx}\n\nEXCHANGE (for fit)\n${renderLines(input.around)}\n\nTHE LINE\n${renderLine(input.line)}\nliteral: ${input.line.literal_en ?? "(none)"}\ncurrent rationale: ${input.line.current_rationale_en ?? "(none)"}\n${note}${existing}\n${ask}`,
    schema: AlternativesSchema,
    model: MODEL_STRONG,
    maxTokens: 4000,
    effort: "high" as const,
    prompt_version: PROMPT_VERSION,
    check: (out: AlternativesOutput) => {
      if (out.alternatives.length !== count) return `Return exactly ${count} alternative(s), not ${out.alternatives.length}`;
      if (direction && !out.alternatives.every((a) => a.tags.includes(direction))) {
        return `Every take must carry the "${direction}" tag — that is the direction the producer asked for`;
      }
      return null;
    },
  };
}
