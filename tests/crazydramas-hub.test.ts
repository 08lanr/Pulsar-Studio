// The CrazyDramas hub, the flow strip, the publish progress and the labels of
// imported titles (the overnight spec, phase 2, 2026-09-24). The hub's rules
// are pure (`buildHub`): one row per film or title, every live series that
// matches neither, the not-ready films folded, and one next step each. The
// loader is read against the fixture workspace; the public-page check and the
// sweep-now guard against the crazydramas fake. Nothing leaves the process.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { systemSession } from "@/lib/auth";
import { fakeCrazydramasTransport, FAKE_SLUGS } from "@/lib/crazydramas/fake";
import { buildHub, ledgerCounts, loadCrazydramasHub, onCdOf, titleAction, type HubInput, type HubStatusInput, type HubTitleInput } from "@/lib/crazydramas/hub";
import { checkPublicPage, PUBLIC_CHECK_MIN_MS, resetCrazydramasSweep, sweepCrazydramasNow, type UnmatchedSeries } from "@/lib/crazydramas/sweep";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { usesTranslationWorkflow } from "@/lib/data/views";
import { resetImportRegistry, type HubFilmRow } from "@/lib/film-import/import";
import { titleFlow } from "@/lib/titles/flow";
import { batches, batchSize, publicShows } from "@/components/producer/crazydramas/PublishProgress";
import { isNotReady } from "@/components/producer/film-import-words";
import { uploadTotals } from "@/components/producer/crazydramas/UploadProgress";
import type { CdPublication } from "@/lib/types";
import { producer, staff } from "./seed-minute";

const temps: string[] = [];
beforeEach(() => {
  resetFixtureStore();
  resetCrazydramasSweep();
  fakeCrazydramasTransport.reset();
});
afterEach(() => {
  resetFixtureStore();
  resetImportRegistry();
  fakeCrazydramasTransport.reset();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.WORKSPACE_ROOT;
  delete process.env.STUDIO_WORK_DIR;
  delete process.env.STUDIO_IMPORT_QUIET_MS;
});

// ---- the pure rows -----------------------------------------------------------------------------------------------

function film(ref: string, over: Partial<HubFilmRow> = {}): HubFilmRow {
  const folder = ref.split("/").pop()!;
  return {
    source_ref: ref, folder, display_title: folder.replace(/-/g, " "), source_title: null, crazydramas_slug: null, state: "READY", reason: null,
    episodes: 3, bytes: 1000, video: null, language: "en", poster_ref: null, delivered: null, imported: null, changed: [], progress: null, warnings: [],
    producer_id: null, ...over,
  };
}
function title(id: string, over: Partial<HubTitleInput> = {}): HubTitleInput {
  return { id, name_zh: id, name_en: id, producer_id: "p1", producer_name_zh: "公司", producer_name_en: "Company", episodes_ingested: 3, source_ref: null, crazydramas_slug: null, cover_url: null, episodes_with_video: 3, ...over };
}
const counts = (studio: number, same: number, live = same) => ({ missing: 0, extra: 0, not_ready: 0, same_length: same, close: 0, different_length: 0, unknown: 0, identical: 0, studio, live, ready: live });
function status(state: HubStatusInput["state"], slug: string, over: Partial<HubStatusInput> = {}): HubStatusInput {
  return { state, detail: null, note: null, slug, counts: counts(3, state.startsWith("live") ? 3 : 0), series: null, ...over };
}
function series(slug: string, t: string, episodes = 10): UnmatchedSeries {
  return { slug, cd_drama_id: `d-${slug}`, title: t, episode_count: episodes, free_episode_count: 5, series_price_cents: 999, iap_product_set: false, poster_url: null, poster_placeholder: false, public_url: `https://crazydramas.com/drama/${slug}`, read_at: "2026-09-24T00:00:00.000Z" };
}
function input(over: Partial<HubInput>): HubInput {
  return {
    workspace: true, films: [], titles: [], statuses: new Map(), ledgers: new Map(), unmatched: [], catalog_read: true, can_act: true,
    film_poster: (ref) => `/poster?ref=${ref}`, public_url: (slug) => `https://crazydramas.com/drama/${slug}`, ...over,
  };
}

test("the hub: one row per film or title, each live series once, not-ready films folded, one next step each", () => {
  const hub = buildHub(input({
    films: [
      film("low-quality/fresh-film"),
      film("low-quality/the-cold-ceo", { display_title: "The Cold CEO" }), // a show already live, made in the CMS: KNOWN_LIVE_SERIES
      film("low-quality/rendering-film", { state: "RENDERING", reason: { code: "part_file", file: "ep02.part.mp4" } }),
      film("lbl-e02", { state: "NO_MANIFEST", reason: { code: "no_narrated_manifest", file: "DELIVERED-narrated.json" } }),
      film("low-quality/mafia-king", { state: "IMPORTED", imported: { title_id: "t-mafia", name: "Mafia King", imported_at: "x", cover_url: null, episodes: 52 }, producer_id: "p1" }),
    ],
    titles: [
      title("t-mafia", { name_en: "Mafia King", source_ref: "low-quality/mafia-king", crazydramas_slug: "forced-to-marry-the-mafia-boss", episodes_ingested: 52, episodes_with_video: 52 }),
      title("t-draft", { source_ref: "low-quality/gone-folder", crazydramas_slug: "ghostly-night-bus" }),
      title("t-new", { crazydramas_slug: null, episodes_with_video: 0, episodes_ingested: 0, name_en: null, name_zh: "新剧" }),
    ],
    statuses: new Map([
      ["t-mafia", status("live_complete", "forced-to-marry-the-mafia-boss", { counts: counts(52, 52), series: { managed_by: "cms", status: "published", episode_count: 52, poster_url: null } })],
      ["t-draft", status("not_live", "ghostly-night-bus", { detail: "draft" })],
    ]),
    ledgers: new Map([["t-draft", { active: 0, verified: 3, published: 0, failed: 0 }]]),
    unmatched: [
      series("forced-to-marry-the-mafia-boss", "Forced to Marry the Mafia Boss", 52), // held by t-mafia's slug: not a row
      series("hired-as-his-secretary-claimed-as-his-wife", "Hired as His Secretary, Claimed as His Wife", 61), // the Cold CEO film's show
      series("he-treated-our-love-like-a-prank", "He Treated Our Love Like a Prank", 40), // nobody's
    ],
  }));
  const by = new Map(hub.rows.map((r) => [r.key, r]));
  assert.deepEqual(hub.not_ready.map((f) => f.source_ref), ["lbl-e02", "low-quality/rendering-film"], "the not-ready films fold into one line");
  assert.equal(hub.rows.length, 6, "fresh film, Cold CEO film, Mafia King, the draft, the new title, one unmatched series");

  const fresh = by.get("film:low-quality/fresh-film")!;
  assert.deepEqual(fresh.action, { kind: "import", source_ref: "low-quality/fresh-film" });
  assert.equal(fresh.in_studio.code, "not_imported");
  assert.deepEqual(fresh.on_cd, { code: "before_import", read: true });

  const cold = by.get("film:low-quality/the-cold-ceo")!;
  assert.equal(cold.on_cd.code, "live", "a film nobody imported shows the live series of its show");
  assert.equal(cold.slug, "hired-as-his-secretary-claimed-as-his-wife");
  assert.equal(cold.action.kind, "import");

  const mafia = by.get("title:t-mafia")!;
  assert.equal(mafia.kind, "film");
  assert.deepEqual(mafia.in_studio, { code: "imported", episodes: 52, update: false });
  assert.deepEqual(mafia.on_cd, { code: "live", episodes: 52, match: 52, of: 52, state: "live_complete", cms: true });
  assert.deepEqual(mafia.action, { kind: "open_site", url: "https://crazydramas.com/drama/forced-to-marry-the-mafia-boss" });

  const draft = by.get("title:t-draft")!;
  assert.equal(draft.kind, "title", "its folder is gone from the workspace: still a row");
  assert.deepEqual(draft.on_cd, { code: "draft", uploaded: 3, of: 3, publishable: 3, uploading: 0, failed: 0, cms: false });
  assert.deepEqual(draft.action, { kind: "publish", title_id: "t-draft", n: 3 });

  const fresh2 = by.get("title:t-new")!;
  assert.equal(fresh2.in_studio.code, "made_in_studio");
  assert.equal(fresh2.lang, "zh-CN");
  assert.deepEqual(fresh2.action, { kind: "add_episodes", title_id: "t-new" });

  const prank = by.get("series:he-treated-our-love-like-a-prank")!;
  assert.equal(prank.in_studio.code, "not_in_studio");
  assert.equal(prank.action.kind, "open_site");

  assert.deepEqual(hub.rows.map((r) => r.action.kind), ["publish", "import", "import", "add_episodes", "open_site", "open_site"], "what needs doing first");

  const readOnly = buildHub(input({ films: [film("low-quality/fresh-film")], can_act: false }));
  assert.deepEqual(readOnly.rows[0].action, { kind: "none" }, "someone who may not act gets no button");
});

test("the next step follows the series: upload, uploads on their way, publish, open the site; a CMS series is only opened", () => {
  const none = { active: 0, verified: 0, published: 0, failed: 0 };
  assert.deepEqual(titleAction("t", onCdOf(null, null, 3), none, 3, null, true), { kind: "upload", title_id: "t" }, "no slug yet: the form picks one");
  assert.deepEqual(titleAction("t", onCdOf(status("not_live", "s", { detail: "not_uploaded" }), none, 3), none, 3, null, true), { kind: "upload", title_id: "t" });
  const moving = { active: 2, verified: 1, published: 0, failed: 0 };
  assert.deepEqual(titleAction("t", onCdOf(status("not_live", "s", { detail: "draft" }), moving, 3), moving, 3, null, true), { kind: "uploading", title_id: "t", n: 1, of: 3 });
  const partly = { active: 0, verified: 1, published: 0, failed: 0 };
  assert.deepEqual(titleAction("t", onCdOf(status("not_live", "s"), partly, 3), partly, 3, null, true), { kind: "upload", title_id: "t" }, "two still to send before publishing");
  assert.deepEqual(onCdOf(status("not_live", "s"), none, 3), { code: "not_uploaded", certain: false }, "a public 404 cannot tell a draft from nothing");
  const liveMore = { active: 0, verified: 2, published: 3, failed: 0 };
  assert.deepEqual(titleAction("t", onCdOf(status("live_partial", "s", { series: { managed_by: "studio", status: "published", episode_count: 3, poster_url: null } }), liveMore, 5), liveMore, 5, "https://x", true), { kind: "publish", title_id: "t", n: 2 });
  const cms = onCdOf(status("live_partial", "s", { series: { managed_by: "cms", status: "published", episode_count: 3, poster_url: null } }), liveMore, 5);
  assert.deepEqual(titleAction("t", cms, liveMore, 5, "https://x", true), { kind: "open_site", url: "https://x" });
  assert.deepEqual(titleAction("t", onCdOf(status("read_failed", "s"), none, 3), none, 3, null, true), { kind: "check", title_id: "t" });
  assert.deepEqual(onCdOf(status("not_live", "s", { note: "slug_reassigned" }), none, 3), { code: "elsewhere" });

  const row = (n: number, step: CdPublication["step"], created: string) => ({ episode_number: n, step, created_at: created }) as CdPublication;
  assert.deepEqual(ledgerCounts([row(1, "published", "a"), row(2, "verified", "a"), row(3, "failed", "a"), row(3, "planned", "b"), row(4, "superseded", "a")]), { active: 1, verified: 1, published: 1, failed: 0 }, "each episode's live row, an active one first");
});

test("the hub reads the fixture workspace: the imported film is one row with its title, the not-ready ones fold, staff read the catalog now", async () => {
  process.env.WORKSPACE_ROOT = path.resolve("tests", "fixtures", "workspace");
  process.env.STUDIO_IMPORT_QUIET_MS = "0";
  const work = mkdtempSync(path.join(tmpdir(), "hub-work-"));
  temps.push(work);
  process.env.STUDIO_WORK_DIR = work;
  const who = producer();
  const t = await fixtureData.createImportedTitle(systemSession(), { producer_id: who.producerId!, source_ref: "low-quality/fixture-film", display_title_en: "Fixture Film", crazydramas_slug: FAKE_SLUGS.complete, created_by: who.userId });

  const before = await loadCrazydramasHub(staff(), { portal: "admin", can_act: true });
  assert.equal(before.workspace, true);
  assert.deepEqual(before.not_ready.map((f) => f.source_ref), ["low-quality/rendering-film", "low-quality/undelivered-film"]);
  const row = before.rows.find((r) => r.title_id === t.id)!;
  assert.equal(row.kind, "film", "the film and its title are one row");
  assert.equal(row.source_ref, "low-quality/fixture-film");
  assert.equal(row.on_cd.code, "not_checked", "nothing read yet");
  assert.equal(before.catalog_read, false);
  assert.equal(before.rows.filter((r) => r.source_ref === "low-quality/fixture-film").length, 1);

  const read = await sweepCrazydramasNow({ transport: fakeCrazydramasTransport });
  assert.equal(read.ran, true);
  const again = await sweepCrazydramasNow({ transport: fakeCrazydramasTransport });
  assert.equal(again.ran, false, "a second read within fifteen seconds is refused");
  if (!again.ran) assert.equal(again.reason, "too_soon");

  const after = await loadCrazydramasHub(staff(), { portal: "admin", can_act: true });
  assert.equal(after.catalog_read, true);
  const live = after.rows.find((r) => r.title_id === t.id)!;
  assert.equal(live.on_cd.code, "live");
  assert.equal(live.action.kind, "open_site");
  assert.ok(after.rows.some((r) => r.kind === "series"), "the live series no title matches are rows of their own");

  const mine = await loadCrazydramasHub(producer(), { portal: "producer", can_act: true });
  assert.equal(mine.rows.some((r) => r.kind === "series"), false, "a producer never sees nobody's series");
});

// ---- the public page after a publish ----------------------------------------------------------------------------

test("the public-page check reads what a viewer gets: nothing until the cache catches up, at most once every three seconds", async () => {
  const fake = fakeCrazydramasTransport;
  let now = Date.parse("2026-09-24T10:00:00.000Z");
  fake.now = () => now;
  fake.publicLagMs = 60_000;
  fake.addCmsSeries("hub-draft-series", "Hub Draft Series", [60, 61], { status: "draft" });
  fake.setManagedBy("hub-draft-series", "studio");
  const published = await fake.request("POST", "/api/studio/series/hub-draft-series/publish", { publish_series: true });
  assert.equal(published.status, 200);
  const who = producer();
  const t = await fixtureData.createImportedTitle(systemSession(), { producer_id: who.producerId!, source_ref: "low-quality/hub", display_title_en: "Hub Draft Series", crazydramas_slug: "hub-draft-series", created_by: who.userId });

  const first = await checkPublicPage(who, t.id, { transport: fake, now: () => now });
  assert.equal(first.outcome, "read");
  if (first.outcome === "read") assert.equal(first.live, false, "the public cache still says 404");
  assert.equal((await checkPublicPage(who, t.id, { transport: fake, now: () => now + 1000 })).outcome, "too_soon");
  now += 61_000;
  const later = await checkPublicPage(who, t.id, { transport: fake, now: () => now });
  assert.equal(later.outcome, "read");
  if (later.outcome === "read") {
    assert.equal(later.live, true);
    assert.deepEqual(later.episodes, [1, 2]);
    assert.match(later.url, /\/drama\/hub-draft-series$/);
  }
  assert.ok(fake.calls.some((c) => c.what === "public"), "the public read, not the authenticated one");
  const viewer = { ...who, producerRole: "viewer" as const };
  await assert.rejects(checkPublicPage(viewer, t.id, { transport: fake, now: () => now + PUBLIC_CHECK_MIN_MS * 2 }), /reviewer/);
});

test("the publish progress sends the episodes in small batches and waits until the public page lists them", () => {
  assert.equal(batchSize(3), 1);
  assert.equal(batchSize(10), 1);
  assert.equal(batchSize(52), 6);
  assert.deepEqual(batches([3, 1, 2]), [[1], [2], [3]]);
  assert.equal(batches(Array.from({ length: 52 }, (_, i) => i + 1)).length, 9);
  assert.equal(publicShows({ live: true, episodes: [1, 2, 3] }, [2, 3]), true);
  assert.equal(publicShows({ live: true, episodes: [1] }, [2]), false, "not yet: the cache has the series but not the new episode");
  assert.equal(publicShows({ live: false, episodes: [] }, []), false);
});

test("the upload bar counts the files on crazydramas, those on their way and the failed ones", () => {
  const ep = (n: number, over: Record<string, unknown>) => ({ n, studio_frames: 120, ledger_step: null, cd_status: null, is_published: false, is_free: true, verdict: null, ...over });
  const totals = uploadTotals([
    ep(1, { ledger_step: "published", is_published: true, cd_status: "ready" }),
    ep(2, { ledger_step: "verified", cd_status: "ready" }),
    ep(3, { ledger_step: "bytes_sent", cd_status: "processing" }),
    ep(4, { ledger_step: "failed", error: "Mux refused" }),
    ep(5, {}),
    ep(6, { studio_frames: null }),
  ] as never);
  assert.deepEqual(totals, { files: 5, onCd: 2, moving: 1, failed: 1, published: 1 });
});

// ---- the labels and the flow strip ------------------------------------------------------------------------------

test("an imported film reads as imported until someone starts the translation workflow; a title made in Studio always uses it", () => {
  const ep = (over: Record<string, unknown> = {}) => ({ status: "ingested" as const, lines_adapted: 0, ...over });
  assert.equal(usesTranslationWorkflow({ source_ref: "low-quality/x" }, [ep(), ep()]), false);
  assert.equal(usesTranslationWorkflow({ source_ref: "low-quality/x" }, [ep(), ep({ lines_adapted: 4 })]), true);
  assert.equal(usesTranslationWorkflow({ source_ref: "low-quality/x" }, [ep({ status: "in_review" })]), true);
  assert.equal(usesTranslationWorkflow({ source_ref: null }, []), true);
});

test("the flow strip: done, next, not yet, not needed, each with its page", () => {
  const imported = titleFlow({ imported: true, episodes_with_video: 3, crazydramas: "not_live", clips_ready: 0, campaigns: 0 }, "t1", "admin");
  assert.deepEqual(imported.map((s) => [s.id, s.state]), [["segment", "done"], ["import", "done"], ["upload", "next"], ["clips", "later"], ["launch", "later"], ["stats", "later"]]);
  assert.equal(imported.find((s) => s.id === "upload")!.href, "/titles/t1/crazydramas#cd-publish");
  assert.equal(imported.find((s) => s.id === "stats")!.href, "/promote/monitor/titles/t1");
  const studio = titleFlow({ imported: false, episodes_with_video: 3, crazydramas: "live_complete", clips_ready: 4, campaigns: 0 }, "t2", "producer");
  assert.deepEqual(studio.map((s) => [s.id, s.state]), [["segment", "skip"], ["import", "skip"], ["upload", "done"], ["clips", "done"], ["launch", "next"], ["stats", "later"]]);
  assert.equal(studio.find((s) => s.id === "segment")!.href, null, "the producer portal has no segment page");
  assert.equal(studio.find((s) => s.id === "launch")!.href, "/producer/launch");
  const all = titleFlow({ imported: true, episodes_with_video: 3, crazydramas: "live_partial", clips_ready: 1, campaigns: 2 }, "t3", "admin");
  assert.equal(all.every((s) => s.state === "done"), true);
});

test("Import films folds the films that cannot be imported yet; an imported or importing film keeps its row", () => {
  assert.equal(isNotReady({ state: "RENDERING", imported: null, progress: null }), true);
  assert.equal(isNotReady({ state: "NO_MANIFEST", imported: null, progress: null }), true);
  assert.equal(isNotReady({ state: "NOT_DELIVERED", imported: null, progress: null }), true);
  assert.equal(isNotReady({ state: "READY", imported: null, progress: null }), false);
  assert.equal(isNotReady({ state: "RENDERING", imported: { title_id: "t", name: "x", imported_at: null, cover_url: null, episodes: 3 }, progress: null }), false);
});
