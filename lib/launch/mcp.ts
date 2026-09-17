import { z } from "zod";
import type { Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { isDataError } from "@/lib/data/errors";
import { controlSchema } from "./routes";
import { controlLaunch, queueLaunch, refreshLaunches } from "./service";
import type { LaunchConnection, LaunchPlan, LaunchRun } from "./types";

export const MCP_VERSION = "2025-11-25";
export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  return /^Bearer ([^\s]+)$/i.exec(header)?.[1] ?? null;
}
type Params = Record<string, unknown>;
type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; parse: z.ZodType<Params> };
const id = z.string().min(1).max(150);
const idShape = { id: { type: "string", description: "Studio launch UUID or lr_ external ID" } };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const controlInput = { oneOf: [
  ...["pause", "resume", "end", "duplicate"].map(action => object({ action: { const: action } }, ["action"])),
  object({ action: { const: "budget" }, budget_cents: { type: "integer", minimum: 1 } }, ["action", "budget_cents"]),
  object({ action: { const: "daily_budget" }, daily_budget_cents: { type: "integer", minimum: 1 } }, ["action", "daily_budget_cents"]),
  object({ action: { const: "bid" }, bid_cents: { type: "integer", minimum: 1 } }, ["action", "bid_cents"]),
  object({ action: { const: "schedule" }, end_time: { type: "string", format: "date-time" } }, ["action", "end_time"]),
  object({ action: { const: "group" }, group_id: { type: "string" }, enabled: { type: "boolean" } }, ["action", "group_id", "enabled"]),
] };
const tools: Tool[] = [
  { name: "launch_list", description: "List visible Studio launches and their delivery summaries.", inputSchema: object({ force: { type: "boolean", description: "Refresh provider readback before listing." } }), parse: z.object({ force: z.boolean().optional() }).strict() },
  { name: "launch_get", description: "Read one visible launch and its internal campaign IDs for controls.", inputSchema: object(idShape, ["id"]), parse: z.object({ id }).strict() },
  { name: "launch_preview", description: "Preview a saved draft's campaign allocation and signed budget before submitting.", inputSchema: object(idShape, ["id"]), parse: z.object({ id }).strict() },
  { name: "launch_submit", description: "Approve and submit a saved draft at its current revision. Requires producer approver or staff administrator; staff must supply an audit note.", inputSchema: object({ ...idShape, revision: { type: "integer", minimum: 1 }, note: { type: "string", maxLength: 2000 } }, ["id", "revision"]), parse: z.object({ id, revision: z.number().int().positive(), note: z.string().trim().max(2000).optional() }).strict() },
  { name: "launch_retry", description: "Retry failed steps of a visible launch without making duplicate campaigns.", inputSchema: object(idShape, ["id"]), parse: z.object({ id }).strict() },
  { name: "launch_control", description: "Change one campaign through Studio's audited provider control service.", inputSchema: object({ ...idShape, campaign_id: { type: "string", format: "uuid" }, control: controlInput }, ["id", "campaign_id", "control"]), parse: z.object({ id, campaign_id: z.string().uuid(), control: controlSchema }).strict() },
  { name: "launch_new_round", description: "Create a new draft round using the existing launch's approved settings and content.", inputSchema: object(idShape, ["id"]), parse: z.object({ id }).strict() },
];

export const mcpToolDefinitions = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

const redact = (value: string) => value.replace(/\b(?:act_)?\d{8,}\b/g, "[provider id]").replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
function summary(run: LaunchRun) {
  return {
    id: run.id, external_id: run.external_id, producer_id: run.producer_id,
    name: run.draft.name, provider: run.draft.provider, round: run.round,
    status: run.status, revision: run.revision, mode: run.mode,
    budget_cents: run.draft.total_budget_cents, daily_budget_cents: run.draft.daily_budget_cents,
    allocation: run.draft.allocation, account_count: run.draft.account_ids.length,
    content_count: run.draft.content.length, start_paused: run.draft.start_paused,
    approved_at: run.approved_at, approved_by: run.approved_by,
    campaigns: run.campaigns.map(c => ({ id: c.id, name: c.name, status: c.status,
      delivery: c.snapshot?.delivery ?? null, spend_cents: c.snapshot?.spend_cents ?? null,
      clicks: c.snapshot?.clicks ?? null, conversions: c.snapshot?.conversions ?? null,
      checked_at: c.snapshot?.checked_at ?? null, note: c.snapshot?.note ? redact(c.snapshot.note) : null,
      error: c.error ? redact(c.error) : null })),
    error: run.error ? redact(run.error) : null,
  };
}
function preview(plan: LaunchPlan, run: LaunchRun, connections: LaunchConnection[]) {
  return { launch_id: run.id, revision: run.revision, name: run.draft.name,
    provider: run.draft.provider, destination_url: run.draft.destination_url,
    start_paused: run.draft.start_paused, allocation: run.draft.allocation,
    settings: run.draft.provider === "meta" ? run.draft.meta_settings : run.draft.tiktok_settings,
    total_budget_cents: plan.total_budget_cents, daily_total_cents: plan.daily_total_cents,
    campaign_count: plan.campaign_count, account_count: plan.account_count, content_count: plan.content_count,
    warnings: plan.warnings.map(redact), rows: plan.rows.map(r => {
      const account = connections.find(c => c.id === r.connection_id);
      return { index: r.index, name: r.name,
        account: account ? { name: account.name, advertiser_id: account.advertiser_id,
          page_id: account.page_id, instagram_id: account.instagram_id } : null,
        budget_cents: r.budget_cents, daily_budget_cents: r.daily_budget_cents,
        content: r.content.map(c => ({ kind: c.kind, label: c.label ?? null,
          reference: c.kind === "spark" ? null : c.value,
          spark_code_suffix: c.kind === "spark" ? c.value.slice(-4) : null,
          text: c.text ?? null, headline: c.headline ?? null })) };
    }) };
}
function jsonResult(data: unknown) { return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data }; }
const rpcError = (id: string | number | null, code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });

async function invoke(session: Session, name: string, args: Params) {
  const data = getData();
  switch (name) {
    case "launch_list": return { runs: (await refreshLaunches(session, args.force === true)).map(summary) };
    case "launch_get": return summary(await data.getLaunchRun(session, args.id as string));
    case "launch_preview": {
      const run = await data.getLaunchRun(session, args.id as string);
      const [plan, workspace] = await Promise.all([data.previewLaunchRun(session, run.id), data.getLaunchWorkspace(session, run.producer_id)]);
      return preview(plan, run, workspace.connections);
    }
    case "launch_submit": {
      const run = await data.submitLaunchRun(session, args.id as string, args.revision as number, args.note as string | undefined);
      queueLaunch(run.id); return summary(run);
    }
    case "launch_retry": {
      const run = await data.retryLaunchRun(session, args.id as string); queueLaunch(run.id); return summary(run);
    }
    case "launch_control": return summary(await controlLaunch(session, args.id as string, args.campaign_id as string, args.control as z.infer<typeof controlSchema>));
    case "launch_new_round": return summary(await data.newLaunchRound(session, args.id as string));
    default: throw new Error("Unknown tool");
  }
}

/** A single stateless JSON-RPC message. Null means an accepted notification (HTTP 202). */
export async function handleMcpMessage(session: Session, input: unknown): Promise<Record<string, unknown> | null> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return rpcError(null, -32600, "Invalid JSON-RPC request");
  const msg = input as Record<string, unknown>;
  const requestId = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(requestId, -32600, "Invalid JSON-RPC request");
  if (msg.method === "notifications/initialized" && msg.id === undefined) return null;
  if (requestId === null) return rpcError(null, -32600, "Requests need an ID");
  if (msg.method === "initialize") {
    const parsed = z.object({ protocolVersion: z.string(), capabilities: z.record(z.unknown()), clientInfo: z.object({ name: z.string(), version: z.string() }).passthrough() }).safeParse(msg.params);
    if (!parsed.success) return rpcError(requestId, -32602, "Invalid initialize parameters");
    return { jsonrpc: "2.0", id: requestId, result: { protocolVersion: MCP_VERSION,
      capabilities: { tools: {} }, serverInfo: { name: "pulsar-studio-launch", version: "1.0.0" } } };
  }
  if (msg.method === "ping") return { jsonrpc: "2.0", id: requestId, result: {} };
  if (msg.method === "tools/list") return { jsonrpc: "2.0", id: requestId, result: { tools: mcpToolDefinitions } };
  if (msg.method !== "tools/call") return rpcError(requestId, -32601, "Method not found");
  const call = z.object({ name: z.string(), arguments: z.record(z.unknown()).optional() }).safeParse(msg.params);
  if (!call.success) return rpcError(requestId, -32602, "Invalid tool call");
  const tool = tools.find(t => t.name === call.data.name);
  if (!tool) return rpcError(requestId, -32601, "Tool not found");
  const args = tool.parse.safeParse(call.data.arguments ?? {});
  if (!args.success) return rpcError(requestId, -32602, redact(args.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")));
  try { return { jsonrpc: "2.0", id: requestId, result: jsonResult(await invoke(session, tool.name, args.data)) }; }
  catch (e) {
    const message = isDataError(e) ? redact(e.message) : "Launch operation failed.";
    return { jsonrpc: "2.0", id: requestId, result: { content: [{ type: "text", text: message }], isError: true } };
  }
}
