// The pure parts of scripts/seed-test-clips.mjs (docs/launch-ux-round-2.md §4):
// argument parsing and its refusals, the hook cycle, the seed marker, the row
// builders against the not-null columns and enums of 0001_init.sql / 0010, the
// dry-run planner, and — the point of the whole script — that the clip rows it
// builds pass the Clips tab's filter in lib/data/launch.ts.
//
// Nothing here writes, reads env or touches the network: the script exports
// these functions and only runs itself when it is the entry point.

import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { ANGLES } from "@/lib/angles";
import {
  CYCLE_SUFFIXES,
  DEFAULT_COUNT,
  FALLBACK_HEIGHT,
  FALLBACK_WIDTH,
  HOOKS,
  MAX_COUNT,
  SEED_EPISODE_NUMBER,
  SEED_MARKER,
  SEED_TITLE_NAME_EN,
  SEED_TITLE_NAME_ZH,
  WHYS,
  buildClipRow,
  buildEpisodeRow,
  buildTitleRow,
  hookForRank,
  insertableClipRow,
  isUuid,
  matchProducers,
  parseArgs,
  passesClipsTabFilter,
  pickSourceFiles,
  planSeed,
  seedFilename,
  whyForRank,
} from "../scripts/seed-test-clips.mjs";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** The storage helper's own shape, so the planner is exercised with the real path rule. */
const storagePath = (titleId: string, episodeId: string, filename: string) => `${titleId}/${episodeId}/${filename}`;

const media = { duration_ms: 25_000, width: 1080, height: 1920 };
const source = (n: number) => ({
  file: `.uploads/fixture/clip-demo-${n}.mp4`,
  bytes: 1000 + n,
  sha256: String(n).repeat(64).slice(0, 64),
  media,
});
const sources = (n: number) => Array.from({ length: n }, (_, i) => source(i + 1));

const clipRow = (rank: number) =>
  buildClipRow({
    titleId: "t-1",
    episodeId: "e-1",
    adaptationId: "a-1",
    rank,
    media,
    renderPath: storagePath("t-1", "e-1", seedFilename(rank)),
    sha256: "a".repeat(64),
  });

// ---- arguments ---------------------------------------------------------------

test("seed args: nothing runs without --live or --dry-run", () => {
  const args = parseArgs(["--producer=Xinghai Pictures"]);
  assert.ok(args.errors.some((e: string) => /Pass --live/.test(e)));
});

test("seed args: --producer is required", () => {
  assert.ok(parseArgs(["--dry-run"]).errors.some((e: string) => /--producer/.test(e)));
  assert.ok(parseArgs(["--dry-run", "--producer=   "]).errors.some((e: string) => /--producer/.test(e)));
});

test("seed args: a valid dry run parses with the default count", () => {
  const args = parseArgs(["--dry-run", "--producer=Xinghai Pictures"]);
  assert.deepEqual(args.errors, []);
  assert.equal(args.count, DEFAULT_COUNT);
  assert.equal(args.dryRun, true);
  assert.equal(args.live, false);
  assert.equal(args.producer, "Xinghai Pictures");
});

test("seed args: --count is a whole number of 1..20", () => {
  assert.equal(parseArgs(["--live", "--producer=p", "--count=20"]).count, MAX_COUNT);
  assert.ok(parseArgs(["--live", "--producer=p", "--count=21"]).errors.some((e: string) => /may not exceed 20/.test(e)));
  assert.ok(parseArgs(["--live", "--producer=p", "--count=0"]).errors.length > 0);
  assert.ok(parseArgs(["--live", "--producer=p", "--count=2.5"]).errors.length > 0);
  assert.ok(parseArgs(["--live", "--producer=p", "--count=six"]).errors.length > 0);
});

test("seed args: --remove needs --live, and an unknown flag is refused", () => {
  assert.ok(parseArgs(["--remove", "--producer=p"]).errors.some((e: string) => /needs --live/.test(e)));
  assert.deepEqual(parseArgs(["--live", "--remove", "--producer=p"]).errors, []);
  assert.ok(parseArgs(["--live", "--producer=p", "--force"]).errors.some((e: string) => /Unknown flag --force/.test(e)));
});

test("seed args: the usage says what it refuses and carries no secret", () => {
  const usage = parseArgs([]).usage.join("\n");
  assert.match(usage, /--live/);
  assert.match(usage, /DATA_SOURCE=supabase/);
  assert.match(usage, /never opens \.tokens\.json and never calls Meta or TikTok/);
  assert.doesNotMatch(usage, /eyJ|sk-[A-Za-z0-9]|SERVICE_ROLE|ANON_KEY/i, "the usage must never carry a key or a token value");
});

// ---- producer resolution -----------------------------------------------------

test("seed producer: id, name_en (case-insensitive) and name_zh all resolve; two matches are ambiguous", () => {
  const rows = [
    { id: "11111111-1111-4111-8111-111111111111", name_en: "Xinghai Pictures", name_zh: "星海影业" },
    { id: "22222222-2222-4222-8222-222222222222", name_en: "Xinghai Pictures", name_zh: "星海传媒" },
    { id: "33333333-3333-4333-8333-333333333333", name_en: null, name_zh: "别的公司" },
  ];
  assert.equal(isUuid("11111111-1111-4111-8111-111111111111"), true);
  assert.equal(isUuid("Xinghai Pictures"), false);
  assert.equal(matchProducers(rows, "11111111-1111-4111-8111-111111111111").length, 1);
  assert.equal(matchProducers(rows, "xinghai pictures").length, 2, "an ambiguous name must not resolve to one row");
  assert.equal(matchProducers(rows, "星海传媒")[0].id, rows[1].id);
  assert.equal(matchProducers(rows, "别的公司").length, 1);
  assert.equal(matchProducers(rows, "nobody").length, 0);
});

// ---- hooks and the marker ----------------------------------------------------

test("seed hooks: distinct for every rank up to the maximum and they read like hooks", () => {
  const hooks = Array.from({ length: MAX_COUNT }, (_, i) => hookForRank(i + 1));
  assert.equal(new Set(hooks).size, MAX_COUNT, "hook_en must be distinct on every clip");
  for (const hook of hooks) {
    assert.ok(hook.length > 30, hook);
    assert.doesNotMatch(hook, /^(clip|seed|rank)[-_ ]?\d/i, `${hook} reads like an id`);
    assert.doesNotMatch(hook, /_/, `${hook} reads like an id`);
    assert.match(hook, /[.?!]/, `${hook} is not a sentence`);
  }
  assert.equal(HOOKS.length, 8);
  assert.equal(hookForRank(1), HOOKS[0]);
  assert.equal(hookForRank(9), `${HOOKS[0]}${CYCLE_SUFFIXES[1]}`, "the ninth clip cycles back to the first hook with a new tail");
  assert.equal(hookForRank(17), `${HOOKS[0]}${CYCLE_SUFFIXES[2]}`);
});

test("seed hooks: why_en and why_zh are filled for every rank", () => {
  assert.equal(WHYS.length, HOOKS.length);
  for (let rank = 1; rank <= MAX_COUNT; rank++) {
    const { why_en, why_zh } = whyForRank(rank);
    assert.ok(why_en.trim().length > 20, `rank ${rank} why_en`);
    assert.ok(why_zh.trim().length > 6, `rank ${rank} why_zh`);
    assert.match(why_zh, /[一-鿿]/, `rank ${rank} why_zh must be Chinese`);
  }
});

test("seed marker: the recognisable external marker is on the clip row and named in the title's notes", () => {
  assert.equal(clipRow(3).prompt_version, SEED_MARKER);
  assert.match(buildTitleRow("p-1").notes, new RegExp(SEED_MARKER.replace("/", "\\/")));
  assert.match(buildTitleRow("p-1").notes, /seed-test-clips\.mjs/);
  assert.equal(seedFilename(4), "seed-clip-4.mp4");
});

// ---- the rows against the schema ---------------------------------------------

/** Columns of a create-table block that are `not null` with no default: the minimum viable row. */
function requiredColumns(sql: string, table: string): string[] {
  const block = sql.split(`create table ${table} (`)[1]?.split("\n);")[0] ?? "";
  assert.ok(block, `${table} not found in the migration`);
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /not null/.test(l) && !/default/.test(l) && !/^(constraint|unique|primary|check)/.test(l))
    .map((l) => l.split(/\s+/)[0]);
}

test("seed rows: the clip row fills every not-null column of studio.clips that has no default", () => {
  const required = requiredColumns(read("supabase/migrations/0001_init.sql"), "studio.clips");
  assert.deepEqual(required.sort(), ["end_ms", "episode_id", "hook_en", "rank", "start_ms", "title_id", "why_en", "why_zh"]);
  const row = clipRow(1) as Record<string, unknown>;
  for (const column of required) {
    assert.ok(column in row, `studio.clips.${column} is missing from the built row`);
    assert.notEqual(row[column], null, `studio.clips.${column} may not be null`);
  }
});

test("seed rows: the title and episode rows fill every not-null column with no default", () => {
  const sql = read("supabase/migrations/0001_init.sql");
  const title = buildTitleRow("p-1") as Record<string, unknown>;
  for (const column of requiredColumns(sql, "core.titles")) {
    assert.ok(column in title && title[column] !== null, `core.titles.${column}`);
  }
  const episode = buildEpisodeRow("t-1", null) as Record<string, unknown>;
  for (const column of requiredColumns(sql, "core.episodes")) {
    assert.ok(column in episode && episode[column] !== null, `core.episodes.${column}`);
  }
  assert.equal(title.name_en, SEED_TITLE_NAME_EN);
  assert.equal(title.name_zh, SEED_TITLE_NAME_ZH);
  assert.equal(episode.number, SEED_EPISODE_NUMBER);
  assert.equal(episode.has_timecodes, false);
});

test("seed rows: every enum and check value is one the database accepts", () => {
  const sql = read("supabase/migrations/0001_init.sql");
  const titleStatuses = sql.match(/create type core\.title_status\s+as enum \(([^)]*)\)/)![1];
  const clipStatuses = sql.match(/create type studio\.clip_status\s+as enum \(([^)]*)\)/)![1];
  const row = clipRow(1);
  assert.ok(titleStatuses.includes(`'${buildTitleRow("p-1").status}'`));
  assert.ok(clipStatuses.includes(`'${row.status}'`));
  assert.notEqual(row.status, "dismissed", "a dismissed clip is hidden from the Clips tab");
  // migration 0010: source, moment and render_status are text columns with check constraints.
  assert.ok(["script", "footage"].includes(row.source));
  assert.ok(["opening", "peak"].includes(row.moment));
  assert.ok(["pending", "rendered", "failed"].includes(row.render_status));
  assert.equal(ANGLES[row.angle as keyof typeof ANGLES].status, "active", "the seed angle must be an active one");
});

test("seed rows: the window is the whole file and the shape is 9:16", () => {
  const row = clipRow(2);
  assert.equal(row.start_ms, 0);
  assert.equal(row.end_ms, media.duration_ms);
  assert.equal(row.duration_ms, media.duration_ms);
  assert.equal(row.cut_length_s, 25);
  assert.ok(row.height > row.width, "a clip for TikTok and Reels is vertical");
  const noProbe = buildClipRow({ titleId: "t", episodeId: "e", rank: 1, media: null, renderPath: "t/e/x.mp4", sha256: "b".repeat(64) });
  assert.equal(noProbe.width, FALLBACK_WIDTH, "without ffprobe the fixture's known shape is used");
  assert.equal(noProbe.height, FALLBACK_HEIGHT);
  assert.equal(noProbe.end_ms, noProbe.duration_ms);
});

test("seed rows: the insert payload leaves the render columns to setClipRender", () => {
  const insertable = insertableClipRow(clipRow(1)) as Record<string, unknown>;
  for (const column of ["render_path", "render_sha256", "render_status", "render_note", "duration_ms", "width", "height"]) {
    assert.equal(column in insertable, false, `${column} is written by the data layer, not the insert`);
  }
  for (const column of ["title_id", "episode_id", "rank", "start_ms", "end_ms", "hook_en", "why_en", "why_zh", "prompt_version"]) {
    assert.ok(column in insertable, column);
  }
});

// ---- the Clips tab's filter ---------------------------------------------------

test("seed clips: every built row passes the Clips tab's filter", () => {
  for (let rank = 1; rank <= MAX_COUNT; rank++) {
    assert.equal(passesClipsTabFilter(clipRow(rank)), true, `rank ${rank}`);
  }
});

test("seed clips: the filter is the same sentence lib/data/launch.ts uses", () => {
  const launch = read("lib/data/launch.ts");
  assert.match(
    launch,
    /c\.render_status === "rendered" && c\.render_path && c\.render_sha256 && c\.status !== "dismissed"/,
    "clipLibrary's filter changed; update passesClipsTabFilter in scripts/seed-test-clips.mjs"
  );
  // The same predicate, refusing each way a clip can fall out of the tab.
  const base = clipRow(1);
  assert.equal(passesClipsTabFilter({ ...base, render_status: "pending" }), false);
  assert.equal(passesClipsTabFilter({ ...base, render_status: "failed" }), false);
  assert.equal(passesClipsTabFilter({ ...base, render_path: null }), false);
  assert.equal(passesClipsTabFilter({ ...base, render_sha256: null }), false);
  assert.equal(passesClipsTabFilter({ ...base, status: "dismissed" }), false);
  assert.equal(passesClipsTabFilter({ ...base, status: "suggested" }), true);
});

// ---- sources and the planner --------------------------------------------------

test("seed sources: distinct files, deterministic order, and a refusal when there are too few", () => {
  const files = [".uploads/b/clip-demo-2.mp4", ".uploads/a/clip-demo-1.mp4", ".uploads/a/clip-demo-1.mp4", ".uploads/c/clip-demo-3.mp4"];
  assert.deepEqual(pickSourceFiles(files, 3), [".uploads/a/clip-demo-1.mp4", ".uploads/b/clip-demo-2.mp4", ".uploads/c/clip-demo-3.mp4"]);
  assert.deepEqual(pickSourceFiles(files, 2), pickSourceFiles(files, 3).slice(0, 2));
  assert.throws(() => pickSourceFiles(files, 6), /only 3 distinct/);
});

test("seed planner: a first run plans one title, one episode and count clips, each on its own path", () => {
  const plan = planSeed({ producerLabel: "Xinghai Pictures", count: 6, titleId: "<title_id>", episodeId: "<episode_id>", sources: sources(6), storagePath });
  assert.equal(plan.clips.length, 6);
  assert.deepEqual(plan.counts, { create: 6, repair: 0, keep: 0 });
  assert.deepEqual(
    plan.clips.map((c: { render_path: string }) => c.render_path),
    Array.from({ length: 6 }, (_, i) => `<title_id>/<episode_id>/seed-clip-${i + 1}.mp4`)
  );
  assert.equal(new Set(plan.clips.map((c: { source_file: string }) => c.source_file)).size, 6, "each clip uses a distinct fixture file");
  assert.equal(plan.episode.video_path, plan.clips[0].render_path, "the episode needs a stored video before a clip row may exist");
  assert.deepEqual(plan.uploads, plan.clips.map((c: { render_path: string }) => c.render_path));
  assert.equal(new Set(plan.clips.map((c: { row: { hook_en: string } }) => c.row.hook_en)).size, 6);
  assert.deepEqual(plan.clips.map((c: { row: { rank: number } }) => c.row.rank), [1, 2, 3, 4, 5, 6]);
  assert.ok(plan.clips.every((c: { row: Record<string, unknown> }) => passesClipsTabFilter(c.row)));
});

test("seed planner: a re-run tops up, keeps what is finished and repairs what is not", () => {
  const existing = [
    { rank: 1, id: "c1", rendered: true },
    { rank: 2, id: "c2", rendered: false },
  ];
  const plan = planSeed({ producerLabel: "p", count: 4, titleId: "t", episodeId: "e", existing, sources: sources(4), storagePath });
  assert.deepEqual(
    plan.clips.map((c: { action: string }) => c.action),
    ["keep", "repair", "create", "create"]
  );
  assert.deepEqual(plan.counts, { create: 2, repair: 1, keep: 1 });
  assert.deepEqual(plan.uploads, ["t/e/seed-clip-2.mp4", "t/e/seed-clip-3.mp4", "t/e/seed-clip-4.mp4"]);
  assert.equal(plan.clips[1].clip_id, "c2", "a repair updates the row that is already there");
  assert.equal(plan.clips[2].clip_id, null);
});

test("seed planner: the plan carries the sha256 of the exact bytes it would upload", () => {
  const plan = planSeed({ producerLabel: "p", count: 2, titleId: "t", episodeId: "e", sources: sources(2), storagePath });
  assert.equal(plan.clips[0].row.render_sha256, source(1).sha256);
  assert.equal(plan.clips[1].row.render_sha256, source(2).sha256);
  assert.notEqual(plan.clips[0].row.render_sha256, plan.clips[1].row.render_sha256);
});
