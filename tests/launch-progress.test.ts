import { test } from "node:test";
import assert from "node:assert/strict";
import { currentStepKey, launchProgress, showsProgress, STUCK_AFTER } from "@/lib/launch/progress";
import { nextWaiting } from "@/lib/launch/waiting";
import { defaultLaunchDraft } from "@/lib/launch/plan";
import type { LaunchCampaign, LaunchContent } from "@/lib/launch/types";

// The Monitor's step list is read from the driver's own checkpoints only
// (decision 2026-09-26 "Launch progress on the Monitor").

const NOW = Date.parse("2026-09-26T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const clip = (n: number): LaunchContent => ({ kind: "video", value: `clip-${n}`, file_path: `clips/${n}.mp4`, sha256: "a".repeat(64) });
const clips = (count: number) => Array.from({ length: count }, (_, i) => clip(i + 1));
const tiktok = defaultLaunchDraft("tiktok");
const meta = defaultLaunchDraft("meta");
type Row = Pick<LaunchCampaign, "status" | "state" | "error" | "content" | "budget_cents" | "daily_budget_cents">;
const row = (over: Partial<Row> = {}): Row => ({ status: "running", state: {}, error: null, content: clips(5), budget_cents: 10_000, daily_budget_cents: null, ...over });
const statuses = (steps: { key: string; status: string }[]) => Object.fromEntries(steps.map(s => [s.key, s.status]));
const settings = { ...tiktok.tiktok_settings };

test("a fresh TikTok run: every step not started, Account current, in the driver's order", () => {
  const p = launchProgress(tiktok, row({ state: { progress: { step: "account", since: ago(0.2) } } }), NOW);
  // Website purchases is TikTok's default shape, so the pixel check applies; no Instant Page.
  assert.deepEqual(p.steps.map(s => s.key), ["account", "pixel", "videos", "campaign", "adgroup", "ads", "done"]);
  assert.equal(p.current, "account");
  assert.equal(p.done, 0);
  assert.deepEqual(p.steps.map(s => s.status), ["current", "todo", "todo", "todo", "todo", "todo", "todo"]);
  assert.equal(p.stuck, null);
  assert.ok(p.elapsed_ms !== null && p.elapsed_ms < 60_000);
  // Queued behind another campaign: nothing started, nothing claimed as current.
  const queued = launchProgress(tiktok, row({ status: "pending" }), NOW);
  assert.equal(queued.queued, true);
  assert.equal(queued.current, null);
  assert.ok(queued.steps.every(s => s.status === "todo"));
});

test("mid-upload: 2 of 5 videos uploaded, 1 of 5 covers, Videos is current", () => {
  const uploads = { "clip-1": { video_id: "v1", image_id: "i1" }, "clip-2": { video_id: "v2" } };
  const p = launchProgress(tiktok, row({ state: { settings, pixel: { code: "C", pixel_id: "123" }, identity: { identity_id: "x" }, uploads, progress: { step: "videos", since: ago(2) } } }), NOW);
  const videos = p.steps.find(s => s.key === "videos")!;
  assert.equal(videos.status, "current");
  assert.equal(videos.phase, "uploading");
  assert.deepEqual(videos.counts, [{ key: "uploaded", done: 2, of: 5 }, { key: "covers", done: 1, of: 5 }]);
  assert.deepEqual(statuses(p.steps), { account: "done", pixel: "done", videos: "current", campaign: "todo", adgroup: "todo", ads: "todo", done: "todo" });
  assert.equal(Math.round(p.elapsed_ms! / 60_000), 2);
  assert.equal(p.stuck, null);
});

test("a cover wait that has not moved in 7 minutes turns amber with the reason, timed from its first wait", () => {
  const uploads = Object.fromEntries(clips(2).map((c, i) => [c.value, { video_id: `v${i}`, cover_wait_since: ago(7) }]));
  const reason = "TikTok is still processing an uploaded Studio clip; its cover will be ready in a minute.";
  // The last retry was 20 seconds ago; the wait began 7 minutes ago.
  const waiting = { reason, since: ago(0.3), first_since: ago(7), retry_after_ms: 30_000, step: "videos" };
  const p = launchProgress(tiktok, row({ status: "pending", content: clips(2), state: { settings, pixel: { code: "C", pixel_id: "1" }, uploads, waiting, progress: { step: "videos", since: ago(8) } } }), NOW);
  assert.equal(p.current, "videos");
  const videos = p.steps.find(s => s.key === "videos")!;
  assert.equal(videos.phase, "covers");
  assert.deepEqual(videos.counts, [{ key: "uploaded", done: 2, of: 2 }, { key: "covers", done: 0, of: 2 }]);
  assert.ok(p.stuck);
  assert.equal(p.stuck!.what, "lpg.what.covers");
  assert.equal(p.stuck!.usual, "lpg.usual.underMinute");
  assert.equal(Math.floor(p.stuck!.wait_ms / 60_000), 7);
  assert.equal(p.stuck!.threshold_ms, STUCK_AFTER.covers.ms);
  assert.equal(p.stuck!.reason, reason);
  // Under the limit it is only a wait, not a warning.
  const early = launchProgress(tiktok, row({ status: "pending", content: clips(2), state: { settings, pixel: { code: "C", pixel_id: "1" },
    uploads: Object.fromEntries(clips(2).map((c, i) => [c.value, { video_id: `v${i}`, cover_wait_since: ago(1) }])), waiting: { ...waiting, first_since: ago(1) } } }), NOW);
  assert.equal(early.stuck, null);
  assert.equal(early.waiting?.reason, reason);
});

test("the honest timer: first_since survives a repeating reason and resets when it changes", () => {
  const first = nextWaiting(undefined, "cover not ready", 30_000, "videos", ago(7));
  const again = nextWaiting(first, "cover not ready", 30_000, "videos", ago(0));
  assert.equal(again.first_since, ago(7));
  assert.equal(again.since, ago(0));
  assert.equal(again.step, "videos");
  const other = nextWaiting(again, "TikTok did not respond in time.", 60_000, "campaign", ago(0));
  assert.equal(other.first_since, ago(0));
  // A row written before first_since existed starts its count from its last `since`.
  const legacy = nextWaiting({ reason: "cover not ready", since: ago(3), retry_after_ms: 30_000 }, "cover not ready", 30_000, "videos", ago(0));
  assert.equal(legacy.first_since, ago(3));
});

test("a campaign created paused: every step done, Done says created paused, no progress row after", () => {
  const groups = [{ id: "g1", key: "primary", ads: { "clip-1": "a1" }, ready: true }];
  const c = row({ status: "done", content: clips(1), state: { settings, pixel: { code: "C", pixel_id: "1" }, posts: [{ code: "clip-1" }], campaign_id: "c1", groups, launch_complete: true } });
  const p = launchProgress(tiktok, c, NOW);
  assert.ok(p.steps.every(s => s.status === "done"));
  assert.equal(p.steps.at(-1)!.outcome, "paused");
  assert.equal(p.current, null);
  assert.equal(currentStepKey(tiktok, c), null);
  assert.equal(showsProgress(c), false);
  const live = launchProgress(tiktok, { ...c, state: { ...c.state, activated: true } }, NOW);
  assert.equal(live.steps.at(-1)!.outcome, "live");
});

test("failed at ad-group creation: the cross sits on Ad group with TikTok's own words", () => {
  const error = "Create ad group: The budget is below the minimum for this optimization goal.";
  const c = row({ status: "failed", error, content: clips(2), state: { settings, pixel: { code: "C", pixel_id: "1" }, posts: [{ code: "clip-1" }, { code: "clip-2" }], campaign_id: "c1", waiting: undefined } });
  assert.equal(showsProgress(c), true);
  const p = launchProgress(tiktok, c, NOW);
  assert.deepEqual(statuses(p.steps), { account: "done", pixel: "done", videos: "done", campaign: "done", adgroup: "failed", ads: "todo", done: "todo" });
  assert.equal(p.current, "adgroup");
  assert.equal(p.failed, true);
  assert.equal(p.error, error);
  assert.equal(p.stuck, null);
  // An ended campaign keeps its old failure off the Monitor.
  assert.equal(showsProgress({ ...c, state: { ...c.state, stop_applied: "ended" } }), false);
});

test("a Meta run reads its own driver's order: account, videos, campaign, ad sets, ads, done", () => {
  const content: LaunchContent[] = [clip(1), clip(2)];
  const placements = { ...meta, meta_settings: { ...meta.meta_settings, placements: ["facebook", "instagram"] as ("facebook" | "instagram")[] } };
  const waiting = { reason: "Meta is still processing the uploaded clip.", since: ago(0.5), first_since: ago(6), retry_after_ms: 45_000, step: "videos" };
  const processing = launchProgress(placements, row({ status: "pending", content, state: { meta: { version: 1, intents: {}, video_ids: { a: "v1", b: "v2" }, creative_ids: {}, ad_ids: {}, content_values: {} }, waiting } }), NOW);
  assert.deepEqual(processing.steps.map(s => s.key), ["account", "videos", "campaign", "adsets", "ads", "done"]);
  assert.equal(processing.current, "videos");
  assert.equal(processing.steps[1].phase, "processing");
  assert.deepEqual(processing.steps[1].counts, [{ key: "uploaded", done: 2, of: 2 }]);
  assert.equal(processing.stuck?.what, "lpg.what.processing");
  assert.equal(processing.stuck?.usual, "lpg.usual.fewMinutes");
  // One ad set of two made, one clip in both: ads are 2 per set.
  const midway = launchProgress(placements, row({ content, state: { meta: { version: 1, intents: {}, campaign_id: "mc", adset_ids: { facebook: "s1" }, video_ids: { a: "v1", b: "v2" }, creative_ids: {}, ad_ids: { "facebook/a": "ad1" }, content_values: {} } } }), NOW);
  assert.deepEqual(statuses(midway.steps), { account: "done", videos: "done", campaign: "done", adsets: "current", ads: "todo", done: "todo" });
  assert.deepEqual(midway.steps[3].counts, [{ key: "adsets", done: 1, of: 2 }]);
  // Posts only: no videos step, the account step names the post checks it covers.
  const posts = launchProgress(meta, row({ status: "failed", error: "Meta rejected the request (HTTP 400, code 100): Invalid post.", content: [{ kind: "facebook_post", value: "123_456" }], state: {} }), NOW);
  assert.deepEqual(posts.steps.map(s => s.key), ["account", "campaign", "adsets", "ads", "done"]);
  assert.equal(posts.steps[0].label, "lpg.step.accountPosts");
  assert.equal(posts.steps[0].status, "failed");
});

test("an old row without progress, first_since or step still reads, with no timer it cannot back up", () => {
  // Written before 2026-09-26: a TikTok wait with only `since`, no stamps, no cover_wait_since.
  const c = row({ status: "pending", content: clips(1), state: { settings, pixel: { code: "C", pixel_id: "1" }, uploads: { "clip-1": { video_id: "v1" } },
    waiting: { reason: "TikTok is still processing an uploaded Studio clip.", since: ago(0.4), retry_after_ms: 30_000 } } });
  const p = launchProgress(tiktok, c, NOW);
  assert.equal(p.current, "videos");
  assert.equal(p.steps.find(s => s.key === "videos")!.phase, "covers");
  assert.ok(p.elapsed_ms !== null && p.elapsed_ms < 60_000);
  assert.equal(p.stuck, null);
  // A campaign made before pixels were recorded: its later checkpoints carry the pixel step as done.
  const old = launchProgress(tiktok, row({ status: "failed", error: "x", content: [{ kind: "spark", value: "code" }], state: { settings, posts: [{ code: "code" }], campaign_id: "c1" } }), NOW);
  assert.deepEqual(statuses(old.steps), { account: "done", pixel: "done", posts: "done", campaign: "done", adgroup: "failed", ads: "todo", done: "todo" });
  assert.equal(old.elapsed_ms, null);
  // A legacy row with nothing at all is still a list, never a throw.
  assert.equal(launchProgress(tiktok, row({ status: "running", state: {}, content: [] }), NOW).current, "account");
});
