// What a writing pass knows beyond the source and the title bible, gathered
// once per scene (or per line) and rendered as prompt blocks in authority
// order:
//
//   1. approved memory   — producer-approved lines (house truth, highest)
//   2. house exemplars   — Pulsar-authored literal → studio moves
//   3. register guide    — set phrases and how American series say them
//   4. glosses           — CC-CEDICT meanings for phrases in the scene
//   5. reference pairs   — Tatoeba near-exact matches only (lowest)
//
// The blocks vary per scene, so they always sit AFTER the cached system
// blocks (bible + rules); see buildFirstPass. Fingerprints are recorded on the
// job for audit and never enter idempotency keys: a memory that grew since the
// last click must not silently regenerate what a producer already edited.

import type { LlmSystemBlock } from "@/lib/llm";
import type { ReferenceTranslationMemoryExample, TranslationMemoryExample } from "@/lib/types";
import {
  rankTranslationMemory,
  translationMemoryBlock,
  translationMemoryFingerprint,
  type TranslationMemoryQueryLine,
} from "@/lib/translation-memory";
import {
  loadTatoebaCorpus,
  rankReferenceTranslationMemory,
  referenceMemoryBlock,
  referenceMemoryFingerprint,
} from "@/lib/reference-memory";
import { findGlosses, glossBlock, type Gloss } from "./glosses";
import { houseExemplarBlock, houseExemplarFingerprint, rankHouseExemplars, type HouseExemplar } from "./house-style";
import { idiomBlock, matchIdioms, type IdiomEntry } from "./idioms";

export type Knowledge = {
  approved: TranslationMemoryExample[];
  house: HouseExemplar[];
  idioms: IdiomEntry[];
  glosses: Gloss[];
  reference: ReferenceTranslationMemoryExample[];
  /** Prompt blocks in authority order; empty sources contribute nothing. */
  blocks: LlmSystemBlock[];
  /** Short stable digest of everything retrieved, for the job's input record. */
  fingerprint: string;
  /** Counts for the job's input record. */
  counts: { approved: number; house: number; idioms: number; glosses: number; reference: number };
};

export type KnowledgeOptions = {
  /** Skip the approved-memory ranking (callers without a corpus). */
  approvedMemory?: TranslationMemoryExample[];
  titleId?: string;
  /** Skip the Tatoeba lookup (rewrite/alternatives keep prompts short). */
  reference?: boolean;
  limits?: Partial<{ approved: number; house: number; idioms: number; glosses: number; reference: number }>;
};

export async function gatherKnowledge(lines: TranslationMemoryQueryLine[], opts: KnowledgeOptions = {}): Promise<Knowledge> {
  const texts = lines.map((l) => l.text_zh);
  const limits = { approved: 12, house: 4, idioms: 12, glosses: 10, reference: 3, ...opts.limits };

  const approved =
    opts.approvedMemory && opts.titleId ? rankTranslationMemory(opts.approvedMemory, opts.titleId, lines, limits.approved) : [];
  const house = rankHouseExemplars(lines, limits.house);
  const idioms = matchIdioms(texts, limits.idioms);
  const covered = new Set(idioms.flatMap((e) => e.zh));
  const glosses = await findGlosses(texts, { limit: limits.glosses, skip: covered });
  const reference =
    opts.reference === false ? [] : rankReferenceTranslationMemory(await loadTatoebaCorpus(), lines, limits.reference);

  const blocks: LlmSystemBlock[] = [
    translationMemoryBlock(approved),
    houseExemplarBlock(house),
    idiomBlock(idioms),
    glossBlock(glosses),
    referenceMemoryBlock(reference),
  ]
    .filter((text): text is string => !!text)
    .map((text) => ({ text }));

  const fingerprint = [
    translationMemoryFingerprint(approved),
    houseExemplarFingerprint(house),
    idioms.map((e) => e.zh[0]).join(","),
    glosses.map((g) => g.zh).join(","),
    referenceMemoryFingerprint(reference),
  ].join("|");

  return {
    approved,
    house,
    idioms,
    glosses,
    reference,
    blocks,
    fingerprint,
    counts: {
      approved: approved.length,
      house: house.length,
      idioms: idioms.length,
      glosses: glosses.length,
      reference: reference.length,
    },
  };
}
