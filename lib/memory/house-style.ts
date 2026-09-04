// House exemplars: the Pulsar-authored demo bank (data/fixture/canned*.ts) is
// the largest body of "how WE adapt" in the repo — each line carries the
// literal, the rewrite, the key phrase and the why. Retrieving the closest
// few into every writing pass shows the model the TRANSFORMATION, not just a
// target sentence. Authority: house style, below producer-approved memory,
// above any external corpus. Cross-title by design (it is our writing, not a
// producer's IP), so the prompt forbids importing its plot facts.

import { createHash } from "node:crypto";
import { cannedExemplars } from "@/data/fixture/canned";
import type { AdaptTag, ChangeType } from "@/lib/types";
import { BigramIndex } from "./rank";

export type HouseExemplar = {
  text_zh: string;
  literal_en: string | null;
  text_en: string;
  key_phrase_en: string | null;
  rationale_en: string | null;
  change_type: ChangeType;
  tags: AdaptTag[];
};

let index: BigramIndex<HouseExemplar> | null = null;
let all: HouseExemplar[] = [];

function load(): BigramIndex<HouseExemplar> {
  if (index) return index;
  all = cannedExemplars()
    .filter(({ line }) => line.text_en && line.change_type !== "keep" && line.change_type !== "cut")
    .map(({ zh, line }) => ({
      text_zh: zh,
      literal_en: line.literal_en ?? null,
      text_en: line.text_en,
      key_phrase_en: line.key_phrase_en ?? null,
      rationale_en: line.rationale_en ?? null,
      change_type: line.change_type,
      tags: line.tags ?? [],
    }));
  index = new BigramIndex(all, (e) => e.text_zh);
  return index;
}

export function houseExemplarCount(): number {
  return load().size;
}

/**
 * The closest exemplars to a scene's lines. Lexical closeness is a weak
 * proxy for "same kind of beat", so the bar is low and the cap small; when
 * nothing clears it the pass still gets nothing rather than noise.
 */
export function rankHouseExemplars(lines: { text_zh: string }[], limit = 4, minScore = 0.22): HouseExemplar[] {
  return load()
    .query(lines.map((l) => l.text_zh), limit, minScore)
    .map((h) => h.item);
}

export function houseExemplarFingerprint(examples: HouseExemplar[]): string {
  const stable = examples.map((e) => [e.text_zh, e.text_en]);
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 12);
}

export function houseExemplarBlock(examples: HouseExemplar[]): string | null {
  if (!examples.length) return null;
  const rows = examples.map((e, i) => {
    const tags = e.tags.length ? ` [${e.tags.join(", ")}]` : "";
    return [
      `[house ${i + 1}]${tags}`,
      `  zh:      ${e.text_zh}`,
      e.literal_en ? `  literal: ${e.literal_en}` : null,
      `  studio:  ${e.text_en}${e.key_phrase_en ? `   (key phrase: "${e.key_phrase_en}")` : ""}`,
      e.rationale_en ? `  why:     ${e.rationale_en}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return `HOUSE EXEMPLARS (adapted by Pulsar editors for other titles)
Study the move from literal to studio line: what was cut, what was sharpened, where the American register comes from. Match the MOVE, not the words. These are other stories: never import a name, relationship or plot fact from them.

${rows.join("\n")}`;
}
