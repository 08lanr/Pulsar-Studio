// understand_scene: the one-paragraph context (zh + en) for a scene — where
// we are, who wants what, what the beat is — written before the first pass
// so the rewrite has something to be faithful to beyond the line itself.
// Stored on studio.scenes.context_zh / context_en and shown on the
// workbench and in the partner review.

import { z } from "zod";
import type { Scene } from "@/lib/types";
import { MODEL_FAST, type LlmSystemBlock } from "@/lib/llm";
import { PROMPT_VERSION, STYLE_ANCHOR, fmtMs, renderLines, type PromptLine } from "./shared";

export const UnderstandSceneSchema = z.object({
  context_zh: z
    .string()
    .describe("场景说明，简体中文，2-4 句：地点/时间、在场人物、各自想要什么、这场戏的情绪节拍。只写剧本里有的"),
  context_en: z
    .string()
    .describe("The same for the U.S. editor, 2-4 sentences, written natively; not a translation of the Chinese"),
});

export type UnderstandSceneOutput = z.infer<typeof UnderstandSceneSchema>;

export type UnderstandSceneInput = {
  bible: LlmSystemBlock;
  episode_number: number;
  scene: Pick<Scene, "number" | "start_ms" | "end_ms">;
  lines: PromptLine[];
  /** The previous scene's context, for continuity; null for scene 1. */
  previous_context_zh: string | null;
};

const SYSTEM = `You are the story editor at Pulsar Studio. Before a scene is adapted for American viewers you write its context: the paragraph an editor reads to know what the beat is before touching a line.

Facts from the script and the bible only. No speculation about what happens later unless the bible states it. Name characters as the bible does.

${STYLE_ANCHOR}`;

export function buildUnderstandScene(input: UnderstandSceneInput) {
  const s = input.scene;
  const header = `Episode ${input.episode_number}, scene ${s.number}${
    s.start_ms !== null ? ` (${fmtMs(s.start_ms)}-${fmtMs(s.end_ms)})` : ""
  }`;
  const prev = input.previous_context_zh ? `Previous scene's context (zh): ${input.previous_context_zh}\n\n` : "";
  const system: LlmSystemBlock[] = [input.bible, { text: SYSTEM, cache: true }];
  return {
    name: "understand_scene",
    description: "Record the scene context in Chinese and English.",
    system,
    user: `${header}\n\n${prev}LINES\n${renderLines(input.lines)}\n\nWrite the context for this scene.`,
    schema: UnderstandSceneSchema,
    model: MODEL_FAST,
    maxTokens: 2000,
    effort: "low" as const,
    prompt_version: PROMPT_VERSION,
  };
}
