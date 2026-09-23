// The headless Claude Code launcher (lib/claude-session.ts; decision
// 2026-09-23 "Narrated mode in Studio", amendments 1–2): the session's
// environment carries no API key (the subscription pays); the SDK is tried
// first and its options are what the typings name; the CLI fallback's flags
// are what `claude --help` lists; with neither, the outcome is the clean
// "Claude Code CLI not installed — install it, then Retry", never a throw;
// the event stream lands in a JSON-lines log with the session id; a usage
// limit is `limited` and resumes the same session; one writing session holds
// the machine's slot; and the SDK really resolves on this machine.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CLI_MISSING_MESSAGE,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_WRITER_MODEL,
  FakeClaudeLauncher,
  STRIPPED_ENV,
  claudeLauncher,
  cliArgs,
  cliCommand,
  findClaudeCli,
  loadSdk,
  parseStreamLine,
  resetsAtIso,
  sdkBinaryPath,
  sdkOptions,
  sdkResolvable,
  sessionEnv,
  sessionEnvAllows,
  takeWritingLock,
  writingSlotHolder,
  type SessionRequest,
} from "@/lib/claude-session";

const tmp = () => mkdtempSync(path.join(tmpdir(), "studio-claude-"));

function request(dir: string, extra: Partial<SessionRequest> = {}): SessionRequest {
  return { cwd: dir, prompt: "brief", logFile: path.join(dir, "log", "session.jsonl"), ...extra };
}

const secretEnv = { PATH: "C:/bin", ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_AUTH_TOKEN: "tok", ELEVENLABS_API_KEY: "el-key", anthropic_api_key: "lower", USERPROFILE: "C:/Users/x", TYPESAFE_API_KEY: "jev" };

test("the session's environment drops the Anthropic keys (any case) and the ElevenLabs key, keeps the rest, and names the client", () => {
  const env = sessionEnv(secretEnv);
  for (const k of [...STRIPPED_ENV, "anthropic_api_key"]) assert.equal(env[k], undefined, `${k} must not reach the session`);
  assert.equal(env.PATH, "C:/bin");
  assert.equal(env.USERPROFILE, "C:/Users/x", "the subscription login lives under the user profile");
  assert.equal(env.TYPESAFE_API_KEY, "jev", "the prep runs the Jev checks");
  assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, "pulsar-studio");
});

test("the session's environment is an allow-list: a parent desktop session's variables and Studio's service secrets never reach it", () => {
  // Measured in the Claude Code desktop environment a dev server or worker started from .claude/launch.json inherits,
  // plus the service secrets .env.local puts beside them (phase 4a review, probe d).
  const host = {
    ...secretEnv,
    ANTHROPIC_BASE_URL: "http://127.0.0.1:1234/gateway",
    ANTHROPIC_MODEL: "x",
    CLAUDECODE: "1",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_SESSION_ID: "host-session",
    CLAUDE_CODE_HOST_SESSION_ID: "host",
    CLAUDE_CODE_MESSAGING_SOCKET: "\\\\.\\pipe\\host",
    CLAUDE_CODE_MESSAGING_TOKEN: "host-token",
    CLAUDE_CODE_ENTRYPOINT: "desktop",
    CLAUDE_PID: "4242",
    CLAUDE_EFFORT: "high",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    META_ACCESS_TOKEN: "meta",
    TIKTOK_APP_SECRET: "tiktok",
    DEEPSEEK_API_KEY: "deepseek",
    OPENAI_API_KEY: "openai",
    HF_TOKEN: "hf",
    DATABASE_URL: "postgres://user:pw@host/db",
    NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
    // What a session needs and keeps.
    CLAUDE_CONFIG_DIR: "C:/Users/x/.claude",
    CLAUDE_CODE_GIT_BASH_PATH: "C:/Program Files/Git/bin/bash.exe",
    HTTPS_PROXY: "http://proxy:8080",
    NO_PROXY: "localhost",
    SystemRoot: "C:/Windows",
    Path: "C:/Windows/system32",
    PYTHONUTF8: "1",
  };
  const env = sessionEnv(host);
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_PID", "CLAUDE_EFFORT", "SUPABASE_SERVICE_ROLE_KEY", "META_ACCESS_TOKEN", "TIKTOK_APP_SECRET", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "HF_TOKEN", "DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", ...STRIPPED_ENV]) {
    assert.equal(env[k], undefined, `${k} must not reach the session`);
    assert.equal(sessionEnvAllows(k), false, k);
  }
  for (const k of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_GIT_BASH_PATH", "HTTPS_PROXY", "NO_PROXY", "SystemRoot", "Path", "PYTHONUTF8", "TYPESAFE_API_KEY", "USERPROFILE", "PATH"]) assert.equal(env[k], (host as Record<string, string>)[k], `${k} is kept`);
  assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_AGENT_SDK_CLIENT_APP", "CLAUDE_CODE_GIT_BASH_PATH", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY", "NO_PROXY", "PATH", "PYTHONUTF8", "Path", "SystemRoot", "TYPESAFE_API_KEY", "USERPROFILE"].sort(), "nothing else");
  // The SDK's options carry the same environment (it REPLACES the child's).
  const dir = tmp();
  try {
    const o = sdkOptions(request(dir, { env: host }), new AbortController(), null);
    assert.deepEqual(o.env, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a session whose init names an API key source instead of the subscription is stopped as `failed`, before its first turn", async () => {
  const dir = tmp();
  try {
    let yielded = 0;
    const msgs: Msg[] = [
      { type: "system", subtype: "init", session_id: "s-key", apiKeySource: "ANTHROPIC_API_KEY" },
      { type: "assistant", session_id: "s-key", message: { content: [{ type: "text", text: "billed turn" }] } },
      { type: "result", subtype: "success", is_error: false, session_id: "s-key", result: "done on the key" },
    ];
    const l = claudeLauncher({
      loadSdk: (async () => ({
        query: () =>
          (async function* () {
            for (const m of msgs) {
              yielded += 1;
              yield m;
            }
          })(),
      })) as never,
      sdkBinary: () => "C:/sdk/claude.exe",
      env: secretEnv,
    });
    const events: string[] = [];
    const out = await l.launch(request(dir, { env: secretEnv, onEvent: (e) => events.push(e.kind) }));
    assert.equal(out.status, "failed");
    assert.match(out.status === "failed" ? out.message : "", /apiKeySource "ANTHROPIC_API_KEY": it would bill an API key, not the Claude subscription/);
    assert.deepEqual(events, ["init"], "the stream is not read past the init");
    assert.equal(yielded, 1, "the session is closed after its init message");
    const again = await l.launch(request(dir, { env: secretEnv, logFile: path.join(dir, "log", "b.jsonl") }));
    assert.equal(again.status, "failed");
    // The subscription's own source ("none") runs.
    const ok = claudeLauncher({ loadSdk: fakeSdk(() => [{ type: "system", subtype: "init", session_id: "s-sub", apiKeySource: "none" }, { type: "result", subtype: "success", is_error: false, session_id: "s-sub", result: "ok" }]) as never, sdkBinary: () => "C:/sdk/claude.exe" });
    assert.equal((await ok.launch(request(dir, { logFile: path.join(dir, "log", "c.jsonl") }))).status, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the SDK options: cwd, the stripped env that REPLACES the child's, Opus by default, dontAsk with the allowed tools, resume by id, the skills", () => {
  const dir = tmp();
  try {
    const ac = new AbortController();
    const o = sdkOptions(request(dir, { env: secretEnv, resume: "sess-1", skills: ["drama-remix"], additionalDirectories: ["C:/work"] }), ac, null);
    assert.equal(o.cwd, dir);
    assert.equal(o.abortController, ac);
    assert.equal(o.env?.ANTHROPIC_API_KEY, undefined);
    assert.equal(o.env?.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(o.model, DEFAULT_WRITER_MODEL);
    assert.equal(DEFAULT_WRITER_MODEL, "claude-opus-5-5");
    assert.equal(o.permissionMode, "dontAsk");
    assert.deepEqual(o.allowedTools, [...DEFAULT_ALLOWED_TOOLS]);
    assert.equal(o.resume, "sess-1");
    assert.deepEqual(o.skills, ["drama-remix"]);
    assert.deepEqual(o.additionalDirectories, ["C:/work"]);
    assert.equal(o.pathToClaudeCodeExecutable, undefined, "the SDK's own binary unless STUDIO_CLAUDE_CLI names one");
    assert.equal(sdkOptions(request(dir), ac, "C:/claude.exe").pathToClaudeCodeExecutable, "C:/claude.exe");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI fallback's flags are the ones `claude --help` lists; the prompt goes on stdin, never the command line; an npm .cmd shim goes through cmd", () => {
  const args = cliArgs(request("C:/film", { resume: "abc", additionalDirectories: ["C:/work dir"], maxTurns: 50 }));
  assert.deepEqual(args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.equal(args[args.indexOf("--model") + 1], DEFAULT_WRITER_MODEL);
  assert.equal(args[args.indexOf("--max-turns") + 1], "50");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(args[args.indexOf("--allowedTools") + 1], DEFAULT_ALLOWED_TOOLS.join(","));
  assert.equal(args[args.indexOf("--add-dir") + 1], "C:/work dir");
  assert.equal(args[args.indexOf("--resume") + 1], "abc");
  assert.ok(!args.includes("brief"));
  if (process.platform === "win32") {
    const c = cliCommand("C:/npm/claude.cmd", ["-p", "--add-dir", "C:/a b"], { ComSpec: "C:/Windows/System32/cmd.exe" });
    assert.equal(c.command, "C:/Windows/System32/cmd.exe");
    assert.deepEqual(c.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.match(c.args[3], /^"C:\/npm\/claude\.cmd -p --add-dir "C:\/a b""$/);
    assert.deepEqual(cliCommand("C:/x/claude.exe", ["-p"]), { command: "C:/x/claude.exe", args: ["-p"] });
  }
});

test("with no SDK and no CLI the launcher answers the clean missing-CLI outcome; findClaudeCli reads STUDIO_CLAUDE_CLI only when it exists", async () => {
  const dir = tmp();
  try {
    const l = claudeLauncher({ loadSdk: async () => null, findCli: () => null });
    assert.deepEqual(await l.available(), { ok: false, reason: "cli_missing", message: CLI_MISSING_MESSAGE });
    const out = await l.launch(request(dir));
    assert.equal(out.status, "unavailable");
    assert.equal(out.status === "unavailable" && out.message, "Claude Code CLI not installed — install it, then Retry");
    assert.equal(findClaudeCli({ STUDIO_CLAUDE_CLI: path.join(dir, "nope.exe") }, () => "C:/should-not-be-used"), null);
    writeFileSync(path.join(dir, "claude.exe"), "");
    assert.equal(findClaudeCli({ STUDIO_CLAUDE_CLI: path.join(dir, "claude.exe") }), path.join(dir, "claude.exe"));
    assert.equal(findClaudeCli({}, () => "C:/found/claude.cmd"), "C:/found/claude.cmd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Msg = Record<string, unknown>;
function fakeSdk(script: (opts: Record<string, unknown>) => Msg[], seen: Record<string, unknown>[] = []) {
  return async () => ({
    query: ({ options }: { prompt: string; options?: Record<string, unknown> }) => {
      seen.push(options ?? {});
      return (async function* () {
        for (const m of script(options ?? {})) yield m;
      })();
    },
  });
}

test("through the SDK: the session id is captured from the stream, every event is a JSON line in the log, and a success is `done`", async () => {
  const dir = tmp();
  try {
    const seen: Record<string, unknown>[] = [];
    const events: string[] = [];
    const l = claudeLauncher({
      loadSdk: fakeSdk(() => [
        { type: "system", subtype: "init", session_id: "s-42", apiKeySource: "none" },
        { type: "assistant", session_id: "s-42", message: { content: [{ type: "tool_use", name: "Bash" }, { type: "text", text: "Reading script_raw.md" }] } },
        { type: "result", subtype: "success", is_error: false, session_id: "s-42", result: "Wrote SCRIPT-S01E05.md", total_cost_usd: 1.25, duration_ms: 1000, num_turns: 1 },
      ], seen) as never,
      sdkBinary: () => "C:/sdk/claude.exe",
      env: secretEnv,
    });
    assert.deepEqual(await l.available(), { ok: true, transport: "sdk", executable: "C:/sdk/claude.exe" });
    const out = await l.launch(request(dir, { env: secretEnv, onEvent: (e) => events.push(e.kind) }));
    assert.equal(out.status, "done");
    if (out.status !== "done") return;
    assert.equal(out.session_id, "s-42");
    assert.equal(out.transport, "sdk");
    assert.equal(out.result, "Wrote SCRIPT-S01E05.md");
    assert.equal(out.turns, 1);
    assert.deepEqual(events, ["init", "assistant", "result"]);
    assert.equal((seen[0].env as Record<string, string | undefined>).ANTHROPIC_API_KEY, undefined, "the SDK got the stripped environment");
    const lines = readFileSync(out.log_file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.ok(lines.length >= 4, "a start line and one line per message");
    assert.ok(!readFileSync(out.log_file, "utf8").includes("sk-ant-test"), "no key in the log");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a usage limit is `limited` with when it resets, and a resume continues the same session by id", async () => {
  const dir = tmp();
  try {
    const seen: Record<string, unknown>[] = [];
    const resetsAt = Math.floor(Date.parse("2026-09-24T03:00:00Z") / 1000);
    const l = claudeLauncher({
      loadSdk: fakeSdk(
        (o) =>
          o.resume
            ? [{ type: "result", subtype: "success", is_error: false, session_id: String(o.resume), result: "done after the reset", num_turns: 3 }]
            : [
                { type: "system", subtype: "init", session_id: "s-7" },
                { type: "rate_limit_event", session_id: "s-7", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "seven_day" } },
                { type: "result", subtype: "success", is_error: true, session_id: "s-7", result: "Claude AI usage limit reached", num_turns: 2 },
              ],
        seen
      ) as never,
      sdkBinary: () => "C:/sdk/claude.exe",
    });
    const first = await l.launch(request(dir));
    assert.equal(first.status, "limited");
    if (first.status !== "limited") return;
    assert.equal(first.session_id, "s-7");
    assert.equal(first.resets_at, "2026-09-24T03:00:00.000Z");
    assert.equal(resetsAtIso(resetsAt * 1000), "2026-09-24T03:00:00.000Z", "milliseconds read the same");
    const second = await l.resume("s-7", "Continue.", { cwd: dir, logFile: path.join(dir, "log", "session.jsonl") });
    assert.equal(second.status, "done");
    assert.equal(seen[1].resume, "s-7");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nobody logged in is `unavailable: not_logged_in`; a cancel is `interrupted` and resumable", async () => {
  const dir = tmp();
  try {
    const l = claudeLauncher({
      loadSdk: fakeSdk(() => [
        { type: "system", subtype: "init", session_id: "s-9" },
        { type: "assistant", session_id: "s-9", error: "authentication_failed", message: { content: [{ type: "text", text: "Invalid API key · Please run /login" }] } },
        { type: "result", subtype: "success", is_error: true, session_id: "s-9", result: "Invalid API key · Please run /login" },
      ]) as never,
      sdkBinary: () => "C:/sdk/claude.exe",
    });
    const out = await l.launch(request(dir));
    assert.equal(out.status, "unavailable");
    assert.equal(out.status === "unavailable" && out.reason, "not_logged_in");

    const ac = new AbortController();
    const slow = claudeLauncher({
      loadSdk: (async () => ({
        query: ({ options }: { options?: { abortController?: AbortController } }) =>
          (async function* () {
            yield { type: "system", subtype: "init", session_id: "s-10" };
            await new Promise((r) => setTimeout(r, 50));
            if (options?.abortController?.signal.aborted) throw new Error("aborted");
            yield { type: "result", subtype: "success", is_error: false, session_id: "s-10", result: "x" };
          })(),
      })) as never,
      sdkBinary: () => "C:/sdk/claude.exe",
    });
    const p = slow.launch(request(dir, { signal: ac.signal }));
    ac.abort();
    const cancelled = await p;
    assert.equal(cancelled.status, "interrupted");
    assert.equal(cancelled.status === "interrupted" && cancelled.session_id, "s-10");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI fallback reads the stream-json lines, gets the prompt on stdin, and sees only the allow-listed environment", async () => {
  const dir = tmp();
  try {
    const script = path.join(dir, "fake-claude.js");
    writeFileSync(
      script,
      [
        "let input = '';",
        "process.stdin.on('data', (c) => (input += c));",
        "process.stdin.on('end', () => {",
        "  const resume = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : null;",
        "  const sid = resume || 'cli-1';",
        "  console.log('not json chatter');",
        "  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }));",
        "  console.log(JSON.stringify({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: 'key=' + (process.env.ANTHROPIC_API_KEY || 'none') + ' prompt=' + input }] } }));",
        "  const seen = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_SESSION_ID', 'SUPABASE_SERVICE_ROLE_KEY'].map((k) => k + '=' + (process.env[k] || 'none')).join(' ');",
        "  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'key=' + (process.env.ANTHROPIC_API_KEY || 'none') + ' | ' + seen + ' | path=' + (process.env.PATH || process.env.Path ? 'yes' : 'no') }));",
        "});",
      ].join("\n")
    );
    const names = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_SESSION_ID", "SUPABASE_SERVICE_ROLE_KEY"] as const;
    const prev = Object.fromEntries(names.map((k) => [k, process.env[k]]));
    process.env.ANTHROPIC_API_KEY = "sk-ant-parent";
    process.env.CLAUDE_CODE_SESSION_ID = "the-host-session";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    try {
      const l = claudeLauncher({ prefer: "cli", findCli: () => process.execPath, cliPrefix: [script] });
      const out = await l.launch(request(dir, { prompt: "THE BRIEF" }));
      assert.equal(out.status, "done");
      if (out.status !== "done") return;
      assert.equal(out.transport, "cli");
      assert.equal(out.session_id, "cli-1");
      assert.equal(out.result, "key=none | ANTHROPIC_API_KEY=none CLAUDE_CODE_SESSION_ID=none SUPABASE_SERVICE_ROLE_KEY=none | path=yes", "the parent's key, its host session's variables and Studio's secrets never reach the CLI; PATH does");
      assert.match(readFileSync(out.log_file, "utf8"), /prompt=THE BRIEF/);
      const again = await l.resume("cli-1", "Continue.", { cwd: dir, logFile: path.join(dir, "log", "b.jsonl") });
      assert.equal(again.status === "done" && again.session_id, "cli-1");
    } finally {
      for (const k of names) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
    assert.equal(parseStreamLine("chatter"), null);
    assert.deepEqual(parseStreamLine('{"type":"x"}'), { type: "x" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one writing session on the machine: a second holder is `busy` and nothing starts; the slot frees when the first ends; the holder is looked at without taking it", async () => {
  const dir = tmp();
  try {
    const lock = { root: dir, holder: "run-a/ep12", what: "prep of ep12" };
    const held = takeWritingLock(lock);
    assert.equal(writingSlotHolder(lock), null, "our own lock is no holder");
    const other = { root: dir, holder: "run-a/ep13", what: "prep of ep13" };
    assert.equal(writingSlotHolder(other)?.run_id, "run-a/ep12");
    const fake = new FakeClaudeLauncher(() => ({ writes: { "made.txt": "x" } }));
    const busy = await fake.launch(request(dir, { lock: other }));
    assert.equal(busy.status, "busy");
    assert.equal(existsSync(path.join(dir, "made.txt")), false, "a busy slot starts nothing");
    held.release();
    assert.equal(writingSlotHolder(other), null);
    const ok = await fake.launch(request(dir, { lock: other }));
    assert.equal(ok.status, "done");
    assert.equal(readFileSync(path.join(dir, "made.txt"), "utf8"), "x");
    assert.equal(writingSlotHolder(lock), null, "released after the session");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fake launcher keeps one id per conversation and plays limits and failures", async () => {
  const dir = tmp();
  try {
    const fake = new FakeClaudeLauncher((call) => (call.kind === "launch" ? { outcome: { status: "limited", resets_at: "2026-09-24T03:00:00.000Z" } } : { outcome: { status: "done", result: "finished" } }));
    const a = await fake.launch(request(dir));
    assert.equal(a.status, "limited");
    const id = a.status === "limited" ? a.session_id : null;
    assert.equal(id, "fake-1");
    const b = await fake.resume(String(id), "go on", { cwd: dir, logFile: path.join(dir, "l.jsonl") });
    assert.equal(b.status === "done" && b.session_id, "fake-1");
    assert.deepEqual(fake.calls.map((c) => c.kind), ["launch", "resume"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Agent SDK resolves on this machine with its Claude Code binary (installed 2026-09-23, @anthropic-ai/claude-agent-sdk)", async (t) => {
  if (!sdkResolvable()) return t.skip("the SDK is not installed here");
  const sdk = await loadSdk();
  assert.ok(sdk && typeof sdk.query === "function", "the SDK loads and exports query()");
  const bin = sdkBinaryPath();
  if (!bin) return t.skip("no platform binary package for this platform");
  assert.ok(existsSync(bin));
});
