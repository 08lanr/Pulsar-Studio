// Fixture mode must never reach a model (CLAUDE.md). Every real model call
// funnels through runJob in lib/jobs.ts, which refuses while demo replay is
// on — so a key in .env.local cannot spend money from a demo, and the
// producer sees a plain explanation rather than an engineering hint.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { demoReplayActive } from "@/lib/data-source";
import { resetFixtureStore, fixtureData } from "@/lib/data/fixture";
import { LlmUnavailableError } from "@/lib/llm";
import { runAlternatives, runRewrite } from "@/lib/jobs";
import { producer, seedMinute } from "./seed-minute";

const saved = { replay: process.env.DEMO_REPLAY, source: process.env.DATA_SOURCE, key: process.env.ANTHROPIC_API_KEY };

beforeEach(() => {
  delete process.env.DEMO_REPLAY;
  delete process.env.DATA_SOURCE;
  // A key present is the realistic dev setup that made the leak dangerous.
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
});
afterEach(() => {
  resetFixtureStore();
  for (const [k, v] of [["DEMO_REPLAY", saved.replay], ["DATA_SOURCE", saved.source], ["ANTHROPIC_API_KEY", saved.key]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("demo replay is on by default in fixture mode and DEMO_REPLAY=0 is the only override", () => {
  assert.equal(demoReplayActive(), true);
  process.env.DEMO_REPLAY = "0";
  assert.equal(demoReplayActive(), false);
  delete process.env.DEMO_REPLAY;
  process.env.DATA_SOURCE = "supabase";
  assert.equal(demoReplayActive(), false, "replay is a fixture-mode concept");
});

test("with replay on, rewrite and alternatives refuse before any model call, in producer words", async () => {
  const t = await seedMinute({ adapt: true });
  const wb = await fixtureData.getWorkbench(producer(), t.id, 1);
  const adapted = wb.adapted_lines[0];
  const ctx = { titleId: t.id, episodeNumber: 1 };

  await assert.rejects(
    runRewrite(producer(), adapted.id, "regenerate", ctx),
    (e: unknown) => e instanceof LlmUnavailableError && /demo mode/.test(e.message) && !/API_KEY/.test(e.message)
  );
  await assert.rejects(
    runAlternatives(producer(), adapted.id, ctx),
    (e: unknown) => e instanceof LlmUnavailableError && /demo mode/.test(e.message)
  );
  // Nothing was recorded as spend.
  const after = await fixtureData.getWorkbench(producer(), t.id, 1);
  assert.equal(after.adapted_lines[0].text_en, adapted.text_en, "the line is untouched");
});
