// The Claude probe of decision 2026-09-23 "The frame judge on Claude": a few
// tiny text-only calls (well under $0.05) that answer, before the eval spends
// on eighty boundaries, the questions only a live call can:
//
//   - does the key work at all (an identity-linked key needs ANTHROPIC_WORKSPACE_ID);
//   - does Sonnet 5 / Opus 5 think BEFORE a forced tool call (thinking blocks in
//     the content, output tokens well above the JSON's size), or only under
//     tool_choice auto — if only under auto, run the eval with ANTHROPIC_TOOL_CHOICE=auto;
//   - what Opus 5.5 answers on the gateway's auto path.
//
//   npx tsx scripts/anthropic-probe.ts            (from the Studio repo root; reads .env.local)
//
// Prints stop reasons, content block types, usage and cents per call. Never
// prints a key. Fixture data source, no job rows: the calls go straight
// through lib/llm.ts's gateway and, for the block types, the SDK.

process.env.DATA_SOURCE = process.env.DATA_SOURCE ?? "fixture";
process.env.DEMO_REPLAY = "0";

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { anthropicRequestParams, anthropicUserText, callStructured, costCents, turnTraceOf, type StructuredCall } from "@/lib/llm";

const Schema = z.object({ reasoning_summary: z.string().describe("One sentence on how the answer was reached."), answer: z.number().int() });
const QUESTION = "A train leaves at 09:47 and the trip takes 3 h 38 min. Then it waits 47 min and returns on a trip 12 min longer than the first. At what minute of the day (0-1439) does it arrive back?";

function call(model: string): StructuredCall<z.infer<typeof Schema>> {
  return { name: "record_answer", description: "Record the answer.", system: "You answer arithmetic questions exactly.", user: QUESTION, schema: Schema, provider: "anthropic", model, maxTokens: 2000, effort: "medium" };
}

/** Through the gateway: what the frame judge will get. */
async function viaGateway(model: string): Promise<void> {
  try {
    const r = await callStructured(call(model));
    const trace = (r.trace ?? []).map((t) => `${t.stop_reason} out=${t.output_tokens} thinking_blocks=${t.thinking_blocks}`).join(" | ");
    console.log(`[gateway] ${model}: answer=${r.data.answer} turns=${r.turns} [${trace}] cents=${r.cost_cents}`);
  } catch (e) {
    const err = e as { name?: string; code?: string; status?: number; message?: string };
    console.log(`[gateway] ${model}: ${err.name} code=${err.code ?? "-"} status=${err.status ?? "-"} ${err.message}`);
  }
}

/** Direct, with the gateway's own request: the content block types say whether the model thought before the tool call. */
async function direct(model: string, env: NodeJS.ProcessEnv): Promise<void> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, defaultHeaders: env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } : undefined });
  const c = call(model);
  const params = anthropicRequestParams(c, model, env);
  try {
    const res = await client.messages.stream({ ...params, messages: [{ role: "user", content: anthropicUserText(c.user, c.name, params.tool_choice) }] }).finalMessage();
    const blocks = res.content.map((b) => (b.type === "thinking" ? `thinking(${b.thinking.length} chars)` : b.type === "tool_use" ? `tool_use(${JSON.stringify(b.input)})` : b.type));
    const t = turnTraceOf(res);
    const usage = { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, cache_read_tokens: res.usage.cache_read_input_tokens ?? 0, cache_write_tokens: res.usage.cache_creation_input_tokens ?? 0 };
    console.log(`[direct] ${model} tool_choice=${params.tool_choice.type}: stop=${t.stop_reason} thinking_blocks=${t.thinking_blocks} blocks=[${blocks.join(", ")}] in=${usage.input_tokens} out=${usage.output_tokens} cents=${costCents(model, usage)}`);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    console.log(`[direct] ${model} tool_choice=${params.tool_choice.type}: ERROR status=${err.status ?? "-"} ${err.message}`);
  }
}

async function main(): Promise<void> {
  console.log(`ANTHROPIC_API_KEY set: ${!!process.env.ANTHROPIC_API_KEY}; ANTHROPIC_WORKSPACE_ID set: ${!!process.env.ANTHROPIC_WORKSPACE_ID}; ANTHROPIC_TOOL_CHOICE: ${process.env.ANTHROPIC_TOOL_CHOICE || "(blank: forced where accepted)"}`);
  for (const model of ["claude-sonnet-5", "claude-opus-5", "claude-opus-5-5"]) await viaGateway(model);
  // The forced call as the gateway sends it, then the same call on the auto path, so the two thinking counts sit side by side.
  for (const model of ["claude-sonnet-5", "claude-opus-5"]) {
    await direct(model, { ...process.env, ANTHROPIC_TOOL_CHOICE: "" });
    await direct(model, { ...process.env, ANTHROPIC_TOOL_CHOICE: "auto" });
  }
  await direct("claude-opus-5-5", process.env);
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exit(1);
});
