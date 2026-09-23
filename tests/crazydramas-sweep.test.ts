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
import { fakeCrazydramasTransport, FAKE_PLACEHOLDER_POSTER_URL, FAKE_POSTER_URL, FAKE_SLUGS } from "@/lib/crazydramas/fake";
import { crazydramasReadMode, shownPosterUrl } from "@/lib/crazydramas/pick";
import { CHECK_MIN_AGE_MS, SWEEP_EVERY_MS, SWEEP_HOT_EVERY_MS, checkCrazydramasTitle, listUnmatchedCrazydramas, loadCrazydramasStatus, loadCrazydramasStatuses, nextSweepAt, resetCrazydramasSweep, sweepCrazydramas, tickCrazydramas } from "@/lib/crazydramas/sweep";
import { CrazydramasApiError, type CrazydramasTransport } from "@/lib/crazydramas/transport";
import { PLATFORM, type SeriesRead } from "@/lib/crazydramas/types";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { importFilm, resetImportRegistry, type VideoFacts } from "@/lib/film-import/import";
import type { Title } from "@/lib/types";
import { producer, staff } from "./seed-minute";

/** The fixture film's frame counts as the import's `ffprobe -count_packets` measures tests/fixtures/workspace/low-quality/fixture-film/cut/eps. */
const FIXTURE_FRAMES: Record<number, number> = { 1: 120, 2: 150, 3: 180 };
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

/** An imported title carrying the fixture film's three episodes (120, 150, 180 frames at 30 fps) under a slug the fake knows. */
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

test("Check now on a complete series: the first 200 makes the link with the drama id, records the snapshot and answers live_complete with three same_length; a viewer is refused", async () => {
  const title = await fixtureTitle(FAKE_SLUGS.complete);
  assert.equal((await loadCrazydramasStatus(producer(), title)).state, "not_checked");
  await assert.rejects(checkCrazydramasTitle(viewer(), title.id), { code: "forbidden" }, "a viewer-role producer stays read-only: a check writes a row");
  assert.equal((await loadCrazydramasStatus(viewer(), title)).state, "not_checked", "the refusal read nothing and wrote nothing");
  const r = await checkCrazydramasTitle({ ...producer(), producerRole: "reviewer" }, title.id);
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
  assert.equal(link?.title_slug, FAKE_SLUGS.complete, "the link records the title's own slug");
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

test("a CMS rename is followed through the catalog, the link moves with it and every later check keeps reading the platform's slug; a slug re-pointed in Studio moves the link to the new drama, unless another title holds it", async () => {
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
  const afterRename = await fixtureData.getPlatformLink(staff(), title.id, PLATFORM);
  assert.equal(afterRename?.slug, "fixture-film-renamed", "the link follows");
  assert.equal(afterRename?.title_slug, FAKE_SLUGS.complete, "and still knows the title's own slug, which film-meta still carries");
  assert.equal(afterRename?.cd_drama_id, "f1000000-0000-4000-8000-000000000001", "the same drama");

  // Checks three, four and five after the rename (film-meta unchanged, so the title's slug is still the old one): each reads
  // the platform's slug, never the old one — the reviewer's probe found the third check reading `old-slug`, getting 404 and
  // answering not_live while the screens froze on the second read.
  for (let n = 3; n <= 5; n++) {
    const again = await checkCrazydramasTitle(staff(), title.id, { force: true, transport: renamed });
    assert.equal(again.outcome, "checked");
    if (again.outcome !== "checked") return;
    assert.equal(again.slug, "fixture-film-renamed", `check ${n} reads the platform's slug`);
    assert.equal(again.http_status, 200);
    assert.equal(again.status.state, "live_complete");
    const shown = await loadCrazydramasStatus(staff(), (await fixtureData.getTitle(staff(), title.id)).title);
    assert.equal(shown.state, "live_complete");
    assert.equal(shown.checked_at, again.snapshot.read_at, `the screens show check ${n}'s read`);
  }
  assert.equal((await fixtureData.getPlatformLink(staff(), title.id, PLATFORM))?.title_slug, FAKE_SLUGS.complete, "a followed rename never rewrites title_slug");

  // The person re-points the title at another series in Studio: the link moves to that drama and records the new slug as the title's own.
  await fixtureData.setTitleImport(staff(), title.id, { crazydramas_slug: FAKE_SLUGS.partial });
  const moved = await checkCrazydramasTitle(staff(), title.id, { force: true });
  assert.equal(moved.outcome, "checked");
  if (moved.outcome === "checked") {
    assert.equal(moved.slug, FAKE_SLUGS.partial);
    assert.equal(moved.linked, true);
    assert.equal(moved.status.state, "live_partial");
  }
  const movedLink = await fixtureData.getPlatformLink(staff(), title.id, PLATFORM);
  assert.equal(movedLink?.cd_drama_id, "f1000000-0000-4000-8000-000000000002");
  assert.equal(movedLink?.title_slug, FAKE_SLUGS.partial);

  // Another title already linked to that drama: the read is recorded with the refusal, the link stays, and the words name no
  // other title (it may be another company's) and no drama id.
  const other = await fixtureTitle(FAKE_SLUGS.differs, "low-quality/other");
  await checkCrazydramasTitle(staff(), other.id);
  await fixtureData.setTitleImport(staff(), title.id, { crazydramas_slug: FAKE_SLUGS.differs });
  const refused = await checkCrazydramasTitle(staff(), title.id, { force: true });
  assert.equal(refused.outcome, "checked");
  if (refused.outcome === "checked") {
    assert.match(refused.error ?? "", /linked to a different title/);
    assert.doesNotMatch(refused.error ?? "", /f1000000|another title/);
    assert.equal(refused.status.state, "read_failed", "the reading says why in words");
    assert.equal(refused.linked, false);
  }
  assert.equal((await fixtureData.getPlatformLink(staff(), title.id, PLATFORM))?.cd_drama_id, "f1000000-0000-4000-8000-000000000002", "not moved");
});

test("a title re-pointed at a slug that is not live: the check and every screen answer not_live under the slug the title now carries, never the old drama with a frozen checked time", async () => {
  const title = await fixtureTitle(FAKE_SLUGS.complete);
  const first = await checkCrazydramasTitle(staff(), title.id);
  assert.equal(first.outcome, "checked");
  const before = await loadCrazydramasStatus(staff(), title);
  assert.equal(before.state, "live_complete");

  // The ordinary case: film-meta now names a series that is still a draft (or not uploaded yet), which answers 404.
  await fixtureData.setTitleImport(staff(), title.id, { crazydramas_slug: FAKE_SLUGS.draft });
  const edited = (await fixtureData.getTitle(staff(), title.id)).title;
  const shownBefore = await loadCrazydramasStatus(staff(), edited);
  assert.equal(shownBefore.state, "not_checked", "before any read of the new slug the screens say so");
  assert.equal(shownBefore.slug, FAKE_SLUGS.draft);
  assert.equal(shownBefore.link, null);
  assert.equal(shownBefore.checked_at, null);

  const r = await checkCrazydramasTitle(staff(), title.id, { force: true });
  assert.equal(r.outcome, "checked");
  if (r.outcome !== "checked") return;
  assert.equal(r.slug, FAKE_SLUGS.draft);
  assert.equal(r.http_status, 404);
  assert.equal(r.linked, false);
  assert.equal(r.status.state, "not_live");
  assert.equal(r.status.slug, FAKE_SLUGS.draft, "the check's reading is of the slug it read");
  assert.equal(r.status.link, null, "the old drama's link is not this reading's");
  assert.equal(r.status.series, null);

  const shown = await loadCrazydramasStatus(staff(), edited);
  assert.equal(shown.state, "not_live");
  assert.equal(shown.slug, FAKE_SLUGS.draft);
  assert.equal(shown.checked_at, r.snapshot.read_at, "the screens show this read");
  assert.equal(shown.series, null);
  const many = await loadCrazydramasStatuses(staff(), [edited]);
  assert.equal(many.get(title.id)?.state, "not_live");
  assert.equal(many.get(title.id)?.slug, FAKE_SLUGS.draft);

  // A second Check now inside 30 s is refused under the new slug, with the same reading.
  const soon = await checkCrazydramasTitle(staff(), title.id);
  assert.equal(soon.outcome, "too_soon");
  if (soon.outcome === "too_soon") {
    assert.equal(soon.slug, FAKE_SLUGS.draft);
    assert.equal(soon.status.state, "not_live");
    assert.equal(soon.status.slug, FAKE_SLUGS.draft);
  }

  // The link itself stays on the old drama until the new slug answers 200 — nothing moved on a 404.
  const link = await fixtureData.getPlatformLink(staff(), title.id, PLATFORM);
  assert.equal(link?.slug, FAKE_SLUGS.complete);
  assert.equal(link?.title_slug, FAKE_SLUGS.complete);

  // The sweep counts it as not live too.
  const summary = await sweepCrazydramas();
  assert.equal(summary.states.not_live, 1);

  // Pointed back at the live series: the link's own slug, read again, and the screens follow.
  await fixtureData.setTitleImport(staff(), title.id, { crazydramas_slug: FAKE_SLUGS.complete });
  const back = await checkCrazydramasTitle(staff(), title.id, { force: true });
  assert.equal(back.outcome, "checked");
  if (back.outcome === "checked") {
    assert.equal(back.slug, FAKE_SLUGS.complete);
    assert.equal(back.status.state, "live_complete");
    const again = await loadCrazydramasStatus(staff(), (await fixtureData.getTitle(staff(), title.id)).title);
    assert.equal(again.state, "live_complete");
    assert.equal(again.checked_at, back.snapshot.read_at);
  }
});

test("two CMS renames: film-meta brought up to date with the first is the title's own slug, so the second rename records it on the link and every later check keeps reading the platform's slug", async () => {
  const title = await fixtureTitle(FAKE_SLUGS.complete);
  assert.equal((await checkCrazydramasTitle(staff(), title.id)).outcome, "checked");
  const base = await fakeCrazydramasTransport.catalog();
  /** The fake with the complete series renamed to `current` in the CMS: the catalog lists it there and only that slug answers. */
  const renamedTo = (current: string): CrazydramasTransport => ({
    mode: "fake",
    catalog: async () => base.map((d) => (d.slug === FAKE_SLUGS.complete ? { ...d, slug: current } : d)),
    series: async (slug): Promise<SeriesRead> => {
      if (slug === current) {
        const s = await fakeCrazydramasTransport.series(FAKE_SLUGS.complete);
        return s.http_status === 200 ? { ...s, drama: { ...s.drama, slug } } : s;
      }
      return { http_status: 404, drama: null, episodes: null };
    },
  });

  // The first rename, followed; then the person edits film-meta to the new slug and Update carries it to the title.
  const b = await checkCrazydramasTitle(staff(), title.id, { force: true, transport: renamedTo("fixture-film-b") });
  assert.equal(b.outcome, "checked");
  if (b.outcome === "checked") assert.equal(b.slug, "fixture-film-b");
  await fixtureData.setTitleImport(staff(), title.id, { crazydramas_slug: "fixture-film-b" });
  const same = await checkCrazydramasTitle(staff(), title.id, { force: true, transport: renamedTo("fixture-film-b") });
  assert.equal(same.outcome, "checked");
  if (same.outcome === "checked") {
    assert.equal(same.slug, "fixture-film-b", "the title's slug is the link's: not a re-point");
    assert.equal(same.linked, false);
    assert.equal(same.status.state, "live_complete");
  }
  assert.equal((await fixtureData.getPlatformLink(staff(), title.id, PLATFORM))?.title_slug, FAKE_SLUGS.complete, "no rewrite while nothing moved");

  // The second rename: the link moves to c and records b — the title's own slug, which it had accepted — as title_slug,
  // so no later check reads film-meta's b as a re-point (the reviewer's probe found every later check reading b, 404).
  for (let n = 1; n <= 3; n++) {
    const c = await checkCrazydramasTitle(staff(), title.id, { force: true, transport: renamedTo("fixture-film-c") });
    assert.equal(c.outcome, "checked");
    if (c.outcome !== "checked") return;
    assert.equal(c.slug, "fixture-film-c", `check ${n} after the second rename reads the platform's slug`);
    assert.equal(c.http_status, 200);
    assert.equal(c.status.state, "live_complete");
    assert.equal(c.status.slug, "fixture-film-c");
    const shown = await loadCrazydramasStatus(staff(), (await fixtureData.getTitle(staff(), title.id)).title);
    assert.equal(shown.state, "live_complete");
    assert.equal(shown.slug, "fixture-film-c");
    assert.equal(shown.checked_at, c.snapshot.read_at, `the screens show check ${n}'s read`);
  }
  const link = await fixtureData.getPlatformLink(staff(), title.id, PLATFORM);
  assert.equal(link?.slug, "fixture-film-c");
  assert.equal(link?.title_slug, "fixture-film-b", "the title's own slug, as film-meta carries it");
  assert.equal(link?.cd_drama_id, "f1000000-0000-4000-8000-000000000001");
});

test("two companies' titles on one slug: each title's reading is its own reads, so the other company's refusal never shows on this title, for its producer or for staff", async () => {
  const mine = await fixtureTitle(FAKE_SLUGS.complete);
  const first = await checkCrazydramasTitle(producer(), mine.id);
  assert.equal(first.outcome, "checked");
  // Company B imports the same film ("one film is one title per company"): its check answers 200 for the drama company A's
  // title holds, so the link is refused and B's row carries the refusal on B's title.
  const { other, session: them } = await stranger();
  const theirs = await fixtureData.createImportedTitle(them, { producer_id: other.id, source_ref: "low-quality/fixture-film", display_title_en: "Theirs", crazydramas_slug: FAKE_SLUGS.complete });
  const b = await checkCrazydramasTitle(them, theirs.id, { force: true });
  assert.equal(b.outcome, "checked");
  if (b.outcome === "checked") {
    assert.equal(b.status.state, "read_failed");
    assert.match(b.error ?? "", /linked to a different title/);
    assert.doesNotMatch(JSON.stringify(b.status), new RegExp(mine.id), "nothing of company A's title reaches company B");
  }
  assert.equal(await fixtureData.getPlatformLink(them, theirs.id, PLATFORM), null);

  // Company A's reading, by its producer and by staff, is its own last read: complete, no error, no stale mark — although B's
  // refusal is now the newest row of the slug.
  for (const who of [producer(), staff()]) {
    const shown = await loadCrazydramasStatus(who, mine);
    assert.equal(shown.state, "live_complete");
    assert.equal(shown.error, null);
    assert.equal(shown.stale, false);
  }
  // The 30-second rule is judged on every read of the slug, and the refusal still answers company A's own reading.
  const soon = await checkCrazydramasTitle(producer(), mine.id);
  assert.equal(soon.outcome, "too_soon");
  if (soon.outcome === "too_soon") assert.equal(soon.status.state, "live_complete", "the refusal answers company A's own reading");
  const a = await checkCrazydramasTitle(producer(), mine.id, { force: true });
  assert.equal(a.outcome, "checked");
  if (a.outcome === "checked") assert.equal(a.status.state, "live_complete");
  // B's own reading stays its refusal, marked as a failed read with no earlier good one.
  const bShown = await loadCrazydramasStatus(them, (await fixtureData.getTitle(them, theirs.id)).title);
  assert.equal(bShown.state, "read_failed");
  assert.equal(bShown.stale, false);
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

// ---- the poster a screen may load -----------------------------------------------------------------------------------

test("in fake mode the screens put only a same-origin poster in an <img>: a crazydramas.com URL left behind by a live read is withheld, and the picture returns with the live-read override", () => {
  assert.equal(crazydramasReadMode(), "fake");
  assert.equal(shownPosterUrl(FAKE_POSTER_URL), FAKE_POSTER_URL);
  assert.equal(shownPosterUrl(FAKE_PLACEHOLDER_POSTER_URL), FAKE_PLACEHOLDER_POSTER_URL);
  assert.equal(shownPosterUrl("https://crazydramas.com/posters/one-night.jpg"), null, "persisted from an earlier CRAZYDRAMAS_LIVE_READ=1 run: not fetched from fixture mode");
  assert.equal(shownPosterUrl("//crazydramas.com/posters/one-night.jpg"), null, "protocol-relative is not same-origin");
  assert.equal(shownPosterUrl(null), null);
  assert.equal(shownPosterUrl(undefined), null);
  process.env.CRAZYDRAMAS_LIVE_READ = "1";
  try {
    assert.equal(crazydramasReadMode(), "live");
    assert.equal(shownPosterUrl("https://crazydramas.com/posters/one-night.jpg"), "https://crazydramas.com/posters/one-night.jpg");
  } finally {
    delete process.env.CRAZYDRAMAS_LIVE_READ;
  }
  assert.equal(crazydramasReadMode(), "fake");
});
