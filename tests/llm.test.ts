// lib/llm without a network: the price table, the per-call provider choice
// (decision 2026-09-22: text on one gateway, frames on another), the vision
// status the ads page reads, and the image blocks each dialect wants. Every
// refusal here happens before a request could be made.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { z } from "zod";
import { assertModelCallsAllowed } from "@/lib/jobs";
import {
  DEFAULT_MODELS,
  KEY_VAR,
  LlmUnavailableError,
  PRICES,
  adsTextProvider,
  anthropicUserContent,
  chatUserContent,
  costCents,
  imageDataUri,
  isLlmAvailable,
  loadImages,
  modelFor,
  modelSupportsVision,
  priceFor,
  resolveCall,
  responsesUserInput,
  visionProviderStatus,
  type LlmProvider,
} from "@/lib/llm";

const PROVIDERS: LlmProvider[] = ["anthropic", "openai", "deepseek"];

test("every default model of every provider has a list price; the discontinued DeepSeek ids are gone", () => {
  for (const p of PROVIDERS) {
    for (const tier of ["fast", "strong"] as const) {
      const model = DEFAULT_MODELS[p][tier];
      assert.ok(PRICES[model], `${p} ${tier} (${model}) must be priced`);
    }
  }
  assert.equal(PRICES["deepseek-chat"], undefined, "deepseek-chat was discontinued 2026-07-24");
  assert.equal(PRICES["deepseek-reasoner"], undefined);
  assert.equal(DEFAULT_MODELS.deepseek.fast, "deepseek-flash");
  assert.equal(DEFAULT_MODELS.deepseek.strong, "deepseek-v4-pro");
  // The legacy ids DeepSeek still serves are priced like the model that answers them.
  assert.deepEqual(PRICES["deepseek-v4-flash"], PRICES["deepseek-flash"]);
  assert.deepEqual(PRICES["deepseek-v4-flash-vision-exp"], PRICES["deepseek-flash"]);
});

test("an unknown model is charged at the dearest tier, never under-reported", () => {
  assert.deepEqual(priceFor("some-model-that-does-not-exist"), PRICES["claude-fable-5-1"]);
});

test("DeepSeek is charged at peak rates and every non-zero call is at least one cent", () => {
  const z0 = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  assert.equal(costCents("deepseek-flash", { ...z0, input_tokens: 1_000_000 }), 30, "cache miss $0.30 per million at peak");
  assert.equal(costCents("deepseek-flash", { ...z0, output_tokens: 1_000_000 }), 120);
  assert.equal(costCents("deepseek-flash", { ...z0, cache_read_tokens: 1_000_000 }), 1, "cache hit $0.006 rounds up");
  assert.equal(costCents("deepseek-v4-pro", { ...z0, input_tokens: 1_000_000 }), 132);
  assert.equal(costCents("deepseek-v4-pro", { ...z0, output_tokens: 1_000_000 }), 396);
  assert.equal(costCents("deepseek-flash", { ...z0, input_tokens: 10 }), 1, "a 0.0003-cent call is a 1-cent row");
  assert.equal(costCents("deepseek-flash", z0), 0);
});

test("modelFor: the env overrides apply to the process-wide provider only", () => {
  const env = { LLM_PROVIDER: "anthropic", LLM_MODEL_FAST: "claude-haiku-4-5", LLM_MODEL_STRONG: "claude-opus-4-8" };
  assert.equal(modelFor("anthropic", "fast", env), "claude-haiku-4-5");
  assert.equal(modelFor("anthropic", "strong", env), "claude-opus-4-8");
  assert.equal(modelFor("deepseek", "fast", env), "deepseek-flash", "a Claude id is never sent to DeepSeek");
  assert.equal(modelFor("deepseek", "strong", env), "deepseek-v4-pro");
  assert.equal(modelFor("deepseek", "fast", { LLM_PROVIDER: "deepseek", LLM_MODEL_FAST: "deepseek-v4-pro" }), "deepseek-v4-pro");
  assert.equal(modelFor("anthropic", "fast", {}), "claude-sonnet-5", "no LLM_PROVIDER means anthropic");
});

test("which models read images", () => {
  assert.equal(modelSupportsVision("anthropic", "claude-sonnet-5"), true);
  assert.equal(modelSupportsVision("openai", "gpt-5.6-terra"), true);
  assert.equal(modelSupportsVision("deepseek", "deepseek-flash"), true);
  assert.equal(modelSupportsVision("deepseek", "deepseek-v4-flash-vision-exp"), true);
  assert.equal(modelSupportsVision("deepseek", "deepseek-v4-pro"), false);
  assert.equal(modelSupportsVision("deepseek", "deepseek-chat"), false);
});

test("the ad engine's text provider is DeepSeek unless the environment says otherwise", () => {
  assert.equal(adsTextProvider({}), "deepseek");
  assert.equal(adsTextProvider({ ADS_TEXT_PROVIDER: "Anthropic" }), "anthropic");
  assert.equal(adsTextProvider({ ADS_TEXT_PROVIDER: "gemini" }), "deepseek", "an unknown name falls back rather than crashing");
});

test("visionProviderStatus: anthropic by default, deepseek-flash when only that key exists, a named provider is never swapped", () => {
  const anthropic = visionProviderStatus({ ANTHROPIC_API_KEY: "k" });
  assert.deepEqual(anthropic, { available: true, provider: "anthropic", model: "claude-sonnet-5", reason: null });

  const fallback = visionProviderStatus({ DEEPSEEK_API_KEY: "k" });
  assert.equal(fallback.available, true);
  assert.equal(fallback.provider, "deepseek");
  assert.equal(fallback.model, "deepseek-flash");
  assert.match(fallback.reason ?? "", /ANTHROPIC_API_KEY is not set/);

  const none = visionProviderStatus({});
  assert.equal(none.available, false);
  assert.equal(none.provider, "anthropic");
  assert.match(none.reason ?? "", /vision provider unavailable: add ANTHROPIC_API_KEY/);
  assert.match(none.reason ?? "", /DEEPSEEK_API_KEY/, "the reason names the other key that would do");

  const explicit = visionProviderStatus({ ADS_VISION_PROVIDER: "anthropic", DEEPSEEK_API_KEY: "k" });
  assert.equal(explicit.available, false, "an explicit anthropic with no key does not silently become deepseek");
  assert.match(explicit.reason ?? "", /add ANTHROPIC_API_KEY/);
  assert.doesNotMatch(explicit.reason ?? "", /DEEPSEEK_API_KEY/);

  const textOnly = visionProviderStatus({ ADS_VISION_PROVIDER: "deepseek", LLM_PROVIDER: "deepseek", LLM_MODEL_FAST: "deepseek-v4-pro", DEEPSEEK_API_KEY: "k" });
  assert.equal(textOnly.available, false);
  assert.match(textOnly.reason ?? "", /deepseek-v4-pro does not read images/);

  const explicitDeepseek = visionProviderStatus({ ADS_VISION_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "k", ANTHROPIC_API_KEY: "k" });
  assert.deepEqual(explicitDeepseek, { available: true, provider: "deepseek", model: "deepseek-flash", reason: null });
});

test("isLlmAvailable answers per provider", () => {
  const env = { DEEPSEEK_API_KEY: "k" };
  assert.equal(isLlmAvailable("deepseek", env), true);
  assert.equal(isLlmAvailable("anthropic", env), false);
  assert.equal(isLlmAvailable("openai", {}), false);
  assert.equal(KEY_VAR.deepseek, "DEEPSEEK_API_KEY");
});

test("resolveCall refuses a missing key or a text-only model with images before any request", () => {
  const schema = z.object({ ok: z.boolean() });
  const base = { name: "probe", system: "s", user: "u", schema, maxTokens: 10 };
  const image = { media_type: "image/png" as const, path: "does-not-exist.png" };

  assert.throws(
    () => resolveCall({ ...base, provider: "deepseek" }, {}),
    (e: unknown) => e instanceof LlmUnavailableError && /DEEPSEEK_API_KEY/.test(e.message) && e.provider === "deepseek"
  );
  assert.throws(
    () => resolveCall({ ...base, provider: "deepseek", model: "deepseek-v4-pro", images: [image] }, { DEEPSEEK_API_KEY: "k" }),
    (e: unknown) => e instanceof LlmUnavailableError && /vision provider unavailable/.test(e.message) && /deepseek-v4-pro/.test(e.message)
  );
  assert.deepEqual(resolveCall({ ...base, provider: "deepseek", images: [image] }, { DEEPSEEK_API_KEY: "k" }), { provider: "deepseek", model: "deepseek-flash" });
  assert.deepEqual(resolveCall({ ...base, provider: "anthropic", images: [image] }, { ANTHROPIC_API_KEY: "k" }), { provider: "anthropic", model: "claude-sonnet-5" });
  assert.deepEqual(resolveCall(base, { LLM_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "k" }), { provider: "deepseek", model: "deepseek-flash" }, "no provider on the call means the process-wide one");
  assert.deepEqual(resolveCall({ ...base, model: "claude-opus-5" }, { ANTHROPIC_API_KEY: "k" }), { provider: "anthropic", model: "claude-opus-5" });
});

test("image blocks: base64 from disk, shaped for each dialect, and nothing but the text without images", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "studio-llm-"));
  try {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
    const file = path.join(dir, "strip.png");
    writeFileSync(file, bytes);
    const [loaded] = loadImages([{ media_type: "image/png", path: file }]);
    assert.equal(loaded.data, bytes.toString("base64"));
    assert.equal(imageDataUri(loaded), `data:image/png;base64,${bytes.toString("base64")}`);

    assert.deepEqual(anthropicUserContent("look", [loaded]), [
      { type: "image", source: { type: "base64", media_type: "image/png", data: loaded.data } },
      { type: "text", text: "look" },
    ]);
    assert.deepEqual(chatUserContent("look", [loaded]), [
      { type: "image_url", image_url: { url: imageDataUri(loaded) } },
      { type: "text", text: "look" },
    ]);
    assert.deepEqual(responsesUserInput("look", [loaded]), [
      { role: "user", content: [{ type: "input_image", image_url: imageDataUri(loaded), detail: "auto" }, { type: "input_text", text: "look" }] },
    ]);
    assert.equal(anthropicUserContent("look", []), "look");
    assert.equal(chatUserContent("look", []), "look");
    assert.equal(responsesUserInput("look", []), "look");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// runJob's gate: the key it checks is the CALL's provider, not the process-wide one.
const saved = { replay: process.env.DEMO_REPLAY, source: process.env.DATA_SOURCE, anthropic: process.env.ANTHROPIC_API_KEY, deepseek: process.env.DEEPSEEK_API_KEY };
beforeEach(() => {
  process.env.DEMO_REPLAY = "0";
  delete process.env.DATA_SOURCE;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  delete process.env.DEEPSEEK_API_KEY;
});
afterEach(() => {
  for (const [k, v] of [["DEMO_REPLAY", saved.replay], ["DATA_SOURCE", saved.source], ["ANTHROPIC_API_KEY", saved.anthropic], ["DEEPSEEK_API_KEY", saved.deepseek]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("assertModelCallsAllowed checks the key of the provider the job names", () => {
  assert.doesNotThrow(() => assertModelCallsAllowed("anthropic"));
  assert.throws(
    () => assertModelCallsAllowed("deepseek"),
    (e: unknown) => e instanceof LlmUnavailableError && /DEEPSEEK_API_KEY/.test(e.message)
  );
  process.env.DEEPSEEK_API_KEY = "k";
  assert.doesNotThrow(() => assertModelCallsAllowed("deepseek"));
});
