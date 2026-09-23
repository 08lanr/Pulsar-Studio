// The one gateway for every model call in Studio — the way every TikTok call
// in the sibling goes through lib/tiktok.ts. One place for the model choice,
// the price table, retries, structured output and the failure taxonomy, so a
// prompt module (lib/prompts/*) only says WHAT it wants back and lib/jobs.ts
// only says WHERE the result goes.
//
// Structured output is a tool call — forced where the model accepts it, `auto`
// with an instruction on the models that refuse a forced choice and on the
// calls that ask for it so the model thinks first (see "the Anthropic
// request" below): one tool per call whose input_schema is derived
// from the caller's zod schema, `strict: true` so the API guarantees
// schema-valid arguments, and the same zod schema (plus an optional semantic
// `check`) re-validates on our side; a failure gets exactly one repair turn.
// Cost is computed here from PRICES on every call so a job row can never carry
// usage without cents, and a call that fails after spending carries its usage
// on the LlmError so the job row keeps it. Nothing in this file touches the
// database.
//
// Provider per call (decision 2026-09-22): LLM_PROVIDER stays the process-wide
// default for the adaptation passes; a StructuredCall may name its own
// `provider`, so the ad engine nominates text on DeepSeek and judges frames on
// Anthropic. A call may carry `images` (files, sent base64); a model that does
// not read images is refused BEFORE any request. Which provider judges frames
// is `visionProviderStatus()`, the one answer the UI and the verify job read.
//
// Works without credentials: isLlmAvailable() is the switch the UI and the
// jobs read; callStructured() throws LlmUnavailableError before any request
// when the key is missing.

import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ContentFilterFinishReasonError, LengthFinishReasonError } from "openai/error";
import { zodTextFormat } from "openai/helpers/zod";
import type { ZodType, ZodTypeAny } from "zod";
import type { Character, JobUsage, Title } from "@/lib/types";

export type LlmProvider = "anthropic" | "openai" | "deepseek";

/** An environment-shaped record, so the pure selectors can be tested without touching process.env. */
type Env = Record<string, string | undefined>;

export function parseProvider(v: string | undefined | null): LlmProvider | null {
  const s = v?.trim().toLowerCase();
  return s === "anthropic" || s === "openai" || s === "deepseek" ? s : null;
}

/** One switch for every adaptation pass; fixture replay remains provider-free. */
export const LLM_PROVIDER: LlmProvider = parseProvider(process.env.LLM_PROVIDER) ?? "anthropic";

export const KEY_VAR: Record<LlmProvider, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", deepseek: "DEEPSEEK_API_KEY" };

/**
 * Two tiers. FAST does the reading passes (title bible, scene context, clip
 * ranking, ad nomination); STRONG does the writing passes (first pass,
 * alternatives, rewrites, the creative pack). Both overridable from the
 * environment so a cheaper model can be tried without a code change. The
 * frame judge is neither tier: it has its own model per provider
 * (VISION_DEFAULT_MODELS, ADS_VISION_MODEL), measured on its own bar.
 *
 * DeepSeek ids are the V4.1 generation (api-docs.deepseek.com/quick_start/pricing,
 * read 2026-09-22): `deepseek-flash` reads images, `deepseek-v4-pro` does not.
 * The older `deepseek-chat` / `deepseek-reasoner` names were discontinued on
 * 2026-07-24 (api-docs.deepseek.com/updates) and must not be sent.
 */
export const DEFAULT_MODELS: Record<LlmProvider, { fast: string; strong: string }> = {
  anthropic: { fast: "claude-sonnet-5", strong: "claude-opus-5" },
  openai: { fast: "gpt-5.6-terra", strong: "gpt-5.6-sol" },
  deepseek: { fast: "deepseek-flash", strong: "deepseek-v4-pro" },
};

export type ModelTier = "fast" | "strong";

/**
 * The model a tier resolves to for a provider. LLM_MODEL_FAST / LLM_MODEL_STRONG
 * override the process-wide provider's models only: a Claude id would be
 * nonsense to DeepSeek, so a per-call provider that differs from LLM_PROVIDER
 * always takes its own defaults.
 */
export function modelFor(provider: LlmProvider, tier: ModelTier, env: Env = process.env): string {
  const processProvider = parseProvider(env.LLM_PROVIDER) ?? "anthropic";
  if (provider === processProvider) {
    const override = tier === "fast" ? env.LLM_MODEL_FAST : env.LLM_MODEL_STRONG;
    if (override) return override;
  }
  return DEFAULT_MODELS[provider][tier];
}

export const MODEL_FAST = modelFor(LLM_PROVIDER, "fast");
export const MODEL_STRONG = modelFor(LLM_PROVIDER, "strong");

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** USD per million tokens. Cache write is 1.25x input, cache read 0.1x (0.25 on Fable 5.1). */
export type ModelPrice = {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
};

// DeepSeek list prices at PEAK rates (api-docs.deepseek.com/quick_start/pricing,
// read 2026-09-22): deepseek-flash cache miss $0.30, cache hit $0.006, output
// $1.20 per million; deepseek-v4-pro $1.32 / $0.044 / $3.96. Off-peak is half.
// Peak is charged so spend is never under-reported; no cache-write surcharge.
const DEEPSEEK_FLASH: ModelPrice = { input: 0.3, output: 1.2, cache_write: 0.3, cache_read: 0.006 };
const DEEPSEEK_V4_PRO: ModelPrice = { input: 1.32, output: 3.96, cache_write: 1.32, cache_read: 0.044 };

export const PRICES: Record<string, ModelPrice> = {
  "claude-opus-5": { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  // The Workflow's own model (docs/decisions.md, "The vision pass as an API module"); it refuses a forced tool_choice, see anthropicToolChoice.
  "claude-opus-5-5": { input: 4, output: 20, cache_write: 5, cache_read: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cache_write: 2.5, cache_read: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cache_write: 12.5, cache_read: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cache_write: 12.5, cache_read: 1 },
  "claude-opus-4-8": { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 },
  "gpt-5.6-sol": { input: 4, output: 20, cache_write: 4, cache_read: 0.4 },
  "gpt-5.6-terra": { input: 2, output: 12, cache_write: 2, cache_read: 0.2 },
  "deepseek-flash": DEEPSEEK_FLASH,
  "deepseek-v4-pro": DEEPSEEK_V4_PRO,
  // Legacy ids DeepSeek still accepts and serves with V4.1-Flash at flash prices (updates page, 2026-09-10).
  "deepseek-v4-flash": DEEPSEEK_FLASH,
  "deepseek-v4-flash-vision-exp": DEEPSEEK_FLASH,
};

/** An unknown model id is priced at the dearest known tier: spend must never be under-reported. */
const FALLBACK_PRICE: ModelPrice = PRICES["claude-fable-5-1"];

export function priceFor(model: string): ModelPrice {
  const p = PRICES[model];
  if (!p) console.warn(`[llm] no price for model ${model}; charging at the top tier`);
  return p ?? FALLBACK_PRICE;
}

// ---- availability and errors --------------------------------------------------------

export function isLlmAvailable(provider: LlmProvider = LLM_PROVIDER, env: Env = process.env): boolean {
  return !!env[KEY_VAR[provider]];
}

/** No key. Routes map it to 503 with error code 'llm_unavailable'. */
export class LlmUnavailableError extends Error {
  readonly code = "llm_unavailable" as const;
  readonly provider: LlmProvider;
  constructor(message?: string, provider: LlmProvider = LLM_PROVIDER) {
    const key = KEY_VAR[provider];
    super(message ?? `AI passes are not configured on this server (missing ${key})`);
    this.name = "LlmUnavailableError";
    this.provider = provider;
  }
}

/** `invalid` never reached a provider: the call itself was wrong (a model from another vendor). */
export type LlmFailure = "refused" | "invalid_output" | "truncated" | "api" | "invalid";

/**
 * A call that reached the API and came back unusable (or, `invalid`, one
 * refused before it left). `status` is the HTTP status when there was one.
 * `usage` and `cost_cents` are what the failed call still spent (a refusal
 * after its repair turn, a truncated reply: the gateway attaches them), and
 * `job_id` the failed studio.jobs row that kept that spend (lib/jobs.ts
 * attaches it), so a caller can list the row.
 */
export class LlmError extends Error {
  readonly code: LlmFailure;
  readonly status: number | undefined;
  usage?: LlmUsage;
  cost_cents?: number;
  job_id?: string;
  constructor(code: LlmFailure, message: string, status?: number) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.status = status;
  }
}

// ---- vision and the ad engine's providers ------------------------------------------------

/**
 * Which models read images. Every current Claude and GPT-5 model is
 * multimodal; on DeepSeek only the Flash line is (api-docs.deepseek.com/guides/vision,
 * read 2026-09-22: `deepseek-flash`, plus the two legacy ids it serves).
 */
export function modelSupportsVision(provider: LlmProvider, model: string): boolean {
  switch (provider) {
    case "anthropic":
      return true;
    case "openai":
      return true;
    case "deepseek":
      return /^deepseek-(flash|v4-flash|v4-flash-vision-exp)$/.test(model);
  }
}

/**
 * The vendor a model id belongs to, by its prefix: claude-* is Anthropic's,
 * gpt-* OpenAI's, deepseek-* DeepSeek's; null for an id no family claims
 * (OpenAI's o-series, say). resolveCall refuses a model on another vendor's
 * gateway, so a prompt that names `provider: "deepseek"` but keeps
 * MODEL_FAST under LLM_PROVIDER=anthropic fails before any request.
 */
export function modelFamily(model: string): LlmProvider | null {
  if (/^claude-/.test(model)) return "anthropic";
  if (/^gpt-/.test(model)) return "openai";
  if (/^deepseek-/.test(model)) return "deepseek";
  return null;
}

/** The ad engine's text passes (nomination): ADS_TEXT_PROVIDER, DeepSeek unless said otherwise. */
export function adsTextProvider(env: Env = process.env): LlmProvider {
  return parseProvider(env.ADS_TEXT_PROVIDER) ?? "deepseek";
}

export type VisionProviderStatus = {
  available: boolean;
  provider: LlmProvider;
  /** The model the frame judge would run on (visionModelFor). */
  model: string;
  /** Why it is unavailable, or the note that a fallback was taken; null on the plain path. */
  reason: string | null;
};

/**
 * The frame judge's model per provider. Anthropic: claude-opus-5-5, measured
 * on He Hated All Women (decision 2026-09-23, "The frame judge on Claude,
 * measured"): applied agreement 16/20 and 17/20 against claude-sonnet-5's
 * 14/20 and 12/20, one wrong cut in forty through unflagged against eight,
 * about $0.15 per boundary. The other providers judge on their fast tier.
 * LLM_MODEL_FAST never moves the judge: it would move every reading pass
 * with it; ADS_VISION_MODEL is the judge's own override.
 */
export const VISION_DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: "claude-opus-5-5",
  openai: DEFAULT_MODELS.openai.fast,
  deepseek: DEFAULT_MODELS.deepseek.fast,
};

/** The frame judge's model on a provider: ADS_VISION_MODEL when it is that provider's (or claims no family), else the provider's vision default. Pure. */
export function visionModelFor(provider: LlmProvider, env: Env = process.env): string {
  const named = env.ADS_VISION_MODEL?.trim();
  if (named && (modelFamily(named) ?? provider) === provider) return named;
  return VISION_DEFAULT_MODELS[provider];
}

/**
 * The frame judge's provider (amendment 4, 2026-09-22): ADS_VISION_PROVIDER,
 * Anthropic by default. With no ADS_VISION_PROVIDER set, no ANTHROPIC_API_KEY
 * and a DEEPSEEK_API_KEY, the judge runs on deepseek-flash, which reads
 * images. An explicit provider or model is never swapped behind the
 * operator's back: a missing key, a text-only model or an ADS_VISION_MODEL of
 * another vendor is reported, and the verify stage refuses cleanly with this
 * reason instead of guessing.
 */
export function visionProviderStatus(env: Env = process.env): VisionProviderStatus {
  const requested = parseProvider(env.ADS_VISION_PROVIDER);
  const provider = requested ?? "anthropic";
  const model = visionModelFor(provider, env);
  const named = env.ADS_VISION_MODEL?.trim();
  const namedFamily = named ? modelFamily(named) : null;
  if (named && namedFamily && namedFamily !== provider) {
    return { available: false, provider, model, reason: `vision provider unavailable: ADS_VISION_MODEL=${named} is a ${namedFamily} model and the judge's provider is ${provider}; set ADS_VISION_PROVIDER=${namedFamily} with ${KEY_VAR[namedFamily]}, or clear ADS_VISION_MODEL` };
  }
  if (isLlmAvailable(provider, env)) {
    if (!modelSupportsVision(provider, model)) {
      return { available: false, provider, model, reason: `vision provider unavailable: ${model} does not read images; point ADS_VISION_MODEL at a vision model of ${provider} (${VISION_DEFAULT_MODELS[provider]}), or clear it` };
    }
    return { available: true, provider, model, reason: null };
  }
  if (!requested && isLlmAvailable("deepseek", env)) {
    const fallback = visionModelFor("deepseek", env);
    if (modelSupportsVision("deepseek", fallback)) {
      return { available: true, provider: "deepseek", model: fallback, reason: `${KEY_VAR.anthropic} is not set; frames are judged by ${fallback} (${KEY_VAR.deepseek})` };
    }
  }
  const hint = requested ? "" : ` (or ${KEY_VAR.deepseek}, which runs deepseek-flash)`;
  return { available: false, provider, model, reason: `vision provider unavailable: add ${KEY_VAR[provider]} to .env.local${hint}` };
}

// ---- usage and cost --------------------------------------------------------------------

/** What a call consumed; the JobUsage columns plus the cache-write count the row does not keep. */
export type LlmUsage = Required<Pick<JobUsage, "input_tokens" | "output_tokens" | "cache_read_tokens">> & {
  cache_write_tokens: number;
};

function zeroUsage(): LlmUsage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
}

function addAnthropicUsage(into: LlmUsage, u: Anthropic.Usage): void {
  into.input_tokens += u.input_tokens;
  into.output_tokens += u.output_tokens;
  into.cache_read_tokens += u.cache_read_input_tokens ?? 0;
  into.cache_write_tokens += u.cache_creation_input_tokens ?? 0;
}

function addOpenAiUsage(
  into: LlmUsage,
  u: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } }
): void {
  const read = u.input_tokens_details?.cached_tokens ?? 0;
  const written = u.input_tokens_details?.cache_write_tokens ?? 0;
  into.input_tokens += Math.max(0, u.input_tokens - read - written);
  into.output_tokens += u.output_tokens;
  into.cache_read_tokens += read;
  into.cache_write_tokens += written;
}

/** Chat-completions usage (DeepSeek): prompt/completion counts, with DeepSeek's own cache-hit field first. */
function addChatUsage(
  into: LlmUsage,
  u: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number | null } | null }
): void {
  const read = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  into.input_tokens += Math.max(0, u.prompt_tokens - read);
  into.output_tokens += u.completion_tokens;
  into.cache_read_tokens += read;
}

/** The exact price of a call in USD, unrounded, from PRICES: what the eval sums for the spend it reports beside the rounded rows. */
export function costUsd(model: string, u: LlmUsage): number {
  const p = priceFor(model);
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_write_tokens * p.cache_write +
      u.cache_read_tokens * p.cache_read) /
    1_000_000
  );
}

/** Whole cents, rounded up: a 0.3-cent call is a 1-cent row, never a free one (over 200 rows the sum overstates the spend by up to $2; costUsd is the exact figure). */
export function costCents(model: string, u: LlmUsage): number {
  const usd = costUsd(model, u);
  return usd <= 0 ? 0 : Math.ceil(usd * 100);
}

/** The columns studio.jobs.usage keeps (cache writes are billed input and counted there). */
export function toJobUsage(u: LlmUsage): JobUsage {
  return {
    input_tokens: u.input_tokens + u.cache_write_tokens,
    output_tokens: u.output_tokens,
    cache_read_tokens: u.cache_read_tokens,
  };
}

// ---- images --------------------------------------------------------------------------------

export type LlmImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** An image on disk (a frame strip, a join sheet); read and sent base64 at call time. */
export type LlmImage = { media_type: LlmImageMediaType; path: string };

/** The same image once read: base64 bytes, never a path. */
export type LoadedImage = { media_type: LlmImageMediaType; data: string };

export function loadImages(images: LlmImage[]): LoadedImage[] {
  return images.map((i) => ({ media_type: i.media_type, data: fs.readFileSync(i.path).toString("base64") }));
}

export function imageDataUri(image: LoadedImage): string {
  return `data:${image.media_type};base64,${image.data}`;
}

/** Anthropic: image blocks first, then the text, so the words refer to what the model has already seen. */
export function anthropicUserContent(text: string, images: LoadedImage[]): string | Anthropic.ContentBlockParam[] {
  if (!images.length) return text;
  return [
    ...images.map((i): Anthropic.ImageBlockParam => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })),
    { type: "text", text },
  ];
}

/** Chat completions (DeepSeek): image_url parts carrying data URIs, in the user message only — the API refuses images anywhere else. */
export function chatUserContent(text: string, images: LoadedImage[]): string | OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  if (!images.length) return text;
  return [
    ...images.map((i): OpenAI.Chat.Completions.ChatCompletionContentPartImage => ({ type: "image_url", image_url: { url: imageDataUri(i) } })),
    { type: "text", text },
  ];
}

/** Responses API (OpenAI): one user item with input_image parts before the text. */
export function responsesUserInput(text: string, images: LoadedImage[]): string | OpenAI.Responses.ResponseInputItem[] {
  if (!images.length) return text;
  return [
    {
      role: "user",
      content: [
        ...images.map((i): OpenAI.Responses.ResponseInputImage => ({ type: "input_image", image_url: imageDataUri(i), detail: "auto" })),
        { type: "input_text", text },
      ],
    },
  ];
}

// ---- the client ------------------------------------------------------------------------

// One client per process: Next bundles lib/ separately into every route, so
// the singleton lives on globalThis (the sibling's pattern for pacers and
// job locks). maxRetries 0 because the backoff loop below owns retries.
const g = globalThis as typeof globalThis & { __studioLlm?: Anthropic; __studioOpenAi?: OpenAI; __studioDeepSeek?: OpenAI };

function anthropicClient(): Anthropic {
  if (!g.__studioLlm) {
    g.__studioLlm = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 0,
      timeout: 10 * 60 * 1000,
      // Identity-linked console keys must name the workspace they act in.
      defaultHeaders: process.env.ANTHROPIC_WORKSPACE_ID
        ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID }
        : undefined,
    });
  }
  return g.__studioLlm;
}

function openAiClient(): OpenAI {
  if (!g.__studioOpenAi) {
    g.__studioOpenAi = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      maxRetries: 0,
      timeout: 10 * 60 * 1000,
    });
  }
  return g.__studioOpenAi;
}

/** DeepSeek speaks the OpenAI chat-completions dialect; only the host and the key differ. */
function deepSeekClient(): OpenAI {
  if (!g.__studioDeepSeek) {
    g.__studioDeepSeek = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
      maxRetries: 0,
      timeout: 10 * 60 * 1000,
    });
  }
  return g.__studioDeepSeek;
}

const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [1000, 3000, 9000];

function isRetryable(e: unknown): boolean {
  if (e instanceof Anthropic.RateLimitError) return true;
  if (e instanceof Anthropic.InternalServerError) return true; // 5xx and 529 overloaded
  if (e instanceof Anthropic.APIConnectionError) return true; // includes timeouts
  if (e instanceof Anthropic.APIError) return e.status === 408 || e.status === 409;
  if (e instanceof OpenAI.RateLimitError) return true;
  if (e instanceof OpenAI.InternalServerError) return true;
  if (e instanceof OpenAI.APIConnectionError) return true;
  if (e instanceof OpenAI.APIError) return e.status === 408 || e.status === 409;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isRetryable(e) || attempt === MAX_ATTEMPTS - 1) break;
      const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      await sleep(base + Math.floor(Math.random() * 500));
    }
  }
  throw last;
}

/** The 400 an identity-linked console key gets when the request names no workspace: a gap in .env.local, never a transient failure. */
const WORKSPACE_400 = /anthropic-workspace-id|not scoped to a workspace/i;

/** SDK errors become one LlmError so callers never depend on SDK classes. Exported for the tests. */
export function toLlmError(e: unknown, provider: LlmProvider): Error {
  if (e instanceof LlmError || e instanceof LlmUnavailableError) return e;
  if (e instanceof Anthropic.AuthenticationError) return new LlmUnavailableError(undefined, provider);
  if (e instanceof Anthropic.BadRequestError) {
    // The calibration smoke of 2026-09-23 retried this twice per boundary and exited 0: it is the key's configuration, reported as unavailable with the variable named.
    if (WORKSPACE_400.test(e.message)) {
      return new LlmUnavailableError(`AI passes unavailable: this ${KEY_VAR.anthropic} is not scoped to a workspace, so ANTHROPIC_WORKSPACE_ID (wrkspc_…, console.anthropic.com → Settings → Workspaces) must be in .env.local, or use a key scoped to a workspace`, provider);
    }
    // A model that refuses the request's shape (a forced tool_choice on Opus 5.5): the call was wrong, a retry would repeat it.
    if (/tool_choice/i.test(e.message) && /not supported/i.test(e.message)) return new LlmError("invalid", `Claude API 400: ${e.message}`, 400);
  }
  if (e instanceof Anthropic.APIError) {
    return new LlmError("api", `Claude API ${e.status ?? "?"}: ${e.message}`, e.status);
  }
  if (e instanceof OpenAI.AuthenticationError) return new LlmUnavailableError(undefined, provider);
  if (e instanceof OpenAI.APIError) {
    const who = provider === "deepseek" ? "DeepSeek" : "OpenAI";
    return new LlmError("api", `${who} API ${e.status ?? "?"}: ${e.message}`, e.status);
  }
  if (e instanceof ContentFilterFinishReasonError) {
    return new LlmError("refused", "The model declined to process this content.");
  }
  if (e instanceof LengthFinishReasonError) {
    return new LlmError("truncated", "Output hit max_output_tokens before structured output completed.");
  }
  return new LlmError("api", e instanceof Error ? e.message : String(e));
}

// ---- system blocks and the title bible ---------------------------------------------------

/** One system text block; `cache` marks it as a prompt-cache breakpoint. */
export type LlmSystemBlock = { text: string; cache?: boolean };

/**
 * The title bible: everything a pass must know about the title before it
 * reads a line. Stable across every call for the title, so it is marked for
 * caching; anything that varies per call (scene, line, instruction) goes in
 * the user message so it never breaks the cached prefix.
 */
export function titleBible(
  title: Pick<
    Title,
    "name_zh" | "name_en" | "genre" | "synopsis_zh" | "synopsis_en" | "logline_en" | "character_notes" | "notes"
  >,
  characters: Pick<Character, "name_zh" | "name_en" | "notes">[]
): LlmSystemBlock {
  const lines: string[] = ["TITLE BIBLE"];
  lines.push(`Title: ${title.name_zh}${title.name_en ? ` / ${title.name_en}` : ""}`);
  if (title.genre) lines.push(`Genre: ${title.genre}`);
  if (title.logline_en) lines.push(`Logline: ${title.logline_en}`);
  if (title.synopsis_zh) lines.push(`\n剧情简介:\n${title.synopsis_zh}`);
  if (title.synopsis_en) lines.push(`\nSynopsis:\n${title.synopsis_en}`);
  if (title.character_notes) lines.push(`\n人物与语气（制片方/staff 填写）:\n${title.character_notes}`);
  if (characters.length) {
    lines.push("\nCharacters:");
    for (const c of characters) {
      lines.push(`- ${c.name_zh}${c.name_en ? ` (${c.name_en})` : ""}${c.notes ? `: ${c.notes}` : ""}`);
    }
  }
  if (title.notes) lines.push(`\nStaff notes:\n${title.notes}`);
  return { text: lines.join("\n"), cache: true };
}

function systemParam(
  system: string | LlmSystemBlock[],
  cacheSystem: boolean | undefined
): Anthropic.TextBlockParam[] {
  const blocks: LlmSystemBlock[] = typeof system === "string" ? [{ text: system }] : system.slice();
  if (cacheSystem && blocks.length) blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache: true };
  return blocks.map((b) =>
    b.cache
      ? { type: "text", text: b.text, cache_control: { type: "ephemeral" } }
      : { type: "text", text: b.text }
  );
}

// ---- zod -> JSON schema ------------------------------------------------------------------
//
// Deliberately small: only the keywords strict structured outputs accept
// (type, properties, required, additionalProperties:false, items, enum,
// anyOf, description). Numeric bounds, string lengths and array lengths are
// NOT emitted — zod enforces them after the call, and a violation is what the
// repair turn is for. Every object key is required (strict mode demands it),
// so prompt schemas say .nullable() where a value may be absent; .optional()
// is rejected here on purpose because zod would then refuse the null the
// model sends.

export type JsonSchema = Record<string, unknown>;

type ZodDefLike = {
  typeName: string;
  description?: string;
  checks?: { kind: string }[];
  type?: ZodTypeAny;
  shape?: () => Record<string, ZodTypeAny>;
  values?: unknown;
  value?: unknown;
  innerType?: ZodTypeAny;
  schema?: ZodTypeAny;
  options?: ZodTypeAny[];
};

function defOf(s: ZodTypeAny): ZodDefLike {
  return (s as unknown as { _def: ZodDefLike })._def;
}

function nullable(inner: JsonSchema): JsonSchema {
  const { description, ...rest } = inner;
  const out: JsonSchema = { anyOf: [rest, { type: "null" }] };
  if (description) out.description = description;
  return out;
}

export function zodToJsonSchema(s: ZodTypeAny): JsonSchema {
  const def = defOf(s);
  const withDesc = (o: JsonSchema): JsonSchema => (def.description ? { ...o, description: def.description } : o);
  switch (def.typeName) {
    case "ZodString":
      return withDesc({ type: "string" });
    case "ZodNumber":
      return withDesc({ type: def.checks?.some((c) => c.kind === "int") ? "integer" : "number" });
    case "ZodBoolean":
      return withDesc({ type: "boolean" });
    case "ZodNull":
      return { type: "null" };
    case "ZodLiteral":
      return withDesc({ enum: [def.value] });
    case "ZodEnum":
      return withDesc({ type: "string", enum: def.values as string[] });
    case "ZodNativeEnum":
      return withDesc({
        type: "string",
        enum: Object.values(def.values as Record<string, unknown>).filter((v) => typeof v === "string"),
      });
    case "ZodArray":
      return withDesc({ type: "array", items: zodToJsonSchema(def.type as ZodTypeAny) });
    case "ZodObject": {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const key of Object.keys(shape)) {
        properties[key] = zodToJsonSchema(shape[key]);
        required.push(key);
      }
      return withDesc({ type: "object", properties, required, additionalProperties: false });
    }
    case "ZodNullable":
      return withDesc(nullable(zodToJsonSchema(def.innerType as ZodTypeAny)));
    case "ZodDefault":
      return withDesc(zodToJsonSchema(def.innerType as ZodTypeAny));
    case "ZodEffects":
      return withDesc(zodToJsonSchema(def.schema as ZodTypeAny));
    case "ZodUnion":
      return withDesc({ anyOf: (def.options as ZodTypeAny[]).map(zodToJsonSchema) });
    case "ZodAny":
    case "ZodUnknown":
      return withDesc({});
    case "ZodOptional":
      throw new Error("zodToJsonSchema: use .nullable() instead of .optional() (strict output requires every key)");
    default:
      throw new Error(`zodToJsonSchema: unsupported zod type ${def.typeName}`);
  }
}

// ---- callStructured ----------------------------------------------------------------------

export type StructuredCall<T> = {
  /** The tool name; also the job's name in logs. snake_case. */
  name: string;
  /** What the tool records — the model reads it as the output contract. */
  description?: string;
  system: string | LlmSystemBlock[];
  user: string;
  /** Images the user message carries (frame strips, join sheets); refused before any request on a text-only model. */
  images?: LlmImage[];
  schema: ZodType<T>;
  /** The gateway for this call; LLM_PROVIDER when absent. `model` must then be one of that provider's ids. */
  provider?: LlmProvider;
  /** Defaults to the provider's fast tier (modelFor). */
  model?: string;
  maxTokens: number;
  /** Mark the last system block as a cache breakpoint (the whole tools+system prefix is then cached). */
  cacheSystem?: boolean;
  effort?: Effort;
  /**
   * Anthropic only: how the tool call is asked for when ANTHROPIC_TOOL_CHOICE
   * is blank. `auto` lets the model think before it answers (a forced call
   * skips the thinking: the probe and the calibration of 2026-09-23); the
   * frame judge's prompts set it. Absent = forced where the model accepts it.
   */
  toolChoice?: ToolChoicePreference;
  /**
   * A semantic check the JSON schema cannot express (every seq present once,
   * exactly five titles). Return a message to trigger the repair turn, null
   * when the data is good.
   */
  check?: (data: T) => string | null;
};

/** How one Anthropic turn ended: its stop reason, its output tokens (thinking included) and how many thinking blocks came before the answer, so the job record and the eval can see whether the model thought first. */
export type TurnTrace = { stop_reason: string | null; output_tokens: number; thinking_blocks: number };

export type StructuredResult<T> = {
  data: T;
  usage: LlmUsage;
  cost_cents: number;
  provider: LlmProvider;
  model: string;
  /** 1 when the first answer validated, 2 when the repair turn was needed. */
  turns: number;
  /** One entry per turn on the Anthropic path; absent on the other gateways. */
  trace?: TurnTrace[];
};

/** What callStructured resolved before dispatching: the provider, its model and the loaded images. */
export type CallContext = { provider: LlmProvider; model: string; images: LoadedImage[] };

// ---- the Anthropic request ----------------------------------------------------------------
//
// Adaptive thinking is on by default on Sonnet 5 and Opus 5 (and cannot be
// switched off on Opus 5.5), and the thinking counts against max_tokens, so a
// budget sized for the JSON answer alone ends in stop_reason "max_tokens"
// with no tool_use block: a lost call, paid for. The call's maxTokens is the
// room for the answer; ANTHROPIC_THINKING_TOKENS is added on top for the
// thinking, as DEEPSEEK_THINKING_TOKENS is on DeepSeek's strong tier. Every
// request streams, so the larger ceiling costs no timeout.
//
// The tool call is forced (`tool_choice: {type: "tool"}`) on the models that
// accept it, unless the call asks for `auto`. Opus 5.5, Fable 5.1 and Mythos
// 5.1 answer a forced choice with 400 (`tool_choice: type "tool" and "any"
// are not supported for this model.`), so on those the choice is always
// `auto` with one call at most, the user turn ends with "Answer only by
// calling <tool>.", and a reply with no tool call gets the nudge as its
// repair turn. The probe and the calibration of 2026-09-23 ("The frame
// judge on Claude, measured") showed that a FORCED call skips the thinking
// (0 of 40 turns thought first) while `auto` thinks first (41 of 41), so a
// prompt that needs the thinking (the frame judge) sets `toolChoice: "auto"`.
// ANTHROPIC_TOOL_CHOICE overrides every call: `auto` sends every model that
// way, `forced` forces where the model accepts it, the judge included (the
// cheap comparison arm: on Sonnet 5, 14/20 either way).

/** Tokens added to the call's maxTokens for the thinking the model does before its tool call. */
export const ANTHROPIC_THINKING_TOKENS = 16_000;

/** Whether a model accepts `tool_choice: {type: "tool"}`; Opus 5.5, Fable 5.1 and Mythos 5.1 answer 400 to it. */
export function acceptsForcedToolChoice(model: string): boolean {
  return !/^claude-(opus-5-5|fable-5-1|mythos-5-1)(-|$)/.test(model);
}

export type AnthropicToolChoice = Anthropic.ToolChoiceTool | Anthropic.ToolChoiceAuto;

/** A call's own preference when the environment says nothing: `auto` thinks first; `forced` (the default) is the cheaper direct call. */
export type ToolChoicePreference = "auto" | "forced";

/** What ANTHROPIC_TOOL_CHOICE says, or null when it is blank or unrecognised. */
export function toolChoiceSetting(env: Env = process.env): ToolChoicePreference | null {
  const s = (env.ANTHROPIC_TOOL_CHOICE ?? "").trim().toLowerCase();
  return s === "auto" || s === "forced" ? s : null;
}

/**
 * The tool_choice of one call: ANTHROPIC_TOOL_CHOICE when set (`auto` or
 * `forced`), else the call's own preference, else forced; and forced only
 * where the model accepts it. Auto is sent with at most one call. Pure.
 */
export function anthropicToolChoice(model: string, name: string, env: Env = process.env, prefer: ToolChoicePreference = "forced"): AnthropicToolChoice {
  const auto = (toolChoiceSetting(env) ?? prefer) === "auto";
  if (!auto && acceptsForcedToolChoice(model)) return { type: "tool", name, disable_parallel_tool_use: true };
  return { type: "auto", disable_parallel_tool_use: true };
}

/** The user text of the first turn: the call's own, plus the instruction to answer through the tool when the call is not forced. */
export function anthropicUserText(user: string, name: string, toolChoice: AnthropicToolChoice): string {
  return toolChoice.type === "tool" ? user : `${user}\n\nAnswer only by calling ${name}.`;
}

/** Everything of one Anthropic turn but the messages. */
export type AnthropicTurnParams = Pick<Anthropic.MessageCreateParams, "model" | "max_tokens" | "system" | "tools" | "output_config"> & { tool_choice: AnthropicToolChoice };

/** The request of one turn without its messages: the strict tool, the budget with the thinking's room, the tool choice for the model, the effort. Pure; the tests pin it per model. */
export function anthropicRequestParams<T>(call: StructuredCall<T>, model: string, env: Env = process.env): AnthropicTurnParams {
  const tool: Anthropic.Tool = {
    name: call.name,
    description: call.description ?? `Record the ${call.name} result.`,
    input_schema: zodToJsonSchema(call.schema) as Anthropic.Tool.InputSchema,
    strict: true,
  };
  return {
    model,
    max_tokens: call.maxTokens + ANTHROPIC_THINKING_TOKENS,
    system: systemParam(call.system, call.cacheSystem),
    tools: [tool],
    tool_choice: anthropicToolChoice(model, call.name, env, call.toolChoice),
    output_config: { effort: call.effort ?? "medium" },
  };
}

/** How a turn's reply can be repaired: the tool's error result (a schema or check failure), the nudge (no tool call at all), or not at all. */
export type TurnRepair = { kind: "tool_result"; tool_use_id: string } | { kind: "nudge" } | null;

export type ParsedTurn<T> = { ok: true; data: T } | { ok: false; code: LlmFailure; problem: string; repair: TurnRepair };

/** One reply read against the call's schema and check. Pure; exported for the tests. */
export function parseAnthropicResponse<T>(res: Anthropic.Message, call: StructuredCall<T>): ParsedTurn<T> {
  if (res.stop_reason === "refusal") {
    return { ok: false, code: "refused", problem: res.stop_details?.explanation || "The model declined to process this content.", repair: null };
  }
  const block = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === call.name);
  if (!block) {
    if (res.stop_reason === "max_tokens") {
      return { ok: false, code: "truncated", problem: `Output hit max_tokens (${res.usage.output_tokens} output tokens, thinking included) before the tool call completed.`, repair: null };
    }
    // The model answered in text (a tool_choice of auto): one nudge, then it is invalid output.
    return { ok: false, code: "invalid_output", problem: `No ${call.name} tool call in the response (stop_reason ${res.stop_reason}).`, repair: { kind: "nudge" } };
  }
  const parsed = call.schema.safeParse(block.input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 12)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    return { ok: false, code: "invalid_output", problem: `Schema violations:\n${issues}`, repair: { kind: "tool_result", tool_use_id: block.id } };
  }
  const semantic = call.check ? call.check(parsed.data) : null;
  if (semantic) return { ok: false, code: "invalid_output", problem: semantic, repair: { kind: "tool_result", tool_use_id: block.id } };
  return { ok: true, data: parsed.data };
}

/** The trace of one reply: how it stopped, what it produced, whether it thought first (a thinking block with `display` omitted is present with empty text, so the count still says). */
export function turnTraceOf(res: Pick<Anthropic.Message, "stop_reason" | "content" | "usage">): TurnTrace {
  return { stop_reason: res.stop_reason, output_tokens: res.usage.output_tokens, thinking_blocks: res.content.filter((b) => b.type === "thinking" || b.type === "redacted_thinking").length };
}

/** The spend of a failed call rides on its error, so the job row keeps it (CLAUDE.md: every model call has a row with usage and cost_cents). */
function withSpend(err: Error, model: string, usage: LlmUsage): Error {
  const spent = usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens > 0;
  if (err instanceof LlmError && !err.usage && spent) {
    err.usage = { ...usage };
    err.cost_cents = costCents(model, usage);
  }
  return err;
}

/**
 * One structured call: system + user in, a schema-validated object out, with
 * what it cost. Streams so a long first pass cannot outlive the SDK's
 * non-streaming ceiling; retries transport and rate-limit failures with
 * backoff; validates with zod and, on a schema or semantic failure, sends the
 * violations back as an error tool_result and lets the model call once more
 * (after a reply with no tool call at all, the repair turn is the nudge).
 */
async function callAnthropicStructured<T>(call: StructuredCall<T>, ctx: CallContext): Promise<StructuredResult<T>> {
  const { provider, model } = ctx;
  const params = anthropicRequestParams(call, model);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: anthropicUserContent(anthropicUserText(call.user, call.name, params.tool_choice), ctx.images) }];
  const usage = zeroUsage();
  const trace: TurnTrace[] = [];

  const request = async () => {
    const res = await withRetries(() => anthropicClient().messages.stream({ ...params, messages }).finalMessage());
    addAnthropicUsage(usage, res.usage);
    trace.push(turnTraceOf(res));
    return res;
  };

  try {
    let res = await request();
    let parsed = parseAnthropicResponse(res, call);
    let turns = 1;

    if (!parsed.ok && parsed.repair) {
      // The repair turn: hand the violations back as the tool's error result
      // and ask for the same tool again, or, after a reply with no tool call,
      // the nudge. Thinking blocks ride along unchanged (same model), which
      // the API requires.
      messages.push({ role: "assistant", content: res.content });
      messages.push({
        role: "user",
        content:
          parsed.repair.kind === "tool_result"
            ? [
                { type: "tool_result", tool_use_id: parsed.repair.tool_use_id, is_error: true, content: parsed.problem },
                { type: "text", text: `Call ${call.name} again with a corrected input. Fix only what the error names; keep everything else identical.` },
              ]
            : [{ type: "text", text: `Call ${call.name} now with your answer; do not answer in text.` }],
      });
      res = await request();
      parsed = parseAnthropicResponse(res, call);
      turns = 2;
    }

    if (!parsed.ok) throw new LlmError(parsed.code, parsed.problem);
    return { data: parsed.data, usage, cost_cents: costCents(model, usage), provider, model, turns, trace };
  } catch (e) {
    throw withSpend(toLlmError(e, provider), model, usage);
  }
}

/** OpenAI Responses API equivalent of the Claude forced-tool contract. */
async function callOpenAiStructured<T>(call: StructuredCall<T>, ctx: CallContext): Promise<StructuredResult<T>> {
  const { provider, model } = ctx;
  const usage = zeroUsage();
  const instructions = typeof call.system === "string" ? call.system : call.system.map((b) => b.text).join("\n\n");
  let input = responsesUserInput(call.user, ctx.images);

  try {
    for (let turn = 1; turn <= 2; turn++) {
      const res = await withRetries(() =>
        openAiClient().responses.parse({
          model,
          instructions,
          input,
          max_output_tokens: call.maxTokens,
          reasoning: { effort: call.effort ?? "medium" },
          text: {
            format: zodTextFormat(call.schema, call.name, {
              description: call.description ?? `Record the ${call.name} result.`,
            }),
          },
          store: false,
        })
      );
      if (res.usage) addOpenAiUsage(usage, res.usage);

      const parsed = call.schema.safeParse(res.output_parsed);
      const semantic = parsed.success && call.check ? call.check(parsed.data) : null;
      if (parsed.success && !semantic) {
        return { data: parsed.data, usage, cost_cents: costCents(model, usage), provider, model, turns: turn };
      }

      const problem = parsed.success
        ? semantic!
        : `Schema violations:\n${parsed.error.issues
            .slice(0, 12)
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("\n")}`;
      if (turn === 2) throw new LlmError("invalid_output", problem);
      input = responsesUserInput(
        `${call.user}\n\nYOUR PREVIOUS STRUCTURED ANSWER WAS INVALID:\n${res.output_text}\n\nVALIDATION ERROR:\n${problem}\n\nReturn a corrected answer. Fix only what the error names; keep everything else identical.`,
        ctx.images
      );
    }
    throw new LlmError("invalid_output", "No structured output was returned.");
  } catch (e) {
    throw withSpend(toLlmError(e, provider), model, usage);
  }
}

function schemaIssues(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  return `Schema violations:\n${error.issues
    .slice(0, 12)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n")}`;
}

// ---- DeepSeek thinking mode ---------------------------------------------------------------
//
// The V4 API thinks unless told not to (`thinking.type` defaults to
// "enabled" at effort high; api-docs.deepseek.com/api/create-chat-completion,
// read 2026-09-23) and its reasoning tokens count against max_tokens, so a
// budget sized for a JSON answer would end with finish_reason "length" and
// every reading pass would pay reasoning at the output rate. The rule
// (decision 2026-09-22): the fast tier never thinks (what deepseek-chat was);
// the strong tier thinks when the call names an effort (what deepseek-reasoner
// was), and the reasoning then gets its own room on top of the call's
// maxTokens. `reasoning_effort` is a top-level field beside `thinking`.

export type DeepSeekEffort = "low" | "high" | "max";

export type DeepSeekReasoning =
  | { thinking: { type: "disabled" } }
  | { thinking: { type: "enabled" }; reasoning_effort: DeepSeekEffort };

/** Tokens the reasoning may use on top of the call's own maxTokens when thinking is on. */
export const DEEPSEEK_THINKING_TOKENS = 32_000;

/** DeepSeek accepts none/low/high/max and itself maps medium and xhigh to high; sent explicitly so the body only carries documented values. */
const DEEPSEEK_EFFORT: Record<Effort, DeepSeekEffort> = { low: "low", medium: "high", high: "high", xhigh: "high", max: "max" };

/** The thinking decision for one call, from its tier and effort. Pure; the tests prove both tiers. */
export function deepSeekReasoning(call: Pick<StructuredCall<unknown>, "effort">, model: string, env: Env = process.env): DeepSeekReasoning {
  // A model that also serves the fast tier never thinks: the fast tier is the cheap lane whatever id it carries.
  const strong = model === modelFor("deepseek", "strong", env) && model !== modelFor("deepseek", "fast", env);
  if (!strong || !call.effort) return { thinking: { type: "disabled" } };
  return { thinking: { type: "enabled" }, reasoning_effort: DEEPSEEK_EFFORT[call.effort] };
}

/** The chat.completions body; `thinking` is not in the SDK's type but the SDK posts the params object as the JSON body untouched. */
export type DeepSeekRequestBody = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & DeepSeekReasoning;

/** The whole request body for one DeepSeek turn. Pure; exported for the tests. */
export function deepSeekRequestBody<T>(
  call: StructuredCall<T>,
  ctx: Pick<CallContext, "model" | "images">,
  turn: { system: string; user: string },
  env: Env = process.env
): DeepSeekRequestBody {
  const reasoning = deepSeekReasoning(call, ctx.model, env);
  return {
    model: ctx.model,
    messages: [
      { role: "system", content: turn.system },
      { role: "user", content: chatUserContent(turn.user, ctx.images) },
    ],
    max_tokens: reasoning.thinking.type === "enabled" ? call.maxTokens + DEEPSEEK_THINKING_TOKENS : call.maxTokens,
    response_format: { type: "json_object" },
    stream: false,
    ...reasoning,
  };
}

/**
 * DeepSeek equivalent: chat completions in JSON mode with the schema stated
 * in the system prompt (no server-side schema enforcement there), the same
 * zod validation on our side, and the same single repair turn. `effort`
 * becomes `reasoning_effort` on the strong tier only (deepSeekReasoning).
 * Images ride in the user message as data URIs; the text-only model was
 * refused before this point.
 */
async function callDeepSeekStructured<T>(call: StructuredCall<T>, ctx: CallContext): Promise<StructuredResult<T>> {
  const { provider, model } = ctx;
  const usage = zeroUsage();
  const systemText = typeof call.system === "string" ? call.system : call.system.map((b) => b.text).join("\n\n");
  const contract = call.description ?? `Record the ${call.name} result.`;
  const system = `${systemText}\n\nOUTPUT CONTRACT (${call.name}): ${contract}\nRespond with exactly one JSON object and nothing else. It must validate against this JSON Schema; every listed key is required and no other key is allowed:\n${JSON.stringify(zodToJsonSchema(call.schema))}`;
  let user = call.user;

  try {
    for (let turn = 1; turn <= 2; turn++) {
      const res = await withRetries(() => deepSeekClient().chat.completions.create(deepSeekRequestBody(call, ctx, { system, user })));
      if (res.usage) addChatUsage(usage, res.usage);
      const choice = res.choices[0];
      if (!choice) throw new LlmError("invalid_output", "No choices in the response.");
      if (choice.finish_reason === "length") throw new LlmError("truncated", "Output hit max_tokens before the JSON object completed.");
      if (choice.finish_reason === "content_filter") throw new LlmError("refused", "The model declined to process this content.");
      const text = choice.message.content ?? "";

      let json: unknown;
      let problem: string | null = null;
      try {
        json = JSON.parse(text);
      } catch {
        const m = text.match(/\{[\s\S]*\}/);
        try {
          json = m ? JSON.parse(m[0]) : undefined;
        } catch {
          json = undefined;
        }
      }
      if (json === undefined) problem = "The response was not a JSON object.";
      else {
        const parsed = call.schema.safeParse(json);
        if (!parsed.success) problem = schemaIssues(parsed.error);
        else {
          const semantic = call.check ? call.check(parsed.data) : null;
          if (!semantic) return { data: parsed.data, usage, cost_cents: costCents(model, usage), provider, model, turns: turn };
          problem = semantic;
        }
      }
      if (turn === 2) throw new LlmError("invalid_output", problem);
      user = `${call.user}\n\nYOUR PREVIOUS STRUCTURED ANSWER WAS INVALID:\n${text}\n\nVALIDATION ERROR:\n${problem}\n\nReturn a corrected JSON object. Fix only what the error names; keep everything else identical.`;
    }
    throw new LlmError("invalid_output", "No structured output was returned.");
  } catch (e) {
    throw withSpend(toLlmError(e, provider), model, usage);
  }
}

/**
 * Resolve the call's provider and model and refuse what cannot run before a
 * single byte leaves the process: a model from another vendor, a missing
 * key, or images for a model that does not read them. Pure apart from
 * reading the environment; exported so the tests can prove the refusals
 * without a network.
 */
export function resolveCall<T>(call: StructuredCall<T>, env: Env = process.env): { provider: LlmProvider; model: string } {
  const provider = call.provider ?? (parseProvider(env.LLM_PROVIDER) ?? "anthropic");
  const model = call.model ?? modelFor(provider, "fast", env);
  const family = modelFamily(model);
  if (family && family !== provider) {
    throw new LlmError("invalid", `${model} is a ${family} model and cannot be sent to ${provider}; set the call's provider and model together`);
  }
  if (!isLlmAvailable(provider, env)) throw new LlmUnavailableError(undefined, provider);
  if (call.images?.length && !modelSupportsVision(provider, model)) {
    throw new LlmUnavailableError(
      `vision provider unavailable: ${model} (${provider}) does not read images; set ADS_VISION_PROVIDER to a provider with a vision model and its key`,
      provider
    );
  }
  return { provider, model };
}

export async function callStructured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
  const { provider, model } = resolveCall(call);
  const ctx: CallContext = { provider, model, images: call.images?.length ? loadImages(call.images) : [] };
  if (provider === "openai") return callOpenAiStructured(call, ctx);
  if (provider === "deepseek") return callDeepSeekStructured(call, ctx);
  return callAnthropicStructured(call, ctx);
}
