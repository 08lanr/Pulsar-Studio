// Quick hook ads (decision 2026-10-01): the pick (a 2-3 s bait from the end
// of a strong clip, then a scene that leads up to it — never through the
// bait's own frames, never past the spoiler line — every bait × scene × text,
// coded H#-B#-X#), the words (wrapping, the offered texts), the drawn text in
// the ffmpeg line, and the whole build on the fixture film with the real
// ffmpeg: the text on the first frames and gone after, a quick_hook row per
// variant with its code in the file name, in the library and kept out of the
// 60-second ad's panel. The ffmpeg tests are skipped on a machine without it.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FIXTURE_PRODUCER_ID, fixtureSession, type Session } from "@/lib/auth";
import { AD_FORMAT_CHOICES, AD_FORMATS, isAdFormat } from "@/lib/ad-formats";
import type { MontageEpisode } from "@/lib/clips/montage";
import { montageArgs, overlayFilter, overlayFont } from "@/lib/clips/montage-render";
import { montageStatus } from "@/lib/clips/montage-run";
import { baitOf, isQuickHook, overlayIssue, planQuickHooks, quickHookCode, quickHookFile, suggestOverlayTexts, wrapOverlay, type QuickHookClip, type QuickHookInput } from "@/lib/clips/quick-hook";
import { quickHooksStatus, startQuickHooks } from "@/lib/clips/quick-hook-run";
import { getData } from "@/lib/data";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { resetLaunchFixture } from "@/lib/data/launch";
import { resolveUploadPath, uploadsDir } from "@/lib/data/storage";
import { ffprobeBin, importFilm, resetImportRegistry, type VideoFacts } from "@/lib/film-import/import";
import type { AdRules, MontagePiece } from "@/lib/types";
import { producer, staff } from "./seed-minute";

const FIXTURE_ROOT = path.join(process.cwd(), "tests", "fixtures", "workspace");
const FILM = "low-quality/fixture-film";
const temps: string[] = [];

beforeEach(() => {
  resetFixtureStore();
  resetLaunchFixture();
  resetImportRegistry();
  const media = mkdtempSync(path.join(tmpdir(), "studio-quick-hook-"));
  temps.push(media);
  process.env.STUDIO_LOCAL_MEDIA_DIR = media;
  process.env.STUDIO_WORK_DIR = path.join(media, "work");
  process.env.PROMO_RENDER = "off";
});
afterEach(() => {
  resetFixtureStore();
  resetImportRegistry();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.STUDIO_LOCAL_MEDIA_DIR;
  delete process.env.STUDIO_WORK_DIR;
});

// ---- the pick ------------------------------------------------------------------------------------------

/** A line every 4 s: 1-3.5 s, 5-7.5 s, ... */
const cuesOf = (ms: number) => Array.from({ length: Math.floor(ms / 4_000) }, (_, i) => ({ start_ms: i * 4_000 + 1_000, end_ms: i * 4_000 + 3_500 }));
const ep = (n: number, extra: Partial<MontageEpisode> = {}): MontageEpisode => ({ id: `e${n}`, number: n, has_video: true, duration_ms: 120_000, film_start_ms: (n - 1) * 120_000, cues: cuesOf(120_000), ...extra });
let seq = 0;
const clip = (n: number, rank: number, start: number, end: number, extra: Partial<QuickHookClip> = {}): QuickHookClip => ({
  id: `c${n}-${rank}-${++seq}`, external_id: `clip_${n}_${rank}`, episode_id: `e${n}`, rank, start_ms: start, end_ms: end,
  hook_en: `Hook of ${n}.${rank}`, status: "suggested", moment: "peak", source: "script", opening_text_en: null, ...extra,
});
const noRules: AdRules = { spoiler_from_s: null, exclusions: [] };
const overlaps = (a: MontagePiece, b: MontagePiece) => a.episode_id === b.episode_id && a.start_ms < b.end_ms && b.start_ms < a.end_ms;

/** Ten episodes, two 25-second clips each (rank 1 at 10 s, rank 2 at 60 s), the opening on episode 1. */
function tenEpisodes(rules: AdRules | null = noRules): QuickHookInput {
  const episodes = Array.from({ length: 10 }, (_, i) => ep(i + 1));
  const clips = episodes.flatMap((e) => [
    clip(e.number, 1, 10_000, 35_000, e.number === 1 ? { moment: "opening", hook_en: "She signs the contract without reading it." } : {}),
    clip(e.number, 2, 60_000, 85_000),
  ]);
  return { episodes, clips, rules };
}

test("the bait: the window's last spoken line with a quarter second either side; its last 3 s without lines; never shorter than 1.8 s", () => {
  const e = ep(1);
  // Lines at 29-31.5 s and 33-35.5 s: the last one inside 10-35 s is 29-31.5 s.
  assert.deepEqual(baitOf({ start: 10_000, end: 35_000, episode: e }), { start: 28_750, end: 31_750 });
  assert.deepEqual(baitOf({ start: 10_000, end: 35_000, episode: { cues: [] } }), { start: 32_000, end: 35_000 });
  // A long line keeps its last 3.5 s.
  assert.deepEqual(baitOf({ start: 0, end: 20_000, episode: { cues: [{ start_ms: 5_000, end_ms: 15_000 }] } }), { start: 11_750, end: 15_250 });
  assert.equal(baitOf({ start: 0, end: 1_000, episode: { cues: [] } }), null);
});

test("the pick: up to four baits (one per episode first) × up to three scenes × every text, the bait's own lead-up first, never a frame twice", () => {
  const input = tenEpisodes();
  const plan = planQuickHooks(input, ["She was the maid.", "He didn't know she owned the company."]);
  assert.ok(plan.ok, JSON.stringify(plan));
  if (!plan.ok) return;
  assert.equal(plan.hooks, 4);
  assert.equal(plan.texts, 2);
  assert.equal(plan.variants.length, 24, "4 baits × 3 scenes × 2 texts");
  assert.equal(new Set(plan.variants.map((v) => v.code)).size, 24);
  assert.equal(new Set(plan.variants.map((v) => v.key)).size, 24);
  // Without a spoiler line the last fifth (episodes 9-10) stays out; the baits are rank-1 clips, later episodes first.
  const baits = [...new Map(plan.variants.map((v) => [v.hook, v.pieces[0]])).values()];
  assert.deepEqual(baits.map((b) => b.episode_number), [8, 7, 6, 5]);
  for (const v of plan.variants) {
    const [bait, body] = v.pieces;
    assert.deepEqual([bait.role, body.role], ["hook", "scene"]);
    assert.ok(bait.end_ms - bait.start_ms >= 1_800 && bait.end_ms - bait.start_ms <= 3_500, `${v.code} bait ${bait.end_ms - bait.start_ms} ms`);
    assert.ok(body.end_ms - body.start_ms >= 10_000 && body.end_ms - body.start_ms <= 40_000, `${v.code} body`);
    assert.ok(v.duration_ms <= 45_000);
    assert.ok(!overlaps(bait, body), `${v.code}: the scene never plays the bait's frames`);
    assert.ok(v.pieces.every((p) => p.episode_number <= 8));
    assert.equal(v.overlay_ms, bait.end_ms - bait.start_ms + 2_500);
    assert.match(v.code, /^H\d-B\d+-X[12]$/);
  }
  // H1's first scene is its own clip's lead-up, cut before the bait (the flash-forward).
  const h1 = plan.variants.find((v) => v.code.startsWith("H1-") && v.text === 1)!;
  assert.equal(h1.pieces[1].clip_id, h1.pieces[0].clip_id);
  assert.ok(h1.pieces[1].end_ms <= h1.pieces[0].start_ms);
  // The other scenes: the opening first; a scene keeps its code across baits.
  const scenes = plan.variants.filter((v) => v.text === 1 && v.pieces[1].clip_id !== v.pieces[0].clip_id);
  assert.equal(scenes[0].pieces[1].episode_number, 1);
  const opening = scenes.filter((v) => v.pieces[1].episode_number === 1 && v.pieces[1].start_ms === scenes[0].pieces[1].start_ms);
  assert.equal(new Set(opening.map((v) => v.body)).size, 1);
  // The ad text is the bait clip's hook; the drawn text is the person's.
  assert.equal(h1.ad_text, "Hook of 8.1");
  assert.equal(h1.overlay, "She was the maid.");
  // The same input is the same plan.
  assert.deepEqual(planQuickHooks(input, ["She was the maid.", "He didn't know she owned the company."]), plan);
});

test("the spoiler line holds back what comes after it; a text that does not fit is left out; refusals in words", () => {
  const rules: AdRules = { spoiler_from_s: 4 * 120, exclusions: [] }; // episode 5 on is a spoiler
  const plan = planQuickHooks(tenEpisodes(rules), ["One", "x".repeat(80)]);
  assert.ok(plan.ok);
  if (plan.ok) {
    assert.ok(plan.variants.every((v) => v.pieces.every((p) => p.episode_number <= 4)));
    assert.equal(plan.texts, 1);
  }
  const none = planQuickHooks({ episodes: [ep(1)], clips: [], rules: noRules }, ["Text"]);
  assert.deepEqual(none.ok ? null : [none.code, none.usable], ["no_clips", 0]);
  const noText = planQuickHooks(tenEpisodes(), ["  ", "x".repeat(90)]);
  assert.equal(noText.ok ? null : noText.code, "no_text");
  // One short clip cannot hold a 10 s scene beside its bait.
  const short = planQuickHooks({ episodes: [ep(1)], clips: [clip(1, 1, 0, 6_000)], rules: noRules }, ["Text"]);
  assert.equal(short.ok ? null : short.code, "too_few");
  // Dismissed clips, other joined ads and uploaded ads are not moments.
  const skipped = planQuickHooks({ episodes: [ep(1)], clips: [clip(1, 1, 0, 30_000, { status: "dismissed" }), clip(1, 2, 0, 30_000, { moment: "montage" }), clip(1, 3, 0, 30_000, { source: "upload" })], rules: noRules }, ["Text"]);
  assert.equal(skipped.ok ? null : skipped.code, "no_clips");
});

test("the words: wrapping in three lines of about 24 characters, the issues, the offered texts, the code in the file name", () => {
  assert.deepEqual(wrapOverlay("She was the maid. He didn't know she owned the company."), ["She was the maid. He", "didn't know she owned", "the company."]);
  assert.equal(wrapOverlay("   "), null);
  assert.equal(wrapOverlay("a".repeat(25)), null);
  assert.equal(overlayIssue("Fine"), null);
  assert.match(overlayIssue("x ".repeat(40))!, /characters/);
  assert.match(overlayIssue("")!, /write/);
  const clips = [clip(1, 2, 0, 1, { opening_text_en: "Second opening", hook_en: "Second hook" }), clip(1, 1, 0, 1, { opening_text_en: "First opening", hook_en: "First hook" }), clip(1, 3, 0, 1, { opening_text_en: "first OPENING" })];
  assert.deepEqual(suggestOverlayTexts(clips), ["First opening", "Second opening", "First hook"]);
  const file = quickHookFile("t1", "H2-B1-X3", "0123456789abcdef");
  assert.equal(file, "t1/quick-hooks/quick-hook-H2-B1-X3-0123456789abcdef.mp4");
  assert.equal(quickHookCode(file), "H2-B1-X3");
  assert.equal(quickHookCode("t1/montage/ad60-0123456789abcdef-aaaaaaaa.mp4"), null);
  assert.equal(isQuickHook({ moment: "montage", ad_format: "quick_hook" }), true);
  assert.equal(isQuickHook({ moment: "montage", ad_format: null }), false);
});

test("the ad types: the quick hook ad is a type; the hook ad stays valid for the ads filed under it but is no longer offered", () => {
  assert.ok(isAdFormat("quick_hook"));
  assert.ok(isAdFormat("hook_ad"));
  assert.ok(AD_FORMATS.includes("hook_ad"));
  assert.deepEqual([...AD_FORMAT_CHOICES], ["narration_trailer", "direct_cuts_trailer", "clip", "quick_hook"]);
});

test("the drawn text in the ffmpeg line: one centred drawtext per line, read from files, shown while t < the bait plus 2.5 s; a 60-second ad draws nothing", () => {
  const facts = { size: { width: 720, height: 1280 }, fps: 30, hasAudio: true };
  const pieces = [{ start_frame: 0, frames: 90, src: "/a.mp4", facts }, { start_frame: 300, frames: 300, src: "/a.mp4", facts }];
  const rate = { expr: "30", value: 30 };
  const plain = montageArgs(pieces, rate, "/out.mp4");
  assert.ok(!plain[plain.indexOf("-filter_complex") + 1].includes("drawtext"));
  const font = overlayFont((f) => f.endsWith("DejaVuSans-Bold.ttf"));
  assert.match(font, /^fontfile='.*DejaVuSans-Bold\.ttf'$/);
  assert.equal(overlayFont(() => false), "font='Sans\\:bold'");
  const drawn = montageArgs(pieces, rate, "/out.mp4", { files: ["/w/text-0.txt", "/w/text-1.txt"], untilS: 5.5, font });
  const graph = drawn[drawn.indexOf("-filter_complex") + 1];
  assert.match(graph, /concat=n=2:v=1:a=1\[joinedv\]\[joined\]/);
  assert.match(graph, /\[joinedv\]drawtext=.*textfile='\/w\/text-0\.txt'.*y=300.*enable='lt\(t,5\.500\)',drawtext=.*textfile='\/w\/text-1\.txt'.*y=384.*\[vout\]/);
  assert.equal(overlayFilter({ files: ["/a:b/it's.txt"], untilS: 1, font: "font=x" }).includes("textfile='/a\\:b/it'\\''s.txt'"), true);
});

// ---- the build on the fixture film ---------------------------------------------------------------------

const hasFfmpeg = spawnSync(process.env.FFMPEG_PATH?.trim() || "ffmpeg", ["-version"]).status === 0 && spawnSync(ffprobeBin(), ["-version"]).status === 0;
const fakeProbe = async (link: string): Promise<VideoFacts | null> => {
  const n = Number(path.basename(link).match(/^ep(\d+)/)?.[1]);
  const frames = ({ 1: 120, 2: 150, 3: 180 } as Record<number, number>)[n];
  return { width: 720, height: 1280, fps: 30, frames, duration_s: frames / 30 };
};
/** The fixture film's episodes are 4-6 s long: its builds take baits of 0.5-1 s, scenes from 0.8 s and hold the text 0.2 s. */
const TINY = { baitMinMs: 500, baitMaxMs: 1_000, bodyMinMs: 800, gapMs: 100, overlayHoldMs: 200 };

async function fixtureFilmWithClips() {
  const r = await importFilm(producer(), { source_ref: FILM, mode: "import" }, { producer_id: FIXTURE_PRODUCER_ID, created_by: producer().userId }, { root: FIXTURE_ROOT, quietMs: 0, probe: fakeProbe });
  const detail = await fixtureData.getTitle(staff(), r.title_id);
  const [e1, e2, e3] = [...detail.episodes].sort((a, b) => a.number - b.number);
  const row = (rank: number, start: number, end: number, moment: "opening" | "peak" = "peak") => ({ rank, start_ms: start, end_ms: end, scene_ids: [], hook_en: `Moment ${rank}`, opening_text_en: rank === 1 ? "Where is she?" : null, why_en: "w", why_zh: "w", source: "script" as const, moment });
  await fixtureData.upsertClips(staff(), e1.id, [row(1, 0, 1_800, "opening"), row(2, 2_000, 3_900)]);
  await fixtureData.upsertClips(staff(), e2.id, [row(1, 0, 1_500), row(2, 1_600, 3_400)]);
  await fixtureData.upsertClips(staff(), e3.id, [row(1, 0, 3_000)]); // after the spoiler line
  return { titleId: r.title_id, e1, e2, e3 };
}

/** The mean brightness of the top band where the text is drawn, at frame n. */
function topBand(file: string, n: number): number {
  const r = spawnSync(process.env.FFMPEG_PATH?.trim() || "ffmpeg", ["-v", "error", "-i", file, "-vf", `trim=start_frame=${n}:end_frame=${n + 1},crop=1080:240:0:290,scale=108:24,format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: 1 << 24 });
  const b = r.stdout as Buffer;
  let s = 0;
  for (const v of b) s += v;
  return s / b.length;
}

test("the build on the fixture film: a quick_hook row per variant, its code in the file name, the text on the first frames only, in the library and not in the 60-second panel", { skip: !hasFfmpeg && "ffmpeg or ffprobe is not on this machine" }, async () => {
  delete process.env.PROMO_RENDER; // this test renders for real
  const { titleId, e3 } = await fixtureFilmWithClips();
  temps.push(path.join(uploadsDir(), titleId));
  const status0 = await quickHooksStatus(producer(), titleId);
  assert.equal(status0.state, "none");
  assert.deepEqual(status0.suggestions.slice(0, 1), ["Where is she?"]);

  const started = await startQuickHooks(producer(), titleId, ["Where is she?"], { wait: true, options: { ...TINY, hooksMax: 2, bodiesMax: 1 } });
  assert.equal(started.outcome, "started", JSON.stringify(started));
  if (started.outcome !== "started") return;
  assert.ok(started.variants.length >= 1);
  assert.ok(started.variants.every((v) => v.pieces.every((p) => p.episode_id !== e3.id)), "nothing from after the spoiler line");
  const built = await started.done!;
  assert.ok(built.ok, JSON.stringify(built));
  if (!built.ok) return;
  assert.equal(built.clips.length, started.variants.length);
  const ad = built.clips[0];
  const v = started.variants[0];
  assert.equal(ad.moment, "montage");
  assert.equal(ad.ad_format, "quick_hook");
  assert.equal(ad.opening_text_en, "Where is she?");
  assert.equal(quickHookCode(ad.render_path), v.code);
  assert.deepEqual(ad.pieces!.map((p) => p.role), ["hook", "scene"]);

  // The file: 1080×1920, and the text: the top band differs from the same frame without it, then is gone.
  const file = resolveUploadPath(ad.render_path!);
  const probe = JSON.parse(spawnSync(ffprobeBin(), ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=width,height,nb_read_packets", "-of", "json", file], { encoding: "utf8" }).stdout).streams[0];
  const frames = ad.pieces!.reduce((n, p) => n + (p.frames ?? 0), 0);
  assert.deepEqual([probe.width, probe.height, Number(probe.nb_read_packets)], [1080, 1920, frames]);
  const lastFrame = frames - 1;
  const untilFrame = Math.ceil((v.overlay_ms / 1000) * 30);
  assert.ok(untilFrame < lastFrame, "the text ends before the ad does");
  const plain = await (async () => {
    // The same pieces without the text, for comparison.
    const { renderMontage } = await import("@/lib/clips/montage-render");
    const videoPaths = new Map<string, string>();
    for (const e of await fixtureData.getTitle(staff(), titleId).then((d) => d.episodes)) {
      const wb = await fixtureData.getWorkbench(staff(), titleId, e.number);
      if (wb.episode.video_path) videoPaths.set(e.id, wb.episode.video_path);
    }
    const r = await renderMontage({ pieces: v.pieces, videoPaths, storedPath: `${titleId}/quick-hooks/plain.mp4`, maxMs: 45_000 });
    return resolveUploadPath(r.render_path);
  })();
  assert.ok(Math.abs(topBand(file, 0) - topBand(plain, 0)) > 2, "the text is drawn on the first frame");
  assert.ok(Math.abs(topBand(file, lastFrame) - topBand(plain, lastFrame)) < 1, "and is gone by the last");

  // Its panel, the library (with its code) and not the 60-second ad's panel.
  const status = await quickHooksStatus(producer(), titleId);
  assert.equal(status.state, "ready");
  assert.equal(status.ads.length, built.clips.length);
  assert.equal(status.ads.find((a) => a.id === ad.id)?.code, v.code);
  assert.equal((await montageStatus(producer(), titleId)).montages.length, 0);
  const row = (await getData().listClipLibrary(producer(), { title_id: titleId })).find((r) => r.id === ad.id)!;
  assert.equal(row.montage?.variant, v.code);
  assert.equal(row.ad_format, "quick_hook");

  // Pressing again with the same clips and text makes nothing new; a new text makes new variants.
  const again = await startQuickHooks(producer(), titleId, ["Where is she?"], { wait: true, options: { ...TINY, hooksMax: 2, bodiesMax: 1 } });
  assert.equal(again.outcome, "exists");
  const more = await startQuickHooks(producer(), titleId, ["Where is she?", "Who took her?"], { wait: true, options: { ...TINY, hooksMax: 2, bodiesMax: 1 } });
  assert.equal(more.outcome, "started");
  if (more.outcome === "started") {
    assert.ok(more.variants.every((x) => x.overlay === "Who took her?"), "only the new text's variants are made");
    assert.ok((await more.done!).ok);
  }
});

test("who may build, and when it cannot: a viewer is forbidden, another company's title is not found, a server that cannot render says so", async () => {
  const { titleId } = await fixtureFilmWithClips();
  const viewer: Session = { ...fixtureSession("producer"), producerRole: "viewer" };
  await assert.rejects(startQuickHooks(viewer, titleId, ["Text"]), (e: unknown) => (e as { code?: string }).code === "forbidden");
  const other = await getData().createProducer(staff(), { name_zh: "别家", name_en: "Other" });
  await assert.rejects(startQuickHooks({ ...fixtureSession("producer"), producerId: other.id }, titleId, ["Text"]), (e: unknown) => (e as { code?: string }).code === "not_found");
  await assert.rejects(quickHooksStatus({ ...fixtureSession("producer"), producerId: other.id }, titleId), (e: unknown) => (e as { code?: string }).code === "not_found");
  const off = await startQuickHooks(producer(), titleId, ["Text"], { options: TINY });
  assert.equal(off.outcome, "failed");
  if (off.outcome === "failed") assert.equal(off.error, "rendering is switched off on this server");
  const status = await quickHooksStatus(producer(), titleId);
  assert.deepEqual([status.state, status.note], ["failed", "rendering is switched off on this server"]);
  const job = await fixtureData.latestJobByTarget(staff(), "title", titleId, "build_quick_hooks");
  assert.equal(job?.cost_cents, 0);
  // No text: refused before any job.
  const refused = await startQuickHooks(staff(), titleId, [], { options: TINY });
  assert.equal(refused.outcome, "refused");
  if (refused.outcome === "refused") assert.equal(refused.refusal.code, "no_text");
});

test("before migration 0024 the clips page still opens: a database that refuses the job kind reads as no build yet", async () => {
  const { titleId } = await fixtureFilmWithClips();
  const real = fixtureData.latestJobByTarget;
  let asked = 0;
  fixtureData.latestJobByTarget = async () => { asked++; throw new Error('invalid input value for enum studio.job_kind: "build_quick_hooks"'); };
  try {
    const status = await quickHooksStatus(producer(), titleId);
    assert.equal(status.state, "none");
    assert.equal(asked, 1, "the refused lookup was the one asked");
  } finally {
    fixtureData.latestJobByTarget = real;
  }
});
