// A finished ad uploaded as a clip (decision 2026-09-24): the bytes are used
// as delivered, the row is launchable at once, and a later re-cut can never
// delete it. Pure data-layer behaviour; the route's own guards are separate.

process.env.PROMO_RENDER = "off";

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { systemSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { putStoredBytes, safeFilename, uploadedClipFilename } from "@/lib/data/storage";
import { pickClipsForRound } from "@/lib/clips/creatives";
import { clipsToRender } from "@/lib/clips/run";
import { producer, staff } from "./seed-minute";

afterEach(() => resetFixtureStore());

const SHA = "a".repeat(64);

async function titleWithEpisode(withVideo: boolean) {
  resetFixtureStore();
  const title = await fixtureData.createTitle(producer(), { name_zh: "上传", name_en: "Upload", producer_id: "ignored" });
  const videoPath = `${title.id}/episode-1/source.mp4`;
  await putStoredBytes(videoPath, Buffer.from("not really an mp4"), "video/mp4");
  const episode = await fixtureData.addVideoOnlyEpisode(producer(), title.id, 1, withVideo ? videoPath : "");
  return { title, episode, videoPath };
}

test("an uploaded clip is rendered and launchable immediately, and keeps the delivered hash", async () => {
  const { title, episode, videoPath } = await titleWithEpisode(true);
  const clip = await fixtureData.addUploadedClip(systemSession(), episode.id, {
    render_path: videoPath, render_sha256: SHA, hook_en: "She said yes", duration_ms: 31_000, width: 1080, height: 1920,
  });
  assert.equal(clip.source, "upload");
  assert.equal(clip.render_status, "rendered", "no cutter run is needed");
  assert.equal(clip.render_sha256, SHA, "the delivered bytes' hash is kept as given");
  assert.equal(clip.render_path, videoPath);
  assert.equal(clip.hook_en, "She said yes");
  assert.equal(clip.cut_length_s, 31, "a 31 s ad is not clamped to the cutter's 20-30 s window");
  // The producer reads it, and it is eligible to become an ad.
  const mine = await fixtureData.listEpisodeClips(producer(), title.id, 1);
  assert.deepEqual(mine.map((c) => c.id), [clip.id]);
  assert.deepEqual(pickClipsForRound(mine, [episode]).map((c) => c.id), [clip.id]);
});

test("a later cutter run never deletes an uploaded clip", async () => {
  const { episode, videoPath } = await titleWithEpisode(true);
  const uploaded = await fixtureData.addUploadedClip(systemSession(), episode.id, {
    render_path: videoPath, render_sha256: SHA, hook_en: "mine", duration_ms: 25_000,
  });
  // upsertClips replaces 'suggested' rows; the uploaded row is 'shortlisted'.
  assert.equal(uploaded.status, "shortlisted");
  const after = await fixtureData.upsertClips(staff(), episode.id, [
    { rank: 1, start_ms: 0, end_ms: 25_000, scene_ids: [], hook_en: "", why_en: "footage", why_zh: "画面", source: "footage", moment: "opening" },
  ]);
  assert.ok(after.some((c) => c.id === uploaded.id), "the uploaded clip survives a re-cut");
  assert.equal(new Set(after.map((c) => c.rank)).size, after.length, "ranks stay unique");
});

test("a forced re-cut never re-renders an uploaded ad or a 60-second ad from the episode video", async () => {
  const { episode, videoPath } = await titleWithEpisode(true);
  const uploaded = await fixtureData.addUploadedClip(systemSession(), episode.id, {
    render_path: videoPath, render_sha256: SHA, hook_en: "delivered", duration_ms: 31_000,
  });
  const all = await fixtureData.upsertClips(staff(), episode.id, [
    { rank: 1, start_ms: 0, end_ms: 25_000, scene_ids: [], hook_en: "", why_en: "footage", why_zh: "画面", source: "footage", moment: "opening" },
  ]);
  const cut = all.find((c) => c.source === "footage")!;
  const montage = { ...cut, id: "montage-row", rank: 1001, moment: "montage" as const, status: "shortlisted" as const, render_status: "rendered" as const };
  for (const force of [false, true]) {
    const picked = clipsToRender([...all, montage], force).map((c) => c.id);
    assert.deepEqual(picked, [cut.id], `force=${force}: only the cutter's own clip is cut`);
    assert.ok(!picked.includes(uploaded.id), "the delivered file is never replaced by a window of the episode");
  }
});

test("an uploaded clip does not need the episode to have a video or timecodes", async () => {
  const { episode, videoPath } = await titleWithEpisode(false);
  // The cutter refuses this episode outright...
  await assert.rejects(
    fixtureData.upsertClips(staff(), episode.id, [
      { rank: 1, start_ms: 0, end_ms: 25_000, scene_ids: [], hook_en: "", why_en: "f", why_zh: "画", source: "footage" },
    ]),
    /timed episode or an episode with video/
  );
  // ...but an uploaded ad carries its own finished file.
  const clip = await fixtureData.addUploadedClip(systemSession(), episode.id, {
    render_path: videoPath, render_sha256: SHA, hook_en: "standalone",
  });
  assert.equal(clip.render_status, "rendered");
  assert.equal(clip.end_ms, 0, "no duration given means no invented range");
});

test("a producer session cannot write a clip row directly", async () => {
  const { episode, videoPath } = await titleWithEpisode(true);
  await assert.rejects(
    fixtureData.addUploadedClip(producer(), episode.id, { render_path: videoPath, render_sha256: SHA, hook_en: "x" }),
    /staff|forbidden/i,
    "clip writes stay with staff / the system actor, as the SQL policies have it"
  );
});

test("an uploaded ad never shares an object key with another clip or the episode's own video", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  // The same careless filename twice — the common case, since editors export
  // `ad.mp4` every time — must not resolve to one object.
  assert.notEqual(uploadedClipFilename(a, "ad.mp4"), uploadedClipFilename(b, "ad.mp4"));
  // Identical bytes reuse one object: a genuine re-upload is idempotent.
  assert.equal(uploadedClipFilename(a, "ad.mp4"), uploadedClipFilename(a, "ad.mp4"));
  // And it can never collide with the episode source, stored by bare name
  // through the replace-video route.
  assert.notEqual(uploadedClipFilename(a, "ep1.mp4"), safeFilename("ep1.mp4"));
  // A hostile name is still sanitised.
  assert.equal(uploadedClipFilename(a, "../../etc/passwd"), `upload-${a.slice(0, 16)}-passwd`);
});
