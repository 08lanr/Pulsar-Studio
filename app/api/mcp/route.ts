import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { loadProfile, requireSession, sessionFromProfile, type Session } from "@/lib/auth";
import { dataSource } from "@/lib/data-source";
import { handleMcpMessage, MCP_VERSION, parseBearer } from "@/lib/launch/mcp";
import { withUserSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };
const disabled = () => NextResponse.json({ error: "Not found" }, { status: 404, headers });
const denied = (status: number) => NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: status === 401 ? "Authentication required" : "Access denied" } }, { status, headers });

async function bearerSession(token: string): Promise<{ session: Session; client: SupabaseClient } | null> {
  if (dataSource() !== "supabase") return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const client = createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  const profile = await loadProfile(client, data.user.id);
  return profile ? { session: sessionFromProfile(profile), client } : null;
}

export async function GET(req: NextRequest) {
  if (process.env.STUDIO_LAUNCH_MCP_ENABLED !== "1") return disabled();
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;
  return NextResponse.json({ error: "This stateless MCP endpoint has no SSE stream. Use POST." }, { status: 405, headers: { ...headers, Allow: "POST" } });
}

export async function POST(req: NextRequest) {
  if (process.env.STUDIO_LAUNCH_MCP_ENABLED !== "1") return disabled();
  const blocked = guardApiRequest(req);
  if (blocked) return blocked;
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Expected application/json" } }, { status: 415, headers });
  const version = req.headers.get("mcp-protocol-version");
  if (version && version !== MCP_VERSION) return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32602, message: "Unsupported MCP protocol version" } }, { status: 400, headers });
  const execute = async (session: Session) => {
    const body = await req.json().catch(() => undefined);
    const result = body === undefined ? { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } } : await handleMcpMessage(session, body);
    return result === null ? new Response(null, { status: 202, headers }) : NextResponse.json(result, { headers });
  };
  const authorization = req.headers.get("authorization");
  if (authorization !== null) {
    const token = parseBearer(authorization);
    if (!token) return denied(401);
    const verified = await bearerSession(token);
    if (!verified) return denied(401);
    return withUserSupabase(verified.client, () => execute(verified.session));
  }
  const guard = await requireSession();
  if (guard.response) return denied(401);
  return execute(guard.session);
}
