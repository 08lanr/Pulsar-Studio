// The clip library and the promote.clip_posts records (docs/meta-organic-plan.md
// §2): who sees which clips, who may publish one, and what a post row records.
// Fixture mode here; the Supabase branch runs the same code path and differs
// only at storage, so these are the guards both backends owe.
process.env.PROMO_RENDER = "off";

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fixtureSession, systemSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { resetLaunchFixture } from "@/lib/data/launch";
import { clipRouteRoles } from "@/lib/launch/clip-routes";
import { resetFakeMeta } from "@/lib/meta/fake";
import { approver, assignMeta, ownCompany, reviewer, seedClipTitle, staffEditor, viewer } from "./clip-seed";
import { staff } from "./seed-minute";

const data = () => getData();
const env = { DATA_SOURCE: process.env.DATA_SOURCE, FIXTURE_SEED: process.env.FIXTURE_SEED, FIXTURE_PERSIST: process.env.FIXTURE_PERSIST };
const originalFetch = globalThis.fetch;
let networkCalls = 0;

beforeEach(() => {
  process.env.DATA_SOURCE = "fixture"; process.env.FIXTURE_SEED = "empty"; process.env.FIXTURE_PERSIST = "off";
  resetFixtureStore(); resetLaunchFixture(); resetFakeMeta(); networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error("Fixture clip posting attempted network access"); };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  resetFixtureStore();
});

async function world(opts: { episodes?: number } = {}) {
  const own = await seedClipTitle(approver(), ownCompany, "Own title", { episodes: opts.episodes ?? 1, clipsPerEpisode: 2 });
  const other = await fixtureData.createProducer(staff(), { name_zh: "别家影视", name_en: "Other company" });
  const foreign = await seedClipTitle(staff(), other.id, "Foreign title", { clipsPerEpisode: 1 });
  const connection = await assignMeta(ownCompany);
  return { own, other, foreign, connection };
}
const post = (clipId: string, connectionId: string, extra: Record<string, unknown> = {}) =>
  ({ clip_id: clipId, platform: "facebook" as const, connection_id: connectionId, caption: "Hook\nOwn title", sha256: "", ...extra });

test("the library scopes by company: staff see every producer, a producer session ignores a foreign filter", async () => {
  const { own, other, foreign } = await world();
  const all = await data().listClipLibrary(staff(), {});
  assert.equal(all.length, own.clips.length + foreign.clips.length);
  assert.deepEqual([...new Set(all.map(row => row.producer_id))].sort(), [ownCompany, other.id].sort());
  assert.ok(all.every(row => row.producer_name));
  const staffFiltered = await data().listClipLibrary(staff(), { producer_id: other.id });
  assert.deepEqual(staffFiltered.map(row => row.id), foreign.clips.map(clip => clip.id));
  // A producer is always its own company, whatever the filter says.
  const asked = await data().listClipLibrary(approver(), { producer_id: other.id });
  assert.deepEqual(asked.map(row => row.id).sort(), own.clips.map(clip => clip.id).sort());
  assert.equal(networkCalls, 0);
});

test("the library filters by title, episode, state and hook, and carries the episode and rendered file", async () => {
  const { own, connection } = await world({ episodes: 2 });
  const rows = await data().listClipLibrary(approver(), {});
  assert.equal(rows.length, 4);
  assert.deepEqual([...new Set(rows.map(row => row.episode_label))].sort(), ["1", "2"]);
  assert.ok(rows.every(row => row.sha256 && row.file_path && row.media_url && row.duration_ms === 25_000));
  assert.equal((await data().listClipLibrary(approver(), { episode_id: own.episodes[1].id })).length, 2);
  assert.equal((await data().listClipLibrary(approver(), { title_id: own.title.id })).length, 4);
  assert.equal((await data().listClipLibrary(approver(), { search: "no setup" })).length, 4);
  assert.equal((await data().listClipLibrary(approver(), { search: "nothing matches this" })).length, 0);
  assert.equal((await data().listClipLibrary(approver(), { posted: "posted" })).length, 0);
  assert.equal((await data().listClipLibrary(approver(), { posted: "not_posted" })).length, 4);
  const created = await data().createClipPost(approver(), post(own.clips[0].id, connection.id, { sha256: rows[0].sha256 }));
  const published = await data().updateClipPost(systemSession(), created.id, created.revision,
    { status: "published", step: "published", external_post_id: "9000000000000011_1", published_at: new Date().toISOString() });
  assert.equal(published.status, "published");
  assert.deepEqual((await data().listClipLibrary(approver(), { posted: "posted" })).map(row => row.id), [own.clips[0].id]);
  assert.equal((await data().listClipLibrary(approver(), { posted: "not_posted" })).length, 3);
  const row = (await data().listClipLibrary(approver(), { posted: "posted" }))[0];
  assert.equal(row.posts.length, 1);
  assert.equal(row.posts[0].external_post_id, "9000000000000011_1");
});

test("only an approver or a staff administrator may publish; viewers, reviewers and staff editors are refused", async () => {
  const { own, connection } = await world();
  const clip = (await data().listClipLibrary(staff(), {})).find(row => row.id === own.clips[0].id)!;
  const input = post(clip.id, connection.id, { sha256: clip.sha256 });
  await assert.rejects(data().createClipPost(viewer(), input), { code: "forbidden" });
  await assert.rejects(data().createClipPost(reviewer(), input), { code: "forbidden" });
  await assert.rejects(data().createClipPost(staffEditor(), input), { code: "forbidden" });
  const byApprover = await data().createClipPost(approver(), input);
  assert.equal(byApprover.status, "publishing");
  assert.equal(byApprover.step, "uploading");
  assert.equal(byApprover.revision, 1);
  const byStaff = await data().createClipPost(staff(), { ...input, platform: "instagram" as const, sha256: clip.sha256! });
  assert.equal(byStaff.step, "container");
  assert.equal(byStaff.created_by, fixtureSession("staff").userId);
});

test("a foreign clip, a foreign post and an unassigned account are not found", async () => {
  const { foreign, connection, other } = await world();
  const foreignClip = (await data().listClipLibrary(staff(), { producer_id: other.id }))[0];
  await assert.rejects(data().createClipPost(approver(), post(foreignClip.id, connection.id, { sha256: foreignClip.sha256 })), { code: "not_found" });
  const own = (await data().listClipLibrary(approver(), {}))[0];
  await assert.rejects(data().createClipPost(approver(), post(own.id, "not-an-account", { sha256: own.sha256 })), { code: "not_found" });
  const created = await data().createClipPost(approver(), post(own.id, connection.id, { sha256: own.sha256 }));
  const stranger = { ...approver(), producerId: other.id };
  await assert.rejects(data().getClipPost(stranger, created.id), { code: "not_found" });
  await assert.rejects(data().getClipPost(approver(), "00000000-0000-4000-8000-0000000000ff"), { code: "not_found" });
});

test("a changed clip, an empty caption and a Page-less or Instagram-less account are refused before any row exists", async () => {
  const { own } = await world();
  const clip = (await data().listClipLibrary(approver(), {}))[0];
  const noPage = await assignMeta(ownCompany, { index: 2, page: false });
  const noInstagram = await assignMeta(ownCompany, { index: 3, instagram: false });
  await assert.rejects(data().createClipPost(approver(), post(clip.id, noPage.id, { sha256: clip.sha256 })), { code: "invalid" });
  await assert.rejects(data().createClipPost(approver(), post(clip.id, noInstagram.id, { platform: "instagram", sha256: clip.sha256 })), { code: "invalid" });
  const withPage = await assignMeta(ownCompany, { index: 4 });
  await assert.rejects(data().createClipPost(approver(), post(clip.id, withPage.id, { sha256: "not-the-rendered-hash" })), { code: "invalid" });
  await assert.rejects(data().createClipPost(approver(), post(clip.id, withPage.id, { sha256: clip.sha256, caption: "   " })), { code: "invalid" });
  assert.equal((await data().listClipPosts(approver())).length, 0);
  assert.equal(own.clips.length, 2);
});

test("one published post per clip, platform and account; a second needs Post again", async () => {
  const { connection } = await world();
  const clip = (await data().listClipLibrary(approver(), {}))[0];
  const first = await data().createClipPost(approver(), post(clip.id, connection.id, { sha256: clip.sha256 }));
  // A publish already under way is refused too: no concurrent double post.
  await assert.rejects(data().createClipPost(approver(), post(clip.id, connection.id, { sha256: clip.sha256 })), { code: "conflict" });
  const published = await data().updateClipPost(systemSession(), first.id, first.revision, { status: "published", step: "published", external_post_id: "9000000000000011_7" });
  await assert.rejects(data().createClipPost(approver(), post(clip.id, connection.id, { sha256: clip.sha256 })), { code: "conflict" });
  const again = await data().createClipPost(approver(), post(clip.id, connection.id, { sha256: clip.sha256, again: true }));
  assert.notEqual(again.id, published.id);
  // The partial unique index is mirrored in fixture: two published rows cannot coexist.
  await assert.rejects(data().updateClipPost(systemSession(), again.id, again.revision, { status: "published", step: "published", external_post_id: "9000000000000011_8" }), { code: "conflict" });
  // Another platform on the same clip and account is a different record.
  const instagram = await data().createClipPost(approver(), post(clip.id, connection.id, { platform: "instagram", sha256: clip.sha256 }));
  assert.equal(instagram.platform, "instagram");
});

test("only the system session writes a post row, and a lost update is a conflict", async () => {
  const { connection } = await world();
  const clip = (await data().listClipLibrary(approver(), {}))[0];
  const created = await data().createClipPost(approver(), post(clip.id, connection.id, { sha256: clip.sha256 }));
  await assert.rejects(data().updateClipPost(approver(), created.id, created.revision, { step: "uploaded" }), { code: "forbidden" });
  await assert.rejects(data().updateClipPost(staff(), created.id, created.revision, { step: "uploaded" }), { code: "forbidden" });
  const moved = await data().updateClipPost(systemSession(), created.id, created.revision, { step: "uploaded", external_video_id: "v1" });
  assert.equal(moved.revision, created.revision + 1);
  await assert.rejects(data().updateClipPost(systemSession(), created.id, created.revision, { step: "published" }), { code: "conflict" });
  const published = await data().updateClipPost(systemSession(), moved.id, moved.revision, { status: "published", step: "published", external_post_id: "9000000000000011_9" });
  await assert.rejects(data().updateClipPost(systemSession(), published.id, published.revision, { status: "failed" }), { code: "conflict" });
});

test("every publishing transition leaves an audit entry", async () => {
  const { connection } = await world();
  const clip = (await data().listClipLibrary(approver(), {}))[0];
  const created = await data().createClipPost(approver(), post(clip.id, connection.id, { sha256: clip.sha256 }));
  assert.deepEqual(created.audit?.map(entry => entry.action), ["clip_post_created"]);
  assert.equal(created.audit?.[0].actor, fixtureSession("producer").userId);
  const failed = await data().updateClipPost(systemSession(), created.id, created.revision, { status: "failed", error: "Meta refused the upload." });
  assert.deepEqual(failed.audit?.map(entry => entry.action), ["clip_post_created", "clip_post_failed"]);
  assert.equal(failed.audit?.[1].note, "Meta refused the upload.");
  const retried = await data().updateClipPost(systemSession(), failed.id, failed.revision, { status: "publishing", error: null }, { action: "clip_post_retried", actor: approver() });
  assert.equal(retried.audit?.at(-1)?.action, "clip_post_retried");
  assert.equal(retried.audit?.at(-1)?.actor, fixtureSession("producer").userId);
  const published = await data().updateClipPost(systemSession(), retried.id, retried.revision, { status: "published", step: "published", external_post_id: "9000000000000011_11" });
  assert.equal(published.audit?.at(-1)?.action, "clip_post_published");
  // The system actor is recorded as nobody, never as the approver.
  assert.equal(published.audit?.at(-1)?.actor, null);
});

test("listClipPosts scopes to the caller and filters by company and clip", async () => {
  const { own, other, connection } = await world();
  const clips = await data().listClipLibrary(approver(), {});
  await data().createClipPost(approver(), post(clips[0].id, connection.id, { sha256: clips[0].sha256 }));
  await data().createClipPost(approver(), post(clips[1].id, connection.id, { sha256: clips[1].sha256 }));
  assert.equal((await data().listClipPosts(approver())).length, 2);
  assert.equal((await data().listClipPosts(approver(), { clip_id: own.clips[0].id })).length, 1);
  assert.equal((await data().listClipPosts(staff(), { producer_id: other.id })).length, 0);
  assert.equal((await data().listClipPosts({ ...approver(), producerId: other.id })).length, 0);
});

test("reading Clips is open to every member; publishing is approver or staff administrator work", async () => {
  for (const op of ["list", "get", "pagePosts"] as const) {
    assert.deepEqual(clipRouteRoles(op), {}, `${op} must not demand a role beyond membership`);
  }
  for (const op of ["post", "retry"] as const) {
    assert.deepEqual(clipRouteRoles(op), { staffRole: "admin", producerMinRole: "approver" });
  }
  const { own, connection } = await world();
  const clip = (await data().listClipLibrary(approver(), {}))[0];
  const created = await data().createClipPost(approver(), post(clip.id, connection.id, { sha256: clip.sha256 }));
  // A viewer sees the clips and the state of a post; it just cannot make one.
  assert.equal((await data().listClipLibrary(viewer(), {})).length, own.clips.length);
  assert.equal((await data().getClipPost(viewer(), created.id)).id, created.id);
  assert.equal((await data().listClipPosts(viewer())).length, 1);
  assert.equal((await data().listClipLibrary(reviewer(), {})).length, own.clips.length);
});

test("staff previewing the producer portal may read the clips but not publish there", async () => {
  const { own, connection } = await world();
  const clip = (await data().listClipLibrary(approver(), {}))[0];
  const created = await data().createClipPost(approver(), post(clip.id, connection.id, { sha256: clip.sha256 }));
  // The producer route's reads take any session, so the portal preview works
  // the way the episode clips and presets routes already do.
  for (const op of ["list", "get", "pagePosts"] as const) {
    assert.equal(clipRouteRoles(op).producerMinRole, undefined, `${op} must not force a producer role`);
  }
  const seen = await data().listClipLibrary(staff(), { producer_id: ownCompany });
  assert.equal(seen.length, own.clips.length);
  assert.equal((await data().getClipPost(staff(), created.id)).id, created.id);
  // Publishing from the portal is still the company's approver or a staff admin.
  assert.equal(clipRouteRoles("post").producerMinRole, "approver");
  await assert.rejects(
    () => data().createClipPost(staffEditor(), post(clip.id, connection.id, { sha256: clip.sha256, again: true })),
    (e: Error & { code?: string }) => e.code === "forbidden",
  );
});

test("the launch workspace library carries the same rows with their posts", async () => {
  const { own, connection } = await world();
  const clip = (await data().listClipLibrary(approver(), {}))[0];
  const created = await data().createClipPost(approver(), post(clip.id, connection.id, { sha256: clip.sha256 }));
  const workspace = await data().getLaunchWorkspace(approver());
  assert.equal(workspace.library.length, own.clips.length);
  const item = workspace.library.find(row => row.id === clip.id)!;
  assert.equal(item.posts.length, 1);
  assert.equal(item.posts[0].id, created.id);
  assert.equal(item.clip_id, clip.id);
  assert.equal(item.episode_label, "1");
});
