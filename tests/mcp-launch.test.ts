import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { fixtureSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { resetLaunchFixture } from "@/lib/data/launch";
import { defaultLaunchDraft } from "@/lib/launch/plan";
import { handleMcpMessage, MCP_VERSION, parseBearer } from "@/lib/launch/mcp";
import { GET, POST } from "@/app/api/mcp/route";
import { createServerSupabase, withUserSupabase } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

const initialMcpEnabled = process.env.STUDIO_LAUNCH_MCP_ENABLED;
afterEach(() => {
  resetLaunchFixture();
  if (initialMcpEnabled === undefined) delete process.env.STUDIO_LAUNCH_MCP_ENABLED;
  else process.env.STUDIO_LAUNCH_MCP_ENABLED = initialMcpEnabled;
});
const approver = fixtureSession("producer");
const call = (name: string, args: Record<string, unknown>, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("MCP handshake, tool list and notification use stateless JSON-RPC shapes", async () => {
  const init = await handleMcpMessage(approver, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  assert.equal((init?.result as { protocolVersion: string }).protocolVersion, MCP_VERSION);
  const list = await handleMcpMessage(approver, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual((list?.result as { tools: { name: string }[] }).tools.map(x => x.name), ["launch_list", "launch_get", "launch_preview", "launch_submit", "launch_retry", "launch_control", "launch_new_round"]);
  assert.equal(await handleMcpMessage(approver, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal((await handleMcpMessage(approver, { jsonrpc: "2.0", id: 3, method: "something/unknown" }))?.error && ((await handleMcpMessage(approver, { jsonrpc: "2.0", id: 3, method: "something/unknown" }))?.error as { code: number }).code, -32601);
});

test("MCP validates arguments, preserves role checks, and redacts Spark codes", async () => {
  const invalid = await handleMcpMessage(approver, call("launch_submit", { id: "x" }));
  assert.equal((invalid?.error as { code: number }).code, -32602);
  const draft = defaultLaunchDraft("tiktok");
  draft.content_per_campaign = 1;
  const assigned = await getData().assignLaunchConnection(fixtureSession("staff"), {
    producer_id: approver.producerId!, provider: "tiktok", advertiser_id: "70000000000000999", name: "Owned test account",
    currency: "USD", timezone: "America/Los_Angeles", page_id: null, instagram_id: null, business_id: null, enabled: true,
  });
  draft.account_ids = [assigned.id];
  draft.destination_url = "https://example.com/watch";
  draft.content = [{ kind: "spark", value: "TOP-SECRET-SPARK-CODE" }];
  const saved = await getData().saveLaunchDraft(approver, draft);
  const read = await handleMcpMessage(approver, call("launch_get", { id: saved.id }));
  assert.equal(JSON.stringify(read).includes("TOP-SECRET-SPARK-CODE"), false);
  assert.equal(((read?.result as { structuredContent: { id: string } }).structuredContent).id, saved.id);
  const plan = await handleMcpMessage(approver, call("launch_preview", { id: saved.id }));
  const shown = (plan?.result as { structuredContent: { revision: number; destination_url: string; rows: { account: { name: string }; content: { spark_code_suffix: string }[] }[] } }).structuredContent;
  assert.equal(shown.revision, saved.revision);
  assert.equal(shown.destination_url, "https://example.com/watch");
  assert.equal(shown.rows[0].account.name, "Owned test account");
  assert.equal(shown.rows[0].content[0].spark_code_suffix, "CODE");
  assert.equal(JSON.stringify(plan).includes("TOP-SECRET-SPARK-CODE"), false);
  const viewer = { ...approver, producerRole: "viewer" as const };
  const denied = await handleMcpMessage(viewer, call("launch_submit", { id: saved.id, revision: saved.revision }));
  assert.equal((denied?.result as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(denied), /role/);
  const reviewer = { ...approver, producerRole: "reviewer" as const };
  const reviewerDenied = await handleMcpMessage(reviewer, call("launch_submit", { id: saved.id, revision: saved.revision }));
  assert.equal((reviewerDenied?.result as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(reviewerDenied), /approver role/);
});

test("MCP rejects bearer credentials in fixture mode and foreign Origin before tool handling", async () => {
  process.env.STUDIO_LAUNCH_MCP_ENABLED = "1";
  assert.equal(parseBearer("Bearer abc.def"), "abc.def");
  assert.equal(parseBearer("Basic abc"), null);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const unauth = await POST(new NextRequest("http://localhost:3200/api/mcp", { method: "POST", headers: { host: "localhost:3200", authorization: "Bearer fixture-is-not-an-auth-token", "content-type": "application/json" }, body }));
  assert.equal(unauth.status, 401);
  const crossOrigin = await POST(new NextRequest("http://localhost:3200/api/mcp", { method: "POST", headers: { host: "localhost:3200", origin: "https://elsewhere.example", authorization: "Bearer fixture-is-not-an-auth-token", "content-type": "application/json" }, body }));
  assert.equal(crossOrigin.status, 403);
});

test("MCP route is disabled by default and requires explicit deployment opt-in", async () => {
  delete process.env.STUDIO_LAUNCH_MCP_ENABLED;
  const req = () => new NextRequest("http://localhost:3200/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal((await POST(req())).status, 404);
  assert.equal((await GET(new NextRequest("http://localhost:3200/api/mcp"))).status, 404);
  process.env.STUDIO_LAUNCH_MCP_ENABLED = "true";
  assert.equal((await POST(req())).status, 404);
  process.env.STUDIO_LAUNCH_MCP_ENABLED = "1";
  assert.equal((await GET(new NextRequest("http://localhost:3200/api/mcp"))).status, 405);
});

test("verified user RLS clients stay isolated across overlapping async requests", async () => {
  const one = { marker: "one" } as unknown as SupabaseClient;
  const two = { marker: "two" } as unknown as SupabaseClient;
  await Promise.all([
    withUserSupabase(one, async () => { await new Promise(resolve => setTimeout(resolve, 5)); assert.strictEqual(createServerSupabase(), one); }),
    withUserSupabase(two, async () => { assert.strictEqual(createServerSupabase(), two); await new Promise(resolve => setTimeout(resolve, 10)); assert.strictEqual(createServerSupabase(), two); }),
  ]);
});
