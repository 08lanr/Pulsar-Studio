// The Workflow shim (lib/segment/workflow-shim.ts): the three synced
// skip-through workflows compile under checks.py's signature and run with
// a fake gateway; their JSON schemas become zod and come back out of
// zodToJsonSchema unchanged but for strictness; the hooks keep the Workflow
// tool's semantics (pipeline without a barrier, a failed call is a null);
// a prompt's image paths are attached and an unknown one is refused; at
// most two calls run at once; and the caption-band crop is pinned as a
// filter graph and, where ffmpeg is on this machine, rendered.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resetFixtureStore } from "@/lib/data/fixture";
import { zodToJsonSchema, type JsonSchema, type StructuredCall, type StructuredResult } from "@/lib/llm";
import { dramaRemixRoot } from "@/lib/python";
import {
  CAPTION_CROP_NOTE,
  PICTURE_CALL_CONCURRENCY,
  PICTURE_JOB_KINDS,
  WORKFLOW_SIGNATURE,
  WorkflowShimError,
  accountRefusal,
  apiImageOf,
  apiReaderVersion,
  captionCropFilter,
  compileWorkflow,
  dropNulls,
  imagePathsIn,
  imageSize,
  isWorkflowUnavailable,
  jsonSchemaToZod,
  loadWorkflow,
  renderCaptionCrop,
  resolveImages,
  runWorkflow,
  shimUserText,
  tileGrid,
  withPictureSlot,
  workflowBody,
  workflowMeta,
  workflowReaderVersion,
  type WorkflowCall,
} from "@/lib/segment/workflow-shim";

const SKIP_THROUGH = path.join(dramaRemixRoot(), "scripts", "skip-through");
const WORKFLOWS = ["sheet_read.workflow.js", "frame_verify.workflow.js", "cut_verify.workflow.js"] as const;
const haveCheckout = WORKFLOWS.every((f) => existsSync(path.join(SKIP_THROUGH, f)));
const ffmpegOk = spawnSync(process.env.FFMPEG_PATH?.trim() || "ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true }).status === 0;
const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "narrated");
const RUN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const temps: string[] = [];
const saved = { replay: process.env.DEMO_REPLAY, source: process.env.DATA_SOURCE, anthropic: process.env.ANTHROPIC_API_KEY, deepseek: process.env.DEEPSEEK_API_KEY, vision: process.env.ADS_VISION_PROVIDER, model: process.env.ADS_VISION_MODEL };

beforeEach(() => {
  resetFixtureStore();
  process.env.DEMO_REPLAY = "0";
  delete process.env.DATA_SOURCE;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.ADS_VISION_PROVIDER;
  delete process.env.ADS_VISION_MODEL;
});

afterEach(() => {
  resetFixtureStore();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const [k, v] of [["DEMO_REPLAY", saved.replay], ["DATA_SOURCE", saved.source], ["ANTHROPIC_API_KEY", saved.anthropic], ["DEEPSEEK_API_KEY", saved.deepseek], ["ADS_VISION_PROVIDER", saved.vision], ["ADS_VISION_MODEL", saved.model]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

/** The three workflows as a film's sync puts them: copied byte for byte into `<film>/scripts/`. */
function syncedWorkflows(): string {
  const scripts = path.join(tempDir("studio-shim-"), "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const f of WORKFLOWS) copyFileSync(path.join(SKIP_THROUGH, f), path.join(scripts, f));
  return scripts;
}

/** Every object of a JSON schema with additionalProperties false, as zodToJsonSchema writes it. */
function strict(s: JsonSchema): JsonSchema {
  const o = { ...s } as Record<string, unknown>;
  if (o.type === "object") {
    o.properties = Object.fromEntries(Object.entries((o.properties ?? {}) as Record<string, JsonSchema>).map(([k, v]) => [k, strict(v)]));
    o.additionalProperties = false;
  }
  if (o.type === "array" && o.items) o.items = strict(o.items as JsonSchema);
  if (Array.isArray(o.enum) && !o.type) o.type = "string";
  return o;
}

/** An answer to a workflow schema: strings named after their key, integers 1, booleans false, the first enum value, one array item. */
function answerFor(s: JsonSchema): unknown {
  const o = s as { type?: string; properties?: Record<string, JsonSchema>; items?: JsonSchema; enum?: string[] };
  if (o.enum) return o.enum[0];
  switch (o.type) {
    case "object":
      return Object.fromEntries(Object.entries(o.properties ?? {}).map(([k, v]) => [k, (v as { type?: string }).type === "string" && !(v as { enum?: unknown }).enum ? k : answerFor(v)]));
    case "array":
      return [answerFor(o.items!)];
    case "integer":
      return 1;
    case "boolean":
      return false;
    default:
      return "x";
  }
}

// ---- compiling ----------------------------------------------------------------------------------------

test("the three synced workflows compile under checks.py's signature, with their meta names and reader versions read from the files (skipped without the drama-remix checkout)", (t) => {
  if (!haveCheckout) return t.skip(`no skip-through workflows at ${SKIP_THROUGH}`);
  assert.deepEqual([...WORKFLOW_SIGNATURE], ["args", "agent", "pipeline", "parallel", "phase", "log", "budget", "workflow"]);
  const scripts = syncedWorkflows();
  const got = WORKFLOWS.map((f) => loadWorkflow(path.join(scripts, f)));
  assert.deepEqual(got.map((w) => w.meta.name), ["sheet-read", "frame-verify", "cut-verify"]);
  assert.deepEqual(got.map((w) => w.reader_version), [null, "fv-2", "cv-2"]);
  for (const w of got) {
    assert.equal(typeof w.body, "function");
    assert.match(w.sha256, /^[0-9a-f]{64}$/);
    assert.ok(w.meta.description.length > 10);
  }
});

test("compile strips only the first `export `, refuses a syntax error by name, and reads the meta literal alone", () => {
  const src = "export const meta = { name: 'toy', description: 'a {brace} in a string', phases: [{ title: 'Read' }] }\nconst x = `export ` + 1\nreturn args.n + 1";
  assert.equal(workflowBody(src).startsWith("const meta"), true);
  assert.equal(workflowBody(src).includes("`export `"), true);
  assert.deepEqual(workflowMeta(src), { name: "toy", description: "a {brace} in a string", phases: [{ title: "Read" }] });
  assert.equal(workflowReaderVersion("const READER_VERSION = 'fv-2'\n"), "fv-2");
  assert.equal(workflowReaderVersion("// no version\n"), null);
  assert.throws(() => compileWorkflow("export const meta = { name: 'bad' }\nconst s = 'broken\nstring'", "bad.workflow.js"), (e: unknown) => e instanceof WorkflowShimError && /bad\.workflow\.js does not compile/.test(e.message));
  assert.throws(() => workflowMeta("const meta = {}"), /no `export const meta/);
});

// ---- schemas ------------------------------------------------------------------------------------------

test("the workflows' own schemas become zod that zodToJsonSchema turns back into the same schema, made strict (skipped without the checkout)", async (t) => {
  if (!haveCheckout) return t.skip(`no skip-through workflows at ${SKIP_THROUGH}`);
  const scripts = syncedWorkflows();
  const sheet = path.join(tempDir("studio-shim-img-"), "min-0.png");
  copyFileSync(path.join(FIXTURE, "index", "sheets", "min-9.png"), sheet);
  const p = sheet.replace(/\\/g, "/");
  const schemas: Record<string, JsonSchema> = {};
  const argsFor: Record<string, unknown> = {
    "sheet_read.workflow.js": { premise: "P", groups: [{ project: "toy", sheets: [{ minute: 0, path: p }] }] },
    "frame_verify.workflow.js": { premise: "P", items: [{ key: "ep1-N1", ep: "ep1", id: "N1", text: "Line.", sheet: p }] },
    "cut_verify.workflow.js": { premise: "P", items: [{ key: "ep1-1.00-2.00", ep: "ep1", id: "1.00-2.00", skipped_seconds: 1, words: [], words_fp: "abc", sheet: p }] },
  };
  for (const f of WORKFLOWS) {
    const llm = async <T>(call: StructuredCall<T>): Promise<StructuredResult<T>> => {
      const data = call.schema.parse(answerFor(zodToJsonSchema(call.schema)));
      return { data, usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_cents: 1, provider: "anthropic", model: call.model!, turns: 1 };
    };
    const r = await runWorkflow({
      file: path.join(scripts, f),
      args: argsFor[f],
      images: (q) => (q === p ? [{ path: sheet, media_type: "image/png", note: q }] : null),
      job: (call: WorkflowCall) => {
        schemas[f] = call.schema;
        return { kind: PICTURE_JOB_KINDS.sheet_read, target_id: RUN_ID, idempotency_key: `test:${f}:${call.label}` };
      },
      llm,
    });
    assert.ok(!isWorkflowUnavailable(r));
    assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
    const schema = schemas[f];
    assert.deepEqual(zodToJsonSchema(jsonSchemaToZod(schema)), strict(schema), `${f}: the round trip changes nothing but strictness`);
  }
  assert.deepEqual(Object.keys((schemas["frame_verify.workflow.js"] as { properties: object }).properties), ["people", "claims"]);
  assert.deepEqual(Object.keys((schemas["cut_verify.workflow.js"] as { properties: object }).properties), ["before", "after", "what_was_cut", "viewer_lost", "what_is_confusing", "fix"]);
});

test("jsonSchemaToZod: a property the schema does not require is nullable and its null is dropped; an unsupported type is refused", () => {
  const z1 = jsonSchemaToZod({ type: "object", properties: { a: { type: "string" }, b: { type: "integer" } }, required: ["a"] });
  assert.deepEqual(dropNulls(z1.parse({ a: "x", b: null })), { a: "x" });
  assert.throws(() => z1.parse({ a: "x", b: 1.5 }));
  assert.throws(() => jsonSchemaToZod({ type: "object", properties: {}, required: ["x"] }), /required key x has no property/);
  assert.throws(() => jsonSchemaToZod({ type: "null" }), /not supported/);
  assert.throws(() => jsonSchemaToZod({ enum: [1, 2] }), /only string enums/);
});

// ---- images ------------------------------------------------------------------------------------------

test("the image paths a prompt names are found in order and attached; a path the pass has no image for fails the call", () => {
  const prompt = "Use the Read tool to open this image: C:/x/proj/ep9/review/frames/N1.jpg\n\nIt is a sheet.\n- minute 3: /tmp/p/index/sheets/min-3.png\nagain C:/x/proj/ep9/review/frames/N1.jpg.";
  assert.deepEqual(imagePathsIn(prompt), ["C:/x/proj/ep9/review/frames/N1.jpg", "/tmp/p/index/sheets/min-3.png"]);
  const map = (p: string) => (p.endsWith("N1.jpg") ? [{ path: "a.jpg", media_type: "image/jpeg" as const, note: p }, { path: "b.jpg", media_type: "image/jpeg" as const, note: CAPTION_CROP_NOTE }] : null);
  assert.throws(() => resolveImages(prompt, map), /names \/tmp\/p\/index\/sheets\/min-3\.png, which this pass has no image for/);
  const images = resolveImages("open C:/x/proj/ep9/review/frames/N1.jpg", map);
  assert.equal(images.length, 2);
  const text = shimUserText("PROMPT", images);
  assert.match(text, /^\[Studio runs this reader through the API\./);
  assert.match(text, /image 1: C:\/x\/proj\/ep9\/review\/frames\/N1\.jpg\n  image 2: a 2x enlargement of the bottom band/);
  assert.ok(text.endsWith("\n\nPROMPT"), "the workflow's prompt follows the list unchanged");
  assert.equal(shimUserText("PROMPT", []), "PROMPT");
});

test("imageSize reads a PNG and a JPEG; the tile grid follows the pipeline's layout and the video's aspect", async () => {
  assert.deepEqual(await imageSize(path.join(FIXTURE, "ep9", "review", "frames", "N1.jpg")), { width: 1920, height: 540 });
  assert.deepEqual(await imageSize(path.join(FIXTURE, "ep9", "review", "joins", "J1.jpg")), { width: 2400, height: 675 });
  assert.deepEqual(await imageSize(path.join(FIXTURE, "index", "sheets", "min-9.png")), { width: 640, height: 216 });
  assert.deepEqual(tileGrid({ width: 1920, height: 540 }, 4, null), { cols: 4, rows: 2, tile_w: 480, tile_h: 270 });
  assert.deepEqual(tileGrid({ width: 1920, height: 1080 }, 4, { width: 1440, height: 1080 }), { cols: 4, rows: 3, tile_w: 480, tile_h: 360 }, "a 4:3 source: three rows, not four of 16:9");
  assert.deepEqual(tileGrid({ width: 2400, height: 675 }, 6, { width: 1920, height: 1080 }), { cols: 6, rows: 3, tile_w: 400, tile_h: 225 });
});

test("the caption-band crop's filter graph: the bottom quarter of every tile, 2x, two per row, an odd last band padded", () => {
  const f = captionCropFilter({ cols: 4, rows: 2, tile_w: 480, tile_h: 270 });
  const parts = f.split(";");
  assert.equal(parts[0], "[0:v]split=8[s0][s1][s2][s3][s4][s5][s6][s7]");
  assert.equal(parts[1], "[s0]crop=480:68:0:202,scale=960:136:flags=lanczos[b0]");
  assert.equal(parts[6], "[s5]crop=480:68:480:472,scale=960:136:flags=lanczos[b5]");
  assert.equal(parts[9], "[b0][b1]hstack=inputs=2[r0]");
  assert.equal(parts[parts.length - 1], "[r0][r1][r2][r3]vstack=inputs=4[out]");
  const odd = captionCropFilter({ cols: 3, rows: 1, tile_w: 100, tile_h: 60 }).split(";");
  assert.equal(odd[odd.length - 2], "[b2]pad=400:30:0:0:black[r1]");
  assert.equal(captionCropFilter({ cols: 1, rows: 1, tile_w: 100, tile_h: 60 }), "[0:v]null[s0];[s0]crop=100:15:0:45,scale=200:30:flags=lanczos[b0];[b0]pad=400:30:0:0:black[r0];[r0]null[out]");
});

test("the caption-band crop renders with the real ffmpeg: a frame sheet and a join sheet (skipped without ffmpeg)", async (t) => {
  if (!ffmpegOk) return t.skip("no ffmpeg on this machine");
  const out = tempDir("studio-crop-");
  const frame = await renderCaptionCrop(path.join(FIXTURE, "ep9", "review", "frames", "N1.jpg"), out, 4, null);
  assert.equal(path.basename(frame), "N1.captions2x.jpg");
  assert.deepEqual(await imageSize(frame), { width: 1920, height: 4 * 136 });
  const join = await renderCaptionCrop(path.join(FIXTURE, "ep9", "review", "joins", "J1.jpg"), out, 6, { width: 1920, height: 1080 });
  assert.deepEqual(await imageSize(join), { width: 1600, height: 9 * 112 });
  // Made once: a second call finds the fresh copy and runs nothing.
  let ran = 0;
  await renderCaptionCrop(path.join(FIXTURE, "ep9", "review", "frames", "N1.jpg"), out, 4, null, { run: async () => ((ran += 1), { code: 0, stderr: "" }) });
  assert.equal(ran, 0);
});

test("apiImageOf sends a small image as it is and a large one as a JPEG copy in the work folder (skipped without ffmpeg)", async (t) => {
  const small = await apiImageOf(path.join(FIXTURE, "ep9", "review", "frames", "N1.jpg"), tempDir("studio-api-img-"));
  assert.equal(small.reencoded, false);
  assert.equal(small.media_type, "image/jpeg");
  if (!ffmpegOk) return t.skip("no ffmpeg on this machine");
  const out = tempDir("studio-api-img-");
  const big = await apiImageOf(path.join(FIXTURE, "index", "sheets", "min-9.png"), out, { over_bytes: 1000 });
  assert.equal(big.reencoded, true);
  assert.equal(big.media_type, "image/jpeg");
  assert.equal(path.dirname(big.path), out);
  assert.deepEqual(await imageSize(big.path), { width: 640, height: 216 });
});

// ---- the hooks ---------------------------------------------------------------------------------------

test("withPictureSlot lets at most PICTURE_CALL_CONCURRENCY calls run at once and hands a freed slot to the next waiter", async () => {
  assert.equal(PICTURE_CALL_CONCURRENCY, 2);
  let active = 0;
  let peak = 0;
  const done: number[] = [];
  await Promise.all(
    Array.from({ length: 7 }, (_, i) =>
      withPictureSlot(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5 + (i % 3) * 3));
        active -= 1;
        done.push(i);
      })
    )
  );
  assert.equal(peak, 2);
  assert.equal(done.length, 7);
});

test("runWorkflow keeps the Workflow tool's semantics: pipeline items independent, a failed call is a null the script filters, a throwing stage drops its item, budget has no target, workflow() is refused", async () => {
  const dir = tempDir("studio-toy-wf-");
  const img = path.join(dir, "a.jpg").replace(/\\/g, "/");
  copyFileSync(path.join(FIXTURE, "ep9", "review", "frames", "N1.jpg"), img);
  const file = path.join(dir, "toy.workflow.js");
  writeFileSync(
    file,
    [
      "export const meta = { name: 'toy', description: 'A toy', phases: [{ title: 'Read' }] }",
      "const S = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }",
      "phase('Read')",
      "log(`budget ${budget.total} ${budget.remaining()}`)",
      "let nested = 'ran'",
      "try { await workflow('x') } catch (e) { nested = e.message }",
      "log(nested)",
      "const out = await pipeline(args.items, (it) => parallel([1, 2].map((k) => () => agent(`look at ${args.img} item ${it} lens ${k}`, { label: `l${k}:${it}`, phase: 'Read', schema: S }))), (rs, it) => { if (it === 'boom') throw new Error('stage broke'); return { it, readers: rs.filter(Boolean) } })",
      "return out.filter(Boolean)",
    ].join("\n")
  );
  const seen: StructuredCall<unknown>[] = [];
  const llm = async <T>(call: StructuredCall<T>): Promise<StructuredResult<T>> => {
    seen.push(call as StructuredCall<unknown>);
    if (call.user.includes("item bad lens 2")) throw new Error("fake transport refusal");
    return { data: call.schema.parse({ n: 7 }), usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_cents: 1, provider: "anthropic", model: call.model!, turns: 1 };
  };
  const logs: string[] = [];
  const r = await runWorkflow({
    file,
    args: { img, items: ["ok", "bad", "boom"] },
    images: (p) => (p === img ? [{ path: img, media_type: "image/jpeg", note: p }] : null),
    job: (call) => ({ kind: PICTURE_JOB_KINDS.frame_verify, target_id: RUN_ID, idempotency_key: `toy:${call.label}`, input: { label: call.label } }),
    llm,
    onLog: (l) => logs.push(l),
  });
  assert.ok(!isWorkflowUnavailable(r));
  assert.deepEqual(r.result, [
    { it: "ok", readers: [{ n: 7 }, { n: 7 }] },
    { it: "bad", readers: [{ n: 7 }] },
  ]);
  assert.equal(r.calls.length, 6);
  assert.deepEqual(r.failed.map((c) => [c.label, c.status]), [["l2:bad", "failed"]]);
  assert.match(r.failed[0].error ?? "", /fake transport refusal/);
  assert.equal(r.stage_errors.length, 1);
  assert.match(r.stage_errors[0], /stage broke/);
  assert.ok(logs.includes("phase Read"));
  assert.ok(logs.includes("budget null Infinity"));
  assert.ok(logs.includes("workflow() is not available in the Studio shim"));
  for (const c of seen) {
    assert.equal(c.model, "claude-opus-5-5", "the frame judge's default model");
    assert.equal(c.provider, "anthropic");
    assert.equal(c.toolChoice, "auto", "the judge's tool choice: the model thinks first");
    assert.equal(c.name, "record_toy");
    assert.equal(c.images?.length, 1);
  }
  assert.equal(r.model, "claude-opus-5-5");
  assert.equal(r.cost_cents, 5, "five done rows at a cent each; the failed call spent nothing");
  // The done rows are reused by key: a second run pays only for the call that failed.
  let fresh = 0;
  const again = await runWorkflow({
    file,
    args: { img, items: ["ok", "bad"] },
    images: (p) => (p === img ? [{ path: img, media_type: "image/jpeg", note: p }] : null),
    job: (call) => ({ kind: PICTURE_JOB_KINDS.frame_verify, target_id: RUN_ID, idempotency_key: `toy:${call.label}` }),
    llm: async <T>(call: StructuredCall<T>): Promise<StructuredResult<T>> => ((fresh += 1), { data: call.schema.parse({ n: 8 }), usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_cents: 1, provider: "anthropic", model: call.model!, turns: 1 }),
  });
  assert.ok(!isWorkflowUnavailable(again));
  assert.equal(fresh, 1);
  assert.equal(again.calls.filter((c) => c.reused).length, 3);
});

test("runWorkflow refuses before any call without a vision key or in demo replay, and names a mis-synced workflow", async () => {
  const dir = tempDir("studio-toy-wf-");
  const file = path.join(dir, "toy.workflow.js");
  writeFileSync(file, "export const meta = { name: 'toy', description: '' }\nreturn 1");
  const base = { file, args: {}, images: () => null, job: () => ({ kind: PICTURE_JOB_KINDS.cut_verify, target_id: RUN_ID, idempotency_key: "k" }) };
  delete process.env.ANTHROPIC_API_KEY;
  const noKey = await runWorkflow(base);
  assert.ok(isWorkflowUnavailable(noKey));
  assert.match(noKey.unavailable, /vision provider unavailable: add ANTHROPIC_API_KEY/);
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  process.env.DEMO_REPLAY = "1";
  const demo = await runWorkflow(base);
  assert.ok(isWorkflowUnavailable(demo));
  assert.match(demo.unavailable, /demo mode/);
  process.env.DEMO_REPLAY = "0";
  await assert.rejects(runWorkflow({ ...base, expect_name: "frame-verify" }), /is the toy workflow, not frame-verify/);
  // The bytes compiled are the bytes the sync recorded: a copy a session changed is never compiled in this process.
  await assert.rejects(runWorkflow({ ...base, expect_sha256: "0".repeat(64) }), (e: unknown) => e instanceof WorkflowShimError && /is not the file Studio synced .*the sync recorded 000000000000\): nothing is compiled from a changed copy/.test(e.message));
  assert.equal(apiReaderVersion("fv-2", "claude-opus-5-5"), "fv-2+api:claude-opus-5-5");
});

test("a stop reaches the calls already queued: a provider that cannot run stops the pass after the calls in flight, and the spend cap holds back the rest", async () => {
  const dir = tempDir("studio-toy-wf-");
  const file = path.join(dir, "toy.workflow.js");
  writeFileSync(
    file,
    [
      "export const meta = { name: 'toy', description: '' }",
      "const S = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }",
      "const rs = await parallel([1, 2, 3, 4, 5, 6].map((k) => () => agent(`call ${k}`, { label: `c:${k}`, schema: S })))",
      "return rs",
    ].join("\n")
  );
  const base = { file, args: {}, images: () => null, job: (call: WorkflowCall) => ({ kind: PICTURE_JOB_KINDS.frame_verify, target_id: RUN_ID, idempotency_key: `stop:${call.label}:${Math.random()}` }) };
  let sent = 0;
  const { LlmUnavailableError } = await import("@/lib/llm");
  const down = await runWorkflow({
    ...base,
    llm: async () => {
      sent += 1;
      await new Promise((r) => setTimeout(r, 5));
      throw new LlmUnavailableError(undefined, "anthropic");
    },
  });
  assert.ok(isWorkflowUnavailable(down));
  assert.match(down.unavailable, /missing ANTHROPIC_API_KEY/);
  assert.ok(sent <= PICTURE_CALL_CONCURRENCY, `only the calls already in flight were sent (${sent})`);

  // An account out of credit (the eval of 2026-09-23: every cut_verify call a 400) stops the pass the same way, with the reason.
  const { LlmError } = await import("@/lib/llm");
  const credit = () => new LlmError("api", "Claude API 400: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.", 400);
  sent = 0;
  const broke = await runWorkflow({
    ...base,
    llm: async () => {
      sent += 1;
      await new Promise((r) => setTimeout(r, 5));
      throw credit();
    },
  });
  assert.ok(isWorkflowUnavailable(broke), "not `done` with every item unjudged");
  assert.match(broke.unavailable, /the provider account cannot pay for calls: .*credit balance is too low.*top up the account's credit, then Retry/);
  assert.ok(sent <= PICTURE_CALL_CONCURRENCY, `only the calls already in flight were sent (${sent})`);
  assert.match(accountRefusal(new LlmError("api", "Claude API 401: invalid x-api-key", 401)) ?? "", /refused the key \(401\)/);
  assert.match(accountRefusal(new LlmError("api", "Claude API 403: forbidden", 403)) ?? "", /refused the key \(403\)/);
  assert.equal(accountRefusal(new LlmError("api", "Claude API 400: messages: text content blocks must be non-empty", 400)), null, "a bad request of one call is that call's failure");
  assert.equal(accountRefusal(new LlmError("api", "Claude API 529: overloaded", 529)), null);
  assert.equal(accountRefusal(credit()) !== null, true);

  sent = 0;
  const capped = await runWorkflow({
    ...base,
    max_usd: 0.0001,
    llm: async <T>(call: StructuredCall<T>): Promise<StructuredResult<T>> => {
      sent += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { data: call.schema.parse({ n: 1 }), usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_cents: 2, provider: "anthropic", model: call.model!, turns: 1 };
    },
  });
  assert.ok(!isWorkflowUnavailable(capped));
  assert.equal(sent, PICTURE_CALL_CONCURRENCY, "the two calls in flight finish; none starts after the cap is spent");
  assert.equal(capped.calls.filter((c) => c.status === "capped").length, 6 - PICTURE_CALL_CONCURRENCY);
  assert.match(capped.failed[0].error ?? "", /the spend cap of \$0\.0001 was reached/);
  assert.deepEqual((capped.result as unknown[]).filter(Boolean).length, PICTURE_CALL_CONCURRENCY);
});

test("a known sheet path with a space in it is matched whole; the rest of the prompt is still scanned", () => {
  const known = "C:/Users/Jane Doe/proj/ep9/review/frames/N1.jpg";
  const prompt = `Use the Read tool to open this image: ${known}\n\nAlso /x/other.png`;
  const map = (p: string) => (p === known ? [{ path: "a.jpg", media_type: "image/jpeg" as const, note: p }] : p === "/x/other.png" ? [{ path: "b.png", media_type: "image/png" as const, note: p }] : null);
  assert.deepEqual(resolveImages(prompt, map, [known]).map((i) => i.path), ["a.jpg", "b.png"]);
  assert.throws(() => resolveImages(prompt, map), /names \/proj\/ep9\/review\/frames\/N1\.jpg,/, "without the known path the scan would split it at the space");
});
