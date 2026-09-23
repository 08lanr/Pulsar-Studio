// lib/llm without a network: the price table, the per-call provider choice
// (decision 2026-09-22: text on one gateway, frames on another), the vision
// status the ads page reads, and the image blocks each dialect wants. Every
// refusal here happens before a request could be made.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { assertModelCallsAllowed, runJob } from "@/lib/jobs";
import {
  ANTHROPIC_THINKING_TOKENS,
  DEEPSEEK_THINKING_TOKENS,
  DEFAULT_MODELS,
  KEY_VAR,
  LlmError,
  LlmUnavailableError,
  PRICES,
  acceptsForcedToolChoice,
  adsTextProvider,
  anthropicRequestParams,
  anthropicToolChoice,
  anthropicUserContent,
  anthropicUserText,
  chatUserContent,
  costCents,
  deepSeekRequestBody,
  imageDataUri,
  isLlmAvailable,
  loadImages,
  modelFamily,
  modelFor,
  modelSupportsVision,
  parseAnthropicResponse,
  priceFor,
  resolveCall,
  responsesUserInput,
  toLlmError,
  turnTraceOf,
  visionProviderStatus,
  type LlmProvider,
  type StructuredCall,
} from "@/lib/llm";
import { producer, seedMinute } from "./seed-minute";

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

test("claude-opus-5-5 is priced at its own rate, not the Fable fallback that charged it 2.5x", () => {
  assert.deepEqual(PRICES["claude-opus-5-5"], { input: 4, output: 20, cache_write: 5, cache_read: 0.2 });
  const z0 = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  assert.equal(costCents("claude-opus-5-5", { ...z0, input_tokens: 1_000_000 }), 400);
  assert.equal(costCents("claude-opus-5-5", { ...z0, output_tokens: 1_000_000 }), 2000);
  assert.equal(costCents("claude-sonnet-5", { ...z0, output_tokens: 1_000_000 }), 1000, "the judge's default");
});

// ---- the Anthropic request ---------------------------------------------------------------------

const probeCall: StructuredCall<{ ok: boolean }> = { name: "probe", system: "s", user: "u", schema: z.object({ ok: z.boolean() }), maxTokens: 6000 };

test("the Anthropic request: the thinking's room on top of the call's budget, a strict tool, effort medium, and the tool choice per model", () => {
  const sonnet = anthropicRequestParams(probeCall, "claude-sonnet-5", {});
  assert.equal(ANTHROPIC_THINKING_TOKENS, 16_000);
  assert.equal(sonnet.max_tokens, 6000 + ANTHROPIC_THINKING_TOKENS, "adaptive thinking counts against max_tokens: the answer's budget alone truncated the reviewer");
  assert.equal(sonnet.model, "claude-sonnet-5");
  const tool = sonnet.tools?.[0] as Anthropic.Tool;
  assert.equal(tool.name, "probe");
  assert.equal(tool.strict, true);
  assert.deepEqual(tool.input_schema, { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false });
  assert.deepEqual(sonnet.tool_choice, { type: "tool", name: "probe", disable_parallel_tool_use: true });
  assert.deepEqual(sonnet.output_config, { effort: "medium" });
  assert.deepEqual(sonnet.system, [{ type: "text", text: "s" }]);
  const cached = anthropicRequestParams({ ...probeCall, cacheSystem: true, effort: "high" }, "claude-sonnet-5", {});
  assert.deepEqual(cached.system, [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(cached.output_config, { effort: "high" });

  // Opus 5.5, Fable 5.1 and Mythos 5.1 answer 400 to a forced tool_choice; the rest accept it.
  assert.equal(acceptsForcedToolChoice("claude-sonnet-5"), true);
  assert.equal(acceptsForcedToolChoice("claude-opus-5"), true);
  assert.equal(acceptsForcedToolChoice("claude-fable-5"), true);
  assert.equal(acceptsForcedToolChoice("claude-opus-4-8"), true);
  assert.equal(acceptsForcedToolChoice("claude-opus-5-5"), false);
  assert.equal(acceptsForcedToolChoice("claude-fable-5-1"), false);
  assert.equal(acceptsForcedToolChoice("claude-mythos-5-1"), false);
  assert.deepEqual(anthropicToolChoice("claude-opus-5-5", "probe", {}), { type: "auto", disable_parallel_tool_use: true });
  assert.deepEqual(anthropicRequestParams(probeCall, "claude-opus-5-5", {}).tool_choice, { type: "auto", disable_parallel_tool_use: true });
  assert.deepEqual(anthropicToolChoice("claude-sonnet-5", "probe", { ANTHROPIC_TOOL_CHOICE: "auto" }), { type: "auto", disable_parallel_tool_use: true }, "the probe's switch: every model on the auto path");
  assert.deepEqual(anthropicToolChoice("claude-sonnet-5", "probe", { ANTHROPIC_TOOL_CHOICE: "forced" }), { type: "tool", name: "probe", disable_parallel_tool_use: true }, "anything but auto leaves the default");
  // On the auto path the user turn says which tool to answer with; on the forced path it is the call's own text.
  assert.equal(anthropicUserText("u", "probe", sonnet.tool_choice), "u");
  assert.equal(anthropicUserText("u", "probe", { type: "auto", disable_parallel_tool_use: true }), "u\n\nAnswer only by calling probe.");
});

/** A reply as the SDK returns it; only the fields the parser and the trace read are real. */
function reply(content: Anthropic.ContentBlock[], stop_reason: Anthropic.StopReason | null, extra: { output_tokens?: number; stop_details?: unknown } = {}): Anthropic.Message {
  return { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5", content, stop_reason, stop_sequence: null, stop_details: extra.stop_details ?? null, usage: { input_tokens: 10, output_tokens: extra.output_tokens ?? 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as unknown as Anthropic.Message;
}
const toolUse = (input: unknown, name = "probe"): Anthropic.ContentBlock => ({ type: "tool_use", id: "tu_1", name, input } as Anthropic.ContentBlock);
const thinking: Anthropic.ContentBlock = { type: "thinking", thinking: "", signature: "sig" } as Anthropic.ContentBlock;
const text = (t: string): Anthropic.ContentBlock => ({ type: "text", text: t, citations: null } as Anthropic.ContentBlock);

test("parseAnthropicResponse: a tool call validates, a text-only reply gets the nudge, a schema or check failure the tool_result, a truncation or refusal no repair", () => {
  assert.deepEqual(parseAnthropicResponse(reply([thinking, toolUse({ ok: true })], "tool_use"), probeCall), { ok: true, data: { ok: true } });
  // No tool call at all (a tool_choice of auto answered in text): one nudge.
  assert.deepEqual(parseAnthropicResponse(reply([thinking, text("The answer is yes.")], "end_turn"), probeCall), { ok: false, code: "invalid_output", problem: "No probe tool call in the response (stop_reason end_turn).", repair: { kind: "nudge" } });
  assert.deepEqual(parseAnthropicResponse(reply([toolUse({ ok: true }, "other_tool")], "tool_use"), probeCall).ok, false, "another tool's call is no answer");
  // The budget ran out before the tool call: no repair, the message says how much was produced (thinking included).
  assert.deepEqual(parseAnthropicResponse(reply([thinking, text("…")], "max_tokens", { output_tokens: 22_000 }), probeCall), { ok: false, code: "truncated", problem: "Output hit max_tokens (22000 output tokens, thinking included) before the tool call completed.", repair: null });
  assert.deepEqual(parseAnthropicResponse(reply([], "refusal", { stop_details: { type: "refusal", category: "cyber", explanation: "declined" } }), probeCall), { ok: false, code: "refused", problem: "declined", repair: null });
  // A schema violation or a failed check goes back as the tool's error result.
  const bad = parseAnthropicResponse(reply([toolUse({ ok: "yes" })], "tool_use"), probeCall);
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.code, "invalid_output");
    assert.match(bad.problem, /^Schema violations:\nok: /);
    assert.deepEqual(bad.repair, { kind: "tool_result", tool_use_id: "tu_1" });
  }
  const checked = parseAnthropicResponse(reply([toolUse({ ok: false })], "tool_use"), { ...probeCall, check: (d) => (d.ok ? null : "ok must be true") });
  assert.deepEqual(checked, { ok: false, code: "invalid_output", problem: "ok must be true", repair: { kind: "tool_result", tool_use_id: "tu_1" } });
  // The trace: how the turn stopped, what it produced, whether it thought first (an omitted-display thinking block is present with empty text).
  assert.deepEqual(turnTraceOf(reply([thinking, toolUse({ ok: true })], "tool_use", { output_tokens: 1800 })), { stop_reason: "tool_use", output_tokens: 1800, thinking_blocks: 1 });
  assert.deepEqual(turnTraceOf(reply([toolUse({ ok: true })], "tool_use", { output_tokens: 300 })), { stop_reason: "tool_use", output_tokens: 300, thinking_blocks: 0 });
});

test("toLlmError: the workspace 400 is unavailable naming ANTHROPIC_WORKSPACE_ID, a refused tool_choice is invalid, any other 400 is an api error", () => {
  const bad = (message: string) => new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message } }, message, new Headers());
  const workspace = toLlmError(bad("This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace."), "anthropic");
  assert.ok(workspace instanceof LlmUnavailableError);
  assert.equal(workspace.provider, "anthropic");
  assert.match(workspace.message, /ANTHROPIC_WORKSPACE_ID \(wrkspc_/);
  assert.match(workspace.message, /this ANTHROPIC_API_KEY is not scoped to a workspace/);
  const forced = toLlmError(bad('tool_choice: type "tool" and "any" are not supported for this model.'), "anthropic");
  assert.ok(forced instanceof LlmError && forced.code === "invalid" && forced.status === 400, "the request was wrong; a retry would repeat it");
  const other = toLlmError(bad("messages: text content blocks must be non-empty"), "anthropic");
  assert.ok(other instanceof LlmError && other.code === "api" && other.status === 400);
  const auth = toLlmError(new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, "invalid x-api-key", new Headers()), "anthropic");
  assert.ok(auth instanceof LlmUnavailableError);
  const own = new LlmError("truncated", "x");
  assert.equal(toLlmError(own, "anthropic"), own, "the gateway's own errors pass through");
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

test("resolveCall refuses a model from another vendor's family before the key check", () => {
  assert.equal(modelFamily("claude-sonnet-5"), "anthropic");
  assert.equal(modelFamily("gpt-5.6-terra"), "openai");
  assert.equal(modelFamily("deepseek-v4-pro"), "deepseek");
  assert.equal(modelFamily("o5-mini"), null, "an id no family claims");

  const schema = z.object({ ok: z.boolean() });
  const base = { name: "probe", system: "s", user: "u", schema, maxTokens: 10 };
  const image = { media_type: "image/png" as const, path: "does-not-exist.png" };
  const invalid = (e: unknown) => e instanceof LlmError && e.code === "invalid";

  // The phase-3 mistake: provider "deepseek" on a prompt that kept MODEL_FAST under LLM_PROVIDER=anthropic.
  assert.throws(
    () => resolveCall({ ...base, provider: "deepseek", model: "claude-sonnet-5" }, { DEEPSEEK_API_KEY: "k", LLM_PROVIDER: "anthropic" }),
    (e: unknown) => invalid(e) && /claude-sonnet-5 is a anthropic model/.test((e as Error).message) && /cannot be sent to deepseek/.test((e as Error).message)
  );
  assert.throws(() => resolveCall({ ...base, provider: "anthropic", model: "gpt-5.6-terra" }, {}), invalid, "the wrong model is refused even before a missing key");
  assert.throws(() => resolveCall({ ...base, provider: "openai", model: "deepseek-flash" }, { OPENAI_API_KEY: "k" }), invalid);
  assert.throws(
    () => resolveCall({ ...base, provider: "deepseek", model: "claude-sonnet-5", images: [image] }, { DEEPSEEK_API_KEY: "k" }),
    invalid,
    "with images the family refusal comes first, not a misleading vision message"
  );
  assert.deepEqual(resolveCall({ ...base, provider: "openai", model: "o5-mini" }, { OPENAI_API_KEY: "k" }), { provider: "openai", model: "o5-mini" }, "an unclaimed id is the provider's business");
});

test("DeepSeek thinking: the fast tier never thinks, the strong tier thinks at the call's effort with room for the reasoning", () => {
  const schema = z.object({ ok: z.boolean() });
  const base = { name: "probe", system: "s", user: "u", schema, maxTokens: 2000 };
  const turn = { system: "sys", user: "usr" };
  const effortOf = (b: object) => (b as { reasoning_effort?: string }).reasoning_effort;

  const fast = deepSeekRequestBody({ ...base, effort: "low" }, { model: "deepseek-flash", images: [] }, turn, {});
  assert.deepEqual(fast.thinking, { type: "disabled" }, "the fast tier is what deepseek-chat was: JSON only, no reasoning against its budget");
  assert.equal(effortOf(fast), undefined);
  assert.equal(fast.max_tokens, 2000);
  assert.equal(fast.model, "deepseek-flash");
  assert.deepEqual(fast.messages, [{ role: "system", content: "sys" }, { role: "user", content: "usr" }]);
  assert.deepEqual(fast.response_format, { type: "json_object" });
  assert.equal(fast.stream, false);

  const strong = deepSeekRequestBody({ ...base, effort: "high" }, { model: "deepseek-v4-pro", images: [] }, turn, {});
  assert.deepEqual(strong.thinking, { type: "enabled" }, "the strong tier is what deepseek-reasoner was");
  assert.equal(effortOf(strong), "high");
  assert.equal(strong.max_tokens, 2000 + DEEPSEEK_THINKING_TOKENS, "V4 counts the reasoning against max_tokens, so it gets its own room");

  assert.equal(effortOf(deepSeekRequestBody({ ...base, effort: "medium" }, { model: "deepseek-v4-pro", images: [] }, turn, {})), "high", "DeepSeek's own mapping, sent explicitly");
  assert.equal(effortOf(deepSeekRequestBody({ ...base, effort: "xhigh" }, { model: "deepseek-v4-pro", images: [] }, turn, {})), "high");
  assert.equal(effortOf(deepSeekRequestBody({ ...base, effort: "max" }, { model: "deepseek-v4-pro", images: [] }, turn, {})), "max");

  const noEffort = deepSeekRequestBody(base, { model: "deepseek-v4-pro", images: [] }, turn, {});
  assert.deepEqual(noEffort.thinking, { type: "disabled" }, "a strong call that asks for no effort does not think");
  assert.equal(noEffort.max_tokens, 2000);

  const shared = deepSeekRequestBody({ ...base, effort: "high" }, { model: "deepseek-flash", images: [] }, turn, { LLM_PROVIDER: "deepseek", LLM_MODEL_STRONG: "deepseek-flash" });
  assert.deepEqual(shared.thinking, { type: "disabled" }, "a model that also serves the fast tier never thinks");

  const swapped = deepSeekRequestBody({ ...base, effort: "high" }, { model: "deepseek-flash", images: [] }, turn, { LLM_PROVIDER: "deepseek", LLM_MODEL_FAST: "deepseek-v4-pro", LLM_MODEL_STRONG: "deepseek-flash" });
  assert.deepEqual(swapped.thinking, { type: "enabled" }, "the tier decides, not the id");
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

test("runJob fails a job whose call went to another provider than the row names, and keeps the spend", async () => {
  const t = await seedMinute();
  try {
    const wb = await fixtureData.getWorkbench(producer(), t.id, 1);
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 };
    const spec = {
      kind: "rewrite" as const,
      title_id: t.id,
      episode_id: wb.episode.id,
      target_type: "title",
      target_id: t.id,
      idempotency_key: "probe:provider-mismatch",
      provider: "anthropic" as const,
      model: "claude-sonnet-5",
    };
    await assert.rejects(
      runJob(producer(), { ...spec, run: async () => ({ output: { ok: true }, usage, cost_cents: 3, model: "deepseek-flash", provider: "deepseek" as const }) }),
      /went to deepseek but the job named anthropic/
    );
    const failed = await fixtureData.latestEpisodeJob(producer(), t.id, 1, "rewrite");
    assert.equal(failed?.status, "failed");
    assert.match(failed?.error ?? "", /pass one provider to both/);
    assert.equal(failed?.cost_cents, 3, "the spend is on the row");
    assert.equal(failed?.provider, "anthropic", "the row says what was checked; the error says where it went");

    // The same call on the provider it names goes through.
    const ok = await runJob(producer(), { ...spec, idempotency_key: "probe:provider-match", run: async () => ({ output: { ok: true }, usage, cost_cents: 3, model: "claude-sonnet-5", provider: "anthropic" as const }) });
    assert.equal(ok.job.status, "done");
    assert.equal(ok.job.provider, "anthropic");
  } finally {
    resetFixtureStore();
  }
});

test("runJob keeps a failed call's spend on the failed row and hands the row's id back on the error", async () => {
  const t = await seedMinute();
  try {
    const wb = await fixtureData.getWorkbench(producer(), t.id, 1);
    const spec = { kind: "rewrite" as const, title_id: t.id, episode_id: wb.episode.id, target_type: "title", target_id: t.id, provider: "anthropic" as const, model: "claude-sonnet-5" };
    // A refusal after the repair turn: two turns with images were paid for. The gateway put the usage on the error.
    const spent = Object.assign(new LlmError("refused", "The model declined to process this content."), { usage: { input_tokens: 4000, output_tokens: 900, cache_read_tokens: 2000, cache_write_tokens: 100 }, cost_cents: 2 });
    await assert.rejects(
      runJob(producer(), { ...spec, idempotency_key: "probe:failed-spend", run: async () => { throw spent; } }),
      (e: unknown) => e === spent
    );
    const failed = await fixtureData.latestEpisodeJob(producer(), t.id, 1, "rewrite");
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.cost_cents, 2, "the spend is on the failed row");
    assert.deepEqual(failed?.usage, { input_tokens: 4100, output_tokens: 900, cache_read_tokens: 2000 }, "as toJobUsage keeps it: cache writes are billed input");
    assert.match(failed?.error ?? "", /^LlmError: The model declined/);
    assert.equal(spent.job_id, failed?.id, "the caller can list the row");
    // No spend on the error (nothing reached the API): the row carries none, and still names itself.
    const plain = new LlmError("api", "connect ETIMEDOUT");
    await assert.rejects(runJob(producer(), { ...spec, idempotency_key: "probe:failed-plain", run: async () => { throw plain; } }), (e: unknown) => e === plain);
    const bare = await fixtureData.latestEpisodeJob(producer(), t.id, 1, "rewrite");
    assert.equal(bare?.idempotency_key, "probe:failed-plain");
    assert.equal(bare?.cost_cents ?? null, null);
    assert.equal(bare?.usage ?? null, null);
    assert.equal(plain.job_id, bare?.id);
  } finally {
    resetFixtureStore();
  }
});
