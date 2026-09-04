// The one gateway for every model call in Studio — the way every TikTok call
// in the sibling goes through lib/tiktok.ts. One place for the model choice,
// the price table, retries, structured output and the failure taxonomy, so a
// prompt module (lib/prompts/*) only says WHAT it wants back and lib/jobs.ts
// only says WHERE the result goes.
//
// Structured output is a forced tool call: one tool per call whose
// input_schema is derived from the caller's zod schema, `strict: true` so the
// API guarantees schema-valid arguments, and the same zod schema (plus an
// optional semantic `check`) re-validates on our side; a failure gets exactly
// one repair turn. Cost is computed here from PRICES on every call so a job
// row can never carry usage without cents. Nothing in this file touches the
// database.
//
// Works without credentials: isLlmAvailable() is the switch the UI and the
// jobs read; callStructured() throws LlmUnavailableError before any request
// when the key is missing.

import Anthropic from "@anthropic-ai/sdk";
import type { ZodType, ZodTypeAny } from "zod";
import type { Character, JobUsage, Title } from "@/lib/types";

export const LLM_PROVIDER = "anthropic";

/**
 * Two tiers. FAST does the reading passes (title bible, scene context, clip
 * ranking); STRONG does the writing passes (first pass, alternatives,
 * rewrites, the creative pack). Both overridable from the environment so a
 * cheaper model can be tried without a code change.
 */
export const MODEL_FAST = process.env.LLM_MODEL_FAST || "claude-sonnet-5";
export const MODEL_STRONG = process.env.LLM_MODEL_STRONG || "claude-opus-5";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** USD per million tokens. Cache write is 1.25x input, cache read 0.1x (0.25 on Fable 5.1). */
export type ModelPrice = {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
};

export const PRICES: Record<string, ModelPrice> = {
  "claude-opus-5": { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cache_write: 2.5, cache_read: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cache_write: 12.5, cache_read: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cache_write: 12.5, cache_read: 1 },
  "claude-opus-4-8": { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 },
};

/** An unknown model id is priced at the dearest known tier: spend must never be under-reported. */
const FALLBACK_PRICE: ModelPrice = PRICES["claude-fable-5-1"];

export function priceFor(model: string): ModelPrice {
  const p = PRICES[model];
  if (!p) console.warn(`[llm] no price for model ${model}; charging at the top tier`);
  return p ?? FALLBACK_PRICE;
}

// ---- availability and errors --------------------------------------------------------

export function isLlmAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/** No key. Routes map it to 503 with error code 'llm_unavailable'. */
export class LlmUnavailableError extends Error {
  readonly code = "llm_unavailable" as const;
  constructor() {
    super("AI passes are unavailable: set ANTHROPIC_API_KEY in .env.local");
    this.name = "LlmUnavailableError";
  }
}

export type LlmFailure = "refused" | "invalid_output" | "truncated" | "api";

/** A call that reached the API and came back unusable. `status` is the HTTP status when there was one. */
export class LlmError extends Error {
  readonly code: LlmFailure;
  readonly status: number | undefined;
  constructor(code: LlmFailure, message: string, status?: number) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.status = status;
  }
}

// ---- usage and cost --------------------------------------------------------------------

/** What a call consumed; the JobUsage columns plus the cache-write count the row does not keep. */
export type LlmUsage = Required<Pick<JobUsage, "input_tokens" | "output_tokens" | "cache_read_tokens">> & {
  cache_write_tokens: number;
};

function zeroUsage(): LlmUsage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
}

function addUsage(into: LlmUsage, u: Anthropic.Usage): void {
  into.input_tokens += u.input_tokens;
  into.output_tokens += u.output_tokens;
  into.cache_read_tokens += u.cache_read_input_tokens ?? 0;
  into.cache_write_tokens += u.cache_creation_input_tokens ?? 0;
}

/** Whole cents, rounded up: a 0.3-cent call is a 1-cent row, never a free one. */
export function costCents(model: string, u: LlmUsage): number {
  const p = priceFor(model);
  const usd =
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_write_tokens * p.cache_write +
      u.cache_read_tokens * p.cache_read) /
    1_000_000;
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

// ---- the client ------------------------------------------------------------------------

// One client per process: Next bundles lib/ separately into every route, so
// the singleton lives on globalThis (the sibling's pattern for pacers and
// job locks). maxRetries 0 because the backoff loop below owns retries.
const g = globalThis as typeof globalThis & { __studioLlm?: Anthropic };

function client(): Anthropic {
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

const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [1000, 3000, 9000];

function isRetryable(e: unknown): boolean {
  if (e instanceof Anthropic.RateLimitError) return true;
  if (e instanceof Anthropic.InternalServerError) return true; // 5xx and 529 overloaded
  if (e instanceof Anthropic.APIConnectionError) return true; // includes timeouts
  if (e instanceof Anthropic.APIError) return e.status === 408 || e.status === 409;
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

/** SDK errors become one LlmError so callers never depend on SDK classes. */
function toLlmError(e: unknown): Error {
  if (e instanceof LlmError || e instanceof LlmUnavailableError) return e;
  if (e instanceof Anthropic.AuthenticationError) return new LlmUnavailableError();
  if (e instanceof Anthropic.APIError) {
    return new LlmError("api", `Claude API ${e.status ?? "?"}: ${e.message}`, e.status);
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
  schema: ZodType<T>;
  model?: string;
  maxTokens: number;
  /** Mark the last system block as a cache breakpoint (the whole tools+system prefix is then cached). */
  cacheSystem?: boolean;
  effort?: Effort;
  /**
   * A semantic check the JSON schema cannot express (every seq present once,
   * exactly five titles). Return a message to trigger the repair turn, null
   * when the data is good.
   */
  check?: (data: T) => string | null;
};

export type StructuredResult<T> = {
  data: T;
  usage: LlmUsage;
  cost_cents: number;
  model: string;
  /** 1 when the first answer validated, 2 when the repair turn was needed. */
  turns: number;
};

type Parsed<T> =
  | { ok: true; data: T }
  | { ok: false; code: LlmFailure; problem: string; toolUseId: string | null };

function parseResponse<T>(res: Anthropic.Message, call: StructuredCall<T>): Parsed<T> {
  if (res.stop_reason === "refusal") {
    return {
      ok: false,
      code: "refused",
      problem: res.stop_details?.explanation || "The model declined to process this content.",
      toolUseId: null,
    };
  }
  const block = res.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === call.name
  );
  if (!block) {
    if (res.stop_reason === "max_tokens") {
      return { ok: false, code: "truncated", problem: "Output hit max_tokens before the tool call completed.", toolUseId: null };
    }
    return { ok: false, code: "invalid_output", problem: `No ${call.name} tool call in the response (stop_reason ${res.stop_reason}).`, toolUseId: null };
  }
  const parsed = call.schema.safeParse(block.input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 12)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    return { ok: false, code: "invalid_output", problem: `Schema violations:\n${issues}`, toolUseId: block.id };
  }
  const semantic = call.check ? call.check(parsed.data) : null;
  if (semantic) return { ok: false, code: "invalid_output", problem: semantic, toolUseId: block.id };
  return { ok: true, data: parsed.data };
}

/**
 * One structured call: system + user in, a schema-validated object out, with
 * what it cost. Streams so a long first pass cannot outlive the SDK's
 * non-streaming ceiling; retries transport and rate-limit failures with
 * backoff; validates with zod and, on a schema or semantic failure, sends the
 * violations back as an error tool_result and lets the model call once more.
 */
export async function callStructured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
  if (!isLlmAvailable()) throw new LlmUnavailableError();
  const model = call.model ?? MODEL_FAST;
  const tool: Anthropic.Tool = {
    name: call.name,
    description: call.description ?? `Record the ${call.name} result.`,
    input_schema: zodToJsonSchema(call.schema) as Anthropic.Tool.InputSchema,
    strict: true,
  };
  const system = systemParam(call.system, call.cacheSystem);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: call.user }];
  const usage = zeroUsage();

  const request = () =>
    withRetries(() =>
      client()
        .messages.stream({
          model,
          max_tokens: call.maxTokens,
          system,
          messages,
          tools: [tool],
          tool_choice: { type: "tool", name: call.name, disable_parallel_tool_use: true },
          output_config: { effort: call.effort ?? "medium" },
        })
        .finalMessage()
    );

  try {
    let res = await request();
    addUsage(usage, res.usage);
    let parsed = parseResponse(res, call);
    let turns = 1;

    if (!parsed.ok && parsed.toolUseId) {
      // The repair turn: hand the violations back as the tool's error result
      // and force the same tool again. Thinking blocks ride along unchanged
      // (same model), which the API requires.
      messages.push({ role: "assistant", content: res.content });
      messages.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: parsed.toolUseId, is_error: true, content: parsed.problem },
          {
            type: "text",
            text: `Call ${call.name} again with a corrected input. Fix only what the error names; keep everything else identical.`,
          },
        ],
      });
      res = await request();
      addUsage(usage, res.usage);
      parsed = parseResponse(res, call);
      turns = 2;
    }

    if (!parsed.ok) throw new LlmError(parsed.code, parsed.problem);
    return { data: parsed.data, usage, cost_cents: costCents(model, usage), model, turns };
  } catch (e) {
    throw toLlmError(e);
  }
}
