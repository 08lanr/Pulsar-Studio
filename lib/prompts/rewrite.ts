// rewrite: an explicit, instruction-driven redo of one line — "regenerate"
// (a fresh take), "shorten" (fit a tighter window), or free text from the
// editor ("keep the honorific", "make her angrier"). Never a silent re-run:
// this is the only path that replaces an AI line after the first pass
// (docs/data-model.md § 5).

import { z } from "zod";
import type { Scene } from "@/lib/types";
import { MODEL_STRONG, type LlmSystemBlock } from "@/lib/llm";
import {
  ADAPTATION_RULES,
  AdaptTagSchema,
  ChangeTypeSchema,
  PROMPT_VERSION,
  STYLE_ANCHOR,
  renderLine,
  renderLines,
  type PromptLine,
} from "./shared";

export const RewriteSchema = z.object({
  text_en: z.string().nullable().describe("The new line; null only when change_type is cut"),
  back_translation_zh: z.string().nullable(),
  key_phrase_en: z.string().nullable().describe("the EXACT substring of text_en that carries the change; null when nothing stands out"),
  rationale_zh: z.string().describe("为什么这样改，写给制片方，1-2 句简体中文"),
  rationale_en: z.string(),
  tone_note_zh: z.string().nullable(),
  tone_note_en: z.string().nullable(),
  change_type: ChangeTypeSchema,
  tags: z.array(AdaptTagSchema),
  is_major: z.boolean(),
  syllables_est: z.number().int(),
});

export type RewriteOutput = z.infer<typeof RewriteSchema>;

export type RewriteInstruction = "regenerate" | "shorten" | string;

export type RewriteInput = {
  bible: LlmSystemBlock;
  episode_number: number;
  scene: Pick<Scene, "number" | "context_zh" | "context_en">;
  line: PromptLine & { literal_en: string | null; current_rationale_en: string | null };
  around: PromptLine[];
  instruction: RewriteInstruction;
  producer_note: string | null;
  /** Per-line knowledge blocks (lib/memory), appended after the cached system blocks. */
  knowledge?: LlmSystemBlock[];
};

const SYSTEM = `You are the lead adapter at Pulsar Studio, redoing one line of a Chinese vertical short drama adapted for American viewers because the editor asked.

${STYLE_ANCHOR}

${ADAPTATION_RULES}

Follow the instruction literally. "regenerate" means a fresh take that is clearly different from the current line. "shorten" means the same meaning in fewer syllables so it fits its window (aim for 25-40% fewer). Any other instruction is the editor's own words: do what they say and nothing more, and keep the rest of the line as it was.`;

function describeInstruction(i: RewriteInstruction): string {
  if (i === "regenerate") return "regenerate — a fresh, different take on the line";
  if (i === "shorten") return "shorten — same meaning, fewer syllables, fits the window";
  return `editor's instruction — ${i}`;
}

export function buildRewrite(input: RewriteInput) {
  const s = input.scene;
  const ctx = [s.context_zh ? `Context (zh): ${s.context_zh}` : null, s.context_en ? `Context (en): ${s.context_en}` : null]
    .filter(Boolean)
    .join("\n");
  const note = input.producer_note ? `\nPRODUCER'S NOTE on this scene: ${input.producer_note}\n` : "";
  const system: LlmSystemBlock[] = [input.bible, { text: SYSTEM, cache: true }, ...(input.knowledge ?? [])];
  return {
    name: "rewrite",
    description: "Record the rewritten line.",
    system,
    user: `Episode ${input.episode_number}, scene ${s.number}\n${ctx}\n\nEXCHANGE (for fit)\n${renderLines(input.around)}\n\nTHE LINE\n${renderLine(input.line)}\nliteral: ${input.line.literal_en ?? "(none)"}\ncurrent rationale: ${input.line.current_rationale_en ?? "(none)"}\n${note}\nINSTRUCTION: ${describeInstruction(input.instruction)}\n\nRewrite seq ${input.line.seq}.`,
    schema: RewriteSchema,
    model: MODEL_STRONG,
    maxTokens: 3000,
    effort: "high" as const,
    prompt_version: PROMPT_VERSION,
    check: (out: RewriteOutput) => {
      if (out.change_type === "cut" && out.text_en) return "change_type cut must have text_en null";
      if (out.change_type !== "cut" && !out.text_en) return "text_en is empty";
      if (out.change_type === "add") return "change_type add is not allowed";
      return null;
    },
  };
}
