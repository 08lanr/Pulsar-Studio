// Test clips for a producer company (docs/launch-ux-round-2.md §4).
//
// Creates, under one producer, a single seed title ("Studio seed · test
// drama"), one episode, and N finished clips whose rows satisfy the Clips
// tab's filter in lib/data/launch.ts (render_status 'rendered', a render_path,
// a render_sha256, a status that is not 'dismissed'). The video bytes are the
// rendered fixture files already in .uploads/**/clip-demo-*.mp4 — real short
// vertical mp4s — uploaded to the studio-media bucket through the app's own
// lib/data/storage.ts helper, with the SHA-256 taken over the exact bytes sent.
//
//   node scripts/seed-test-clips.mjs --dry-run --producer="Xinghai Pictures" --count=6
//   node scripts/seed-test-clips.mjs --live    --producer="Xinghai Pictures" --count=6
//   node scripts/seed-test-clips.mjs --live    --producer="Xinghai Pictures" --remove
//
// Rules this script keeps: every write needs --live; a write refuses unless
// DATA_SOURCE resolves to supabase; .tokens.json is never opened; no Meta or
// TikTok call is ever made; nothing it prints is a token, a key or a URL with
// one in it. Re-running tops up to --count and repairs a clip whose render did
// not finish; --remove deletes the seed title, its episode, its clips and their
// storage objects, and nothing else.
//
// The pure pieces below (argument parsing, the hook cycle, the row builders,
// the planner) are exported for tests/seed-test-clips.test.ts.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---- constants ---------------------------------------------------------------

export const SEED_TITLE_NAME_EN = "Studio seed · test drama";
export const SEED_TITLE_NAME_ZH = "测试剧集（种子数据）";
/** Written to clips.prompt_version and named in titles.notes: the marker that says a row came from here. */
export const SEED_MARKER = "seed-test-clips/v1";
export const SEED_EPISODE_NUMBER = 1;
export const DEFAULT_COUNT = 6;
export const MAX_COUNT = 20;
/** The fixture clips are 25 s 1080×1920; used when ffprobe is not installed. */
export const FALLBACK_DURATION_MS = 25_000;
export const FALLBACK_WIDTH = 1080;
export const FALLBACK_HEIGHT = 1920;
export const FFPROBE_WINGET =
  "C:/Users/ruobi/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffprobe.exe";

const USAGE = [
  "Seeds finished test clips for one producer company. Nothing is written without --live.",
  "",
  "  node scripts/seed-test-clips.mjs --dry-run --producer=<name or uuid> [--count=6]",
  "  node scripts/seed-test-clips.mjs --live    --producer=<name or uuid> [--count=6]",
  "  node scripts/seed-test-clips.mjs --live    --producer=<name or uuid> --remove",
  "",
  `  --producer  core.producers name_en, name_zh or id. An ambiguous name is refused.`,
  `  --count     how many clips the company should end up with (default ${DEFAULT_COUNT}, max ${MAX_COUNT}).`,
  "  --dry-run   print the exact rows and paths; no env is read for a key, no network call is made.",
  "  --remove    delete the seed title, its episode, its clips and their storage objects.",
  "",
  "A live run needs DATA_SOURCE=supabase. This script never opens .tokens.json and never calls Meta or TikTok.",
];

/** Eight hooks that read like ad copy, cycled by rank; the cycle suffix keeps hook_en distinct up to 20. */
export const HOOKS = [
  "She served him divorce papers. Ten minutes later he owned her company.",
  "The waitress they mocked at the gala signs their paychecks on Monday.",
  "He married her to spite his family. Then he read her file.",
  "Everyone laughed at the delivery girl — until the chairman called her boss.",
  "Three years inside for his brother's crime. Tonight he walked back in.",
  "She agreed to one year of marriage. He is not letting her leave.",
  "The heiress has a secret. So does the maid who just found it.",
  "They scrubbed her name off the building. She bought the building.",
];

/** Reason lines, one per hook, in both content languages (docs/terminology.md: 你, 剧集, 分集). */
export const WHYS = [
  { en: "The reversal lands in the first three seconds and the stakes are money, not feelings.", zh: "开场三秒就完成反转，赌注是钱，不是情绪。" },
  { en: "Status flip with a hard cut on the last word; it tests class-revenge audiences.", zh: "身份反转，最后一个字直接切走，用来测试逆袭向观众。" },
  { en: "A contract-marriage premise stated in one line, which reads well as cold-open ad copy.", zh: "一句话讲清契约婚姻的设定，适合当冷开场广告文案。" },
  { en: "Humiliation to authority in nine words; the strongest comment-bait window of the episode.", zh: "从被羞辱到掌权只用九个词，是这集最容易引发评论的片段。" },
  { en: "Revenge setup with a time marker, which gives the viewer a reason to stay for the payoff.", zh: "带时间点的复仇铺垫，让观众有理由留下来看结果。" },
  { en: "Possessive-CEO beat with a clear refusal, the pairing that holds two-second watch rate.", zh: "霸总桥段加上明确拒绝，这组搭配能撑住 2 秒完播率。" },
  { en: "Two secrets in one sentence: the question is asked and never answered on screen.", zh: "一句话里藏两个秘密，问题抛出来但画面里不给答案。" },
  { en: "Erasure answered by ownership; the cleanest single-sentence payoff in the episode.", zh: "被抹去之后直接买下大楼，是这集最干净的一句话反转。" },
];

/** Appended by cycle so ranks 9–20 keep distinct hook_en while still reading like hooks. */
export const CYCLE_SUFFIXES = ["", " — the full scene", " — how it ends"];

// ---- pure pieces -------------------------------------------------------------

/** What ffprobe reads off a fixture file (or the fixed fallback shape). @typedef {{ duration_ms?: number, width?: number, height?: number, probed?: boolean }} MediaShape */

/**
 * Argument parsing. Returns the parsed flags plus `errors`; the caller decides
 * what to do with them, so a test can exercise the refusals without exiting.
 */
export function parseArgs(argv) {
  const errors = [];
  const live = argv.includes("--live");
  const dryRun = argv.includes("--dry-run");
  const remove = argv.includes("--remove");
  const rawProducer = argv.find((a) => a.startsWith("--producer="))?.slice("--producer=".length) ?? "";
  const rawCount = argv.find((a) => a.startsWith("--count="))?.slice("--count=".length);
  const unknown = argv.filter(
    (a) => a.startsWith("-") && !["--live", "--dry-run", "--remove"].includes(a) && !a.startsWith("--producer=") && !a.startsWith("--count=")
  );

  const producer = rawProducer.trim();
  if (!producer) errors.push("--producer=<name or uuid> is required.");
  unknown.forEach((a) => errors.push(`Unknown flag ${a}.`));

  let count = DEFAULT_COUNT;
  if (rawCount !== undefined) {
    const n = Number(rawCount);
    if (!Number.isInteger(n) || n < 1) errors.push("--count must be a whole number of at least 1.");
    else if (n > MAX_COUNT) errors.push(`--count may not exceed ${MAX_COUNT}.`);
    else count = n;
  }
  if (!live && !dryRun) errors.push("Nothing was written. Pass --live to write, or --dry-run to see the plan.");
  if (remove && !live && !dryRun) errors.push("--remove deletes rows; it needs --live.");

  return { live, dryRun, remove, producer, count, errors, usage: USAGE };
}

/** Rank → the hook shown in the Clips tab. Distinct for every rank in 1..MAX_COUNT. */
export function hookForRank(rank) {
  const index = (rank - 1) % HOOKS.length;
  const cycle = Math.floor((rank - 1) / HOOKS.length);
  return `${HOOKS[index]}${CYCLE_SUFFIXES[cycle] ?? ` — part ${cycle + 1}`}`;
}

/** Rank → why_en / why_zh, filled for every rank. */
export function whyForRank(rank) {
  const why = WHYS[(rank - 1) % WHYS.length];
  return { why_en: why.en, why_zh: why.zh };
}

/** The filename a seed clip is stored under; stable, so a re-run overwrites the same object. */
export function seedFilename(rank) {
  return `seed-clip-${rank}.mp4`;
}

/** core.titles: every not-null column of the table, the enum value included. */
export function buildTitleRow(producerId, deliverables = {}) {
  return {
    producer_id: producerId,
    name_zh: SEED_TITLE_NAME_ZH,
    name_en: SEED_TITLE_NAME_EN,
    genre: "urban revenge",
    synopsis_zh: "为测试投放流程准备的种子剧集，内容来自 Studio 自带的样片。",
    synopsis_en: "A seed title for testing the launch flow; the footage is Studio's own sample clips.",
    episode_count: 1,
    source_locale: "zh-CN",
    status: "selected",
    notes: `Created by scripts/seed-test-clips.mjs (${SEED_MARKER}). Safe to delete with --remove.`,
    deliverables,
  };
}

/** core.episodes: number is the natural key with title_id; the video path is filled once it is known. */
export function buildEpisodeRow(titleId, videoPath = null) {
  return {
    title_id: titleId,
    number: SEED_EPISODE_NUMBER,
    name_zh: "种子分集 1",
    name_en: "Seed episode 1",
    duration_ms: null,
    source_script_path: null,
    script_format: null,
    has_timecodes: false,
    video_path: videoPath,
  };
}

/**
 * studio.clips: every not-null column and enum of the table plus the render
 * bookkeeping from migration 0010.
 *
 * @param {{ titleId: string, episodeId: string, adaptationId?: string | null, rank: number,
 *           media?: MediaShape | null, renderPath: string, sha256: string }} input
 */
export function buildClipRow({ titleId, episodeId, adaptationId = null, rank, media, renderPath, sha256 }) {
  const duration = media?.duration_ms ?? FALLBACK_DURATION_MS;
  const { why_en, why_zh } = whyForRank(rank);
  return {
    title_id: titleId,
    episode_id: episodeId,
    adaptation_id: adaptationId,
    rank,
    start_ms: 0,
    end_ms: duration,
    scene_ids: [],
    hook_en: hookForRank(rank),
    why_en,
    why_zh,
    opening_text_en: null,
    cut_length_s: Math.max(1, Math.round(duration / 1000)),
    angle: "direct_clip",
    status: "shortlisted",
    model: null,
    prompt_version: SEED_MARKER,
    job_id: null,
    source: "footage",
    moment: "peak",
    render_path: renderPath,
    render_sha256: sha256,
    render_status: "rendered",
    render_note: null,
    duration_ms: duration,
    width: media?.width ?? FALLBACK_WIDTH,
    height: media?.height ?? FALLBACK_HEIGHT,
  };
}

/** The insert payload: the render columns are written afterwards through the data layer's setClipRender. */
export function insertableClipRow(row) {
  const RENDER_COLUMNS = ["render_path", "render_sha256", "render_status", "render_note", "duration_ms", "width", "height"];
  return Object.fromEntries(Object.entries(row).filter(([k]) => !RENDER_COLUMNS.includes(k)));
}

/**
 * The Clips tab's filter, copied verbatim from clipLibrary in
 * lib/data/launch.ts. The test asserts the two stay the same sentence.
 */
export function passesClipsTabFilter(c) {
  return c.render_status === "rendered" && !!c.render_path && !!c.render_sha256 && c.status !== "dismissed";
}

/** Deterministic source picking: sorted distinct fixture files, first `count`. */
export function pickSourceFiles(files, count) {
  const distinct = Array.from(new Set(files)).sort();
  if (distinct.length < count) {
    throw new Error(`only ${distinct.length} distinct clip-demo-*.mp4 fixture files were found; --count=${count} needs ${count}.`);
  }
  return distinct.slice(0, count);
}

/**
 * The whole write, as data. `existing` is the seed clips already in the
 * database; a dry run passes none and placeholder ids.
 *
 * @param {{ producerLabel: string, count: number, titleId: string, episodeId: string,
 *           adaptationId?: string | null,
 *           existing?: { rank: number, id?: string | null, rendered: boolean }[],
 *           sources: { file: string, bytes: number, sha256: string, media?: MediaShape | null }[],
 *           storagePath: (titleId: string, episodeId: string, filename: string) => string }} input
 */
export function planSeed({ producerLabel, count, titleId, episodeId, adaptationId = null, existing = [], sources, storagePath }) {
  const byRank = new Map(existing.map((c) => [c.rank, c]));
  const clips = [];
  for (let rank = 1; rank <= count; rank++) {
    const source = sources[rank - 1];
    const renderPath = storagePath(titleId, episodeId, seedFilename(rank));
    const current = byRank.get(rank);
    const action = !current ? "create" : current.rendered ? "keep" : "repair";
    clips.push({
      rank,
      action,
      clip_id: current?.id ?? null,
      source_file: source.file,
      source_bytes: source.bytes,
      render_path: renderPath,
      row: buildClipRow({ titleId, episodeId, adaptationId, rank, media: source.media, renderPath, sha256: source.sha256 }),
    });
  }
  return {
    producer_label: producerLabel,
    title: buildTitleRow("<producer_id>"),
    episode: buildEpisodeRow(titleId, clips[0]?.render_path ?? null),
    clips,
    uploads: clips.filter((c) => c.action !== "keep").map((c) => c.render_path),
    counts: {
      create: clips.filter((c) => c.action === "create").length,
      repair: clips.filter((c) => c.action === "repair").length,
      keep: clips.filter((c) => c.action === "keep").length,
    },
  };
}

/** The plan as plain lines. No value here is a token, a key or a URL. */
export function formatPlan(plan, { bucket, dryRun }) {
  const lines = [];
  lines.push(dryRun ? "Dry run — nothing was written and no network call was made." : "Plan");
  lines.push(`Producer      ${plan.producer_label}`);
  lines.push(`Data source   a live run refuses unless DATA_SOURCE=supabase`);
  lines.push(`Bucket        ${bucket}`);
  lines.push("");
  lines.push("core.titles");
  Object.entries(plan.title).forEach(([k, v]) => lines.push(`  ${k.padEnd(18)} ${format(v)}`));
  lines.push("core.episodes");
  Object.entries(plan.episode).forEach(([k, v]) => lines.push(`  ${k.padEnd(18)} ${format(v)}`));
  for (const clip of plan.clips) {
    lines.push(`studio.clips · rank ${clip.rank} (${clip.action})`);
    Object.entries(clip.row).forEach(([k, v]) => lines.push(`  ${k.padEnd(18)} ${format(v)}`));
    lines.push(`  ${"bytes from".padEnd(18)} ${clip.source_file} (${clip.source_bytes} bytes)`);
  }
  lines.push("");
  lines.push(
    `Would write   1 title, 1 episode, ${plan.counts.create} new clip rows, ${plan.counts.repair} repaired, ${plan.counts.keep} already finished`
  );
  lines.push(`Would upload  ${plan.uploads.length} object(s) to ${bucket}`);
  plan.uploads.forEach((p) => lines.push(`  ${p}`));
  return lines;
}

function format(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(format).join(", ")}]`;
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * The producer a --producer value names: an id, or an exact name_en / name_zh
 * (case-insensitive on the English name). Two matches are refused, never guessed.
 */
export function matchProducers(rows, value) {
  const needle = value.trim();
  if (isUuid(needle)) return rows.filter((p) => p.id === needle);
  const lower = needle.toLowerCase();
  return rows.filter((p) => (p.name_en ?? "").trim().toLowerCase() === lower || (p.name_zh ?? "").trim() === needle);
}

// ---- the run -----------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (line = "") => console.log(line);

function ffprobePath() {
  const configured = process.env.FFPROBE_PATH;
  if (configured && existsSync(configured)) return configured;
  if (existsSync(FFPROBE_WINGET)) return FFPROBE_WINGET;
  return null;
}

/** Real width/height/duration when ffprobe is installed, the fixture's known shape otherwise. */
function probeMedia(file) {
  const bin = ffprobePath();
  const fallback = { duration_ms: FALLBACK_DURATION_MS, width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT, probed: false };
  if (!bin) return fallback;
  const r = spawnSync(bin, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-show_entries", "format=duration", "-of", "json", file], {
    encoding: "utf8",
  });
  if (r.status !== 0 || !r.stdout) return fallback;
  try {
    const parsed = JSON.parse(r.stdout);
    const stream = parsed.streams?.[0] ?? {};
    const seconds = Number(parsed.format?.duration);
    const duration = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : FALLBACK_DURATION_MS;
    return {
      duration_ms: duration,
      width: Number.isInteger(stream.width) && stream.width > 0 ? stream.width : FALLBACK_WIDTH,
      height: Number.isInteger(stream.height) && stream.height > 0 ? stream.height : FALLBACK_HEIGHT,
      probed: true,
    };
  } catch {
    return fallback;
  }
}

/** Every rendered fixture clip under .uploads/, relative to the repo root. */
async function findFixtureClips() {
  const root = path.join(ROOT, ".uploads");
  const found = [];
  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (/^clip-demo-.*\.mp4$/.test(entry.name)) found.push(path.relative(ROOT, full).split(path.sep).join("/"));
    }
  }
  await walk(root, 0);
  return found;
}

/** The bytes, their SHA-256 and their shape, for each chosen fixture file. Local only. */
async function loadSources(count) {
  const picked = pickSourceFiles(await findFixtureClips(), count);
  const seen = new Set();
  const sources = [];
  for (const file of picked) {
    const abs = path.join(ROOT, file);
    const bytes = await readFile(abs);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (seen.has(sha256)) throw new Error(`two chosen fixture files have the same bytes (${file}); pick distinct files.`);
    seen.add(sha256);
    sources.push({ file, bytes, sha256, size: (await stat(abs)).size, media: probeMedia(abs) });
  }
  return sources.map((s) => ({ ...s, bytes_length: s.bytes.length, source_bytes: s.size }));
}

async function loadTs(rel) {
  return import(pathToFileURL(path.join(ROOT, rel)).href);
}

function loadEnv() {
  const require = createRequire(import.meta.url);
  const { loadEnvConfig } = require("@next/env");
  loadEnvConfig(ROOT, true, { info() {}, error() {} });
}

async function runDryRun(args) {
  const { storagePath, MEDIA_BUCKET } = await loadTs("lib/data/storage.ts");
  if (args.remove) {
    log("Dry run — nothing was deleted and no network call was made.");
    log(`Producer      ${args.producer}`);
    log(`Would delete  the title name_en="${SEED_TITLE_NAME_EN}" of that producer, its episode ${SEED_EPISODE_NUMBER},`);
    log(`              every clip on it (each carrying prompt_version="${SEED_MARKER}"), and each clip's`);
    log(`              object under ${MEDIA_BUCKET}/<title_id>/<episode_id>/seed-clip-<rank>.mp4.`);
    log("Would delete  nothing else: a title of another name, another producer's rows and any clip");
    log("              without the seed marker are left alone and the run refuses instead.");
    return 0;
  }
  const sources = await loadSources(args.count);
  const plan = planSeed({
    producerLabel: args.producer,
    count: args.count,
    titleId: "<title_id>",
    episodeId: "<episode_id>",
    adaptationId: null,
    existing: [],
    sources: sources.map((s) => ({ file: s.file, bytes: s.source_bytes, sha256: s.sha256, media: s.media })),
    storagePath,
  });
  formatPlan(plan, { bucket: MEDIA_BUCKET, dryRun: true }).forEach((l) => log(l));
  log("");
  log(`Media shape   ${sources[0]?.media.probed ? "read with ffprobe" : "ffprobe not found; fixed 1080x1920 and the fixture's 25 s duration"}`);
  log("Ids           <title_id> and <episode_id> are assigned by the database; a live run prints the real ones.");
  return 0;
}

// ---- live ---------------------------------------------------------------------

function service(supabaseServer) {
  return supabaseServer.createServiceSupabase();
}

async function resolveProducer(client, value) {
  const { data, error } = await client.schema("core").from("producers").select("id, name_zh, name_en").limit(2000);
  if (error) throw new Error(`could not read core.producers: ${error.message}`);
  const matches = matchProducers(data ?? [], value);
  if (!matches.length) throw new Error(`no producer matches --producer="${value}". Use its exact name_en, name_zh or id.`);
  if (matches.length > 1) {
    const names = matches.map((p) => `${p.name_en || p.name_zh} (${p.id})`).join(", ");
    throw new Error(`--producer="${value}" is ambiguous: ${names}. Pass the id.`);
  }
  return matches[0];
}

async function findSeedTitle(client, producerId) {
  const { data, error } = await client
    .schema("core")
    .from("titles")
    .select("id, external_id, name_en, name_zh, producer_id")
    .eq("producer_id", producerId)
    .eq("name_en", SEED_TITLE_NAME_EN);
  if (error) throw new Error(`could not read core.titles: ${error.message}`);
  if ((data ?? []).length > 1) throw new Error(`that producer has ${data.length} titles named "${SEED_TITLE_NAME_EN}"; resolve that by hand first.`);
  return data?.[0] ?? null;
}

async function ensureTitle(client, producer) {
  const found = await findSeedTitle(client, producer.id);
  if (found) return { title: found, created: false };
  const { data, error } = await client
    .schema("core")
    .from("titles")
    .insert(buildTitleRow(producer.id, producer.deliverables ?? {}))
    .select("id, external_id, name_en, name_zh, producer_id")
    .single();
  if (error) throw new Error(`could not create the seed title: ${error.message}`);
  // One adaptation per title, exactly as the data layer's createTitle does.
  const { error: adaptationError } = await client
    .schema("studio")
    .from("adaptations")
    .insert({ title_id: data.id, display_title_en: SEED_TITLE_NAME_EN })
    .select("id")
    .single();
  if (adaptationError) throw new Error(`could not create the title's adaptation: ${adaptationError.message}`);
  return { title: data, created: true };
}

async function adaptationOf(client, titleId) {
  const { data, error } = await client.schema("studio").from("adaptations").select("id").eq("title_id", titleId).limit(1).maybeSingle();
  if (error) throw new Error(`could not read studio.adaptations: ${error.message}`);
  return data?.id ?? null;
}

async function ensureEpisode(client, titleId) {
  const { data, error } = await client
    .schema("core")
    .from("episodes")
    .select("id, external_id, number, video_path")
    .eq("title_id", titleId)
    .eq("number", SEED_EPISODE_NUMBER)
    .maybeSingle();
  if (error) throw new Error(`could not read core.episodes: ${error.message}`);
  if (data) return { episode: data, created: false };
  const inserted = await client
    .schema("core")
    .from("episodes")
    .insert(buildEpisodeRow(titleId, null))
    .select("id, external_id, number, video_path")
    .single();
  if (inserted.error) throw new Error(`could not create the seed episode: ${inserted.error.message}`);
  return { episode: inserted.data, created: true };
}

async function runLive(args) {
  loadEnv();
  const { dataSource } = await loadTs("lib/data-source.ts");
  if (dataSource() !== "supabase") {
    console.error("Refused: DATA_SOURCE does not resolve to supabase. This script only writes to the shared project.");
    return 1;
  }
  const [{ putStoredBytes, storagePath, MEDIA_BUCKET }, supabaseServer, { systemSession }, { getData }] = await Promise.all([
    loadTs("lib/data/storage.ts"),
    loadTs("lib/supabase/server.ts"),
    loadTs("lib/auth.ts"),
    loadTs("lib/data/index.ts"),
  ]);
  const client = service(supabaseServer);
  const session = systemSession();
  const data = getData();
  const producer = await resolveProducer(client, args.producer);
  const label = `${producer.name_en || producer.name_zh} (${producer.id})`;

  if (args.remove) return removeSeed({ client, data, session, producer, label, MEDIA_BUCKET });

  const { title, created: titleCreated } = await ensureTitle(client, producer);
  const adaptationId = await adaptationOf(client, title.id);
  const { episode, created: episodeCreated } = await ensureEpisode(client, title.id);

  const existingClips = (await data.listEpisodeClips(session, title.id)).filter((c) => c.episode_id === episode.id);
  const foreign = existingClips.filter((c) => c.prompt_version !== SEED_MARKER);
  if (foreign.length) {
    console.error(`Refused: the seed episode carries ${foreign.length} clip(s) this script did not write. Nothing was changed.`);
    return 1;
  }
  const sources = await loadSources(args.count);
  const plan = planSeed({
    producerLabel: label,
    count: args.count,
    titleId: title.id,
    episodeId: episode.id,
    adaptationId,
    existing: existingClips.map((c) => ({ rank: c.rank, id: c.id, rendered: c.render_status === "rendered" && !!c.render_path && !!c.render_sha256 })),
    sources: sources.map((s) => ({ file: s.file, bytes: s.source_bytes, sha256: s.sha256, media: s.media })),
    storagePath,
  });

  // The episode needs a stored video before a clip row may exist (guard_timecodes, migration 0010).
  if (!episode.video_path) {
    const first = plan.clips[0];
    const bytes = sources[0].bytes;
    await putStoredBytes(first.render_path, bytes, "video/mp4");
    const { error } = await client.schema("core").from("episodes").update({ video_path: first.render_path }).eq("id", episode.id);
    if (error) throw new Error(`could not attach the episode video: ${error.message}`);
    episode.video_path = first.render_path;
  }

  let uploaded = 0;
  let createdRows = 0;
  let repairedRows = 0;
  for (const clip of plan.clips) {
    if (clip.action === "keep") continue;
    const source = sources[clip.rank - 1];
    const stored = await putStoredBytes(clip.render_path, source.bytes, "video/mp4");
    if (stored !== clip.render_path) throw new Error(`storage wrote ${stored}, expected ${clip.render_path}`);
    uploaded++;
    let clipId = clip.clip_id;
    if (clip.action === "create") {
      const { data: row, error } = await client.schema("studio").from("clips").insert(insertableClipRow(clip.row)).select("id").single();
      if (error) throw new Error(`could not create clip rank ${clip.rank}: ${error.message}`);
      clipId = row.id;
      createdRows++;
    } else {
      repairedRows++;
    }
    // The render is recorded through the data layer, which validates the hash shape.
    const saved = await data.setClipRender(session, clipId, {
      render_status: "rendered",
      render_path: clip.render_path,
      render_sha256: clip.row.render_sha256,
      render_note: null,
      duration_ms: clip.row.duration_ms,
      width: clip.row.width,
      height: clip.row.height,
    });
    if (!passesClipsTabFilter(saved)) throw new Error(`clip rank ${clip.rank} was saved but does not pass the Clips tab's filter.`);
  }

  log(`Seeded ${plan.clips.length} clip(s) for ${label}.`);
  log(`Title         ${title.external_id} ${title.id} "${SEED_TITLE_NAME_EN}" (${titleCreated ? "created" : "reused"})`);
  log(`Episode       ${episode.external_id} ${episode.id} number ${SEED_EPISODE_NUMBER} (${episodeCreated ? "created" : "reused"})`);
  log(`Clips         ${createdRows} created, ${repairedRows} repaired, ${plan.counts.keep} already finished`);
  log(`Storage       ${uploaded} object(s) written to ${MEDIA_BUCKET} under ${title.id}/${episode.id}/`);
  log(`Clips tab     all ${plan.clips.length} rows are rendered, hashed and not dismissed.`);
  return 0;
}

async function removeSeed({ client, data, session, producer, label, MEDIA_BUCKET }) {
  const title = await findSeedTitle(client, producer.id);
  if (!title) {
    log(`Nothing to remove: ${label} has no title named "${SEED_TITLE_NAME_EN}".`);
    return 0;
  }
  const { data: episodes, error: episodeError } = await client.schema("core").from("episodes").select("id, external_id, number, video_path").eq("title_id", title.id);
  if (episodeError) throw new Error(`could not read core.episodes: ${episodeError.message}`);
  const clips = await data.listEpisodeClips(session, title.id);
  const foreign = clips.filter((c) => c.prompt_version !== SEED_MARKER);
  if (foreign.length) {
    console.error(`Refused: ${foreign.length} clip(s) on that title were not written by this script. Nothing was deleted.`);
    return 1;
  }
  const paths = Array.from(
    new Set([...clips.map((c) => c.render_path).filter(Boolean), ...(episodes ?? []).map((e) => e.video_path).filter(Boolean)])
  );
  if (paths.length) {
    const { error } = await client.storage.from(MEDIA_BUCKET).remove(paths);
    if (error) throw new Error(`could not delete storage objects: ${error.message}`);
  }
  if (clips.length) {
    const { error } = await client.schema("studio").from("clips").delete().eq("title_id", title.id);
    if (error) throw new Error(`could not delete the seed clips: ${error.message}`);
  }
  for (const episode of episodes ?? []) {
    const { error } = await client.schema("core").from("episodes").delete().eq("id", episode.id);
    if (error) throw new Error(`could not delete episode ${episode.number}: ${error.message}`);
  }
  const { error: titleError } = await client.schema("core").from("titles").delete().eq("id", title.id);
  if (titleError) throw new Error(`could not delete the seed title: ${titleError.message}`);

  log(`Removed the seed data of ${label}.`);
  log(`Clips         ${clips.length} row(s) deleted`);
  log(`Episodes      ${(episodes ?? []).length} row(s) deleted`);
  log(`Title         ${title.id} "${SEED_TITLE_NAME_EN}" deleted`);
  log(`Storage       ${paths.length} object(s) deleted from ${MEDIA_BUCKET}`);
  paths.forEach((p) => log(`  ${p}`));
  return 0;
}

// ---- entry point ---------------------------------------------------------------

function isEntrypoint() {
  const entry = process.argv[1];
  return !!entry && pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

/**
 * The TypeScript helpers (lib/data/storage.ts and the data layer) are the
 * app's own, so the process re-runs itself once under tsx's loader. Argument
 * validation happens first, so a refusal never reaches this.
 */
function reexecUnderTsx() {
  const r = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, STUDIO_SEED_TSX: "1" },
  });
  return r.status ?? 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.errors.length) {
    args.errors.forEach((e) => console.error(e));
    console.error("");
    USAGE.forEach((l) => console.error(l));
    return 1;
  }
  if (process.env.STUDIO_SEED_TSX !== "1") return reexecUnderTsx();
  return args.dryRun ? runDryRun(args) : runLive(args);
}

if (isEntrypoint()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
