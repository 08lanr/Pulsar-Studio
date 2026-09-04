import assert from "node:assert/strict";
import test from "node:test";
import type { ReferenceTranslationMemoryExample } from "@/lib/types";
import {
  REFERENCE_MIN_SCORE,
  loadTatoebaCorpus,
  rankReferenceTranslationMemory,
  referenceMemoryBlock,
  referenceMemoryFingerprint,
} from "@/lib/reference-memory";

function example(
  sourceSentenceId: number,
  textZh: string,
  textEn: string
): ReferenceTranslationMemoryExample {
  return {
    source: "tatoeba",
    source_sentence_id: sourceSentenceId,
    translation_sentence_id: sourceSentenceId + 1_000,
    source_owner: "native_zh",
    translation_owner: "native_en",
    source_license: "CC BY 2.0 FR",
    translation_license: "CC BY 2.0 FR",
    text_zh: textZh,
    text_en: textEn,
  };
}

test("reference retrieval keeps exact and near-identical dialogue only", () => {
  const exact = example(1, "你到底想干什么？", "What the hell do you want?");
  const near = example(2, "你到底想干嘛？", "What do you want?");
  const shareWords = example(3, "你想吃什么？", "What do you want to eat?");
  const unrelated = example(4, "明天会下雨。", "It'll rain tomorrow.");
  const ranked = rankReferenceTranslationMemory([unrelated, shareWords, near, exact], [
    { text_zh: "你到底想干什么！", speaker: null },
  ]);
  assert.equal(ranked[0]?.source_sentence_id, exact.source_sentence_id);
  assert.ok(ranked.some((row) => row.source_sentence_id === near.source_sentence_id));
  assert.ok(!ranked.some((row) => row.source_sentence_id === shareWords.source_sentence_id), "shared function words are not a match");
  assert.ok(!ranked.some((row) => row.source_sentence_id === unrelated.source_sentence_id));
});

test("the bundled corpus no longer returns textbook noise for real drama lines", async () => {
  const corpus = await loadTatoebaCorpus();
  assert.ok(corpus.length >= 10_000);
  assert.ok(corpus.every((row) => row.source_owner && row.translation_owner));
  // The probe that motivated the threshold: these matched "paint the wall",
  // "I go to university" and "He is on the road" under plain bigram Dice.
  const noisy = ["咱们准备开始汇报", "可能我去上海开过会", "路上有点堵车", "你就是向园"];
  for (const text_zh of noisy) {
    assert.deepEqual(rankReferenceTranslationMemory(corpus, [{ text_zh, speaker: null }]), [], text_zh);
  }
  // A genuinely stock line still finds its pair.
  const stock = rankReferenceTranslationMemory(corpus, [{ text_zh: "没办法。", speaker: null }]);
  assert.ok(stock.length >= 1);
  assert.ok(stock.length <= 3, "capped small");
  assert.ok(REFERENCE_MIN_SCORE >= 0.5);
});

test("reference prompt labels community data as lowest authority", () => {
  const rows = [example(1, "别走。", "Don't go.")];
  const block = referenceMemoryBlock(rows) ?? "";
  assert.match(block, /lowest authority/i);
  assert.match(block, /may contain errors/i);
  assert.match(block, /Everything above this block wins/i);
  assert.equal(referenceMemoryFingerprint(rows), referenceMemoryFingerprint(rows));
  assert.notEqual(referenceMemoryFingerprint(rows), referenceMemoryFingerprint([{ ...rows[0], text_en: "Stay." }]));
});
