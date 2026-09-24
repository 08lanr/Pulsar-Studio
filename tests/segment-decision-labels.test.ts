// The film-run log names every decision in words (UI sweep 2026-09-24): each
// action a run can record (lib/segment/stages.ts DECISION) has its seg.decision.*
// label in both languages, and no label is left for a code that does not exist.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DECISION } from "@/lib/segment/stages";
import en from "@/locales/en.json";
import zh from "@/locales/zh.json";

const EN = en as Record<string, string>;
const ZH = zh as Record<string, string>;

test("every film-run decision has a label in English and Chinese, and every label names a real decision", () => {
  const codes = new Set<string>(Object.values(DECISION));
  for (const code of codes) {
    assert.ok(EN[`seg.decision.${code}`], `seg.decision.${code} (en)`);
    assert.ok(ZH[`seg.decision.${code}`], `seg.decision.${code} (zh)`);
  }
  for (const locale of [EN, ZH]) {
    for (const key of Object.keys(locale).filter((k) => k.startsWith("seg.decision."))) {
      assert.ok(codes.has(key.slice("seg.decision.".length)), `${key} names no decision`);
    }
  }
});
