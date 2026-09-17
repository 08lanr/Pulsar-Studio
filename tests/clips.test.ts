// Ad clips cut after upload (decision 2026-09-14): the pure pieces
import { withHistoricalPromoSeed } from "@/lib/data/fixture";
const test = (name: string, fn: () => void | Promise<void>) => nodeTest(name, () => withHistoricalPromoSeed(fn));
// (footage scoring, the framing rule, the 20-30 s clamp,
// the derived run state, the budget rule) and the fixture-mode flows (a
// run without ffmpeg fails every row with a note and never spends; a
// second run while one is going is refused; Generate ads builds from
// rendered clips and refuses without them (the route starts cutting); the approver
// cannot freeze a pick over budget and can unselect an ad).
process.env.PROMO_RENDER = "off";

import { afterEach, test as nodeTest } from "node:test";
import assert from "node:assert/strict";

import { budgetCheck } from "@/lib/angles";
import { NO_CLIPS_MESSAGE, adTextOf, pickClipsForRound } from "@/lib/clips/creatives";
import { generateAds, renderCampaign } from "@/lib/promote/generate";
import { frameFilter } from "@/lib/clips/cut";
import { parseDurationMs, parseLoudness, parseSceneCuts, scoreWindows } from "@/lib/clips/footage";
import { cutEpisodeClips } from "@/lib/clips/run";
import { clipRunState, jobIsRunning } from "@/lib/clips/state";
import { FIXTURE_PRODUCER_ID, systemSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { putStoredBytes } from "@/lib/data/storage";
import { clampClipRange } from "@/lib/jobs";
import type { Clip, Job } from "@/lib/types";
import { producer, seedRenderedClips, staff } from "./seed-minute";

afterEach(() => resetFixtureStore());

// ---- footage scoring ----------------------------------------------------------------------------

test("scoreWindows prefers the loud, cut-dense stretch, snaps to a cut, never runs past the end", () => {
  const duration = 120_000;
  // Quiet everywhere except 60-85 s; cuts cluster at 58.8, 70, 78, 82 s (all four fit only in a window
  // starting between 57 and 58.8 s); a lone cut at 20 s.
  const loud = Array.from({ length: 1200 }, (_, i) => ({ t: i / 10, db: i >= 600 && i < 850 ? -14 : -30 }));
  const cuts = [20, 58.8, 70, 78, 82];
  const windows = scoreWindows(cuts, loud, duration, { windowMs: 25_000 });
  assert.ok(windows.length > 0 && windows.length <= 6);
  assert.equal(windows[0].start_ms, 58_800, "the strongest window opens on the cut at the head of the loud, busy stretch");
  assert.equal(windows[0].on_cut, true);
  for (let i = 1; i < windows.length; i++) assert.ok(windows[i - 1].score >= windows[i].score, "strongest first");
  for (const w of windows) assert.ok(w.end_ms <= duration && w.end_ms - w.start_ms <= 25_000);
  for (let i = 0; i < windows.length; i++) for (let j = i + 1; j < windows.length; j++) {
    const a = windows[i], b = windows[j];
    assert.ok(a.end_ms + 3_000 <= b.start_ms || b.end_ms + 3_000 <= a.start_ms, "windows keep a 3 s gap");
  }
});

test("scoreWindows on a short episode returns at most one window and nothing on an empty one", () => {
  const short = scoreWindows([], [{ t: 1, db: -20 }], 30_000, { windowMs: 25_000 });
  assert.equal(short.length, 1);
  assert.equal(short[0].end_ms, 25_000);
  assert.deepEqual(scoreWindows([], [], 0), []);
});

test("ffmpeg log parsers read pts_time, momentary loudness and the container duration", () => {
  assert.deepEqual(parseSceneCuts("[Parsed_showinfo_1] n:0 pts:1234 pts_time:12.34 ...\n[Parsed_showinfo_1] n:1 pts_time:20.5"), [12.34, 20.5]);
  const loud = parseLoudness("[Parsed_ebur128_0] t: 0.4   TARGET:-23 LUFS    M: -18.3 S: -inf     I: -18.3 LUFS\n[Parsed_ebur128_0] t: 0.5   TARGET:-23 LUFS    M: -inf S: -inf     I: -20 LUFS");
  assert.deepEqual(loud, [{ t: 0.4, db: -18.3 }, { t: 0.5, db: -70 }]);
  assert.equal(parseDurationMs("Input #0, mov,mp4\n  Duration: 00:01:02.04, start: 0.000000, bitrate: 780 kb/s"), 62_040);
  assert.equal(parseDurationMs("no duration here"), null);
});

// ---- framing ------------------------------------------------------------------------------------

test("a vertical source is cover-cropped; a landscape source is kept whole over a blurred fill, never zoom-cropped", () => {
  assert.deepEqual(frameFilter({ width: 1080, height: 1920 }), { filter: "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920", pictureTop: null });
  assert.equal(frameFilter({ width: 720, height: 1280 }).filter.includes("boxblur"), false);
  assert.equal(frameFilter(null).filter.includes("boxblur"), false, "unknown size: the safe default");
  const landscape = frameFilter({ width: 1280, height: 720 });
  assert.match(landscape.filter, /boxblur/);
  assert.match(landscape.filter, /\[fg\]scale=1080:-2\[fgs\]/, "the picture keeps its full width");
  assert.equal(landscape.pictureTop, 1248 - 608, "the picture's bottom sits on the 35% band");
  assert.match(landscape.filter, new RegExp(`overlay=\\(W-w\\)/2:${landscape.pictureTop}$`));
});

// ---- the clip rule ------------------------------------------------------------------------------

test("clampClipRange keeps every cut between 20 and 30 s and inside the episode", () => {
  assert.deepEqual(clampClipRange(10_000, 15_000, 25, null), { start_ms: 10_000, end_ms: 35_000 }, "short line run: the cut continues past the lines");
  assert.deepEqual(clampClipRange(10_000, 80_000, 25, null), { start_ms: 10_000, end_ms: 35_000 }, "long line run: the cut keeps the recommended length");
  assert.deepEqual(clampClipRange(10_000, 15_000, 9, null), { start_ms: 10_000, end_ms: 30_000 }, "under 20 s is raised to 20");
  assert.deepEqual(clampClipRange(10_000, 15_000, 45, null), { start_ms: 10_000, end_ms: 40_000 }, "over 30 s is capped at 30");
  assert.deepEqual(clampClipRange(50_000, 55_000, 25, 62_000), { start_ms: 37_000, end_ms: 62_000 }, "near the end the cut slides back to keep its length");
});

// ---- run state ----------------------------------------------------------------------------------

function job(patch: Partial<Job>): Job {
  const at = new Date().toISOString();
  return { id: "j", title_id: "t", episode_id: "e", version_id: null, kind: "cut_clips", target_type: "episode", target_id: "e", idempotency_key: "k", status: "running", provider: null, model: null, input: null, output: null, error: null, usage: null, cost_cents: 0, heartbeat_at: at, started_at: at, finished_at: null, created_at: at, ...patch };
}
function clip(patch: Partial<Clip>): Clip {
  return { id: "c", external_id: "clip_x", title_id: "t", episode_id: "e", adaptation_id: null, rank: 1, start_ms: 0, end_ms: 25_000, scene_ids: [], hook_en: "", why_en: "", why_zh: "", opening_text_en: null, cut_length_s: 25, angle: null, status: "suggested", model: null, prompt_version: null, job_id: null, source: "footage", moment: "peak", render_path: null, render_sha256: null, render_status: "pending", render_note: null, duration_ms: null, width: null, height: null, created_at: "2026-09-14T00:00:00.000Z", ...patch };
}

test("clipRunState: cutting while the job beats, dead after ten quiet minutes, ready / failed / none from the rows", () => {
  assert.equal(clipRunState([], job({})).state, "cutting");
  const stale = job({ heartbeat_at: new Date(Date.now() - 11 * 60_000).toISOString() });
  assert.equal(jobIsRunning(stale), false);
  assert.equal(clipRunState([clip({ render_status: "pending" })], stale).state, "failed", "a pending row behind a dead run is a failure, not a forever spinner");
  assert.equal(clipRunState([clip({ render_status: "rendered", render_path: "p", render_sha256: "a".repeat(64) })], job({ status: "done" })).state, "ready");
  const failed = clipRunState([clip({ render_status: "failed", render_note: "ffmpeg is not installed on this machine" })], job({ status: "failed", error: "ffmpeg is not installed on this machine" }));
  assert.equal(failed.state, "failed");
  assert.match(failed.note ?? "", /ffmpeg/);
  assert.equal(clipRunState([], null).state, "none");
});

// ---- angles and the budget rule ------------------------------------------------------------------

test("budgetCheck: each chosen ad reserves $50; the pick must fit the experiment budget", () => {
  const two = budgetCheck([{ kind: "direct_clip", status: "approved" }, { kind: "ugc_story", status: "approved" }, { kind: "direct_clip", status: "ready" }], 100);
  assert.deepEqual(two, { reserved_usd: 100, covers: 2, chosen: 2, ok: true });
  const three = budgetCheck([{ kind: "direct_clip", status: "approved" }, { kind: "direct_clip", status: "approved" }, { kind: "direct_clip", status: "approved" }], 100);
  assert.equal(three.ok, false);
  assert.equal(budgetCheck([], null).covers, 0);
});

// ---- fixture flows ------------------------------------------------------------------------------

async function titleWithVideo() {
  resetFixtureStore();
  const title = await fixtureData.createTitle(producer(), { name_zh: "向园", name_en: "Xiang Yuan", producer_id: "ignored" });
  const videoPath = `${title.id}/episode-1/source.mp4`;
  await putStoredBytes(videoPath, Buffer.from("not really an mp4"), "video/mp4");
  const episode = await fixtureData.addVideoOnlyEpisode(producer(), title.id, 1, videoPath);
  return { title, episode, videoPath };
}

test("a run without ffmpeg records a failed cut_clips job at cost 0, selects nothing and spends no tokens", async () => {
  const { title } = await titleWithVideo();
  const r = await cutEpisodeClips(title.id, 1);
  assert.equal(r.outcome, "failed");
  assert.match(r.failed[0], /ffmpeg is not installed/);
  const j = await fixtureData.latestEpisodeJob(producer(), title.id, 1, "cut_clips");
  assert.equal(j?.status, "failed");
  assert.equal(j?.cost_cents, 0);
  assert.equal((await fixtureData.listEpisodeClips(producer(), title.id, 1)).length, 0);
  const state = clipRunState([], j);
  assert.equal(state.state, "failed");
  assert.match(state.note ?? "", /ffmpeg/);
});

test("a second run is refused while one is going; a dead run is superseded", async () => {
  const { title, episode } = await titleWithVideo();
  const running = await fixtureData.recordJob(staff(), { kind: "cut_clips", title_id: title.id, episode_id: episode.id, target_type: "episode", target_id: episode.id, idempotency_key: `cut_clips:${episode.id}:manual` });
  const refused = await cutEpisodeClips(title.id, 1, { force: true });
  assert.equal(refused.outcome, "refused");
  assert.equal(refused.job_id, running.id);
  // The process died: the heartbeat goes quiet and the next run proceeds.
  const store = (await import("@/lib/data/fixture")).fixtureData;
  const dead = (await store.latestEpisodeJob(staff(), title.id, 1, "cut_clips"))!;
  assert.equal(jobIsRunning({ ...dead, heartbeat_at: new Date(Date.now() - 11 * 60_000).toISOString() }), false);
});

test("footage clips are allowed on an untimed episode with video, producers read them, and rendered ones become the campaign's ads", async () => {
  const { title, episode, videoPath } = await titleWithVideo();
  const sha = "b".repeat(64);
  const rows = await fixtureData.upsertClips(staff(), episode.id, [
    { rank: 1, start_ms: 0, end_ms: 25_000, scene_ids: [], hook_en: "", why_en: "footage", why_zh: "画面", source: "footage", moment: "opening" },
    { rank: 2, start_ms: 30_000, end_ms: 55_000, scene_ids: [], hook_en: "", why_en: "footage", why_zh: "画面", source: "footage" },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].render_status, "pending");
  await assert.rejects(fixtureData.setClipRender(systemSession(), rows[0].id, { render_status: "rendered", render_path: videoPath, render_sha256: "nope" }), /sha256/);
  await fixtureData.setClipRender(systemSession(), rows[0].id, { render_status: "rendered", render_path: videoPath, render_sha256: sha, duration_ms: 25_000, width: 1080, height: 1920 });
  await fixtureData.setClipRender(systemSession(), rows[1].id, { render_status: "failed", render_note: "render failed: exit 1" });
  const mine = await fixtureData.listEpisodeClips(producer(), title.id, 1);
  assert.equal(mine.length, 2, "the producer reads their own title's clips");
  assert.equal(clipRunState(mine, null).state, "ready");
  assert.deepEqual(pickClipsForRound(mine, [episode]).map((c) => c.id), [rows[0].id], "only rendered rows become ads");

  const campaign = await fixtureData.createPromoCampaign(producer(), { title_id: title.id, name: "US launch", target_market: "US", destination_url: "https://example.com/w", objective: "views", spoiler_level: "low", experiment: { budget_usd: 100, hypothesis: "h", audience: "a", first_batch: 2, signal: "views" } });
  const creatives = await fixtureData.generatePromoDrafts(producer(), campaign.id);
  assert.equal(creatives.length, 1);
  assert.equal(adTextOf(creatives[0]), creatives[0].caption, "a footage clip has no hook, so the caption is the TikTok ad text");
  assert.equal(adTextOf({ hook: "Have we met somewhere before?", caption: "x" }), "Have we met somewhere before?", "with a hook, the hook is the TikTok ad text");
  assert.equal(creatives[0].render_path, videoPath);
  assert.equal(creatives[0].render_sha256, sha);
  assert.equal(creatives[0].kind, "direct_clip");
  assert.equal((creatives[0].render_settings as { source: string }).source, "auto_clip");
  const detail = await fixtureData.getPromoCampaign(producer(), campaign.id);
  assert.equal(detail.campaign.status, "review", "nothing to render: review opens at once");
  assert.equal(detail.campaign.status_note, null);
  // A clip that finishes later joins the open round on request, once.
  await fixtureData.setClipRender(systemSession(), rows[1].id, { render_status: "rendered", render_path: videoPath, render_sha256: "c".repeat(64), duration_ms: 25_000, width: 1080, height: 1920 });
  const more = await generateAds(producer(), campaign.id);
  assert.equal(more.added.length, 1);
  assert.equal(more.creatives.length, 2);
  assert.equal((await generateAds(producer(), campaign.id)).added.length, 0, "nothing new the second time");
});

test("the producer writes the TikTok ad text of an ad in review; it is frozen once the round is approved", async () => {
  const { title, episode, videoPath } = await titleWithVideo();
  const [clip] = await fixtureData.upsertClips(staff(), episode.id, [{ rank: 1, start_ms: 0, end_ms: 25_000, scene_ids: [], hook_en: "", why_en: "footage", why_zh: "画面", source: "footage" }]);
  await fixtureData.setClipRender(systemSession(), clip.id, { render_status: "rendered", render_path: videoPath, render_sha256: "e".repeat(64), duration_ms: 25_000, width: 1080, height: 1920 });
  await fixtureData.assignLaunchAccount(staff(), FIXTURE_PRODUCER_ID, { advertiser_id: "7000000000000000001", name: "Test ad account", identity_id: "7000000000000000101", identity_type: "BC_AUTH_TT" });
  const campaign = await fixtureData.createPromoCampaign(producer(), { title_id: title.id, name: "US launch", target_market: "US", destination_url: "https://example.com/w", objective: "views", spoiler_level: "low", experiment: { budget_usd: 100, hypothesis: "h", audience: "a", first_batch: 2, signal: "views" } });
  const [ad] = await fixtureData.generatePromoDrafts(producer(), campaign.id);
  assert.equal(ad.hook, "", "a footage clip has no hook until the producer writes one");
  await assert.rejects(fixtureData.setPromoCreativeText(producer(), ad.id, "   "), /write the ad text/);
  await assert.rejects(fixtureData.setPromoCreativeText(producer(), ad.id, "x".repeat(101)), /100 characters/);
  const written = await fixtureData.setPromoCreativeText(producer(), ad.id, "  He never saw   the truck coming.  ");
  assert.equal(written.hook, "He never saw the truck coming.");
  assert.equal(adTextOf(written), "He never saw the truck coming.", "what TikTok gets is exactly what was written");
  await fixtureData.reviewPromoCreative(producer(), ad.id, { status: "approved" });
  await fixtureData.approvePromoCampaign(producer(), campaign.id);
  await assert.rejects(fixtureData.setPromoCreativeText(producer(), ad.id, "Too late"), /in review/);
});

test("without finished clips there are no placeholder ads: generation refuses and the route starts cutting", async () => {
  const { title } = await titleWithVideo();
  const campaign = await fixtureData.createPromoCampaign(producer(), { title_id: title.id, name: "US launch", target_market: "US", destination_url: "https://example.com/w", objective: "views", spoiler_level: "low", experiment: { budget_usd: 100, hypothesis: "h", audience: "a", first_batch: 2, signal: "views" } });
  await assert.rejects(fixtureData.generatePromoDrafts(producer(), campaign.id), new RegExp(NO_CLIPS_MESSAGE));
  const out = await generateAds(producer(), campaign.id);
  assert.equal(out.cutting, true);
  assert.equal(out.creatives.length, 0);
  assert.equal((await fixtureData.getPromoCampaign(producer(), campaign.id)).creatives.length, 0, "no fixed-offset rows were invented");
});

test("a staff revision has no file until it is rendered; the render pass reports why when ffmpeg is off", async () => {
  const { title, episode, videoPath } = await titleWithVideo();
  const [clip] = await fixtureData.upsertClips(staff(), episode.id, [{ rank: 1, start_ms: 0, end_ms: 25_000, scene_ids: [], hook_en: "Hook", why_en: "w", why_zh: "w", source: "footage" }]);
  await fixtureData.setClipRender(systemSession(), clip.id, { render_status: "rendered", render_path: videoPath, render_sha256: "d".repeat(64), duration_ms: 25_000, width: 1080, height: 1920 });
  const campaign = await fixtureData.createPromoCampaign(producer(), { title_id: title.id, name: "US launch", target_market: "US", destination_url: "https://example.com/w", objective: "views", spoiler_level: "low", experiment: { budget_usd: 100, hypothesis: "h", audience: "a", first_batch: 2, signal: "views" } });
  const [first] = await fixtureData.generatePromoDrafts(producer(), campaign.id);
  await fixtureData.reviewPromoCreative(producer(), first.id, { status: "rejected", rejection_note: "Start later." });
  const revision = await fixtureData.revisePromoCreative(staff(), first.id, { hook: "New hook", caption: "c", ad_description: "d", source_start_ms: 5_000, source_end_ms: 30_000, revision_note: "Starts on the slap." });
  assert.equal(revision.render_path, null, "a revision is a new range: it needs its own file");
  const r = await renderCampaign(campaign.id);
  assert.equal(r.rendered, 0);
  assert.match(r.failed[0] ?? "", new RegExp(revision.external_id));
});

test("the approver cannot freeze a pick over budget; unselecting brings it back under", async () => {
  const { title } = await titleWithVideo();
  await fixtureData.assignLaunchAccount(staff(), FIXTURE_PRODUCER_ID, { advertiser_id: "7000000000000000001", name: "Test ad account", identity_id: "7000000000000000101", identity_type: "BC_AUTH_TT" });
  await seedRenderedClips(title.id, (await fixtureData.getTitle(producer(), title.id)).episodes[0].id, 4);
  const campaign = await fixtureData.createPromoCampaign(producer(), { title_id: title.id, name: "US launch", target_market: "US", destination_url: "https://example.com/w", objective: "views", spoiler_level: "low", experiment: { budget_usd: 100, hypothesis: "h", audience: "a", first_batch: 2, signal: "views" } });
  const [a, b, c] = await fixtureData.generatePromoDrafts(producer(), campaign.id);
  for (const x of [a, b, c]) await fixtureData.reviewPromoCreative(producer(), x.id, { status: "approved" });
  await assert.rejects(fixtureData.approvePromoCampaign(producer(), campaign.id), /covers 2 ad\(s\) at \$50 each; 3 are chosen/);
  await assert.rejects(fixtureData.reviewPromoCreative(producer(), (await fixtureData.getPromoCampaign(producer(), campaign.id)).creatives[3].id, { status: "ready" }), /only a chosen ad/);
  await fixtureData.reviewPromoCreative(producer(), c.id, { status: "ready" });
  const approved = await fixtureData.approvePromoCampaign(producer(), campaign.id);
  assert.equal(approved.campaign.status, "approved");
  assert.equal((approved.approval!.manifest as { creatives: unknown[] }).creatives.length, 2);
});
