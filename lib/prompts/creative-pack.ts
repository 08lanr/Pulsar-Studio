// propose_variants: the creative pack for a title — 5 U.S. title options,
// 10 hooks, 3 short descriptions, 3-5 thumbnail concepts as text and 4-6 ad
// angles, each with a rationale in both languages and angle tags. Run on the
// adapted script (approved snapshot when one exists, else the latest) plus
// the bible; one job per batch (docs/data-model.md § 5). Rows land in
// studio.variants; nothing here reaches Reach in V1.

import { z } from "zod";
import type { Variant } from "@/lib/types";
import { MODEL_STRONG, type LlmSystemBlock } from "@/lib/llm";
import { AdAngleSchema, PROMPT_VERSION, STYLE_ANCHOR } from "./shared";

export const VariantItemSchema = z.object({
  text_en: z.string(),
  text_zh: z.string().describe("简体中文版本，给制片方看的；不是逐字翻译，但意思要一致"),
  rationale_zh: z.string().describe("为什么这个选项可能有效，1 句简体中文"),
  rationale_en: z.string().describe("Why this could work for a U.S. paid-social audience, one sentence"),
  tags: z.array(AdAngleSchema).describe("1-2 ad angles this leans on"),
});

export const CreativePackSchema = z.object({
  titles: z.array(VariantItemSchema).describe("Exactly 5 U.S. title options, 2-6 words each"),
  hooks: z
    .array(VariantItemSchema)
    .describe("Exactly 10 hooks: the first line of an ad or a text card, each understandable with zero context, under 20 words"),
  descriptions: z.array(VariantItemSchema).describe("Exactly 3 short descriptions, 40-70 words, platform-listing register"),
  thumbnail_concepts: z
    .array(VariantItemSchema)
    .describe("3-5 thumbnail concepts as text: the frame, who is in it, the overlay text in quotes"),
  ad_angles: z
    .array(VariantItemSchema)
    .describe("4-6 ad angles: the angle name, then how to cut for it in one sentence"),
});

export type CreativePackOutput = z.infer<typeof CreativePackSchema>;

export type CreativePackEpisodeDigest = {
  episode_number: number;
  name_zh: string | null;
  /** Which script the lines came from, so the pack page can say. */
  source: "approved" | "in_review" | "draft" | "source_only";
  scene_contexts_en: string[];
  /** speaker: English (or Chinese when not yet adapted). Bounded by the caller. */
  lines: string[];
};

export type CreativePackInput = {
  bible: LlmSystemBlock;
  episodes: CreativePackEpisodeDigest[];
  /** The current platform picks, kept so the new batch does not just repeat them. */
  selected: Pick<Variant, "kind" | "text_en">[];
  /** Options already generated, to steer away from repeats. */
  existing_en: Pick<Variant, "kind" | "text_en">[];
};

const SYSTEM = `You are the creative lead at Pulsar Studio writing the paid-social creative pack for a Chinese vertical short drama adapted for U.S. viewers on TikTok and Meta.

${STYLE_ANCHOR}

RULES
- Every hook must work with zero context: a viewer who has never heard of the show, three seconds in, mid-scroll. No character names unless the name is the hook. No honorifics that need China to parse.
- Titles are for an American app tile: short, concrete, no pinyin, no translationese.
- Descriptions read like a streaming listing, present tense, the premise and the turn, no spoilers past the first reveal that the ads themselves will use.
- Thumbnail concepts describe a frame a human editor can pull from the footage: setting, who, expression, and the overlay text in quotes.
- Ad angles name the angle (from the fixed list) and say how to cut for it: what to open on, what to end on.
- Never invent a plot beat the script does not contain. Every claim in a hook must be something the show actually delivers.
- Chinese text is for the producer (制片方): natural 简体中文 carrying the same idea, not a word-for-word rendering.
- Do not repeat options already on file; differ in angle, not wording.`;

export function buildCreativePack(input: CreativePackInput) {
  const digest = input.episodes
    .map(
      (e) =>
        `--- Episode ${e.episode_number}${e.name_zh ? ` ${e.name_zh}` : ""} (script: ${e.source}) ---\n` +
        (e.scene_contexts_en.length ? `Scenes: ${e.scene_contexts_en.join(" | ")}\n` : "") +
        e.lines.join("\n")
    )
    .join("\n\n");
  const selected = input.selected.length
    ? `\nCURRENT PLATFORM PICKS\n${input.selected.map((v) => `- ${v.kind}: ${v.text_en}`).join("\n")}\n`
    : "";
  const existing = input.existing_en.length
    ? `\nALREADY ON FILE (do not repeat)\n${input.existing_en.map((v) => `- ${v.kind}: ${v.text_en}`).join("\n")}\n`
    : "";
  const system: LlmSystemBlock[] = [input.bible, { text: SYSTEM, cache: true }];
  return {
    name: "propose_variants",
    description: "Record the creative pack: titles, hooks, descriptions, thumbnail concepts, ad angles.",
    system,
    user: `THE SCRIPT\n${digest}\n${selected}${existing}\nWrite the pack: exactly 5 titles, 10 hooks, 3 descriptions, 3-5 thumbnail concepts, 4-6 ad angles.`,
    schema: CreativePackSchema,
    model: MODEL_STRONG,
    maxTokens: 16000,
    effort: "high" as const,
    prompt_version: PROMPT_VERSION,
    check: (out: CreativePackOutput) => {
      const problems: string[] = [];
      if (out.titles.length !== 5) problems.push(`titles: want 5, got ${out.titles.length}`);
      if (out.hooks.length !== 10) problems.push(`hooks: want 10, got ${out.hooks.length}`);
      if (out.descriptions.length !== 3) problems.push(`descriptions: want 3, got ${out.descriptions.length}`);
      if (out.thumbnail_concepts.length < 3 || out.thumbnail_concepts.length > 5)
        problems.push(`thumbnail_concepts: want 3-5, got ${out.thumbnail_concepts.length}`);
      if (out.ad_angles.length < 4 || out.ad_angles.length > 6) problems.push(`ad_angles: want 4-6, got ${out.ad_angles.length}`);
      return problems.length ? problems.join("\n") : null;
    },
  };
}
