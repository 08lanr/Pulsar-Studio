// Ad types on clips (decision 2026-09-25): the registry guard, the data
// layer (fixture) and both routes — the upload's optional `ad_format` field
// and POST .../clips/[clipId]/format — in fixture mode, through the real
// handlers with a dev-session cookie.

process.env.PROMO_RENDER = "off";
// The handler boots the TikTok scheduler on a first request unless NODE_ENV is "test".
(process.env as Record<string, string>).NODE_ENV = "test";

// Next's server entry sets globalThis.AsyncLocalStorage before its request
// storage loads; a route imported outside a server needs the same first.
import "next/dist/server/node-environment";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
// The request scope Next gives a route handler: cookies() reads the dev
// session from it, exactly as in a running server.
import { requestAsyncStorage } from "next/dist/client/components/request-async-storage.external";

import { DEV_SESSION_COOKIE, systemSession } from "@/lib/auth";
import { AD_FORMATS, AD_FORMAT_INFO, AD_FORMAT_MIGRATION_MESSAGE, adFormatChoices, adFormatColumnMissing, adFormatMatches, isAdFormat } from "@/lib/ad-formats";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { putStoredBytes } from "@/lib/data/storage";
import { POST as upload } from "@/app/api/titles/[id]/clips/upload/route";
import { POST as setFormat } from "@/app/api/titles/[id]/clips/[clipId]/format/route";
import { producer, staff } from "./seed-minute";

afterEach(() => resetFixtureStore());

const SHA = "c".repeat(64);
const HOST = "localhost:3200";

async function titleWithEpisode() {
  resetFixtureStore();
  const title = await fixtureData.createTitle(producer(), { name_zh: "类型", name_en: "Types", producer_id: "ignored" });
  const videoPath = `${title.id}/episode-1/source.mp4`;
  await putStoredBytes(videoPath, Buffer.from("not really an mp4"), "video/mp4");
  const episode = await fixtureData.addVideoOnlyEpisode(producer(), title.id, 1, videoPath);
  return { title, episode, videoPath };
}

/** Run a route handler inside a request scope whose dev-session cookie is `who`. */
function asCookie<T>(who: string, run: () => Promise<T>): Promise<T> {
  const cookies = { get: (name: string) => (name === DEV_SESSION_COOKIE ? { name, value: who } : undefined) };
  const store = { cookies, mutableCookies: cookies, headers: new Headers(), draftMode: {} };
  return requestAsyncStorage.run(store as never, run);
}

function uploadRequest(titleId: string, fields: Record<string, string>, origin?: string) {
  const form = new FormData();
  form.set("video", new File([Buffer.from(`finished ad ${Math.random()}`)], "ad.mp4", { type: "video/mp4" }));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new NextRequest(`http://${HOST}/api/titles/${titleId}/clips/upload`, {
    method: "POST", body: form, headers: { host: HOST, ...(origin ? { origin } : {}) },
  });
}

function formatRequest(titleId: string, clipId: string, body: unknown, origin?: string) {
  return new NextRequest(`http://${HOST}/api/titles/${titleId}/clips/${clipId}/format`, {
    method: "POST", body: JSON.stringify(body), headers: { host: HOST, "content-type": "application/json", ...(origin ? { origin } : {}) },
  });
}

// ---- the registry --------------------------------------------------------------------------------

test("the registry names exactly the four ad types, and the guard accepts only those", () => {
  assert.deepEqual([...AD_FORMATS], ["hook_ad", "narration_trailer", "direct_cuts_trailer", "clip", "quick_hook"]);
  for (const f of AD_FORMATS) {
    assert.equal(isAdFormat(f), true, f);
    assert.equal(AD_FORMAT_INFO[f].id, f);
    assert.ok(AD_FORMAT_INFO[f].label_en && AD_FORMAT_INFO[f].description_en);
  }
  for (const bad of ["", "Hook ad", "HOOK_AD", "hook", "montage", "direct_clip", null, undefined, 1, {}]) {
    assert.equal(isAdFormat(bad), false, String(bad));
  }
});

test("a live database without migration 0023 is recognised, and the sentence names the migration", () => {
  assert.equal(adFormatColumnMissing({ code: "PGRST204", message: "Could not find the 'ad_format' column of 'clips' in the schema cache" }), true);
  assert.equal(adFormatColumnMissing({ code: "42703", message: 'column "ad_format" of relation "clips" does not exist' }), true);
  assert.equal(adFormatColumnMissing({ code: "PGRST204", message: "Could not find the 'pieces' column of 'clips' in the schema cache" }), false);
  assert.equal(adFormatColumnMissing({ code: "23514", message: 'new row violates check constraint "clips_source_check"' }), false);
  assert.match(AD_FORMAT_MIGRATION_MESSAGE, /0023_clip_ad_format\.sql/);
});

// ---- the data layer (fixture) --------------------------------------------------------------------

test("an uploaded clip keeps its ad type; without one it is not classified", async () => {
  const { episode, videoPath } = await titleWithEpisode();
  const typed = await fixtureData.addUploadedClip(systemSession(), episode.id, { render_path: videoPath, render_sha256: SHA, hook_en: "typed", ad_format: "hook_ad" });
  assert.equal(typed.ad_format, "hook_ad");
  const plain = await fixtureData.addUploadedClip(systemSession(), episode.id, { render_path: videoPath, render_sha256: SHA, hook_en: "plain" });
  assert.equal(plain.ad_format ?? null, null);
  await assert.rejects(
    fixtureData.addUploadedClip(systemSession(), episode.id, { render_path: videoPath, render_sha256: SHA, hook_en: "bad", ad_format: "teaser" as never }),
    (e: unknown) => (e as { code?: string }).code === "invalid"
  );
});

test("setClipAdFormat labels and clears a clip, refuses an unknown type, a producer session and another title's clip", async () => {
  const { title, episode, videoPath } = await titleWithEpisode();
  const clip = await fixtureData.addUploadedClip(systemSession(), episode.id, { render_path: videoPath, render_sha256: SHA, hook_en: "x" });
  assert.equal((await fixtureData.setClipAdFormat(systemSession(), title.id, clip.id, "narration_trailer")).ad_format, "narration_trailer");
  const [listed] = await fixtureData.listEpisodeClips(producer(), title.id, 1);
  assert.equal(listed.ad_format, "narration_trailer", "the producer reads the label");
  assert.equal((await fixtureData.setClipAdFormat(staff(), title.id, clip.id, null)).ad_format, null);
  await assert.rejects(fixtureData.setClipAdFormat(systemSession(), title.id, clip.id, "trailer" as never), (e: unknown) => (e as { code?: string }).code === "invalid");
  await assert.rejects(fixtureData.setClipAdFormat(producer(), title.id, clip.id, "clip"), (e: unknown) => (e as { code?: string }).code === "forbidden");
  const other = await fixtureData.createTitle(producer(), { name_zh: "别的", name_en: "Other", producer_id: "ignored" });
  await assert.rejects(fixtureData.setClipAdFormat(systemSession(), other.id, clip.id, "clip"), (e: unknown) => (e as { code?: string }).code === "not_found");
});

// ---- the upload route ----------------------------------------------------------------------------

test("the upload route takes an optional ad_format and refuses an unknown one before storing anything", async () => {
  const { title } = await titleWithEpisode();

  const typed = await asCookie("producer", () => upload(uploadRequest(title.id, { hook: "She said yes", ad_format: "direct_cuts_trailer" }), { params: { id: title.id } }));
  assert.equal(typed.status, 201);
  assert.equal(((await typed.json()) as { clip: { ad_format: string } }).clip.ad_format, "direct_cuts_trailer");

  const plain = await asCookie("producer", () => upload(uploadRequest(title.id, { hook: "no type" }), { params: { id: title.id } }));
  assert.equal(plain.status, 201);
  assert.equal(((await plain.json()) as { clip: { ad_format?: string | null } }).clip.ad_format ?? null, null);

  const before = (await fixtureData.listEpisodeClips(producer(), title.id)).length;
  const bad = await asCookie("producer", () => upload(uploadRequest(title.id, { ad_format: "teaser" }), { params: { id: title.id } }));
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /unknown ad type/);
  assert.equal((await fixtureData.listEpisodeClips(producer(), title.id)).length, before, "a refused upload adds no clip");
});

// ---- the format route ----------------------------------------------------------------------------

test("the format route sets and clears a clip's ad type for the title's editor and staff", async () => {
  const { title, episode, videoPath } = await titleWithEpisode();
  const clip = await fixtureData.addUploadedClip(systemSession(), episode.id, { render_path: videoPath, render_sha256: SHA, hook_en: "x" });
  const params = { params: { id: title.id, clipId: clip.id } };

  const set = await asCookie("producer", () => setFormat(formatRequest(title.id, clip.id, { ad_format: "hook_ad" }), params));
  assert.equal(set.status, 200);
  assert.equal(((await set.json()) as { clip: { ad_format: string } }).clip.ad_format, "hook_ad");

  const cleared = await asCookie("staff", () => setFormat(formatRequest(title.id, clip.id, { ad_format: null }), params));
  assert.equal(cleared.status, 200);
  assert.equal(((await cleared.json()) as { clip: { ad_format: string | null } }).clip.ad_format, null);
  assert.equal((await fixtureData.listEpisodeClips(producer(), title.id))[0].ad_format, null);
});

test("the format route refuses a bad body, a stranger, another title's clip, a signed-out caller and a cross-origin request", async () => {
  const { title, episode, videoPath } = await titleWithEpisode();
  const clip = await fixtureData.addUploadedClip(systemSession(), episode.id, { render_path: videoPath, render_sha256: SHA, hook_en: "x" });
  const params = { params: { id: title.id, clipId: clip.id } };

  for (const body of [{ ad_format: "teaser" }, {}, { ad_format: 3 }]) {
    const r = await asCookie("producer", () => setFormat(formatRequest(title.id, clip.id, body), params));
    assert.equal(r.status, 400, JSON.stringify(body));
  }

  const company = await fixtureData.createProducer(staff(), { name_zh: "别家影视" });
  const foreign = await asCookie(`producer:${company.id}`, () => setFormat(formatRequest(title.id, clip.id, { ad_format: "clip" }), params));
  assert.equal(foreign.status, 404, "a foreign title is not found, never forbidden");

  const other = await fixtureData.createTitle(producer(), { name_zh: "别的", name_en: "Other", producer_id: "ignored" });
  const elsewhere = await asCookie("producer", () => setFormat(formatRequest(other.id, clip.id, { ad_format: "clip" }), { params: { id: other.id, clipId: clip.id } }));
  assert.equal(elsewhere.status, 404, "a clip of another title is not found");

  const signedOut = await asCookie("", () => setFormat(formatRequest(title.id, clip.id, { ad_format: "clip" }), params));
  assert.equal(signedOut.status, 401);

  const cross = await asCookie("producer", () => setFormat(formatRequest(title.id, clip.id, { ad_format: "clip" }, "https://elsewhere.example"), params));
  assert.equal(cross.status, 403);

  assert.equal((await fixtureData.listEpisodeClips(producer(), title.id))[0].ad_format ?? null, null, "nothing refused changed the clip");
});

test("one ad-type filter for the clip picker, the Clips page and both stats tabs (2026-10-01)", () => {
  assert.equal(adFormatMatches("quick_hook", ""), true, "no filter: every ad");
  assert.equal(adFormatMatches(null, null), true);
  assert.equal(adFormatMatches("quick_hook", "quick_hook"), true);
  assert.equal(adFormatMatches("narration_trailer", "quick_hook"), false);
  assert.equal(adFormatMatches(null, "quick_hook"), false, "an unclassified ad is no type");
  assert.equal(adFormatMatches(null, "none"), true, "none = the ads nobody classified");
  assert.equal(adFormatMatches(undefined, "none"), true);
  assert.equal(adFormatMatches("quick_hook", "none"), false);
  // Only the types the list holds, in AD_FORMATS order, then "none".
  assert.deepEqual(adFormatChoices(["quick_hook", null, "narration_trailer", "quick_hook"]), ["narration_trailer", "quick_hook", "none"]);
  assert.deepEqual(adFormatChoices([]), []);
});
