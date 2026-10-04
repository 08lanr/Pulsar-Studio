import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_POST_RULE, autoPostEnabled, nextDueAt, pickAutoPosts } from "@/lib/launch/auto-post";
import { SYSTEM_USER_ID } from "@/lib/auth";
import type { ClipLibraryRow, ClipPost } from "@/lib/launch/clip-posts";

// Auto-post proven clips (decision 2026-10-03). The rule is pure, so what the
// sweep would post is decided here without a provider: the bar, the ranking,
// the platforms already taken, and the cadence read off the posts themselves.

const clip = (id: string, over: Partial<ClipLibraryRow> = {}): ClipLibraryRow => ({
  id, external_id: `clip_${id}`, producer_id: "company", producer_name: "CrazyDramas",
  title_id: "title", title_name: "A Drama", episode_id: null, episode_label: null,
  label: `hook ${id}`, kind: "video", value: id,
  file_path: `stored/${id}.mp4`, sha256: "a".repeat(64),
  media_url: null, spark_code: null, post_url: null, ...over,
} as ClipLibraryRow);

const stat = (over: Partial<{ impressions: number; ctr: number; hold_6s: number; checkouts: number; early: boolean }> = {}) =>
  ({ impressions: 5000, ctr: 0.05, hold_6s: 0.2, checkouts: 4, early: false, ...over });

const post = (over: Partial<ClipPost>): ClipPost => ({
  id: "p", producer_id: "company", clip_id: "x", connection_id: "c", platform: "facebook",
  status: "published", step: "published", caption: "", sha256: "", created_by: "someone",
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), revision: 1, ...over,
} as ClipPost);

test("a clip must have real delivery, clicks and a checkout before it is posted", () => {
  const library = [clip("good"), clip("early"), clip("weak"), clip("nosale"), clip("thin")];
  const summaries = {
    good: stat(),
    early: stat({ early: true }),
    weak: stat({ ctr: 0.001 }),
    nosale: stat({ checkouts: 0 }),
    thin: stat({ impressions: 10, early: false }),
  };
  const { ready } = pickAutoPosts(library, summaries, new Map());
  assert.deepEqual(ready.map(r => r.clip.id), ["good"]);
  assert.deepEqual(ready[0].platforms, ["facebook", "instagram"]);
});

test("a clip with no numbers at all is never posted", () => {
  // An ad account TikTok would not report on leaves its clips absent, which
  // must read as "not proven", never as "fine to post".
  const { ready } = pickAutoPosts([clip("unknown")], {}, new Map());
  assert.deepEqual(ready, []);
});

test("checkouts rank, then click-through, then reach", () => {
  const library = [clip("a"), clip("b"), clip("c")];
  const summaries = {
    a: stat({ checkouts: 2, ctr: 0.09 }),
    b: stat({ checkouts: 9, ctr: 0.02 }),
    c: stat({ checkouts: 2, ctr: 0.09, impressions: 90_000 }),
  };
  const { ready } = pickAutoPosts(library, summaries, new Map());
  assert.deepEqual(ready.map(r => r.clip.id), ["b", "c", "a"]);
});

test("a platform that already has a row is never posted to again", () => {
  const taken = new Map([["good", new Set(["facebook"])]]);
  const { ready } = pickAutoPosts([clip("good")], { good: stat() }, taken);
  assert.deepEqual(ready[0].platforms, ["instagram"]);
  // Both taken: the clip drops out entirely, whatever the row's status was.
  const both = new Map([["good", new Set(["facebook", "instagram"])]]);
  assert.deepEqual(pickAutoPosts([clip("good")], { good: stat() }, both).ready, []);
});

test("a clip with no stored file is skipped rather than sent to fail", () => {
  const { ready } = pickAutoPosts([clip("x", { file_path: undefined, sha256: undefined })], { x: stat() }, new Map());
  assert.deepEqual(ready, []);
});

test("the cadence is read from the posts the system user made, not from memory", async () => {
  const hours = AUTO_POST_RULE.everyHours;
  const justNow = new Date().toISOString();
  const longAgo = new Date(Date.now() - (hours + 5) * 3600_000).toISOString();

  // Nothing posted at all: due immediately.
  assert.ok((await nextDueAt([])).getTime() <= Date.now());
  // Never auto-posted before, but a person just posted by hand: the sweep waits
  // its turn rather than piling onto the account the same day.
  assert.ok((await nextDueAt([post({ created_by: "a-person", created_at: justNow })])).getTime() > Date.now());
  // Once the sweep has its own history, only its own posts set the clock, so a
  // hand post between runs never delays it.
  assert.ok((await nextDueAt([
    post({ created_by: SYSTEM_USER_ID, created_at: longAgo }),
    post({ created_by: "a-person", created_at: justNow }),
  ])).getTime() <= Date.now());
  // The sweep's own recent post does.
  assert.ok((await nextDueAt([post({ created_by: SYSTEM_USER_ID, created_at: justNow })])).getTime() > Date.now());
  // And one older than the cadence does not.
  assert.ok((await nextDueAt([post({ created_by: SYSTEM_USER_ID, created_at: longAgo })])).getTime() <= Date.now());
});

test("the sweep never runs without the switches a live Meta write needs", () => {
  const keep = { d: process.env.DATA_SOURCE, w: process.env.META_LIVE_WRITES, off: process.env.AUTO_POST_DISABLED };
  try {
    process.env.DATA_SOURCE = "fixture"; process.env.META_LIVE_WRITES = "enabled"; delete process.env.AUTO_POST_DISABLED;
    assert.equal(autoPostEnabled(), false, "fixture mode must never post");
    process.env.DATA_SOURCE = "supabase"; delete process.env.META_LIVE_WRITES;
    assert.equal(autoPostEnabled(), false, "live writes must be enabled");
    process.env.META_LIVE_WRITES = "enabled";
    assert.equal(autoPostEnabled(), true);
    process.env.AUTO_POST_DISABLED = "1";
    assert.equal(autoPostEnabled(), false, "the kill switch must stop it");
  } finally {
    if (keep.d === undefined) delete process.env.DATA_SOURCE; else process.env.DATA_SOURCE = keep.d;
    if (keep.w === undefined) delete process.env.META_LIVE_WRITES; else process.env.META_LIVE_WRITES = keep.w;
    if (keep.off === undefined) delete process.env.AUTO_POST_DISABLED; else process.env.AUTO_POST_DISABLED = keep.off;
  }
});
