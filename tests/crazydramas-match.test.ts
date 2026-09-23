// The crazydramas connection, the pure half (decision 2026-09-23; plan A1,
// A3, A8): the whitelist parse of the saved public bodies (no playback id,
// no thumbnail URL, the mock series dropped), the frame rule against the
// real numbers (Mafia King's 52 zip files give 52 × same_length; the current
// re-renders read same_length or close; He Hated All Women's six re-rendered
// boundaries read different_length; never ±0.1 s), every series state the
// chip can show, which slug a check reads, and the guard that no credential
// value and no live request can reach a test.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fakeCrazydramasTransport, FAKE_SLUGS } from "@/lib/crazydramas/fake";
import {
  CRAZYDRAMAS_STATES,
  EPISODE_VERDICTS,
  FRAME_RULE,
  MUX_FRAME_OFFSET,
  chipReading,
  crazydramasStatusFor,
  frameDelta,
  inferFps,
  isHotState,
  matchEpisodes,
  stateFromMatch,
  verdictForDelta,
  type StudioEpisodeForMatch,
} from "@/lib/crazydramas/match";
import { resolveReadSlug } from "@/lib/crazydramas/sweep";
import { CrazydramasApiError, crazydramasBaseUrl, crazydramasPublicUrl, liveCrazydramasTransport } from "@/lib/crazydramas/transport";
import { isMockSlug, parseCatalog, parseSeries, platformSnapshotRow, PublicDramaSchema } from "@/lib/crazydramas/types";
import type { PlatformEpisode, PlatformLink, PlatformSnapshot } from "@/lib/types";

const DIR = path.join(process.cwd(), "tests", "fixtures", "crazydramas");
const body = (name: string): unknown => JSON.parse(readFileSync(path.join(DIR, name), "utf8"));
const FRAMES = body("studio-frames.json") as Record<string, { fps: number; zip?: [number, number][]; current: [number, number][]; boundary_fixes?: number[]; ep01_duration_ms?: number }>;

const MAFIA = "forced-to-marry-the-mafia-boss";
const RHW = "my-new-billionaire-husband";
const HHAW = "one-night-with-the-billionaire-who-hated-women";

/** Studio episode rows from a [n, frames] table at 30 fps: the measured length is frames/fps, as the import records it. */
const studioRows = (pairs: [number, number][], fps = 30): StudioEpisodeForMatch[] => pairs.map(([n, frames]) => ({ number: n, video_frames: frames, duration_ms: Math.round((frames / fps) * 1000), video_sha256: null }));

const snapshotOf = (slug: string, over: Partial<PlatformSnapshot> = {}): PlatformSnapshot => {
  const parsed = parseSeries(body(`d-${slug}.json`));
  return { id: `snap-${slug}`, platform: "crazydramas", slug, cd_drama_id: parsed.drama.id, title_id: "t1", http_status: 200, drama: parsed.drama, episodes: parsed.episodes, read_at: "2026-09-23T07:40:00.000Z", error: null, ...over };
};

// ---- the whitelist ------------------------------------------------------------------------------------

test("the saved public bodies parse through the whitelist: no playback id, no thumbnail, the fields the plan names, episodes sorted", () => {
  for (const slug of [MAFIA, RHW, HHAW, "he-mocked-her-crush-on-him-and-sent-her", "he-treated-our-love-like-a-prank", "ever-since-i-played-that-game-paranormal"]) {
    const s = parseSeries(body(`d-${slug}.json`));
    assert.equal(s.http_status, 200);
    assert.equal(s.drama.slug, slug);
    assert.match(s.drama.id, /^[0-9a-f-]{36}$/);
    assert.equal(s.drama.status, "published");
    assert.equal(s.drama.free_episode_count, 5);
    assert.equal(s.drama.series_price_cents, 999);
    assert.equal(s.drama.iap_product_id, `crazydrama.series.${slug.replace(/-/g, "_")}`);
    assert.equal(s.drama.episode_count, s.episodes.length);
    assert.ok(s.episodes.every((e, i) => e.n === i + 1 && e.status === "ready" && e.is_published && typeof e.duration_s === "number"), `${slug}: 1..N, ready, published, with a length`);
    const text = JSON.stringify(s);
    assert.doesNotMatch(text, /playbackId|thumbnailUrl|previewPlaybackId|image\.mux\.com/, `${slug} carries no playback id or thumbnail`);
    assert.doesNotMatch(text, /"tagline"|"description"|"genre"/, "only the named fields survive");
  }
  assert.equal(parseSeries(body(`d-${MAFIA}.json`)).episodes.length, 52);
  assert.ok(parseSeries(body("d-he-mocked-her-crush-on-him-and-sent-her.json")).drama.poster_url?.includes("-placeholder"), "the placeholder poster is visible through the whitelist");
});

test("a body that carries the leaking fields is stripped, whatever their position; the catalog drops mock- slugs", () => {
  const leaky = {
    drama: {
      id: "01e0f703-725e-4b7c-8770-57a87cc75cff", slug: "x", title: "X", status: "published", freeEpisodeCount: 5, seriesPriceCents: 999, iapProductId: null,
      posterUrl: null, posterBlurhash: null, episodeCount: 1, thumbnailUrl: "https://image.mux.com/LEAK/thumbnail.jpg", previewPlaybackId: "LEAK",
      episodes: [{ id: "e", dramaId: "d", episodeNumber: 1, playbackId: "LEAK", durationSeconds: 100, thumbnailUrl: "https://image.mux.com/LEAK/thumbnail.jpg", subtitleUrl: null, isFree: true, status: "ready", isPublished: true }],
    },
    entitled: false,
  };
  const s = parseSeries(leaky);
  assert.doesNotMatch(JSON.stringify(s), /LEAK|playback|thumbnail/i);
  assert.deepEqual(s.episodes, [{ n: 1, duration_s: 100, status: "ready", is_published: true }]);
  assert.equal(PublicDramaSchema.parse(leaky.drama).slug, "x");
  assert.throws(() => parseSeries({ drama: { slug: "no-id" } }), "a body that is not a series is refused, not guessed");

  const catalog = parseCatalog(body("dramas.json"));
  assert.equal(catalog.length, 6, "the live catalog read with pulsar_mock=0 lists the six real series");
  assert.deepEqual(catalog.map((d) => d.slug).sort(), [MAFIA, RHW, HHAW, "ever-since-i-played-that-game-paranormal", "he-mocked-her-crush-on-him-and-sent-her", "he-treated-our-love-like-a-prank"].sort());
  assert.equal(catalog.filter((d) => d.poster_url?.includes("-placeholder")).length, 3, "three live series carry a placeholder poster");
  const withMocks = { dramas: [...(body("dramas.json") as { dramas: unknown[] }).dramas, { ...(body("dramas.json") as { dramas: Record<string, unknown>[] }).dramas[0], id: "11111111-2222-4333-8444-555555555555", slug: "mock-the-billionaire" }] };
  assert.equal(parseCatalog(withMocks).length, 6, "a mock- series the edge cache mixed in is dropped");
  assert.ok(isMockSlug("mock-x") && !isMockSlug("mocking-bird"));
  assert.throws(() => platformSnapshotRow({ platform: "crazydramas", slug: "x", http_status: 200, drama: { ...catalog[0], playbackId: "LEAK" } as never, episodes: [] }), { code: "invalid" }, "a hand-built body with a leaking key never reaches a row");
});

// ---- the frame rule against the real numbers -------------------------------------------------------------

test("Mafia King: all 52 zip files are exactly +2 against Mux (same_length); the current renders read same_length or close; fps is inferred from the import's own numbers", () => {
  const live = parseSeries(body(`d-${MAFIA}.json`)).episodes;
  const zip = matchEpisodes(studioRows(FRAMES[MAFIA].zip!), live, { free_episode_count: 5 });
  assert.equal(zip.counts.same_length, 52);
  assert.equal(zip.counts.studio, 52);
  assert.equal(zip.counts.live, 52);
  assert.ok(zip.numbered_1_to_n);
  assert.ok(zip.episodes.every((e) => e.d_frames === MUX_FRAME_OFFSET), "d == +2 on every file");
  assert.equal(stateFromMatch(zip), "live_complete");
  assert.deepEqual(zip.episodes.slice(0, 6).map((e) => e.paid), [false, false, false, false, false, true], "free is 1..5");

  const current = matchEpisodes(studioRows(FRAMES[MAFIA].current), live);
  assert.equal(current.counts.same_length + current.counts.close, 52, "a re-render is one frame shorter: +3, close");
  assert.equal(current.counts.different_length, 0);
  assert.equal(current.counts.close, 21);
  assert.equal(stateFromMatch(current), "live_complete", "close reads as an older render, not another cut");

  assert.equal(inferFps(3495, FRAMES[MAFIA].ep01_duration_ms), 30, "ep01: 3495 frames over 116.5 s");
  assert.equal(inferFps(120, 4000), 30);
  assert.equal(inferFps(2398, 100_000), 23.976);
  assert.equal(inferFps(null, 4000), null);
  assert.equal(inferFps(151, 5000), null, "151 frames over exactly 5 s names no standard rate: unknown, never a guess");
  assert.equal(matchEpisodes([{ number: 1, video_frames: 3495, duration_ms: null }], live).episodes[0].verdict, "unknown");
  assert.equal(matchEpisodes([{ number: 1, video_frames: 3495, duration_ms: null }], live, { fps: 30 }).episodes[0].verdict, "same_length", "the film's own fps, when the caller has it");
});

test("Reclaiming Her World's current renders read same_length or close (+3 and +4); He Hated All Women's six re-rendered boundaries read different_length", () => {
  const rhw = matchEpisodes(studioRows(FRAMES[RHW].current), parseSeries(body(`d-${RHW}.json`)).episodes);
  assert.equal(rhw.counts.studio, 53);
  assert.equal(rhw.counts.different_length, 0);
  assert.equal(rhw.counts.missing + rhw.counts.extra, 0);
  assert.ok(rhw.counts.close > 0 && rhw.counts.same_length > 0);
  assert.ok(rhw.episodes.every((e) => [2, 3, 4].includes(e.d_frames!)), "+2, +3 or +4 only");
  assert.equal(stateFromMatch(rhw), "live_complete");

  const hh = matchEpisodes(studioRows(FRAMES[HHAW].current), parseSeries(body(`d-${HHAW}.json`)).episodes);
  assert.equal(hh.counts.studio, 64);
  assert.equal(hh.counts.different_length, 6);
  assert.deepEqual(hh.episodes.filter((e) => e.verdict === "different_length").map((e) => e.n), FRAMES[HHAW].boundary_fixes, "exactly the six episodes whose boundaries moved");
  assert.equal(stateFromMatch(hh), "live_differs");
});

test("the rule is frames, never ±0.1 s: a file within a tenth of a second but off the offset is another length; +1/+3/+4 are close; the offset is one named constant, calibrated on one film", () => {
  assert.equal(MUX_FRAME_OFFSET, 2);
  assert.equal(FRAME_RULE.calibrated_on, MAFIA);
  assert.equal(FRAME_RULE.calibrated_files, 52);
  assert.equal(FRAME_RULE.confirmed, false, "confirmed only by the first Studio-made upload");
  assert.deepEqual(FRAME_RULE.close, [1, 3, 4]);
  const live: PlatformEpisode[] = [{ n: 1, duration_s: 116.5, status: "ready", is_published: true }];
  const s = matchEpisodes([{ number: 1, video_frames: 3495, duration_ms: 116_500 }], live);
  assert.equal(s.episodes[0].d_frames, 0);
  assert.equal(s.episodes[0].verdict, "different_length", "0.000 s apart and yet not the Mux offset: not the same file's length");
  assert.equal(verdictForDelta(2), "same_length");
  assert.equal(verdictForDelta(1), "close");
  assert.equal(verdictForDelta(3), "close");
  assert.equal(verdictForDelta(4), "close");
  assert.equal(verdictForDelta(5), "different_length");
  assert.equal(verdictForDelta(-2), "different_length");
  assert.equal(verdictForDelta(null), "unknown");
  assert.equal(frameDelta(116.567, 30, 3495), 2);
  assert.equal(frameDelta(null, 30, 3495), null);
  assert.equal(frameDelta(116.567, null, 3495), null);
});

// ---- the per-episode verdicts and every series state ----------------------------------------------------------

test("missing, extra, not_ready and unknown pair by number; not_ready and missing read partial, extra and a gap read differs, unknown reads unverified", () => {
  // The fixture film's own counts (ffprobe on tests/fixtures/workspace: 120, 150, 180 at 30 fps) against the lengths Mux would report.
  const studio = studioRows([[1, 120], [2, 150], [3, 180]]);
  const complete: PlatformEpisode[] = [{ n: 1, duration_s: 4.067, status: "ready", is_published: true }, { n: 2, duration_s: 5.067, status: "ready", is_published: true }, { n: 3, duration_s: 6.067, status: "ready", is_published: true }];
  assert.equal(stateFromMatch(matchEpisodes(studio, complete)), "live_complete");

  const missing = matchEpisodes(studio, complete.slice(0, 2));
  assert.equal(missing.episodes[2].verdict, "missing");
  assert.equal(missing.episodes[2].live, null);
  assert.equal(stateFromMatch(missing), "live_partial");

  const extra = matchEpisodes(studio.slice(0, 2), complete);
  assert.equal(extra.episodes[2].verdict, "extra");
  assert.equal(extra.episodes[2].studio, null);
  assert.equal(stateFromMatch(extra), "live_differs");

  const processing = matchEpisodes(studio, [...complete.slice(0, 2), { n: 3, duration_s: null, status: "processing", is_published: true }]);
  assert.equal(processing.episodes[2].verdict, "not_ready");
  assert.equal(processing.counts.ready, 2);
  assert.equal(stateFromMatch(processing), "live_partial");
  assert.equal(matchEpisodes(studio, [...complete.slice(0, 2), { n: 3, duration_s: 6.067, status: "failed", is_published: true }]).episodes[2].verdict, "not_ready", "a failed asset is not ready whatever its length says");

  const gap = matchEpisodes(studioRows([[1, 120], [3, 180]]), [complete[0], complete[2]]);
  assert.equal(gap.numbered_1_to_n, false);
  assert.equal(stateFromMatch(gap), "live_differs", "the platform's numbers are not 1..N");

  const unknown = matchEpisodes([{ number: 1 }, ...studio.slice(1)], complete);
  assert.equal(unknown.episodes[0].verdict, "unknown");
  assert.equal(stateFromMatch(unknown), "live_unverified");

  const differs = matchEpisodes(studio, [{ ...complete[0], duration_s: 4.5 }, complete[1], complete[2]]);
  assert.equal(differs.episodes[0].verdict, "different_length");
  assert.equal(stateFromMatch(differs), "live_differs");
  assert.equal(stateFromMatch(matchEpisodes(studio, [{ ...complete[0], duration_s: 4.5 }, complete[1]])), "live_partial", "missing wins over differs: first rule that applies");
});

test("identical and local_newer exist only with a ledger (plan A6, not built): never produced from a duration alone", () => {
  const studio: StudioEpisodeForMatch[] = [{ number: 1, video_frames: 120, duration_ms: 4000, video_sha256: "a".repeat(64) }];
  const live: PlatformEpisode[] = [{ n: 1, duration_s: 4.067, status: "ready", is_published: true }];
  assert.equal(matchEpisodes(studio, live).episodes[0].verdict, "same_length", "a duration match proves only same length");
  const ledger = [{ episode_number: 1, uploaded_sha256: "a".repeat(64), mux_duration_s: 4.067 }];
  assert.equal(matchEpisodes(studio, live, { ledger }).episodes[0].verdict, "identical");
  assert.equal(matchEpisodes(studio, live, { ledger: [{ ...ledger[0], mux_duration_s: 4.5 }] }).episodes[0].verdict, "same_length", "the ledger's Mux length must pass the rule too");
  const rendered = [{ ...studio[0], video_sha256: "b".repeat(64) }];
  assert.equal(stateFromMatch(matchEpisodes(rendered, live, { ledger }), { ledger, studio: rendered }), "local_newer");
  assert.equal(stateFromMatch(matchEpisodes(studio, live, { ledger }), { ledger, studio }), "live_complete");
});

test("crazydramasStatusFor: every chip state from what the data layer holds, the checked time as observed, the failed read shown stale over the last good one", () => {
  const studio = studioRows(FRAMES[MAFIA].zip!);
  const link: PlatformLink = { id: "l1", title_id: "t1", platform: "crazydramas", slug: MAFIA, title_slug: MAFIA, cd_drama_id: "01e0f703-725e-4b7c-8770-57a87cc75cff", linked_at: "2026-09-23T07:00:00.000Z", linked_by: null };
  const good = snapshotOf(MAFIA);
  const notFound: PlatformSnapshot = { ...good, id: "s404", http_status: 404, drama: null, episodes: null, cd_drama_id: link.cd_drama_id };
  const failed: PlatformSnapshot = { ...good, id: "sfail", http_status: null, drama: null, episodes: null, error: "crazydramas did not answer (timeout, DNS or a refused connection).", read_at: "2026-09-23T08:00:00.000Z" };

  const notLinked = crazydramasStatusFor({ crazydramas_slug: null }, studio, [good], null);
  assert.equal(notLinked.state, "not_linked");
  assert.equal(notLinked.slug, null);
  assert.equal(notLinked.episodes.length, 0);
  assert.equal(notLinked.counts.studio, 52);

  assert.equal(crazydramasStatusFor({ crazydramas_slug: MAFIA }, studio, [], null).state, "not_checked");
  assert.equal(crazydramasStatusFor({ crazydramas_slug: MAFIA }, studio, null, null).state, "not_checked");

  const live = crazydramasStatusFor({ crazydramas_slug: MAFIA }, studio, [good], link);
  assert.equal(live.state, "live_complete");
  assert.equal(live.checked_at, good.read_at, "the observed time is the snapshot's read time");
  assert.equal(live.stale, false);
  assert.equal(live.http_status, 200);
  assert.equal(live.series?.title, "Forced to Marry the Mafia Boss");
  assert.equal(live.series?.iap_product_set, true);
  assert.equal(live.series?.poster_placeholder, false);
  assert.equal(live.series?.series_price_cents, 999);
  assert.deepEqual(live.free_paid, { free: 5, paid: 47 });
  assert.equal(live.counts.same_length, 52);
  assert.deepEqual(live.link, { cd_drama_id: link.cd_drama_id, slug: MAFIA, linked_at: link.linked_at });
  assert.equal(live.frame_rule.offset, 2);
  assert.equal(crazydramasStatusFor({ crazydramas_slug: MAFIA }, studio, good, link).state, "live_complete", "one snapshot or the newest-first list");

  const notLive = crazydramasStatusFor({ crazydramas_slug: MAFIA }, studio, [notFound], link);
  assert.equal(notLive.state, "not_live");
  assert.equal(notLive.http_status, 404);
  assert.equal(notLive.series, null);
  assert.equal(notLive.checked_at, notFound.read_at);

  const stale = crazydramasStatusFor({ crazydramas_slug: MAFIA }, studio, [failed, good], link);
  assert.equal(stale.state, "read_failed");
  assert.equal(stale.stale, true, "the last good read is shown, marked stale");
  assert.equal(stale.checked_at, good.read_at);
  assert.equal(stale.failed_at, failed.read_at);
  assert.equal(stale.error, failed.error);
  assert.equal(stale.counts.same_length, 52, "the verdicts come from the last good read");
  const noGood = crazydramasStatusFor({ crazydramas_slug: MAFIA }, studio, [failed], link);
  assert.equal(noGood.state, "read_failed");
  assert.equal(noGood.stale, false);
  assert.equal(noGood.series, null);

  assert.equal(crazydramasStatusFor({ crazydramas_slug: MAFIA }, studio.slice(0, 50), [good], link).state, "live_differs", "two extra on crazydramas");
  assert.equal(crazydramasStatusFor({ crazydramas_slug: MAFIA }, [...studio, { number: 53, video_frames: 3000, duration_ms: 100_000 }], [good], link).state, "live_partial");
  assert.equal(crazydramasStatusFor({ crazydramas_slug: MAFIA }, [{ number: 1 }, ...studio.slice(1)], [good], link).state, "live_unverified");
  assert.equal(crazydramasStatusFor({ crazydramas_slug: HHAW }, studioRows(FRAMES[HHAW].current), [snapshotOf(HHAW)], null).state, "live_differs");

  // The link names the drama: a 200 for another drama under the slug is a CMS rename, read as not live and said so.
  const other = snapshotOf(MAFIA, { drama: { ...good.drama!, id: "b03e20e3-dac1-4c20-9903-5f37664aeda9" } });
  const reassigned = crazydramasStatusFor({ crazydramas_slug: MAFIA }, studio, [other], link);
  assert.equal(reassigned.state, "not_live");
  assert.equal(reassigned.note, "slug_reassigned");

  // The link's slug wins over the title's: it follows the platform's rename.
  assert.equal(crazydramasStatusFor({ crazydramas_slug: "old-slug" }, studio, [good], link).slug, MAFIA);

  const seen = new Set<string>();
  for (const s of [notLinked, live, notLive, stale, reassigned]) seen.add(s.state);
  seen.add("not_checked");
  seen.add("live_partial");
  seen.add("live_differs");
  seen.add("live_unverified");
  for (const state of CRAZYDRAMAS_STATES) if (state !== "local_newer") assert.ok(seen.has(state), `state ${state} is reachable`);
  assert.equal(EPISODE_VERDICTS.length, 8);
  assert.ok(isHotState("live_partial") && isHotState("live_differs") && !isHotState("live_complete") && !isHotState("not_live") && !isHotState("read_failed"));

  // The chip's reading: "complete" carries "older renders" only when an episode reads close, and never a count.
  assert.deepEqual(chipReading(live), { state: "live_complete", stale: false, older: false });
  assert.deepEqual(chipReading(crazydramasStatusFor({ crazydramas_slug: MAFIA }, studioRows(FRAMES[MAFIA].current), [good], link)), { state: "live_complete", stale: false, older: true }, "the current Mafia King renders: 21 close");
  assert.deepEqual(chipReading(stale), { state: "read_failed", stale: true, older: false });
  assert.deepEqual(chipReading(crazydramasStatusFor({ crazydramas_slug: HHAW }, studioRows(FRAMES[HHAW].current), [snapshotOf(HHAW)], null)), { state: "live_differs", stale: false, older: false }, "older is said only of a complete series");
});

// ---- which slug a check reads -------------------------------------------------------------------------------

test("resolveReadSlug: the title's slug before a link, the link's after; the catalog's slug follows a CMS rename and keeps following it; a slug the person re-pointed in Studio is read instead", () => {
  const link: PlatformLink = { id: "l", title_id: "t", platform: "crazydramas", slug: "a-series", title_slug: "a-series", cd_drama_id: "01e0f703-725e-4b7c-8770-57a87cc75cff", linked_at: "2026-09-23T00:00:00.000Z", linked_by: null };
  const entry = (slug: string, id = link.cd_drama_id) => ({ id, slug, title: "A", status: "published", language: "en", free_episode_count: 5, series_price_cents: 999, iap_product_id: null, poster_url: null, poster_blurhash: null, episode_count: 1, cta_mode: null });
  assert.deepEqual(resolveReadSlug({ crazydramas_slug: "a-series" }, null, null), { slug: "a-series", reason: "title" });
  assert.equal(resolveReadSlug({ crazydramas_slug: null }, null, [entry("a-series")]), null);
  assert.deepEqual(resolveReadSlug({ crazydramas_slug: "a-series" }, link, null), { slug: "a-series", reason: "link" });
  assert.deepEqual(resolveReadSlug({ crazydramas_slug: "a-series" }, link, [entry("a-series-renamed")]), { slug: "a-series-renamed", reason: "catalog" });
  assert.deepEqual(resolveReadSlug({ crazydramas_slug: "a-series-renamed" }, link, [entry("a-series-renamed")]), { slug: "a-series-renamed", reason: "catalog" }, "Studio's slug already follows the rename: not an edit");
  assert.deepEqual(resolveReadSlug({ crazydramas_slug: "another-series" }, link, [entry("a-series")]), { slug: "another-series", reason: "title_edited" });
  assert.deepEqual(resolveReadSlug({ crazydramas_slug: null }, link, null), { slug: "a-series", reason: "link" }, "a cleared slug still reads the link's");
  assert.deepEqual(resolveReadSlug({ crazydramas_slug: "a-series" }, link, [entry("elsewhere", "b03e20e3-dac1-4c20-9903-5f37664aeda9")]), { slug: "a-series", reason: "link" }, "a catalog that no longer lists the drama changes nothing");

  // After a followed rename the link reads the platform's slug and still records the title's own: film-meta carrying
  // `a-series` is not a re-point, so the third check and every one after it keep reading `a-series-renamed`.
  const followed: PlatformLink = { ...link, slug: "a-series-renamed" };
  assert.deepEqual(resolveReadSlug({ crazydramas_slug: "a-series" }, followed, [entry("a-series-renamed")]), { slug: "a-series-renamed", reason: "link" });
  assert.deepEqual(resolveReadSlug({ crazydramas_slug: "a-series" }, followed, null), { slug: "a-series-renamed", reason: "link" }, "with no catalog too");
  assert.deepEqual(resolveReadSlug({ crazydramas_slug: "a-series-renamed" }, followed, null), { slug: "a-series-renamed", reason: "link" }, "film-meta updated to the new slug: still not an edit");
  assert.deepEqual(resolveReadSlug({ crazydramas_slug: "another-series" }, followed, [entry("a-series-renamed")]), { slug: "another-series", reason: "title_edited" }, "a third slug is a re-point");
  assert.deepEqual(resolveReadSlug({ crazydramas_slug: "a-series" }, followed, [entry("a-series")]), { slug: "a-series", reason: "catalog" }, "renamed back in the CMS: followed again");
});

// ---- the guards --------------------------------------------------------------------------------------------

test("no credential value reaches a status, a snapshot row, an error or the fake; the live transport throws in tests before any request; the base URL is not a secret", async () => {
  const secret = "cd-secret-value-9f8e7d6c";
  const before = { token: process.env.CRAZYDRAMAS_STUDIO_TOKEN, base: process.env.CRAZYDRAMAS_BASE_URL };
  process.env.CRAZYDRAMAS_STUDIO_TOKEN = secret;
  process.env.CRAZYDRAMAS_BASE_URL = "https://crazydramas.com/";
  const fetchBefore = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched += 1; throw new Error("no network in tests"); }) as typeof fetch;
  try {
    assert.equal(crazydramasBaseUrl(), "https://crazydramas.com");
    assert.equal(crazydramasPublicUrl(MAFIA), `https://crazydramas.com/drama/${MAFIA}`);
    await assert.rejects(liveCrazydramasTransport.catalog(), (e: unknown) => e instanceof CrazydramasApiError && /tests/.test(e.message));
    await assert.rejects(liveCrazydramasTransport.series(MAFIA), (e: unknown) => e instanceof CrazydramasApiError && /tests/.test(e.message));
    await assert.rejects(liveCrazydramasTransport.series("Not A Slug"), (e: unknown) => e instanceof CrazydramasApiError);
    assert.equal(fetched, 0, "refused before any request");

    const status = crazydramasStatusFor({ crazydramas_slug: MAFIA }, studioRows(FRAMES[MAFIA].zip!), [snapshotOf(MAFIA)], null);
    const row = platformSnapshotRow({ platform: "crazydramas", slug: MAFIA, http_status: 200, drama: snapshotOf(MAFIA).drama, episodes: snapshotOf(MAFIA).episodes });
    const fakeSeries = await fakeCrazydramasTransport.series(FAKE_SLUGS.complete);
    const fakeCatalog = await fakeCrazydramasTransport.catalog();
    let failure = "";
    try { await fakeCrazydramasTransport.series(FAKE_SLUGS.broken); } catch (e) { failure = String((e as Error).message); }
    for (const text of [JSON.stringify(status), JSON.stringify(row), JSON.stringify(fakeSeries), JSON.stringify(fakeCatalog), failure, new CrazydramasApiError("x").message]) {
      assert.doesNotMatch(text, new RegExp(secret));
      assert.doesNotMatch(text, /playbackId|thumbnailUrl|image\.mux\.com/);
    }
    assert.match(failure, /HTTP 502/);
    process.env.CRAZYDRAMAS_BASE_URL = "ftp://x";
    assert.throws(() => crazydramasBaseUrl(), CrazydramasApiError);
    process.env.CRAZYDRAMAS_BASE_URL = "";
    assert.equal(crazydramasBaseUrl(), "https://crazydramas.com", "the default");
  } finally {
    globalThis.fetch = fetchBefore;
    if (before.token === undefined) delete process.env.CRAZYDRAMAS_STUDIO_TOKEN; else process.env.CRAZYDRAMAS_STUDIO_TOKEN = before.token;
    if (before.base === undefined) delete process.env.CRAZYDRAMAS_BASE_URL; else process.env.CRAZYDRAMAS_BASE_URL = before.base;
  }
});
