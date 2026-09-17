# Studio Launch MCP endpoint

The route is disabled by default. Set the server-only `STUDIO_LAUNCH_MCP_ENABLED=1` to expose it for a configured Studio client; other values return HTTP 404 for both GET and POST before authentication or tool dispatch. Enabling it does not authenticate Meta's separate official MCP server.

`POST /api/mcp` exposes seven Studio Launch tools over stateless MCP Streamable HTTP. The endpoint implements the [2025-11-25 MCP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) with a JSON response for each request, an empty HTTP 202 for `notifications/initialized`, and HTTP 405 for `GET` because Studio does not offer an SSE stream. It does not assign `MCP-Session-Id`; each request authenticates independently. Clients should send `Accept: application/json, text/event-stream`, `Content-Type: application/json`, and, after initialization, `MCP-Protocol-Version: 2025-11-25`. The [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) starts with `initialize`, followed by `notifications/initialized`.

The endpoint accepts a signed-in Studio browser cookie. In `DATA_SOURCE=supabase`, it also accepts `Authorization: Bearer <Supabase user access token>`. Studio verifies that token with Supabase Auth, loads the user's `core.profiles` row through a user-scoped RLS client, and keeps that same client in request-local async context for subsequent reads. A service-role key, an invented fixture identity header, and a bearer token in fixture mode are never accepted as user authentication. The normal middleware lets `/api/mcp` reach this route so bearer authentication can occur there; every other route keeps its existing login wall. An invalid `Origin` is rejected before authentication. No remote MCP client is configured by this change.

The tools are `launch_list`, `launch_get`, `launch_preview`, `launch_submit`, `launch_retry`, `launch_control`, and `launch_new_round`. Their input schemas are available through `tools/list`. IDs are Studio launch or campaign IDs. `launch_submit` requires the exact saved draft `revision`, the producer approver role or staff administrator role, and an audit note for staff on-behalf submission. `launch_control` uses the same audited control service as the Studio UI. These tools do not create drafts; create and edit a draft in Studio, then preview and submit it through MCP if desired. All read and write operations go through `getData()` and the existing launch service. An authorized preview includes assigned account names and IDs so the approver can review the allocation. Tool results omit tokens, full Spark codes, raw provider state, file paths, and hashes. Provider budget remains the signed media budget; Studio's 15% service fee is a separate billing line.

For example, initialize:

```http
POST /api/mcp
Content-Type: application/json
Accept: application/json, text/event-stream

{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"studio-client","version":"1.0"}}}
```

Then send `{"jsonrpc":"2.0","method":"notifications/initialized"}` and call `tools/list`. A tool call looks like:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"launch_get","arguments":{"id":"lr_example"}}}
```

JSON-RPC method and argument errors use the protocol `error` object. A correctly formed tool call that the launch service refuses returns a tool result with `isError: true`; for example, a reviewer attempting `launch_submit` sees the existing approver-role failure. The endpoint never bypasses Studio's revision, role, company scope, or environment binding checks. Production, sandbox, and fixture approvals remain bound to their respective environments.
