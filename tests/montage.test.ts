// The 60-second ad (decision 2026-09-24, overnight spec item 16): the pick
// (a hook, two to four scenes and a cliff from the title's own clips, never
// past the spoiler line or inside a card, no edge through a spoken line),
// whole frames under the 60.0 s ceiling, the ffmpeg command line (hard cuts,
// one loudness pass, nothing drawn), the clips row both backends write, and
// the whole build on the fixture film with the real ffmpeg: frame-exact
// pieces, 1080×1920, -14 LUFS, then the ad in the Clips library, in Launch
// and in a Meta draft like any clip. The ffmpeg test is skipped on a machine
// without ffmpeg.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FIXTURE_PRODUCER_ID, fixtureSession, systemSession, type Session } from "@/lib/auth";
import { pickClipsForRound } from "@/lib/clips/creatives";
import { framePieces, MONTAGE_MAX_MS, MONTAGE_RANK_BASE, montageEpisodesLabel, montageKey, planMontage, snapEnd, snapStart, type MontageClip, type MontageEpisode, type MontageInput } from "@/lib/clips/montage";
import { frameRate, montageArgs, parseEncodedFrames, parseIntegratedLoudness, parseSourceFacts, seekOf } from "@/lib/clips/montage-render";
import { MONTAGE_RENDER_FAILED, montageStatus, startMontage } from "@/lib/clips/montage-run";
import { episodeClipsPayload } from "@/lib/clips/payload";
import { getData } from "@/lib/data";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { resetLaunchFixture } from "@/lib/data/launch";
import { localPathOf, resolveUploadPath, uploadsDir } from "@/lib/data/storage";
import { ffprobeBin, importFilm, resetImportRegistry, type VideoFacts } from "@/lib/film-import/import";
import { defaultLaunchDraft } from "@/lib/launch/plan";
import type { LaunchDraft } from "@/lib/launch/types";
import { defaultLaunchSettings } from "@/lib/tiktok/settings";
import type { AdRules, MontagePiece } from "@/lib/types";
import { assignMeta } from "./clip-seed";
import { producer, staff } from "./seed-minute";

const FIXTURE_ROOT = path.join(process.cwd(), "tests", "fixtures", "workspace");
const FILM = "low-quality/fixture-film";
const temps: string[] = [];

beforeEach(() => {
  resetFixtureStore();
  resetLaunchFixture();
  resetImportRegistry();
  const media = mkdtempSync(path.join(tmpdir(), "studio-montage-"));
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

const ep = (n: number, extra: Partial<MontageEpisode> = {}): MontageEpisode => ({ id: `e${n}`, number: n, has_video: true, duration_ms: 120_000, film_start_ms: (n - 1) * 120_000, cues: [], ...extra });
let seq = 0;
const clip = (n: number, rank: number, start: number, end: number, extra: Partial<MontageClip> = {}): MontageClip => ({
  id: `c${n}-${rank}-${++seq}`, external_id: `clip_${n}_${rank}`, episode_id: `e${n}`, rank, start_ms: start, end_ms: end,
  hook_en: `Hook of ${n}.${rank}`, status: "suggested", moment: "peak", source: "script", ...extra,
});
const noRules: AdRules = { spoiler_from_s: null, exclusions: [] };
const story = (p: MontagePiece) => p.episode_number * 1e9 + p.start_ms;
const lengthOf = (pieces: MontagePiece[]) => pieces.reduce((n, p) => n + p.end_ms - p.start_ms, 0);

/** Ten episodes, two 25-second clips each (rank 1 at 10 s, rank 2 at 60 s), the opening on episode 1. */
function tenEpisodes(rules: AdRules | null = noRules): MontageInput {
  const episodes = Array.from({ length: 10 }, (_, i) => ep(i + 1));
  const clips = episodes.flatMap((e) => [
    clip(e.number, 1, 10_000, 35_000, e.number === 1 ? { moment: "opening", hook_en: "She signs the contract without reading it." } : {}),
    clip(e.number, 2, 60_000, 85_000),
  ]);
  return { episodes, clips, rules };
}

test("the pick: the opening's first 8 s, four strong scenes spread through the story, the last usable episode's best clip's last 10 s, 60 s in all", () => {
  const plan = planMontage(tenEpisodes());
  assert.ok(plan.ok, JSON.stringify(plan));
  if (!plan.ok) return;
  assert.deepEqual(plan.pieces.map((p) => p.role), ["hook", "scene", "scene", "scene", "scene", "cliff"]);
  const [hook, ...rest] = plan.pieces;
  const cliff = rest[rest.length - 1];
  assert.deepEqual([hook.episode_number, hook.start_ms, hook.end_ms], [1, 10_000, 18_000], "the opening's first 8 s");
  // No spoiler line: the last fifth (episodes 9 and 10) stays out; the cliff is episode 8's rank 1, its last 10 s.
  assert.deepEqual([cliff.episode_number, cliff.start_ms, cliff.end_ms], [8, 25_000, 35_000]);
  const scenes = plan.pieces.filter((p) => p.role === "scene");
  assert.ok(scenes.every((p) => p.episode_number > 1 && p.episode_number < 8), "scenes sit between hook and cliff");
  assert.equal(new Set(scenes.map((p) => p.episode_number)).size, 4, "one scene per episode, spread");
  assert.ok(scenes.every((p) => p.start_ms === 10_000), "the strongest clip of each episode, from its own start");
  for (let i = 1; i < plan.pieces.length; i++) assert.ok(story(plan.pieces[i - 1]) < story(plan.pieces[i]), "story order");
  assert.equal(plan.duration_ms, 60_000);
  assert.equal(lengthOf(plan.pieces), 60_000);
  assert.equal(plan.hook_en, "She signs the contract without reading it.");
  assert.equal(plan.source, "script");
  assert.deepEqual(plan.episodes, [1, ...scenes.map((p) => p.episode_number), 8]);
  assert.equal(plan.key, montageKey(plan.pieces));
  const again = planMontage(tenEpisodes());
  assert.equal(again.ok ? again.key : "", plan.key, "the same clips, the same pick");
});

test("the spoiler line cuts a clip and holds back what comes after it; a card inside a window is stepped around", () => {
  // Film time: episode n starts at (n-1)×120 s. The line at 315 s falls inside episode 3's rank-2 clip (its 60-85 s are 300-325 s of
  // the film), which is cut to end at the line; everything from episode 4 on is held back. The card is episode 2's 20-24 s.
  const rules: AdRules = { spoiler_from_s: 240 + 75, exclusions: [{ from_s: 120 + 20, to_s: 120 + 24, why: "card: TO BE CONTINUED", source: "film_meta" }] };
  const plan = planMontage(tenEpisodes(rules));
  assert.ok(plan.ok, JSON.stringify(plan));
  if (!plan.ok) return;
  const last = plan.pieces[plan.pieces.length - 1];
  assert.equal(last.episode_number, 3, "nothing from after the line: episode 3 is the last usable one");
  assert.ok(last.end_ms <= 75_000, `the cliff ends at the line at the latest: ${last.end_ms}`);
  assert.ok(plan.pieces.every((p) => p.episode_number <= 3));
  for (const p of plan.pieces.filter((x) => x.episode_number === 2)) assert.ok(p.end_ms <= 20_000 || p.start_ms >= 24_000, "never inside the card");
  // Without enough before the line the build is refused, in words, with what was held back.
  const tight = planMontage(tenEpisodes({ spoiler_from_s: 100, exclusions: [] }));
  assert.equal(tight.ok, false);
  if (tight.ok) return;
  assert.equal(tight.code, "too_few");
  assert.equal(tight.usable, 2, "episode 1's two clips come before the line at 100 s");
  assert.equal(tight.held_back, 18);
  assert.match(tight.message, /needs a hook, at least two scenes and a cliff: four separate moments.*2 usable clips \(18 more come after the spoiler line or inside a card\)/);
});

test("no piece edge cuts through a spoken line when a gap is near; a long line is cut rather than dropped", () => {
  const cues = [{ start_ms: 16_000, end_ms: 19_500 }, { start_ms: 30_000, end_ms: 33_000 }];
  assert.equal(snapEnd(10_000, 18_000, cues, 4_800), 16_000, "an end inside a line moves back to where it starts");
  assert.equal(snapEnd(10_000, 18_000, cues, 7_000), 18_000, "not when that leaves too little");
  assert.equal(snapStart(31_000, 41_000, cues, 6_000), 33_000, "a start inside a line moves on to where it ends");
  assert.equal(snapEnd(10_000, 25_000, cues, 1_000), 25_000, "an end in a gap stays");
  const input = tenEpisodes();
  input.episodes[0].cues = [{ start_ms: 16_500, end_ms: 20_000 }];
  input.episodes[7].cues = [{ start_ms: 24_000, end_ms: 26_000 }];
  const plan = planMontage(input);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.equal(plan.pieces[0].end_ms, 16_500, "the hook ends before the line it would have cut");
  assert.equal(plan.pieces[plan.pieces.length - 1].start_ms, 26_000, "the cliff starts after the line it would have cut");
  assert.ok(plan.duration_ms <= MONTAGE_MAX_MS);
});

test("refusals: no clips, too few that do not overlap; dismissed clips and other montages are not moments", () => {
  const none = planMontage({ episodes: [ep(1)], clips: [], rules: null });
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.code, "no_clips");
  const three = planMontage({ episodes: [ep(1), ep(2)], clips: [clip(1, 1, 0, 20_000), clip(1, 2, 30_000, 50_000), clip(2, 1, 0, 20_000), clip(2, 2, 10_000, 30_000, { status: "dismissed" }), clip(2, 3, 40_000, 60_000, { moment: "montage" })], rules: null });
  assert.equal(three.ok, false);
  if (!three.ok) { assert.equal(three.code, "too_few"); assert.equal(three.usable, 3); }
  // Four usable clips in two short episodes are enough: each piece is its whole window, the whole well under 60 s.
  const four = planMontage({ episodes: [ep(1, { duration_ms: 6_000 }), ep(2, { duration_ms: 6_000 })], clips: [clip(1, 1, 0, 1_800, { moment: "opening" }), clip(1, 2, 3_500, 5_400), clip(2, 1, 0, 1_500), clip(2, 2, 3_200, 5_000)], rules: null });
  assert.ok(four.ok, JSON.stringify(four));
  if (four.ok) {
    assert.deepEqual(four.pieces.map((p) => [p.role, p.episode_number, p.start_ms, p.end_ms]), [["hook", 1, 0, 1_800], ["scene", 1, 3_500, 5_400], ["scene", 2, 0, 1_500], ["cliff", 2, 3_200, 5_000]]);
    assert.equal(four.duration_ms, 7_000);
  }
  // A clip that starts where another ends is one moment with a jump in it, not a second one: the same four, the
  // second clip of episode 1 right after the opening, leave three moments and are refused.
  const touching = planMontage({ episodes: [ep(1, { duration_ms: 6_000 }), ep(2, { duration_ms: 6_000 })], clips: [clip(1, 1, 0, 1_800, { moment: "opening" }), clip(1, 2, 1_800, 3_600), clip(2, 1, 0, 1_500), clip(2, 2, 3_200, 5_000)], rules: null });
  assert.equal(touching.ok, false, JSON.stringify(touching));
  if (!touching.ok) assert.equal(touching.code, "too_few");
});

test("overlapping clips of one episode are trimmed, not dropped: no two pieces share a frame or touch, and the room left goes to the scenes up to 1.5 s before the next piece", () => {
  // The demo catalog's shape: six 62-second episodes, three overlapping 25-28 s clips on each of the first two.
  const episodes = Array.from({ length: 6 }, (_, i) => ep(i + 1, { duration_ms: 62_000 }));
  const clips = [
    clip(1, 1, 0, 25_000, { moment: "opening" }), clip(1, 2, 15_000, 40_000), clip(1, 3, 34_000, 62_000),
    clip(2, 1, 4_000, 30_000), clip(2, 2, 28_000, 55_000), clip(2, 3, 37_000, 62_000),
  ];
  const plan = planMontage({ episodes, clips, rules: null });
  assert.ok(plan.ok, JSON.stringify(plan));
  if (!plan.ok) return;
  assert.deepEqual(plan.pieces.map((p) => [p.role, p.episode_number, p.start_ms, p.end_ms]), [
    ["hook", 1, 0, 8_000],
    ["scene", 1, 15_000, 32_500], // its equal 10.5 s, then the room left up to 1.5 s before the next scene starts
    ["scene", 1, 34_000, 54_000], // the third clip from where the second's window was not taken, up to 20 s
    ["cliff", 2, 20_000, 30_000], // episode 2's strongest clip, its last 10 s
  ]);
  for (const a of plan.pieces) for (const b of plan.pieces) if (a !== b && a.episode_id === b.episode_id) assert.ok(a.end_ms + 1_500 <= b.start_ms || b.end_ms + 1_500 <= a.start_ms, "no frame twice, and no two pieces touch");
  assert.equal(plan.duration_ms, 55_500);
});

test("whole frames: nearest frames, never over 60.0 s (the longest scene gives the excess back), times rewritten to the frames", () => {
  const piece = (role: MontagePiece["role"], s: number, e: number): MontagePiece => ({ role, clip_id: null, clip_external_id: null, episode_id: "e1", episode_number: 1, start_ms: s, end_ms: e });
  const at30 = framePieces([piece("hook", 10, 8_020), piece("scene", 20_000, 40_016), piece("cliff", 50_000, 82_000)], 30);
  // 241 + 600 + 960 = 1801 frames: one over, and the scene (the longest scene) gives it back from its end.
  assert.deepEqual(at30.map((p) => [p.start_frame, p.frames]), [[0, 241], [600, 599], [1_500, 960]]);
  assert.equal(at30.reduce((n, p) => n + p.frames, 0), 1_800, "60.0 s at 30 fps is 1800 frames, not one more");
  assert.deepEqual([at30[1].start_ms, at30[1].end_ms], [20_000, 39_967]);
  const ntsc = frameRate(29.97);
  assert.equal(ntsc.expr, "30000/1001");
  const at2997 = framePieces([piece("hook", 0, 30_000), piece("scene", 40_000, 71_000)], ntsc.value);
  assert.ok(at2997.reduce((n, p) => n + p.frames, 0) <= Math.floor(60 * ntsc.value), "1798 frames at 29.97");
  assert.throws(() => framePieces([piece("hook", 0, 1_000)], 0));
});

test("the ffmpeg line: each input seeked 0.3 frame early and trimmed to its frames, framed 9:16, hard cuts, one -14 LUFS pass, nothing drawn", () => {
  const vertical = { size: { width: 720, height: 1280 }, fps: 30, hasAudio: true };
  const landscape = { size: { width: 1920, height: 1080 }, fps: 30, hasAudio: true };
  const silent = { size: { width: 720, height: 1280 }, fps: 25, hasAudio: false };
  const args = montageArgs([
    { start_frame: 0, frames: 54, src: "a.mp4", facts: vertical },
    { start_frame: 60, frames: 57, src: "b.mp4", facts: landscape },
    { start_frame: 48, frames: 54, src: "c.mp4", facts: silent },
  ], frameRate(30), "out.mp4");
  assert.deepEqual(args.filter((a, i) => args[i - 1] === "-ss"), ["0.000000", seekOf(60, 30), seekOf(48, 30)]);
  assert.equal(seekOf(60, 30), ((60 - 0.3) / 30).toFixed(6));
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /\[0:v:0\]trim=end_frame=54,setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,format=yuv420p\[v0\]/);
  assert.match(graph, /\[1:v:0\]trim=end_frame=57,setpts=PTS-STARTPTS,split=2\[m1bg\]\[m1fg\];\[m1bg\].*\[m1bgb\];\[m1fg\]scale=1080:-2\[m1fgs\];\[m1bgb\]\[m1fgs\]overlay=/, "a landscape piece keeps its whole picture over its own blurred fill");
  assert.match(graph, /\[2:v:0\]fps=30,trim=end_frame=54/, "a source at another rate is brought to the ad's rate before it is trimmed");
  assert.match(graph, /anullsrc=r=48000:cl=stereo,atrim=end=1\.800000/, "a silent source gets silence of its exact length");
  assert.match(graph, /\[v0\]\[a0\]\[v1\]\[a1\]\[v2\]\[a2\]concat=n=3:v=1:a=1\[vout\]\[joined\]/);
  assert.equal(graph.match(/loudnorm=/g)?.length, 1, "one loudness pass, over the joined sound");
  assert.match(graph, /loudnorm=I=-14:TP=-1\.5:LRA=11/);
  assert.doesNotMatch(graph, /drawtext|subtitles|movie=|xfade|acrossfade/, "hard cuts, nothing drawn on the picture");
  assert.deepEqual(args.slice(args.indexOf("-frames:v"), args.indexOf("-frames:v") + 2), ["-frames:v", "165"]);
  assert.ok(args.includes("+faststart"));
  // The encode is capped so a 60 s ad stays under the 32 MB a clip may be for the zip download and the Meta posting.
  assert.deepEqual(args.slice(args.indexOf("-maxrate"), args.indexOf("-maxrate") + 4), ["-maxrate", "3500k", "-bufsize", "7000k"]);
});

test("the log readers: the source's size, rate and sound; the integrated loudness; the encoder's frame count", () => {
  const dump = "  Stream #0:0[0x1](und): Video: h264 (High), yuv420p(progressive), 720x1280 [SAR 1:1 DAR 9:16], 97 kb/s, 29.97 fps, 29.97 tbr, 15360 tbn (default)\n  Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, mono, fltp, 18 kb/s (default)";
  assert.deepEqual(parseSourceFacts(dump), { size: { width: 720, height: 1280 }, fps: 29.97, hasAudio: true });
  assert.deepEqual(parseSourceFacts("  Stream #0:0: Video: h264, yuv420p, 1920x1080, 25 tbr"), { size: { width: 1920, height: 1080 }, fps: 25, hasAudio: false });
  assert.equal(parseIntegratedLoudness("[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -14.1 LUFS\n    Threshold: -24.2 LUFS"), -14.1);
  assert.equal(parseIntegratedLoudness("  Integrated loudness:\n    I:         -inf LUFS"), null);
  assert.equal(parseEncodedFrames("frame=  100 fps=0.0 q=0.0\rframe=  210 fps=50 q=-1.0 Lsize=..."), 210);
});

// ---- the row both backends write -----------------------------------------------------------------------

async function titleWithTwoEpisodes() {
  const title = await fixtureData.createImportedTitle(systemSession(), { producer_id: FIXTURE_PRODUCER_ID, source_ref: "low-quality/montage-rows", display_title_en: "Montage Rows", crazydramas_slug: null, created_by: producer().userId });
  const e1 = await fixtureData.addVideoOnlyEpisode(staff(), title.id, 1, `${title.id}/ep1.mp4`);
  const e2 = await fixtureData.addVideoOnlyEpisode(staff(), title.id, 2, `${title.id}/ep2.mp4`);
  return { title, e1, e2 };
}
const pieceOn = (episode: { id: string; number: number }, role: MontagePiece["role"], s: number, e: number): MontagePiece => ({ role, clip_id: null, clip_external_id: null, episode_id: episode.id, episode_number: episode.number, start_ms: s, end_ms: e, frames: Math.round(((e - s) * 30) / 1000) });

test("a montage row: system or staff only, pieces from the title's own episodes, a real checksum; it ranks from 1001 and a re-run of the episode's clips keeps it", async () => {
  const { title, e1, e2 } = await titleWithTwoEpisodes();
  const input = {
    title_id: title.id, pieces: [pieceOn(e1, "hook", 0, 8_000), pieceOn(e1, "scene", 10_000, 20_000), pieceOn(e2, "scene", 0, 10_000), pieceOn(e2, "cliff", 20_000, 30_000)],
    hook_en: "Hook", why_en: "why", why_zh: "为什么", source: "script" as const, job_id: null, render_path: `${title.id}/montage/ad60-x.mp4`, render_sha256: "a".repeat(64), duration_ms: 38_000, width: 1080, height: 1920,
  };
  await assert.rejects(fixtureData.addMontageClip(producer(), input), (e: unknown) => (e as { code?: string }).code === "forbidden");
  const other = await fixtureData.createImportedTitle(systemSession(), { producer_id: FIXTURE_PRODUCER_ID, source_ref: "low-quality/montage-other", display_title_en: "Other", crazydramas_slug: null, created_by: producer().userId });
  const foreign = await fixtureData.addVideoOnlyEpisode(staff(), other.id, 1, `${other.id}/ep1.mp4`);
  await assert.rejects(fixtureData.addMontageClip(systemSession(), { ...input, pieces: [...input.pieces, pieceOn(foreign, "cliff", 0, 5_000)] }), /the title's own episodes/);
  await assert.rejects(fixtureData.addMontageClip(systemSession(), { ...input, render_sha256: "nope" }), /sha256/);
  await assert.rejects(fixtureData.addMontageClip(systemSession(), { ...input, duration_ms: 60_001 }), /at most 60 seconds/);
  const row = await fixtureData.addMontageClip(systemSession(), input);
  assert.equal(row.moment, "montage");
  assert.equal(row.episode_id, e1.id, "it hangs on its hook's episode");
  assert.deepEqual([row.start_ms, row.end_ms], [0, 8_000], "with the hook's range");
  assert.equal(row.rank, MONTAGE_RANK_BASE);
  assert.equal(row.status, "shortlisted");
  assert.equal(row.render_status, "rendered");
  assert.equal(row.pieces?.length, 4);
  assert.equal(montageEpisodesLabel(row.pieces), "1, 2");
  const second = await fixtureData.addMontageClip(staff(), input);
  assert.equal(second.rank, MONTAGE_RANK_BASE + 1);
  // A re-run of episode 1's clips replaces its suggested rows only: the ad stays, the new clips rank 1 and 2.
  const after = await fixtureData.upsertClips(staff(), e1.id, [
    { rank: 1, start_ms: 0, end_ms: 20_000, scene_ids: [], hook_en: "a", why_en: "a", why_zh: "a" },
    { rank: 2, start_ms: 30_000, end_ms: 50_000, scene_ids: [], hook_en: "b", why_en: "b", why_zh: "b" },
  ]);
  assert.deepEqual(after.map((c) => [c.moment, c.rank]), [["peak", 1], ["peak", 2], ["montage", MONTAGE_RANK_BASE], ["montage", MONTAGE_RANK_BASE + 1]]);
  // Not an episode's clip: the Materials list leaves it out, and so does a Promote round.
  assert.deepEqual((await episodeClipsPayload(producer(), title.id, 1)).clips.map((c) => c.moment), ["peak", "peak"]);
  assert.equal(pickClipsForRound(await fixtureData.listEpisodeClips(producer(), title.id), [e1, e2]).some((c) => c.moment === "montage"), false);
});

// ---- the build on the fixture film ----------------------------------------------------------------------

const hasFfmpeg = spawnSync(process.env.FFMPEG_PATH?.trim() || "ffmpeg", ["-version"]).status === 0 && spawnSync(ffprobeBin(), ["-version"]).status === 0;
const fakeProbe = async (link: string): Promise<VideoFacts | null> => {
  const n = Number(path.basename(link).match(/^ep(\d+)/)?.[1]);
  const frames = ({ 1: 120, 2: 150, 3: 180 } as Record<number, number>)[n];
  return { width: 720, height: 1280, fps: 30, frames, duration_s: frames / 30 };
};

/** The fixture film's episodes are 4-6 s long and its clips sit 0.1-0.2 s apart, so its builds allow pieces 0.1 s apart. */
const TINY = { gapMs: 100 };

/** The fixture film imported (three 720×1280 episodes of 4, 5 and 6 s, spoiler line at 7.5 s film time), with five clips. */
async function fixtureFilmWithClips() {
  const r = await importFilm(producer(), { source_ref: FILM, mode: "import" }, { producer_id: FIXTURE_PRODUCER_ID, created_by: producer().userId }, { root: FIXTURE_ROOT, quietMs: 0, probe: fakeProbe });
  const detail = await fixtureData.getTitle(staff(), r.title_id);
  const [e1, e2, e3] = [...detail.episodes].sort((a, b) => a.number - b.number);
  const row = (rank: number, start: number, end: number, moment: "opening" | "peak" = "peak") => ({ rank, start_ms: start, end_ms: end, scene_ids: [], hook_en: rank === 1 && moment === "opening" ? "Where is she?" : `Moment ${rank}`, why_en: "w", why_zh: "w", source: "script" as const, moment });
  await fixtureData.upsertClips(staff(), e1.id, [row(1, 0, 1_800, "opening"), row(2, 2_000, 3_900)]);
  await fixtureData.upsertClips(staff(), e2.id, [row(1, 0, 1_500), row(2, 1_600, 3_400)]);
  await fixtureData.upsertClips(staff(), e3.id, [row(1, 0, 3_000)]); // film time 9-12 s: after the spoiler line
  return { titleId: r.title_id, e1, e2, e3 };
}

function grayFrame(file: string, n: number): Buffer {
  const r = spawnSync(process.env.FFMPEG_PATH?.trim() || "ffmpeg", ["-v", "error", "-i", file, "-vf", `trim=start_frame=${n}:end_frame=${n + 1},scale=72:128,format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: 1 << 24 });
  return r.stdout as Buffer;
}
const meanDiff = (a: Buffer, b: Buffer) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

test("the build on the fixture film: frame-exact 9:16 at -14 LUFS, a clips row, in the library and in Launch like any clip", { skip: !hasFfmpeg && "ffmpeg or ffprobe is not on this machine" }, async () => {
  delete process.env.PROMO_RENDER; // this test renders for real
  const { titleId, e1, e2, e3 } = await fixtureFilmWithClips();
  temps.push(path.join(uploadsDir(), titleId)); // the rendered ad lands under .uploads/<title>/montage/
  const started = await startMontage(producer(), titleId, { wait: true, options: TINY });
  assert.equal(started.outcome, "started", JSON.stringify(started));
  if (started.outcome !== "started") return;
  assert.deepEqual(started.plan.pieces.map((p) => p.role), ["hook", "scene", "scene", "cliff"]);
  assert.ok(started.plan.pieces.every((p) => p.episode_id !== e3.id), "nothing from after the spoiler line");
  const built = await started.done!;
  assert.ok(built.ok, JSON.stringify(built));
  if (!built.ok) return;
  const ad = built.clip;
  assert.equal(ad.moment, "montage");
  assert.equal(ad.hook_en, "Where is she?");
  const pieces = ad.pieces!;
  const frames = pieces.reduce((n, p) => n + (p.frames ?? 0), 0);
  assert.equal(ad.duration_ms, Math.round((frames * 1000) / 30));
  assert.ok(ad.duration_ms! <= MONTAGE_MAX_MS);

  // The file: 1080×1920, exactly the planned frames, the sound at -14 LUFS, and each piece's first and last frame
  // the source's own (the frame before or after would differ).
  const file = resolveUploadPath(ad.render_path!);
  const probe = JSON.parse(spawnSync(ffprobeBin(), ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=width,height,nb_read_packets", "-of", "json", file], { encoding: "utf8" }).stdout).streams[0];
  assert.deepEqual([probe.width, probe.height, Number(probe.nb_read_packets)], [1080, 1920, frames]);
  const loud = parseIntegratedLoudness(spawnSync(process.env.FFMPEG_PATH?.trim() || "ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-map", "0:a:0", "-af", "ebur128=peak=none", "-f", "null", "-"], { encoding: "utf8" }).stderr);
  assert.ok(loud !== null && loud >= -16 && loud <= -12, `loudness ${loud}`);
  const wb = new Map<string, string>();
  for (const e of [e1, e2]) wb.set(e.id, localPathOf((await fixtureData.getWorkbench(staff(), titleId, e.number)).episode.video_path!));
  let at = 0;
  for (const p of pieces) {
    const src = wb.get(p.episode_id)!;
    const first = Math.round((p.start_ms * 30) / 1000);
    for (const [out, own] of [[at, first], [at + p.frames! - 1, first + p.frames! - 1]]) {
      const mine = meanDiff(grayFrame(file, out), grayFrame(src, own));
      const before = own > 0 ? meanDiff(grayFrame(file, out), grayFrame(src, own - 1)) : Infinity;
      const next = meanDiff(grayFrame(file, out), grayFrame(src, own + 1));
      assert.ok(mine < before && mine < next, `frame ${out} of the ad is frame ${own} of episode ${p.episode_number} (${mine.toFixed(2)} vs ${before.toFixed(2)} / ${next.toFixed(2)})`);
    }
    at += p.frames!;
  }

  // The title's page and the Clips library: "Ad · 60 s", its episodes, its file; the episode filter finds it under episode 2 too.
  const status = await montageStatus(producer(), titleId);
  assert.equal(status.state, "ready");
  assert.equal(status.montages[0].id, ad.id);
  assert.equal(status.montages[0].episodes_label, "1, 2");
  const library = await getData().listClipLibrary(producer(), { title_id: titleId });
  const row = library.find((r) => r.id === ad.id)!;
  assert.deepEqual(row.montage, { episodes: "1, 2", pieces: 4 });
  assert.equal(row.episode_label, null);
  assert.equal(row.file_path, ad.render_path);
  assert.equal(row.sha256, ad.render_sha256);
  assert.ok((await getData().listClipLibrary(producer(), { title_id: titleId, episode_id: e2.id })).some((r) => r.id === ad.id));

  // Pressing again with the same clips answers the same ad; nothing is rendered twice.
  const again = await startMontage(producer(), titleId, { wait: true, options: TINY });
  assert.equal(again.outcome, "exists");

  // Launch: a Spark code made from the ad takes its title (and its link); a Meta draft takes its file.
  const tiktok = await getData().assignLaunchConnection(staff(), { producer_id: FIXTURE_PRODUCER_ID, provider: "tiktok", advertiser_id: "7000000000000000001", name: "TikTok 1", currency: "USD", timezone: "America/Los_Angeles", page_id: null, instagram_id: null, business_id: null, enabled: true });
  const draft: LaunchDraft = { ...defaultLaunchDraft("tiktok"), name: "The 60 s ad", account_ids: [tiktok.id], content_per_campaign: 1, allocation: "shared",
    content: [{ kind: "spark", value: "code-60", clip_id: ad.id }], title_id: titleId, destination_url: "", total_budget_cents: 20000, daily_budget_cents: 3000,
    tiktok_settings: { ...defaultLaunchSettings(), budget_mode: "BUDGET_MODE_DAY", daily_budget_usd: 30, start_paused: true } };
  const saved = await getData().saveLaunchDraft(producer(), draft);
  assert.equal(saved.draft.content[0].clip_id, ad.id);
  assert.equal(saved.draft.content[0].title_id, titleId);
  await getData().previewLaunchRun(producer(), saved.id);
  const meta = await assignMeta(FIXTURE_PRODUCER_ID);
  const metaDraft = await getData().saveLaunchDraft(producer(), { ...defaultLaunchDraft("meta"), name: "The 60 s ad on Meta", account_ids: [meta.id], content_per_campaign: 1, allocation: "shared", content: [{ kind: "video", value: ad.id }], total_budget_cents: 20000, daily_budget_cents: 3000 });
  assert.deepEqual([metaDraft.draft.content[0].file_path, metaDraft.draft.content[0].sha256], [ad.render_path, ad.render_sha256]);
});

test("who may build, and when it cannot: a viewer is forbidden, another company's title is not found, too few clips are refused in words, a server that cannot render says so", async () => {
  const { titleId, e3 } = await fixtureFilmWithClips();
  const viewer: Session = { ...fixtureSession("producer"), producerRole: "viewer" };
  await assert.rejects(startMontage(viewer, titleId), (e: unknown) => (e as { code?: string }).code === "forbidden");
  const other = await getData().createProducer(staff(), { name_zh: "别家", name_en: "Other" });
  await assert.rejects(startMontage({ ...fixtureSession("producer"), producerId: other.id }, titleId), (e: unknown) => (e as { code?: string }).code === "not_found");
  await assert.rejects(montageStatus({ ...fixtureSession("producer"), producerId: other.id }, titleId), (e: unknown) => (e as { code?: string }).code === "not_found");
  // PROMO_RENDER=off: the build is recorded as failed with the reason, and the page says so.
  const off = await startMontage(producer(), titleId, { options: TINY });
  assert.equal(off.outcome, "failed");
  if (off.outcome === "failed") assert.equal(off.error, "rendering is switched off on this server");
  const status = await montageStatus(producer(), titleId);
  assert.deepEqual([status.state, status.note, status.note_code], ["failed", "rendering is switched off on this server", null]);
  const job = await fixtureData.latestJobByTarget(staff(), "title", titleId, "build_montage");
  assert.equal(job?.cost_cents, 0);
  // Fewer than four usable clips: refused before any job.
  for (const c of await fixtureData.listEpisodeClips(staff(), titleId)) if (c.episode_id !== e3.id && c.rank === 2) await fixtureData.setClipStatus(staff(), c.id, "dismissed");
  const refused = await startMontage(producer(), titleId);
  assert.equal(refused.outcome, "refused");
  if (refused.outcome === "refused") { assert.equal(refused.refusal.code, "too_few"); assert.equal(refused.refusal.usable, 2); assert.equal(refused.refusal.held_back, 1); }
  // A staff administrator may build too (the staff clips page): the same refusal, not a forbidden.
  assert.equal((await startMontage(staff(), titleId)).outcome, "refused");
});

test("two presses at once start one build; a join that fails says one plain sentence, never ffmpeg's own words or a server path", { skip: !hasFfmpeg && "ffmpeg or ffprobe is not on this machine" }, async () => {
  delete process.env.PROMO_RENDER;
  const { titleId, e1 } = await fixtureFilmWithClips();
  temps.push(path.join(uploadsDir(), titleId));
  // Episode 1's file goes missing (the link under the media folder is removed; the fixture film itself stays).
  const wb = await fixtureData.getWorkbench(staff(), titleId, e1.number);
  rmSync(localPathOf(wb.episode.video_path!), { force: true });
  const [a, b] = await Promise.all([startMontage(producer(), titleId, { wait: true, options: TINY }), startMontage(staff(), titleId, { wait: true, options: TINY })]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ["running", "started"], "the second press finds the first build running");
  const first = a.outcome === "started" ? a : b.outcome === "started" ? b : null;
  const other = a.outcome === "running" ? a : b.outcome === "running" ? b : null;
  assert.ok(first && other && first.outcome === "started" && other.outcome === "running");
  if (first?.outcome !== "started" || other?.outcome !== "running") return;
  assert.equal(other.job_id, first.job_id);
  const built = await first.done!;
  assert.deepEqual(built, { ok: false, error: MONTAGE_RENDER_FAILED });
  const status = await montageStatus(producer(), titleId);
  assert.deepEqual([status.state, status.note, status.note_code], ["failed", MONTAGE_RENDER_FAILED, "render_failed"]);
  assert.doesNotMatch(status.note!, /[A-Z]:[\\/]|\/tmp\/|ffmpeg|Error opening/i, "no server path or ffmpeg output reaches the page");
  const job = await fixtureData.latestJobByTarget(staff(), "title", titleId, "build_montage");
  assert.equal(job?.id, first.job_id);
  assert.match(String((job?.output as { detail?: string } | null)?.detail), /render failed/, "the detail stays on the job for staff");
});
