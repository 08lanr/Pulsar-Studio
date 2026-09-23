// The refresh (decision 2026-09-23; plan A5, A8) on the fixture fake: one
// check makes the link on the first 200 and records the snapshot, is refused
// for 30 seconds after a read of the same slug, answers not_live on a 404
// and read_failed on a failure; the sweep reads the catalog, every linked
// title and every catalog series that matches no title, and prunes; the
// staff mirror lists the unmatched; the tick is skipped under node:test; the
// import runs one check once it set a slug. No request leaves the process.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fixtureSession, systemSession } from "@/lib/auth";
import { fakeCrazydramasTransport, FAKE_SLUGS } from "@/lib/crazydramas/fake";
import { CHECK_MIN_AGE_MS, SWEEP_EVERY_MS, SWEEP_HOT_EVERY_MS, checkCrazydramasTitle, listUnmatchedCrazydramas, loadCrazydramasStatus, loadCrazydramasStatuses, nextSweepAt, resetCrazydramasSweep, sweepCrazydramas, tickCrazydramas } from "@/lib/crazydramas/sweep";
import { CrazydramasApiError, type CrazydramasTransport } from "@/lib/crazydramas/transport";
import { PLATFORM, type SeriesRead } from "@/lib/crazydramas/types";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { importFilm, resetImportRegistry, type VideoFacts } from "@/lib/film-import/import";
import type { Title } from "@/lib/types";
import { producer, staff } from "./seed-minute";

const FIXTURE_FRAMES: Record<number, number> = { 1: 120, 2: 151, 3: 180 };
const temps: string[] = [];

beforeEach(() => {
  resetFixtureStore();
  resetCrazydramasSweep();
  fakeCrazydramasTransport.reset();
});

afterEach(() => {
  resetFixtureStore();
  resetImportRegistry();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.STUDIO_LOCAL_MEDIA_DIR;
  delete process.env.STUDIO_WORK_DIR;
});

const viewer = () => ({ ...producer(), producerRole: "viewer" as const });

/** An imported title carrying the fixture film's three episodes (120, 151, 180 frames at 30 fps) under a slug the fake knows. */
async function fixtureTitle(slug: string | null, ref = `low-quality/${slug ?? "no-slug"}`): Promise<Title> {
  const who = producer();
  const title = await fixtureData.createImportedTitle(systemSession(), { producer_id: who.producerId!, source_ref: ref, display_title_en: `Fixture ${slug ?? ""}`.trim(), crazydramas_slug: slug, created_by: who.userId });
  for (const n of [1, 2, 3]) {
    await fixtureData.addVideoOnlyEpisode(systemSession(), title.id, n, `local/${title.id}/ws/fixture-film/ep0${n}-0000000${n}.mp4`, { video_frames: FIXTURE_FRAMES[n], duration_ms: Math.round((FIXTURE_FRAMES[n] / 30) * 1000), auto_cut: false });
  }
  return title;
}

async function stranger() {
  const other = await fixtureData.createProducer(staff(), { name_zh: "别家影视" });
  return { other, session: fixtureSession("producer", other.id) };
}

// ---- one check ---------------------------------------------------------------------------------------------

test("Check now on a complete series: the first 200 makes the link with the drama id, records the snapshot and answers live_complete with three same_length", async () => {
  const title = await fixtureTitle(FAKE_SLUGS.complete);
  assert.equal((await loadCrazydramasStatus(producer(), title)).state, "not_checked");
  const r = await checkCrazydramasTitle(viewer(), title.id);
  assert.equal(r.outcome, "checked");
  if (r.outcome !== "checked") return;
  assert.equal(r.slug, FAKE_SLUGS.complete);
  assert.equal(r.http_status, 200);
  assert.equal(r.linked, true);
  assert.equal(r.status.state, "live_complete");
  assert.equal(r.status.counts.same_length, 3);
  assert.equal(r.status.checked_at, r.snapshot.read_at);
  assert.deepEqual(r.status.free_paid, { free: 3, paid: 0 });
  const link = await fixtureData.getPlatformLink(producer(), title.id, PLATFORM);
  assert.equal(link?.cd_drama_id, "f1000000-0000-4000-8000-000000000001");
  assert.equal(link?.linked_by, null, "the sweep's writes are the system's, whoever pressed the button");
  assert.deepEqual(fakeCrazydramasTransport.calls, [{ what: "series", slug: FAKE_SLUGS.complete }], "no link yet: no catalog read");
  assert.equal((await loadCrazydramasStatus(producer(), title)).state, "live_complete");
  assert.equal((await loadCrazydramasStatuses(producer(), [title])).get(title.id)?.state, "live_complete");

  const again = await checkCrazydramasTitle(producer(), title.id);
  assert.equal(again.outcome, "too_soon");
  if (again.outcome === "too_soon") {
    assert.ok(again.retry_after_s >= 1 && again.retry_after_s <= 30, `retry in ${again.retry_after_s} s`);
    assert.equal(again.status.state, "live_complete");
  }
  assert.equal((await fixtureData.listPlatformSnapshots(staff(), PLATFORM, FAKE_SLUGS.complete)).length, 1, "a refused check records nothing");
  const later = await checkCrazydramasTitle(producer(), title.id, { now: () => Date.now() + CHECK_MIN_AGE_MS + 1000 });
  assert.equal(later.outcome, "checked");
  if (later.outcome === "checked") assert.equal(later.linked, false, "the link already existed");
  assert.equal((await checkCrazydramasTitle(staff(), title.id, { force: true })).outcome, "checked", "the sweep and the import skip the rule");
  assert.equal((await fixtureData.listPlatformSnapshots(staff(), PLATFORM, FAKE_SLUGS.complete)).length, 3);
  assert.equal(fakeCrazydramasTransport.calls.filter((c) => c.what === "catalog").length, 2, "with a link, a check reads the catalog once to follow a rename");
});

test("every fake series answers its state: partial, differs, processing (partial), a 404 (not_live), an unreadable one (read_failed, then stale over the last good read), no slug (not_linked)", async () => {
  const states: Record<string, string> = {};
  for (const [key, slug] of Object.entries(FAKE_SLUGS)) {
    const title = await fixtureTitle(slug, `low-quality/${key}`);
    const r = await checkCrazydramasTitle(staff(), title.id);
    assert.equal(r.outcome, "checked");
    if (r.outcome === "checked") states[key] = r.status.state;
  }
  assert.deepEqual(states, { complete: "live_complete", partial: "live_partial", differs: "live_differs", processing: "live_partial", draft: "not_live", broken: "read_failed" });

  const differs = (await fixtureData.listTitlesWithPlatformSlug(staff(), PLATFORM)).find((t) => t.crazydramas_slug === FAKE_SLUGS.differs)!;
  const d = await loadCrazydramasStatus(staff(), differs);
  assert.deepEqual(d.episodes.map((e) => e.verdict), ["close", "different_length", "same_length"]);
  assert.equal(d.episodes[0].d_frames, 3);

  const draft = (await fixtureData.listTitlesWithPlatformSlug(staff(), PLATFORM)).find((t) => t.crazydramas_slug === FAKE_SLUGS.draft)!;
  assert.equal(await fixtureData.getPlatformLink(staff(), draft.id, PLATFORM), null, "a 404 makes no link");
  const broken = (await fixtureData.listTitlesWithPlatformSlug(staff(), PLATFORM)).find((t) => t.crazydramas_slug === FAKE_SLUGS.broken)!;
  const b = await loadCrazydramasStatus(staff(), broken);
  assert.equal(b.state, "read_failed");
  assert.equal(b.stale, false, "no good read yet");
  assert.match(b.error ?? "", /HTTP 502/);
  assert.equal(b.http_status, 502);

  // A good read, then a failure: the good one is shown, marked stale.
  const goodThenBad: CrazydramasTransport = {
    mode: "fake",
    catalog: () => fakeCrazydramasTransport.catalog(),
    series: (slug) => (fakeCrazydramasTransport.calls.push({ what: "series", slug }), Promise.reject(new CrazydramasApiError("crazydramas did not answer (timeout, DNS or a refused connection)."))),
  };
  const complete = (await fixtureData.listTitlesWithPlatformSlug(staff(), PLATFORM)).find((t) => t.crazydramas_slug === FAKE_SLUGS.complete)!;
  const failed = await checkCrazydramasTitle(staff(), complete.id, { force: true, transport: goodThenBad });
  assert.equal(failed.outcome, "checked");
  if (failed.outcome === "checked") {
    assert.equal(failed.status.state, "read_failed");
    assert.equal(failed.status.stale, true);
    assert.equal(failed.status.counts.same_length, 3, "the last good read's verdicts");
    assert.equal(failed.snapshot.http_status, null);
  }

  const none = await fixtureTitle(null, "low-quality/the-cold-ceo");
  const nl = await checkCrazydramasTitle(staff(), none.id);
  assert.equal(nl.outcome, "not_linked");
  assert.equal(nl.status.state, "not_linked");
  const { session: them } = await stranger();
  await assert.rejects(checkCrazydramasTitle(them, complete.id), { code: "not_found" }, "a foreign title is nothing, never forbidden");
});

test("a CMS rename is followed through the catalog and the link moves with it; a slug re-pointed in Studio moves the link to the new drama, unless another title holds it", async () => {
  const title = await fixtureTitle(FAKE_SLUGS.complete);
  const first = await checkCrazydramasTitle(staff(), title.id);
  assert.equal(first.outcome, "checked");
  const base = await fakeCrazydramasTransport.catalog();
  const renamed: CrazydramasTransport = {
    mode: "fake",
    catalog: async () => base.map((d) => (d.slug === FAKE_SLUGS.complete ? { ...d, slug: "fixture-film-renamed" } : d)),
    series: async (slug): Promise<SeriesRead> => {
      if (slug === "fixture-film-renamed") {
        const s = await fakeCrazydramasTransport.series(FAKE_SLUGS.complete);
        return s.http_status === 200 ? { ...s, drama: { ...s.drama, slug } } : s;
      }
      return { http_status: 404, drama: null, episodes: null };
    },
  };
  const followed = await checkCrazydramasTitle(staff(), title.id, { force: true, transport: renamed });
  assert.equal(followed.outcome, "checked");
  if (followed.outcome === "checked") {
    assert.equal(followed.slug, "fixture-film-renamed", "the catalog names the drama's new slug");
    assert.equal(followed.status.state, "live_complete");
    assert.equal(followed.status.slug, "fixture-film-renamed");
  }
  assert.equal((await fixtureData.getPlatformLink(staff(), title.id, PLATFORM))?.slug, "fixture-film-renamed", "the link follows");
  assert.equal((await fixtureData.getPlatformLink(staff(), title.id, PLATFORM))?.cd_drama_id, "f1000000-0000-4000-8000-000000000001", "the same drama");

  // The person re-points the title at another series in Studio: the link moves to that drama.
  await fixtureData.setTitleImport(staff(), title.id, { crazydramas_slug: FAKE_SLUGS.partial });
  const moved = await checkCrazydramasTitle(staff(), title.id, { force: true });
  assert.equal(moved.outcome, "checked");
  if (moved.outcome === "checked") {
    assert.equal(moved.slug, FAKE_SLUGS.partial);
    assert.equal(moved.linked, true);
    assert.equal(moved.status.state, "live_partial");
  }
  assert.equal((await fixtureData.getPlatformLink(staff(), title.id, PLATFORM))?.cd_drama_id, "f1000000-0000-4000-8000-000000000002");

  // Another title already linked to that drama: the read is recorded with the refusal, the link stays.
  const other = await fixtureTitle(FAKE_SLUGS.differs, "low-quality/other");
  await checkCrazydramasTitle(staff(), other.id);
  await fixtureData.setTitleImport(staff(), title.id, { crazydramas_slug: FAKE_SLUGS.differs });
  const refused = await checkCrazydramasTitle(staff(), title.id, { force: true });
  assert.equal(refused.outcome, "checked");
  if (refused.outcome === "checked") {
    assert.match(refused.error ?? "", /another title is linked to/);
    assert.equal(refused.status.state, "read_failed", "the reading says why in words");
    assert.equal(refused.linked, false);
  }
  assert.equal((await fixtureData.getPlatformLink(staff(), title.id, PLATFORM))?.cd_drama_id, "f1000000-0000-4000-8000-000000000002", "not moved");
});

// ---- the sweep ---------------------------------------------------------------------------------------------

test("the sweep: one catalog read, one read per linked title, one per catalog series matching no title (recorded with no title), the prune; the staff mirror lists the unmatched, a producer sees none", async () => {
  assert.equal(await listUnmatchedCrazydramas(staff()), null, "nothing read yet");
  const complete = await fixtureTitle(FAKE_SLUGS.complete);
  const partial = await fixtureTitle(FAKE_SLUGS.partial);
  await fixtureTitle(null, "low-quality/the-cold-ceo");
  for (let i = 0; i < 24; i++) {
    await fixtureData.recordPlatformSnapshot(systemSession(), { platform: PLATFORM, slug: FAKE_SLUGS.complete, title_id: complete.id, http_status: 404, read_at: new Date(Date.UTC(2026, 8, 22, 0, i)).toISOString() });
  }

  const summary = await sweepCrazydramas();
  assert.equal(summary.catalog, 8, "the fake catalog: five fixture series and the three real unmatched ones");
  assert.equal(summary.titles, 2);
  assert.deepEqual(summary.states, { live_complete: 1, live_partial: 1 });
  assert.equal(summary.hot, true, "a partial title asks for the 15-minute cadence");
  assert.equal(summary.unmatched, 5, "differs, processing and the three real series; the broken one failed");
  assert.deepEqual(summary.errors, ["fixture-film-broken: crazydramas answered HTTP 502."]);
  assert.equal(summary.pruned, 5, "24 old rows plus the new one, kept at 20");
  const calls = fakeCrazydramasTransport.calls;
  assert.equal(calls.filter((c) => c.what === "catalog").length, 1, "one catalog read for the whole sweep");
  assert.deepEqual(calls.filter((c) => c.what === "series").map((c) => c.slug), [FAKE_SLUGS.complete, FAKE_SLUGS.partial, FAKE_SLUGS.differs, FAKE_SLUGS.processing, FAKE_SLUGS.broken, "he-mocked-her-crush-on-him-and-sent-her", "he-treated-our-love-like-a-prank", "ever-since-i-played-that-game-paranormal"], "in sequence");
  assert.equal((await fixtureData.getPlatformLink(staff(), partial.id, PLATFORM))?.cd_drama_id, "f1000000-0000-4000-8000-000000000002");
  assert.equal((await fixtureData.listPlatformSnapshots(staff(), PLATFORM, FAKE_SLUGS.complete, { limit: 100 })).length, 20);

  const unmatched = await listUnmatchedCrazydramas(staff());
  assert.deepEqual(unmatched?.map((s) => s.slug), ["ever-since-i-played-that-game-paranormal", FAKE_SLUGS.differs, FAKE_SLUGS.processing, "he-mocked-her-crush-on-him-and-sent-her", "he-treated-our-love-like-a-prank"], "the broken one has no good read");
  const ever = unmatched!.find((s) => s.slug === "ever-since-i-played-that-game-paranormal")!;
  assert.equal(ever.episode_count, 60);
  assert.equal(ever.poster_placeholder, true);
  assert.equal(ever.iap_product_set, true);
  assert.match(ever.public_url, /\/drama\/ever-since-i-played-that-game-paranormal$/);
  assert.equal((await fixtureData.listPlatformSnapshots(staff(), PLATFORM, FAKE_SLUGS.differs))[0].title_id, null);
  assert.deepEqual(await listUnmatchedCrazydramas(producer()), [], "a producer reads no title-less row");
  const { session: them } = await stranger();
  assert.equal(await listUnmatchedCrazydramas(them), null, "a company with nothing read");

  // A title linked since is no longer unmatched: its newest row carries the title.
  const differs = await fixtureTitle(FAKE_SLUGS.differs, "low-quality/differs");
  await checkCrazydramasTitle(staff(), differs.id, { force: true });
  assert.ok(!(await listUnmatchedCrazydramas(staff()))!.some((s) => s.slug === FAKE_SLUGS.differs));

  // A catalog failure is one error; the linked titles are still read on their link slugs.
  fakeCrazydramasTransport.failCatalogOnce = true;
  const second = await sweepCrazydramas();
  assert.equal(second.catalog, null);
  assert.equal(second.titles, 3);
  assert.equal(second.unmatched, 0, "no catalog, no unmatched pass");
  assert.ok(second.errors.some((e) => /^catalog:/.test(e)));
  assert.equal(second.hot, true);
});

test("the tick is skipped under node:test; the cadence is an hour, or 15 minutes while hot", async () => {
  assert.deepEqual(await tickCrazydramas(), { ran: false, skipped: "tests" });
  assert.equal(nextSweepAt(1_000, false), 1_000 + SWEEP_EVERY_MS);
  assert.equal(nextSweepAt(1_000, true), 1_000 + SWEEP_HOT_EVERY_MS);
  assert.equal(SWEEP_EVERY_MS, 60 * 60 * 1000);
  assert.equal(SWEEP_HOT_EVERY_MS, 15 * 60 * 1000);
  assert.equal(fakeCrazydramasTransport.calls.length, 0, "a skipped tick reads nothing");
});

// ---- the import ----------------------------------------------------------------------------------------------

test("a successful import that set a slug runs one check: the link and the snapshot exist when the import answers, and the reading is live_complete", async () => {
  const mediaDir = mkdtempSync(path.join(tmpdir(), "studio-local-"));
  temps.push(mediaDir);
  process.env.STUDIO_LOCAL_MEDIA_DIR = mediaDir;
  process.env.STUDIO_WORK_DIR = path.join(mediaDir, "work");
  const probe = async (link: string): Promise<VideoFacts | null> => {
    const n = Number(path.basename(link).match(/^ep(\d+)/)?.[1]);
    return { width: 720, height: 1280, fps: 30, frames: FIXTURE_FRAMES[n], duration_s: FIXTURE_FRAMES[n] / 30 };
  };
  const root = path.join(process.cwd(), "tests", "fixtures", "workspace");
  const r = await importFilm(producer(), { source_ref: "low-quality/fixture-film", mode: "import", attach_transcript: false }, { producer_id: producer().producerId!, created_by: producer().userId }, { root, quietMs: 0, probe });
  assert.equal(r.state, "IMPORTED");
  const title = (await fixtureData.getTitle(staff(), r.title_id)).title;
  assert.equal(title.crazydramas_slug, "fixture-film");
  assert.equal((await fixtureData.getPlatformLink(producer(), title.id, PLATFORM))?.cd_drama_id, "f1000000-0000-4000-8000-000000000001", "the import's check made the link");
  const status = await loadCrazydramasStatus(producer(), title);
  assert.equal(status.state, "live_complete");
  assert.equal(status.counts.same_length, 3);
  assert.deepEqual(fakeCrazydramasTransport.calls, [{ what: "series", slug: "fixture-film" }]);
});
