// The headless Claude Code launcher (decision 2026-09-23 "Narrated mode in
// Studio", amendments 1–2): the narrated route's writing steps — the script
// read, the per-episode prep, the narration — run as a Claude Code session
// that Studio starts itself in the film folder, with the filled brief as the
// prompt. Not a copy-this-command hand-off (that stays as the fallback,
// "Run it yourself in Claude Code").
//
// What every session gets, the same way:
//
//   - The Claude Agent SDK first (`@anthropic-ai/claude-agent-sdk`, its
//     `query({prompt, options})`, which runs the Claude Code binary the SDK
//     ships for this platform), and `claude -p --output-format stream-json`
//     as the fallback when the SDK cannot load. Flag names were read off the
//     installed SDK's typings and its bundled binary's `--help` (Claude Code
//     2.1.281 on 2026-09-23); the CLI path itself is untested here because
//     no `claude` is on this machine's PATH (the desktop app only). Neither
//     found: the outcome is `unavailable` with CLI_MISSING_MESSAGE, a clean
//     stage error the person clears with Retry — never a crash.
//   - The subscription pays, never the API key: the child's environment is
//     built from an allow-list (the pipeline steps' own, plus the Jev key,
//     Claude Code's config folder and Git Bash path, the proxy settings), so
//     no ANTHROPIC_* variable, no service secret of Studio's and none of the
//     CLAUDECODE / CLAUDE_CODE_* variables a parent desktop session hands its
//     children reaches it (the SDK's `env` REPLACES the child's environment;
//     the CLI child gets every other variable unset). ELEVENLABS_API_KEY is
//     left out too — the prep brief forbids rendering voice, and a key that
//     is not there cannot be spent. A session whose init message names a key
//     source other than the subscription login is stopped as `failed`. Only
//     the three picture checks use the API key, from Studio's own process.
//   - Every event streamed into a JSON-lines log (the run's work folder,
//     never the film's) and a progress callback: the session id as soon as
//     any message carries it, turns, tool uses, the last words.
//   - The session id captured, so a stage stopped by a usage limit or an
//     interruption RESUMES the same conversation (`resume(sessionId, prompt)`)
//     instead of restarting a four-hour prep.
//   - ONE writing session at a time on the machine: a lock file taken
//     through lib/locks.ts (`<lock root>/.studio-writing/.heavy-lock.json`,
//     the heavy lock's own machinery: exclusive create, stale pid or six
//     hours replaced and reported), whose holder names the run AND the
//     episode, so two episodes of one run are two holders. A held lock is
//     the outcome `busy` naming the holder; the stage waits and looks again.
//
// `FakeClaudeLauncher` stands in for tests and the fake pipeline: it plays a
// script per launch (write these files, emit these events, end like this)
// and never starts a process.

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { LockHeldError, heavyLock, heavyLockPath, readLock, staleReason, type Held, type HeavyLock, type LockOptions } from "@/lib/locks";
import { runProcess } from "@/lib/python";

/** An environment-shaped record, so the selectors can be tested without touching process.env. */
export type Env = Record<string, string | undefined>;

/** The stage error when neither the SDK's binary nor a `claude` CLI is there (amendment 1, word for word). */
export const CLI_MISSING_MESSAGE = "Claude Code CLI not installed — install it, then Retry";

/** The stage error when Claude Code answers that nobody is logged in. */
export const NOT_LOGGED_IN_MESSAGE = "Claude Code is not logged in on this machine — run `claude` once and log in with the subscription, then Retry";

/**
 * What a child process of Studio's may inherit (narrated spec N6: an
 * allow-list, never full inheritance): PATH and the Windows system variables
 * a Python, an ffmpeg or a Claude Code child needs, the user folders the
 * model caches and the logins live under, PYTHON* / CUDA* / HF_* / OMP_*.
 * The pipeline steps (lib/segment/narrated/stages.ts `stepEnv`) and the
 * writing sessions (`sessionEnv`) share it.
 */
export const CHILD_ENV_ALLOWED =
  /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|USERPROFILE|USERNAME|HOME|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMMONPROGRAMFILES|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|OS|LANG|LC_ALL|TERM|PYTHON\w*|CUDA\w*|HF_\w*|OMP_NUM_THREADS|MKL_NUM_THREADS|FFMPEG_PATH|FFPROBE_PATH)$/i;

/**
 * What a writing session adds to CHILD_ENV_ALLOWED: the Jev key (the prep
 * brief runs narr_lint and scene_audit), where Claude Code keeps its login
 * and finds Git Bash, and the proxy settings a network may need.
 */
export const SESSION_ENV_EXTRA = /^(TYPESAFE_API_KEY|CLAUDE_CONFIG_DIR|CLAUDE_CODE_GIT_BASH_PATH|HTTPS?_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS)$/i;

/**
 * Never in a session's environment, whatever the allow-lists say
 * (amendment 2): every ANTHROPIC_* (a key, a token or a base URL bills or
 * routes the session away from the subscription login), what a parent
 * Claude Code session sets for its children (CLAUDECODE, CLAUDE_CODE_*,
 * CLAUDE_PID, CLAUDE_EFFORT: a dev server started from the desktop app
 * inherits its host session's socket, token and ids, and a session under
 * them is routed through that host and dies with it), the ElevenLabs key
 * (the brief forbids rendering voice), and any other secret by its name.
 * TYPESAFE_API_KEY is the one key a session gets (`sessionEnvAllows`).
 */
export const SESSION_ENV_DENIED = /^(ANTHROPIC_\w*|CLAUDECODE|CLAUDE_CODE_(?!GIT_BASH_PATH$)\w*|CLAUDE_PID|CLAUDE_EFFORT|ELEVENLABS_API_KEY)$|TOKEN|SECRET|PASSWORD|_KEY$/i;

/** Names a session never sees, as examples for the tests; the rule is SESSION_ENV_DENIED over the allow-lists. */
export const STRIPPED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ELEVENLABS_API_KEY", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_TOKEN"] as const;

/** The writing steps' model (Ruobin asked for Opus on the script read; the prep agents ran on Opus). */
export const DEFAULT_WRITER_MODEL = "claude-opus-5-5";

/** Completed prep agents ran 143–261 turns (session 7b54d972); the cap leaves room without letting a loop run all night. */
export const DEFAULT_MAX_TURNS = 400;

/** A prep ran 1 h 20 min to 4 h 10 min; past six hours a session is stopped and resumable. */
export const DEFAULT_SESSION_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * The tools a writing session may use without asking. The session runs in
 * `dontAsk` mode (nothing prompts; anything not listed is denied), so this
 * list is the whole of what it can do: read and write files in the film
 * folder and the work folder it is given, run bash (the pipeline's scripts),
 * and load the drama-remix skill.
 */
export const DEFAULT_ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Skill", "TodoWrite"] as const;

/** The folder under the lock root that holds the writing-session lock file. */
export const WRITING_LOCK_DIR = ".studio-writing";

export type SessionTransport = "sdk" | "cli" | "fake";

export type SessionProgress = {
  transport: SessionTransport;
  session_id: string | null;
  /** Assistant messages so far. */
  turns: number;
  tool_uses: number;
  /** The last tool the session called, and the first 240 characters of its last words. */
  last_tool: string | null;
  last_text: string | null;
  updated_at: string;
};

export type SessionEvent = {
  kind: "init" | "assistant" | "result" | "rate_limit" | "stderr" | "other";
  progress: SessionProgress;
};

/** Who holds the machine's writing slot, and for what. */
export type SessionLockRequest = {
  /** The folder holding `.studio-writing/`: the heavy lock's root (mini-drama-system), or the work dir under the fake pipeline. */
  root: string;
  /** `<run id>/script` or `<run id>/ep12`: one holder per writing step, so two episodes of one run never share the slot. */
  holder: string;
  /** What the session is doing, for the person the lock makes wait. */
  what: string;
};

export type SessionRequest = {
  /** The film folder: the session's working directory. */
  cwd: string;
  /** The filled brief (a new session) or the continuation (a resume). */
  prompt: string;
  /** Resume this session instead of starting a new one. */
  resume?: string | null;
  model?: string | null;
  maxTurns?: number | null;
  allowedTools?: readonly string[];
  /** Folders outside `cwd` the session may read and write (the run's work folder for its output file). */
  additionalDirectories?: string[];
  /** Skills enabled for the session; the narrated stages pass `["drama-remix"]`. Absent = the CLI's own defaults. */
  skills?: string[];
  /** One JSON line per event, appended. */
  logFile: string;
  onEvent?: (event: SessionEvent) => void;
  signal?: AbortSignal;
  /** The environment the session's is derived from, through the allow-list (`sessionEnv`); process.env when absent. */
  env?: Env;
  timeoutMs?: number;
  /** Take the machine's writing slot for the session's length; absent = no lock (a test). */
  lock?: SessionLockRequest;
};

type Common = { transport: SessionTransport; session_id: string | null; log_file: string; turns: number };

/**
 * How a session ended:
 *   done         it answered; `result` is its last message
 *   limited      a usage limit stopped it; resumable (`resets_at` when Claude Code said)
 *   interrupted  cancelled, timed out, killed or out of turns; resumable by its id
 *   failed       an error that a resume will not cure (billing, a refusal the CLI printed)
 *   busy         another writing session holds the machine's slot; nothing started
 *   unavailable  no Claude Code on the machine (CLI_MISSING_MESSAGE) or nobody logged in
 */
export type SessionOutcome =
  | (Common & { status: "done"; session_id: string; result: string; cost_usd: number | null; duration_ms: number })
  | (Common & { status: "limited"; resets_at: string | null; message: string })
  | (Common & { status: "interrupted"; message: string })
  | (Common & { status: "failed"; message: string })
  | { status: "busy"; holder: HeavyLock; message: string }
  | { status: "unavailable"; reason: "cli_missing" | "not_logged_in"; message: string };

export type LauncherAvailability = { ok: true; transport: "sdk" | "cli"; executable: string | null } | { ok: false; reason: "cli_missing"; message: string };

export interface ClaudeLauncher {
  readonly kind: "auto" | "sdk" | "cli" | "fake";
  /** Whether a session could start here; never throws, never starts one. */
  available(env?: Env): Promise<LauncherAvailability>;
  launch(req: SessionRequest): Promise<SessionOutcome>;
  /** Continue session `sessionId` with `prompt` (after a limit, an interruption, or a person's send-back note). */
  resume(sessionId: string, prompt: string, req: Omit<SessionRequest, "prompt" | "resume">): Promise<SessionOutcome>;
}

// ---- the environment -----------------------------------------------------------------------------------

/** Whether a session may see the variable `name`: on an allow-list and not denied (TYPESAFE_API_KEY is the one key it gets). Pure. */
export function sessionEnvAllows(name: string): boolean {
  if (/^TYPESAFE_API_KEY$/i.test(name)) return true;
  if (SESSION_ENV_DENIED.test(name)) return false;
  return CHILD_ENV_ALLOWED.test(name) || SESSION_ENV_EXTRA.test(name);
}

/** The session's environment, built from an allow-list over `base` (never full inheritance), plus the SDK's client tag. */
export function sessionEnv(base: Env = process.env): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || !sessionEnvAllows(k)) continue;
    out[k] = v;
  }
  out.CLAUDE_AGENT_SDK_CLIENT_APP = "pulsar-studio";
  return out;
}

/** The init message's `apiKeySource` for a subscription login (claude.ai OAuth, per the SDK's typings); anything else bills an API key. */
export const SUBSCRIPTION_KEY_SOURCE = "none";

/** The failure when a session reports it is not on the subscription. */
export function notSubscriptionMessage(source: string): string {
  return `the session reports apiKeySource "${source}": it would bill an API key, not the Claude subscription (amendment 2), so it was stopped. Log Claude Code in with the subscription (run \`claude\`, /login) and remove any apiKeyHelper, then Retry`;
}

// ---- finding Claude Code ---------------------------------------------------------------------------------

const projectRequire = () => createRequire(path.join(process.cwd(), "package.json"));

/** The Claude Code binary the SDK ships for this platform (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`), or null. */
export function sdkBinaryPath(): string | null {
  try {
    const pkg = projectRequire().resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const bin = path.join(path.dirname(pkg), process.platform === "win32" ? "claude.exe" : "claude");
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** True when the SDK package itself resolves from the project (it is loaded lazily, never bundled). */
export function sdkResolvable(): boolean {
  try {
    projectRequire().resolve("@anthropic-ai/claude-agent-sdk");
    return true;
  } catch {
    return false;
  }
}

/**
 * A `claude` CLI: STUDIO_CLAUDE_CLI when it names a file, else the first
 * `claude` on PATH (`where` on Windows, which finds claude.cmd / claude.exe;
 * `which` elsewhere), else null.
 */
export function findClaudeCli(env: Env = process.env, probe: (cmd: string) => string | null = wherePath): string | null {
  const configured = env.STUDIO_CLAUDE_CLI?.trim();
  if (configured) return existsSync(configured) ? configured : null;
  return probe("claude");
}

function wherePath(cmd: string): string | null {
  try {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    if (r.status !== 0) return null;
    const lines = String(r.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // On Windows prefer the .cmd / .exe shim over the extensionless POSIX script npm also writes.
    return lines.find((l) => /\.(cmd|exe)$/i.test(l)) ?? lines[0] ?? null;
  } catch {
    return null;
  }
}

// ---- the writing slot -----------------------------------------------------------------------------------

/** The owner a Studio writing session's lock carries. */
export const WRITING_LOCK_OWNER = "pulsar-studio-writer";

/** Take the machine's one writing slot (lib/locks.ts heavyLock semantics over `<root>/.studio-writing/`); a LockHeldError while another holder's lock is live. */
export function takeWritingLock(req: SessionLockRequest): Held<HeavyLock> {
  const dir = path.join(req.root, WRITING_LOCK_DIR);
  mkdirSync(dir, { recursive: true });
  return heavyLock(dir, { owner: WRITING_LOCK_OWNER, what: req.what, run_id: req.holder });
}

/**
 * Who holds the writing slot live, when it is not this holder: the lock of
 * another writing step (another episode, another run, another worker) whose
 * process is alive and younger than six hours. Null when the slot is free,
 * stale, or ours. Looks only; takes nothing.
 */
export function writingSlotHolder(req: SessionLockRequest, opts: LockOptions = {}): HeavyLock | null {
  const current = readLock<HeavyLock>(heavyLockPath(path.join(req.root, WRITING_LOCK_DIR)));
  if (!current) return null;
  if (current.run_id === req.holder && current.pid === process.pid && current.owner === WRITING_LOCK_OWNER) return null;
  return staleReason(current, opts) ? null : current;
}

// ---- the event stream (the SDK's messages and the CLI's stream-json lines are the same objects) ------------------------------------

type Msg = Record<string, unknown>;

const LIMIT_TEXT = /usage limit|hit your limit|limit reached|rate.?limit|out of (?:extra )?usage|weekly limit|5-hour limit/i;
const LOGIN_TEXT = /not logged in|please run \/login|invalid api key|authentication_failed|oauth token (?:has )?expired|login required/i;

/** The epoch a limit resets at, as ISO: Claude Code reports seconds (or milliseconds); null when absent. */
export function resetsAtIso(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return new Date(v < 1e12 ? v * 1000 : v).toISOString();
}

/** Parse one stream-json line of `claude -p --output-format stream-json`; null for a blank or non-JSON line (the CLI's own chatter). */
export function parseStreamLine(line: string): Msg | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Msg) : null;
  } catch {
    return null;
  }
}

/**
 * Follows one session's messages to an outcome. Transport-neutral: the SDK
 * yields these objects, the CLI prints them one per line.
 */
export class SessionTracker {
  readonly progress: SessionProgress;
  private limited: { resets_at: string | null; message: string } | null = null;
  private loginProblem: string | null = null;
  /** Set when the init message names a key source other than the subscription: the transport stops the session at once. */
  billingProblem: string | null = null;
  private result: Msg | null = null;
  private readonly started = Date.now();

  constructor(
    readonly transport: SessionTransport,
    private readonly logFile: string,
    private readonly onEvent?: (e: SessionEvent) => void,
    resumeOf: string | null = null
  ) {
    this.progress = { transport, session_id: resumeOf, turns: 0, tool_uses: 0, last_tool: null, last_text: null, updated_at: new Date().toISOString() };
    mkdirSync(path.dirname(logFile), { recursive: true });
  }

  /** Append a line to the log (never throws: the log is a record, not a dependency). */
  log(entry: Record<string, unknown>): void {
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), transport: this.transport, ...entry });
      appendFileSync(this.logFile, `${line.length > 40_000 ? `${line.slice(0, 40_000)}…"}` : line}\n`, "utf8");
    } catch {
      // a full disk or a locked file must not end a four-hour session
    }
  }

  private emit(kind: SessionEvent["kind"]): void {
    this.progress.updated_at = new Date().toISOString();
    try {
      this.onEvent?.({ kind, progress: { ...this.progress } });
    } catch {
      // a progress writer that throws is the caller's problem, not the session's
    }
  }

  /** Feed one message (an SDKMessage, or a parsed stream-json line). */
  push(msg: Msg): void {
    this.log({ message: msg });
    if (typeof msg.session_id === "string" && msg.session_id) this.progress.session_id = msg.session_id;
    const type = msg.type;
    if (type === "system" && msg.subtype === "init") {
      // The whole point is that no key pays: a session that reports one is stopped, not just logged (an older CLI that
      // does not report the field is let through; the environment carries no key either way).
      if (typeof msg.apiKeySource === "string" && msg.apiKeySource !== SUBSCRIPTION_KEY_SOURCE && !this.billingProblem) {
        this.billingProblem = notSubscriptionMessage(msg.apiKeySource);
        this.log({ error: this.billingProblem });
      }
      this.emit("init");
      return;
    }
    if (type === "assistant") {
      this.progress.turns += 1;
      const message = (msg.message ?? {}) as { content?: unknown };
      const blocks = Array.isArray(message.content) ? (message.content as Msg[]) : [];
      for (const b of blocks) {
        if (b?.type === "tool_use") {
          this.progress.tool_uses += 1;
          this.progress.last_tool = typeof b.name === "string" ? b.name : this.progress.last_tool;
        } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
          this.progress.last_text = b.text.trim().slice(0, 240);
        }
      }
      const error = msg.error;
      if (error === "rate_limit") this.limited = this.limited ?? { resets_at: null, message: this.progress.last_text ?? "Claude Code hit a usage limit" };
      if (error === "authentication_failed" || error === "oauth_org_not_allowed") this.loginProblem = this.progress.last_text ?? String(error);
      this.emit("assistant");
      return;
    }
    if (type === "rate_limit_event") {
      const info = (msg.rate_limit_info ?? {}) as { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown };
      if (info.status === "rejected") this.limited = { resets_at: resetsAtIso(info.resetsAt), message: `Claude Code usage limit reached${typeof info.rateLimitType === "string" ? ` (${info.rateLimitType})` : ""}` };
      this.emit("rate_limit");
      return;
    }
    if (type === "result") {
      this.result = msg;
      this.emit("result");
      return;
    }
    this.emit("other");
  }

  /** A stderr line (the CLI transport, or the SDK's `stderr` callback). */
  stderr(line: string): void {
    this.log({ stderr: line.slice(0, 4000) });
    if (LOGIN_TEXT.test(line)) this.loginProblem = this.loginProblem ?? line.trim();
    if (LIMIT_TEXT.test(line) && !this.limited) this.limited = { resets_at: null, message: line.trim().slice(0, 400) };
  }

  /** The outcome once the stream ended; `interruption` names what stopped it early (a cancel, a timeout, a crash), if anything did. */
  outcome(interruption: string | null): SessionOutcome {
    const common = { transport: this.transport, session_id: this.progress.session_id, log_file: this.logFile, turns: this.progress.turns };
    if (this.billingProblem) return { status: "failed", ...common, message: this.billingProblem };
    const r = this.result;
    const text = r && typeof r.result === "string" ? r.result : "";
    const errors = r && Array.isArray(r.errors) ? (r.errors as unknown[]).map(String).join("; ") : "";
    const succeeded = !!r && r.subtype === "success" && r.is_error !== true;
    if (!succeeded && (this.loginProblem || (r?.is_error === true && LOGIN_TEXT.test(text)))) {
      this.loginProblem = this.loginProblem ?? text;
      return { status: "unavailable", reason: "not_logged_in", message: `${NOT_LOGGED_IN_MESSAGE} (Claude Code said: ${this.loginProblem.slice(0, 200)})` };
    }
    if (r && r.subtype === "success" && r.is_error !== true && !interruption) {
      const cost = typeof r.total_cost_usd === "number" ? r.total_cost_usd : null;
      const duration = typeof r.duration_ms === "number" ? r.duration_ms : Date.now() - this.started;
      if (!common.session_id) return { status: "failed", ...common, message: "the session answered but never said its id; it cannot be resumed or audited" };
      return { status: "done", ...common, session_id: common.session_id, result: text, cost_usd: cost, duration_ms: duration };
    }
    if (this.limited || LIMIT_TEXT.test(text) || LIMIT_TEXT.test(errors)) {
      return { status: "limited", ...common, resets_at: this.limited?.resets_at ?? null, message: this.limited?.message ?? (text || errors || "Claude Code hit a usage limit").slice(0, 400) };
    }
    if (interruption) return { status: "interrupted", ...common, message: interruption };
    if (r && r.subtype === "error_max_turns") return { status: "interrupted", ...common, message: `the session used its turns (${String(r.num_turns ?? "?")}) without finishing; Retry resumes it` };
    if (r && (r.subtype === "error_during_execution" || r.is_error === true)) return { status: "failed", ...common, message: (errors || text || "Claude Code ended with an error").slice(0, 2000) };
    if (!r) return { status: "interrupted", ...common, message: "the session ended without a result (the process stopped); Retry resumes it" };
    return { status: "failed", ...common, message: `the session ended with ${String(r.subtype)}` };
  }
}

// ---- the SDK transport -----------------------------------------------------------------------------------------------------

/** The SDK's options for a request (exported so the tests can read what a session is given without starting one). */
export function sdkOptions(req: SessionRequest, abortController: AbortController, executable: string | null): Options {
  const opts: Options = {
    cwd: req.cwd,
    abortController,
    env: sessionEnv(req.env ?? process.env),
    model: req.model ?? DEFAULT_WRITER_MODEL,
    maxTurns: req.maxTurns ?? DEFAULT_MAX_TURNS,
    permissionMode: "dontAsk",
    allowedTools: [...(req.allowedTools ?? DEFAULT_ALLOWED_TOOLS)],
    additionalDirectories: req.additionalDirectories ?? [],
    stderr: () => undefined,
  };
  if (req.resume) opts.resume = req.resume;
  if (req.skills?.length) opts.skills = req.skills;
  if (executable) opts.pathToClaudeCodeExecutable = executable;
  return opts;
}

type SdkModule = { query: (p: { prompt: string; options?: Options }) => AsyncGenerator<SDKMessage, void> & { close?: () => void } };

/** The SDK, loaded lazily and never bundled (webpackIgnore): Next's server build must not pull a 1 MB agent runtime into every route. */
export async function loadSdk(): Promise<SdkModule | null> {
  try {
    const name = "@anthropic-ai/claude-agent-sdk";
    return (await import(/* webpackIgnore: true */ name)) as SdkModule;
  } catch {
    return null;
  }
}

async function runSdk(sdk: SdkModule, req: SessionRequest, executable: string | null): Promise<SessionOutcome> {
  const tracker = new SessionTracker("sdk", req.logFile, req.onEvent, req.resume ?? null);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (req.signal?.aborted) controller.abort();
  else req.signal?.addEventListener("abort", onAbort, { once: true });
  let interruption: string | null = null;
  const timer = setTimeout(() => {
    interruption = `the session ran past ${Math.round((req.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS) / 60000)} minutes and was stopped; Retry resumes it`;
    controller.abort();
  }, req.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS);
  timer.unref?.();
  const options = sdkOptions(req, controller, executable);
  options.stderr = (data: string) => {
    for (const line of data.split(/\r?\n/)) if (line.trim()) tracker.stderr(line);
  };
  tracker.log({ start: { cwd: req.cwd, model: options.model, max_turns: options.maxTurns, resume: req.resume ?? null, allowed_tools: options.allowedTools, prompt_chars: req.prompt.length } });
  try {
    const q = sdk.query({ prompt: req.prompt, options });
    for await (const msg of q) {
      tracker.push(msg as unknown as Msg);
      if (tracker.billingProblem) {
        // Not on the subscription: stop before the first turn is billed.
        controller.abort();
        q.close?.();
        break;
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    tracker.log({ error: message });
    if (req.signal?.aborted) interruption = interruption ?? "cancelled";
    else if (/ENOENT|not found|no such file|spawn .*claude/i.test(message) && !tracker.progress.session_id) {
      return { status: "unavailable", reason: "cli_missing", message: `${CLI_MISSING_MESSAGE} (${message.slice(0, 200)})` };
    } else interruption = interruption ?? `the session stopped: ${message.slice(0, 500)}`;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onAbort);
  }
  if (req.signal?.aborted && !interruption) interruption = "cancelled";
  return tracker.outcome(interruption);
}

// ---- the CLI transport (fallback; untested on this machine: no `claude` on PATH) ----------------------------------

/** The CLI's arguments for a request; the prompt goes on stdin (a brief is ~10 KB, past what a Windows command line should carry). */
export function cliArgs(req: SessionRequest): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", req.model ?? DEFAULT_WRITER_MODEL, "--max-turns", String(req.maxTurns ?? DEFAULT_MAX_TURNS), "--permission-mode", "dontAsk", "--allowedTools", [...(req.allowedTools ?? DEFAULT_ALLOWED_TOOLS)].join(",")];
  for (const d of req.additionalDirectories ?? []) args.push("--add-dir", d);
  if (req.resume) args.push("--resume", req.resume);
  return args;
}

/** A Windows command-line argument quoted for cmd.exe (the CLI's npm shim is a .cmd, which Node spawns only through cmd). */
export function cmdQuote(arg: string): string {
  return /^[A-Za-z0-9_.,:/\\=+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/** How to spawn the CLI: an .exe (or a POSIX binary) directly, an npm .cmd/.bat shim through cmd.exe /d /s /c. */
export function cliCommand(cli: string, args: string[], env: Env = process.env): { command: string; args: string[] } {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cli)) {
    return { command: env.ComSpec || env.COMSPEC || "cmd.exe", args: ["/d", "/s", "/c", `"${[cmdQuote(cli), ...args.map(cmdQuote)].join(" ")}"`] };
  }
  return { command: cli, args };
}

async function runCli(cli: string, req: SessionRequest, prefix: string[] = []): Promise<SessionOutcome> {
  const tracker = new SessionTracker("cli", req.logFile, req.onEvent, req.resume ?? null);
  // runProcess merges process.env: every variable the allow-list leaves out is set to undefined, which Node leaves out of
  // the child's environment (compared without case: Windows' `Path` is `PATH`).
  const env = { ...sessionEnv(req.env ?? process.env) } as NodeJS.ProcessEnv;
  const kept = new Set(Object.keys(env).map((k) => k.toLowerCase()));
  for (const k of Object.keys(process.env)) if (!kept.has(k.toLowerCase())) env[k] = undefined;
  const args = [...prefix, ...cliArgs(req)];
  const spawnAs = cliCommand(cli, args);
  tracker.log({ start: { cli, cwd: req.cwd, args, prompt_chars: req.prompt.length } });
  let proc: ReturnType<typeof runProcess>;
  try {
    proc = runProcess(spawnAs.command, spawnAs.args, {
      cwd: req.cwd,
      env,
      stdin: req.prompt,
      priority: "normal",
      timeoutMs: req.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
      tailChars: 8000,
      onLine: (stream, line) => {
        if (stream === "stderr") return tracker.stderr(line);
        const msg = parseStreamLine(line);
        if (msg) {
          tracker.push(msg);
          // Not on the subscription: stop before the first turn is billed.
          if (tracker.billingProblem) void proc?.cancel();
        } else if (line.trim()) tracker.log({ stdout: line.slice(0, 4000) });
      },
    });
  } catch (e) {
    return { status: "unavailable", reason: "cli_missing", message: `${CLI_MISSING_MESSAGE} (${(e as Error).message})` };
  }
  const onAbort = () => void proc.cancel();
  if (req.signal?.aborted) onAbort();
  else req.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const r = await proc.done;
    const interruption = r.cancelled ? "cancelled" : r.timedOut ? "the session ran past its time limit and was stopped; Retry resumes it" : null;
    return tracker.outcome(interruption);
  } catch (e) {
    const message = (e as Error).message;
    if (/could not run/i.test(message)) return { status: "unavailable", reason: "cli_missing", message: `${CLI_MISSING_MESSAGE} (${message.slice(0, 200)})` };
    return tracker.outcome(`the session stopped: ${message}`);
  } finally {
    req.signal?.removeEventListener("abort", onAbort);
  }
}

// ---- the launchers ---------------------------------------------------------------------------------------------------------

async function withLock(req: SessionRequest, fn: () => Promise<SessionOutcome>): Promise<SessionOutcome> {
  if (!req.lock) return fn();
  let held: Held<HeavyLock>;
  try {
    held = takeWritingLock(req.lock);
  } catch (e) {
    if (e instanceof LockHeldError) {
      const holder = e.holder as HeavyLock;
      return { status: "busy", holder, message: `another writing session holds the machine's slot: ${holder.what} (${holder.run_id ?? holder.owner}, since ${holder.started_at})` };
    }
    throw e;
  }
  try {
    return await fn();
  } finally {
    held.release();
  }
}

export type AutoLauncherOptions = {
  /** Only the SDK, or only the CLI (tests, a forced fallback); default both, SDK first. */
  prefer?: "sdk" | "cli";
  env?: Env;
  /** Injectable for the tests. */
  loadSdk?: () => Promise<SdkModule | null>;
  findCli?: (env: Env) => string | null;
  sdkBinary?: () => string | null;
  /** Tests: arguments put before the CLI's own (a fake CLI script run by node). */
  cliPrefix?: string[];
};

/**
 * The real launcher: the SDK when it loads and has a Claude Code binary
 * (its own platform package, or STUDIO_CLAUDE_CLI), else the `claude` CLI,
 * else `unavailable` with CLI_MISSING_MESSAGE.
 */
export function claudeLauncher(opts: AutoLauncherOptions = {}): ClaudeLauncher {
  const env = opts.env ?? process.env;
  const load = opts.loadSdk ?? loadSdk;
  const cliOf = opts.findCli ?? ((e: Env) => findClaudeCli(e));
  const binaryOf = opts.sdkBinary ?? sdkBinaryPath;

  async function pick(): Promise<{ transport: "sdk"; sdk: SdkModule; executable: string | null } | { transport: "cli"; cli: string } | null> {
    if (opts.prefer !== "cli") {
      const sdk = await load();
      const configured = env.STUDIO_CLAUDE_CLI?.trim();
      const executable = configured && existsSync(configured) ? configured : binaryOf();
      if (sdk && executable) return { transport: "sdk", sdk, executable: configured && existsSync(configured) ? configured : null };
    }
    if (opts.prefer !== "sdk") {
      const cli = cliOf(env);
      if (cli) return { transport: "cli", cli };
    }
    return null;
  }

  const start = async (req: SessionRequest): Promise<SessionOutcome> => {
    const chosen = await pick();
    if (!chosen) return { status: "unavailable", reason: "cli_missing", message: CLI_MISSING_MESSAGE };
    return withLock(req, () => (chosen.transport === "sdk" ? runSdk(chosen.sdk, req, chosen.executable) : runCli(chosen.cli, req, opts.cliPrefix ?? [])));
  };

  return {
    kind: opts.prefer ?? "auto",
    async available() {
      const chosen = await pick();
      if (!chosen) return { ok: false, reason: "cli_missing", message: CLI_MISSING_MESSAGE };
      return chosen.transport === "sdk" ? { ok: true, transport: "sdk", executable: chosen.executable ?? binaryOf() } : { ok: true, transport: "cli", executable: chosen.cli };
    },
    launch: (req) => start({ ...req, resume: req.resume ?? null }),
    resume: (sessionId, prompt, req) => start({ ...req, prompt, resume: sessionId }),
  };
}

// ---- the fake -------------------------------------------------------------------------------------------------------------

/** What one fake launch does: files it writes (relative to the request's cwd, or absolute), then how it ends. */
export type FakeSessionScript = {
  writes?: Record<string, string>;
  /** Default `done` with result "ok". */
  outcome?: { status: "done"; result?: string } | { status: "limited"; resets_at?: string | null; message?: string } | { status: "interrupted"; message?: string } | { status: "failed"; message?: string } | { status: "unavailable"; reason?: "cli_missing" | "not_logged_in"; message?: string };
  /** Assistant messages to report before the end (progress); default 1. */
  turns?: number;
};

export type FakeCall = { kind: "launch" | "resume"; req: SessionRequest; session_id: string };

/**
 * A launcher that plays scripts and starts nothing: `script(call, index)`
 * answers what each launch or resume does. Session ids are stable per
 * conversation (`fake-<n>`; a resume keeps its id), the lock and the log are
 * the real ones, so a test sees the busy slot and the JSON-lines file.
 */
export class FakeClaudeLauncher implements ClaudeLauncher {
  readonly kind = "fake" as const;
  readonly calls: FakeCall[] = [];
  private seq = 0;
  constructor(private readonly script: (call: FakeCall, index: number) => FakeSessionScript | Promise<FakeSessionScript> = () => ({})) {}

  async available(): Promise<LauncherAvailability> {
    return { ok: true, transport: "sdk", executable: null };
  }

  launch(req: SessionRequest): Promise<SessionOutcome> {
    return this.play("launch", req, `fake-${++this.seq}`);
  }

  resume(sessionId: string, prompt: string, req: Omit<SessionRequest, "prompt" | "resume">): Promise<SessionOutcome> {
    return this.play("resume", { ...req, prompt, resume: sessionId }, sessionId);
  }

  private async play(kind: FakeCall["kind"], req: SessionRequest, sessionId: string): Promise<SessionOutcome> {
    const call: FakeCall = { kind, req, session_id: sessionId };
    const index = this.calls.length;
    this.calls.push(call);
    return withLock(req, async () => {
      const s = await this.script(call, index);
      if (s.outcome?.status === "unavailable") return { status: "unavailable", reason: s.outcome.reason ?? "cli_missing", message: s.outcome.message ?? CLI_MISSING_MESSAGE };
      const tracker = new SessionTracker("fake", req.logFile, req.onEvent, req.resume ?? null);
      tracker.push({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: "none", model: req.model ?? DEFAULT_WRITER_MODEL });
      for (const [rel, text] of Object.entries(s.writes ?? {})) {
        const file = path.isAbsolute(rel) ? rel : path.join(req.cwd, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text, "utf8");
      }
      const turns = s.turns ?? 1;
      for (let i = 0; i < turns; i++) tracker.push({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: `turn ${i + 1}` }] } });
      const o = s.outcome ?? { status: "done" as const };
      if (o.status === "done") {
        tracker.push({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: o.result ?? "ok", total_cost_usd: 0, duration_ms: 1, num_turns: turns });
        return tracker.outcome(null);
      }
      if (o.status === "limited") {
        tracker.push({ type: "rate_limit_event", session_id: sessionId, rate_limit_info: { status: "rejected", resetsAt: o.resets_at ? Date.parse(o.resets_at) / 1000 : undefined, rateLimitType: "seven_day" } });
        const out = tracker.outcome(null);
        return out.status === "limited" && o.message ? { ...out, message: o.message } : out;
      }
      if (o.status === "interrupted") return tracker.outcome(o.message ?? "interrupted");
      tracker.push({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId, errors: [o.message ?? "failed"], num_turns: turns });
      return tracker.outcome(null);
    });
  }
}
