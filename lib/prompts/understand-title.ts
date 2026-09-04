// understand_title: the reading pass that turns a title's name, whatever the
// staff typed into synopsis / character notes, and a sample of the script
// into the bible every later pass reads — synopsis zh/en, logline zh/en,
// the cast with English names and one-line notes, and register notes.
// Fills gaps; never overwrites what staff wrote (lib/jobs.ts decides that,
// this module only produces the candidate).

import { z } from "zod";
import type { Character, Title } from "@/lib/types";
import { MODEL_FAST, type LlmSystemBlock } from "@/lib/llm";
import { PROMPT_VERSION, STYLE_ANCHOR, renderLines, type PromptLine } from "./shared";

export const UnderstandTitleSchema = z.object({
  synopsis_zh: z.string().describe("剧情简介，简体中文，120-200 字，只写剧本里有的事实"),
  synopsis_en: z.string().describe("Synopsis for a U.S. reader, 80-140 words, facts from the script only"),
  logline_zh: z.string().describe("一句话 logline，简体中文"),
  logline_en: z.string().describe("One-sentence logline in English"),
  register_notes_zh: z
    .string()
    .describe("整体语气与称呼规则，简体中文：谁叫谁什么、哪些称呼有讽刺意味、节奏（斗嘴多还是抒情多）"),
  register_notes_en: z
    .string()
    .describe("The same register notes for the U.S. editor: who calls whom what, which honorifics carry edge, pace"),
  localization_effort_en: z
    .string()
    .describe("One or two sentences: how hard this title is to adapt for the U.S. and what the recurring swaps will be"),
  characters: z
    .array(
      z.object({
        name_zh: z.string().describe("Exactly as the name appears in the script speaker labels"),
        name_en: z.string().describe("Romanised as an American viewer would see it on screen, e.g. Lin Wan, Shen Yichen"),
        notes: z
          .string()
          .describe("One or two English sentences: role, age if known, how they talk, what drives them. Script facts only"),
      })
    )
    .describe("Every named speaker in the sample, plus characters the notes name"),
});

export type UnderstandTitleOutput = z.infer<typeof UnderstandTitleSchema>;

export type UnderstandTitleInput = {
  title: Pick<Title, "name_zh" | "name_en" | "genre" | "synopsis_zh" | "synopsis_en" | "character_notes" | "episode_count">;
  characters: Pick<Character, "name_zh" | "name_en" | "notes">[];
  /** A bounded sample: the opening of episode 1 and a slice of each later episode. */
  sample: { episode_number: number; lines: PromptLine[] }[];
};

const SYSTEM = `You are the story editor at Pulsar Studio, a U.S. localisation studio for Chinese vertical short dramas (微短剧). You read a title before anyone adapts a line of it.

Your job now: build the title bible from what the producer (制片方) gave us and from the script itself. Facts only — a bible that invents a backstory poisons every rewrite downstream. Where the notes and the script disagree, the script wins; say so in the register notes.

${STYLE_ANCHOR}

Write the Chinese for the producer (简体中文, plain, no marketing voice) and the English for the U.S. editor (not a translation of the Chinese; the same facts, written natively).`;

export function buildUnderstandTitle(input: UnderstandTitleInput) {
  const t = input.title;
  const given: string[] = [`Title: ${t.name_zh}${t.name_en ? ` / ${t.name_en}` : ""}`];
  if (t.genre) given.push(`Genre: ${t.genre}`);
  if (t.episode_count) given.push(`Episodes: ${t.episode_count}`);
  given.push(`Synopsis (zh): ${t.synopsis_zh ?? "(none given)"}`);
  given.push(`Synopsis (en): ${t.synopsis_en ?? "(none given)"}`);
  given.push(`Character notes as written by staff: ${t.character_notes ?? "(none given — derive the cast from the script)"}`);
  if (input.characters.length) {
    given.push(
      `Characters already on file:\n${input.characters
        .map((c) => `- ${c.name_zh}${c.name_en ? ` (${c.name_en})` : ""}${c.notes ? `: ${c.notes}` : ""}`)
        .join("\n")}`
    );
  }
  const sample = input.sample
    .map((s) => `--- Episode ${s.episode_number} (${s.lines.length} lines shown) ---\n${renderLines(s.lines)}`)
    .join("\n\n");

  const system: LlmSystemBlock[] = [{ text: SYSTEM, cache: true }];
  return {
    name: "understand_title",
    description: "Record the title bible: synopsis, logline, register notes and the cast.",
    system,
    user: `WHAT WE WERE GIVEN\n${given.join("\n")}\n\nSCRIPT SAMPLE\n${sample || "(no script ingested yet)"}\n\nBuild the bible. Keep every name_zh exactly as it appears in the speaker labels so rows can be matched.`,
    schema: UnderstandTitleSchema,
    model: MODEL_FAST,
    maxTokens: 8000,
    effort: "medium" as const,
    prompt_version: PROMPT_VERSION,
  };
}
