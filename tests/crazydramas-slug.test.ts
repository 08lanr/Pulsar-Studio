// The crazydramas slug Studio picks itself (decision 2026-09-23 "Upload
// automation: poster, slug, series text"; lib/crazydramas/slug.ts and
// lib/film-import/film-meta.ts): the display title as a slug (unicode folded
// to ASCII, punctuation, the 80-character limit), `-2`, `-3` while another
// series has it, the show itself linked when crazydramas already has it under
// the same title, nothing saved and a Retry state when crazydramas does not
// answer; the title and the film's cut/film-meta.json both carry it, every
// other key of the file kept; a typed slug checked, one another series has
// answered with the next free one; the slug locked once the draft series
// exists; and the import picking one for a film whose film-meta names none.
// No network: a reader stands in for crazydramas, or fixture mode's fake.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { systemSession } from "@/lib/auth";
import { fakeCrazydramasTransport as fake } from "@/lib/crazydramas/fake";
import { resetCrazydramasUploads, saveSeries } from "@/lib/crazydramas/publish";
import { CD_SLUG } from "@/lib/crazydramas/publish-types";
import { CD_SLUG_MAX, deriveSlug, isSlugError, knownLiveSlug, pickSlug, slugCandidate, type SlugRead, type SlugReader } from "@/lib/crazydramas/slug";
import { assignCrazydramasSlug } from "@/lib/crazydramas/slug-assign";
import { resetCrazydramasSweep } from "@/lib/crazydramas/sweep";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { filmMetaPath, minimalFilmMeta, withSlug, writeFilmMetaSlug } from "@/lib/film-import/film-meta";
import { importFilm, resetImportRegistry, type VideoFacts } from "@/lib/film-import/import";
import { parseFilmMeta } from "@/lib/film-import/manifest";
import { producer, staff } from "./seed-minute";

const sys = systemSession();
const FIXTURE_ROOT = path.join(process.cwd(), "tests", "fixtures", "workspace");
const temps: string[] = [];

beforeEach(() => {
  resetFixtureStore();
  resetImportRegistry();
  resetCrazydramasSweep();
  resetCrazydramasUploads();
  fake.reset();
  const media = mkdtempSync(path.join(tmpdir(), "cd-slug-media-"));
  temps.push(media);
  process.env.STUDIO_LOCAL_MEDIA_DIR = media;
  process.env.STUDIO_WORK_DIR = path.join(media, "work");
});

afterEach(() => {
  resetFixtureStore();
  resetImportRegistry();
  fake.reset();
  delete process.env.STUDIO_LOCAL_MEDIA_DIR;
  delete process.env.STUDIO_WORK_DIR;
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** A reader over a table of slug → series; a slug not in it is free (404); `down` answers no read at all. */
function reader(table: Record<string, { title: string; managed_by?: "studio" | "cms" | null; id?: string }>, opts: { down?: boolean } = {}): SlugReader & { asked: string[] } {
  const asked: string[] = [];
  const read = async (slug: string): Promise<SlugRead> => {
    asked.push(slug);
    if (opts.down) return { status: "error", error: "crazydramas did not answer." };
    const hit = table[slug];
    if (!hit) return { status: 404 };
    return { status: 200, id: hit.id ?? `00000000-0000-4000-8000-${String(Object.keys(table).indexOf(slug)).padStart(12, "0")}`, title: hit.title, original_title: null, managed_by: hit.managed_by ?? "cms" };
  };
  return Object.assign(read, { asked });
}

/** A film folder of its own (a `cut/` and, when given, a film-meta), and an imported title pointing at it. */
async function filmTitle(name: string, meta?: Record<string, unknown> | string) {
  const root = mkdtempSync(path.join(tmpdir(), "cd-slug-ws-"));
  temps.push(root);
  const folder = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "film";
  const ref = `low-quality/${folder}`;
  mkdirSync(path.join(root, "low-quality", folder, "cut"), { recursive: true });
  if (meta !== undefined) writeFileSync(path.join(root, "low-quality", folder, "cut", "film-meta.json"), typeof meta === "string" ? meta : JSON.stringify(meta, null, 1));
  const who = producer();
  const title = await fixtureData.createImportedTitle(sys, { producer_id: who.producerId!, source_ref: ref, display_title_en: name, crazydramas_slug: null, created_by: who.userId });
  return { root, ref, title, metaFile: path.join(root, "low-quality", folder, "cut", "film-meta.json") };
}

// ---- deriving ----------------------------------------------------------------------------------------------------

test("deriveSlug: lowercase ASCII words joined by hyphens — accents folded, apostrophes inside a word dropped, & read as and, every other mark a single hyphen — and never over 80 characters", () => {
  assert.equal(deriveSlug("Ghostly Night Bus"), "ghostly-night-bus");
  assert.equal(deriveSlug("  She Can't Break the Vow!  "), "she-cant-break-the-vow");
  assert.equal(deriveSlug("Café Crème: Amour & Vengeance"), "cafe-creme-amour-and-vengeance");
  assert.equal(deriveSlug("Straße der Rache — Teil 2"), "strasse-der-rache-teil-2");
  assert.equal(deriveSlug("Ævar's Øre"), "aevars-ore");
  assert.equal(deriveSlug("CEO's Secret Baby (2026)"), "ceos-secret-baby-2026");
  assert.equal(deriveSlug("Mr. & Mrs. Wolf..."), "mr-and-mrs-wolf");
  assert.equal(deriveSlug("冷面总裁"), "", "nothing Latin left: the caller tries the next name");
  assert.equal(deriveSlug("冷面总裁 The Cold CEO"), "the-cold-ceo");
  assert.equal(deriveSlug(null), "");
  const long = deriveSlug("One night with the billionaire who hated every woman in the city and the one who ran away from him forever");
  assert.ok(long.length <= CD_SLUG_MAX, `${long.length}`);
  assert.match(long, CD_SLUG);
  assert.ok(!long.endsWith("-"));
  assert.equal(long, "one-night-with-the-billionaire-who-hated-every-woman-in-the-city-and-the-one-who", "cut at a word boundary");
  assert.equal(deriveSlug("a".repeat(120)).length, CD_SLUG_MAX, "one word longer than the limit is cut");
  for (const title of ["Ghostly Night Bus", "Straße der Rache", "¡Hola! ¿Qué tal?", "x-y_z"]) assert.match(deriveSlug(title), CD_SLUG, title);
});

test("slugCandidate: the slug, then -2, -3 …, the base cut back so the whole stays within 80 characters and never ends on a hyphen before the suffix", () => {
  assert.equal(slugCandidate("ghostly-night-bus", 1), "ghostly-night-bus");
  assert.equal(slugCandidate("ghostly-night-bus", 2), "ghostly-night-bus-2");
  assert.equal(slugCandidate("ghostly-night-bus", 13), "ghostly-night-bus-13");
  const base = "one-night-with-the-billionaire-who-hated-every-woman-in-the-city-and-the-one-who";
  assert.equal(base.length, 80);
  const second = slugCandidate(base, 2);
  assert.equal(second.length, 80);
  assert.match(second, CD_SLUG);
  assert.ok(second.endsWith("-2"));
  const cutOnHyphen = slugCandidate(`${"a".repeat(77)}-bb`, 2);
  assert.match(cutOnHyphen, CD_SLUG, `no double hyphen: ${cutOnHyphen}`);
});

test("pickSlug: 404 is free; another series takes -2, -3 …; the same show (same title, case and punctuation ignored) is linked; a series another title holds is not; no answer is unreachable", async () => {
  const free = await pickSlug("ghostly-night-bus", { names: ["Ghostly Night Bus"], read: reader({}) });
  assert.deepEqual(free, { outcome: "free", slug: "ghostly-night-bus", tried: ["ghostly-night-bus"] });

  const taken = reader({ "ghostly-night-bus": { title: "Ghostly Night Bus (the other one)" }, "ghostly-night-bus-2": { title: "A Different Show", managed_by: "studio" } });
  const third = await pickSlug("ghostly-night-bus", { names: ["Ghostly Night Bus"], read: taken });
  assert.equal(third.outcome, "free");
  assert.equal(third.slug, "ghostly-night-bus-3");
  assert.deepEqual(taken.asked, ["ghostly-night-bus", "ghostly-night-bus-2", "ghostly-night-bus-3"]);

  const same = await pickSlug("ghostly-night-bus", { names: ["Ghostly Night Bus"], read: reader({ "ghostly-night-bus": { title: "GHOSTLY night-bus!", managed_by: "cms" } }) });
  assert.equal(same.outcome, "link", "the show is already there: linked, never a second series");
  assert.equal(same.slug, "ghostly-night-bus");
  assert.equal(same.outcome === "link" ? same.series.managed_by : null, "cms");

  const heldId = "00000000-0000-4000-8000-00000000abcd";
  const held = await pickSlug("ghostly-night-bus", { names: ["Ghostly Night Bus"], read: reader({ "ghostly-night-bus": { title: "Ghostly Night Bus", id: heldId } }), heldByOther: (id) => id === heldId });
  assert.equal(held.outcome, "free");
  assert.equal(held.slug, "ghostly-night-bus-2", "another title's series is not this one's to link");

  const down = await pickSlug("ghostly-night-bus", { names: ["Ghostly Night Bus"], read: reader({}, { down: true }) });
  assert.equal(down.outcome, "unreachable");

  const full = await pickSlug("x", { names: ["X"], read: async () => ({ status: 200, id: "00000000-0000-4000-8000-000000000001", title: "Something else", original_title: null, managed_by: "studio" }), maxTries: 4 });
  assert.equal(full.outcome, "exhausted");
  assert.deepEqual(full.tried, ["x", "x-2", "x-3", "x-4"]);
});

test("knownLiveSlug: the working-name table of STUDIO_API.md, by title or folder, case and punctuation ignored", () => {
  assert.equal(knownLiveSlug(["The Cold CEO"]), "hired-as-his-secretary-claimed-as-his-wife");
  assert.equal(knownLiveSlug([null, "she-returned-with-her-son"]), "i-came-back-with-his-abandoned-son-to-ruin-his-wedding");
  assert.equal(knownLiveSlug(["Ghostly Night Bus"]), null);
});

// ---- film-meta ------------------------------------------------------------------------------------------------------

test("writeFilmMetaSlug keeps every other key where it was (unknown ones included), creates a minimal file that parses when there is none, and leaves a file that is not a JSON object alone", async () => {
  const meta = { display_title_en: "Ghostly Night Bus", source_title_en: "The Night Bus", language: "en", spoiler_from_s: 900, exclusions: [{ from_s: 1, to_s: 2, why: "card", kind: "card" }], live_poster: "gnb-a", notes: "hand-written", pipeline_extra: { keep: true } };
  const a = await filmTitle("Ghostly Night Bus", meta);
  const w = writeFilmMetaSlug(a.root, a.ref, "ghostly-night-bus", { display_title_en: "x", language: "en" });
  assert.deepEqual(w, { written: true, file: a.metaFile, created: false });
  const after = JSON.parse(readFileSync(a.metaFile, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(after), ["display_title_en", "crazydramas_slug", "source_title_en", "language", "spoiler_from_s", "exclusions", "live_poster", "notes", "pipeline_extra"], "the slug sits after the display title; nothing else moved");
  assert.deepEqual({ ...after, crazydramas_slug: undefined }, { ...meta, crazydramas_slug: undefined });
  assert.equal(parseFilmMeta(after).crazydramas_slug, "ghostly-night-bus");
  assert.ok(readFileSync(a.metaFile, "utf8").endsWith("\n"));
  assert.deepEqual(writeFilmMetaSlug(a.root, a.ref, "ghostly-night-bus", { display_title_en: "x", language: "en" }), { written: false, reason: "unchanged" });
  // A slug already there is replaced in place.
  writeFilmMetaSlug(a.root, a.ref, "ghostly-night-bus-2", { display_title_en: "x", language: "en" });
  assert.equal(Object.keys(JSON.parse(readFileSync(a.metaFile, "utf8"))).indexOf("crazydramas_slug"), 1);

  const b = await filmTitle("No Meta Film");
  const made = writeFilmMetaSlug(b.root, b.ref, "no-meta-film", { display_title_en: "No Meta Film", language: "zh" });
  assert.equal(made.written && made.created, true);
  const minimal = parseFilmMeta(JSON.parse(readFileSync(b.metaFile, "utf8")));
  assert.equal(minimal.crazydramas_slug, "no-meta-film");
  assert.equal(minimal.display_title_en, "No Meta Film");
  assert.equal(minimal.language, "zh");
  assert.match(minimal.notes ?? "", /Pulsar Studio/);

  const c = await filmTitle("Broken Meta Film", "{ not json");
  assert.deepEqual(writeFilmMetaSlug(c.root, c.ref, "broken-meta-film", { display_title_en: "x", language: "en" }).written, false);
  assert.equal(readFileSync(c.metaFile, "utf8"), "{ not json", "a file Studio cannot read is left exactly as it was");

  assert.equal(filmMetaPath(a.root, "../outside"), null);
  assert.deepEqual(writeFilmMetaSlug(a.root, "low-quality/no-such-film", "x", { display_title_en: "x", language: "en" }), { written: false, reason: "no_cut_dir" });
  assert.deepEqual(Object.keys(withSlug({ a: 1, b: 2 }, "s")), ["a", "b", "crazydramas_slug"], "no display title: at the end");
  assert.equal(minimalFilmMeta({ display_title_en: "x", slug: "x", language: "e" }).language, "en", "a language too short to parse falls back to en, so the file always parses");
});

// ---- the title's slug -------------------------------------------------------------------------------------------------

test("assignCrazydramasSlug: a free slug is saved on the title and in film-meta; the same show is linked; crazydramas not answering saves nothing and says so", async () => {
  const a = await filmTitle("Ghostly Night Bus", { display_title_en: "Ghostly Night Bus", language: "en", notes: "keep me" });
  const taken = reader({ "ghostly-night-bus": { title: "Ghostly Night Bus: Another Road" } });
  const saved = await assignCrazydramasSlug(producer(), a.title.id, { root: a.root, read: taken, skipCheck: true });
  assert.equal(saved.outcome, "saved");
  assert.equal(saved.slug, "ghostly-night-bus-2");
  assert.equal(saved.film_meta, "written");
  assert.equal((await fixtureData.getTitle(staff(), a.title.id)).title.crazydramas_slug, "ghostly-night-bus-2");
  const meta = JSON.parse(readFileSync(a.metaFile, "utf8")) as Record<string, unknown>;
  assert.equal(meta.crazydramas_slug, "ghostly-night-bus-2");
  assert.equal(meta.notes, "keep me");

  // A second ask with no slug keeps the one the title has and asks crazydramas nothing.
  const again = reader({});
  const kept = await assignCrazydramasSlug(producer(), a.title.id, { root: a.root, read: again, skipCheck: true });
  assert.equal(kept.outcome, "kept");
  assert.deepEqual(again.asked, []);

  const b = await filmTitle("Forced Marriage Contract");
  const linked = await assignCrazydramasSlug(producer(), b.title.id, { root: b.root, read: reader({ "forced-marriage-contract": { title: "Forced Marriage Contract", managed_by: "cms" } }), skipCheck: true });
  assert.equal(linked.outcome, "linked");
  assert.equal(linked.series?.managed_by, "cms");
  assert.equal(linked.film_meta, "created", "no film-meta: a minimal one is written");

  const c = await filmTitle("Night Of The Storm", { display_title_en: "Night Of The Storm", language: "en" });
  const before = readFileSync(c.metaFile, "utf8");
  await assert.rejects(assignCrazydramasSlug(producer(), c.title.id, { root: c.root, read: reader({}, { down: true }), skipCheck: true }), (e: unknown) => {
    assert.ok(isSlugError(e));
    assert.equal(e.status, 503);
    assert.equal(e.code, "crazydramas_unreachable");
    assert.match(e.message, /did not answer.*Nothing was saved; try again/);
    return true;
  });
  assert.equal((await fixtureData.getTitle(staff(), c.title.id)).title.crazydramas_slug ?? null, null, "nothing saved");
  assert.equal(readFileSync(c.metaFile, "utf8"), before, "film-meta untouched");
});

test("a typed slug is checked: one another series has is refused with the next free one; a bad one is refused; once the draft series exists the slug is locked", async () => {
  const a = await filmTitle("Taken One");
  const table = reader({ "taken-one": { title: "Someone Else's Show" } });
  await assert.rejects(assignCrazydramasSlug(producer(), a.title.id, { slug: "taken-one", root: a.root, read: table, skipCheck: true }), (e: unknown) => {
    assert.ok(isSlugError(e));
    assert.equal(e.code, "slug_taken");
    assert.equal((e.body() as { suggestion: string }).suggestion, "taken-one-2");
    assert.match(e.message, /taken-one is another series on crazydramas \("Someone Else's Show"\)\. taken-one-2 is free\./);
    return true;
  });
  await assert.rejects(assignCrazydramasSlug(producer(), a.title.id, { slug: "Not A Slug", root: a.root, read: table, skipCheck: true }), { code: "bad_slug" });
  const ok = await assignCrazydramasSlug(producer(), a.title.id, { slug: "taken-one-2", root: a.root, read: table, skipCheck: true });
  assert.equal(ok.slug, "taken-one-2");

  // The draft series exists (fixture mode's fake crazydramas): the slug no longer changes.
  await saveSeries(producer(), a.title.id, { title: "Taken One" });
  await assert.rejects(assignCrazydramasSlug(producer(), a.title.id, { slug: "taken-one-3", root: a.root, read: table, skipCheck: true }), (e: unknown) => {
    assert.ok(isSlugError(e));
    assert.equal(e.code, "slug_locked");
    assert.match(e.message, /ad links point at crazydramas\.com\/drama\/taken-one-2/);
    return true;
  });
});

test("fixture mode's own reads: a title whose show is in the fake's catalog links to it; the working-name table links a live show to its live slug", async () => {
  const a = await filmTitle("Fixture Film");
  const r = await assignCrazydramasSlug(producer(), a.title.id, { root: a.root, skipCheck: true });
  assert.equal(r.outcome, "linked");
  assert.equal(r.slug, "fixture-film");
  const b = await filmTitle("Brand New Fixture Show");
  const free = await assignCrazydramasSlug(producer(), b.title.id, { root: b.root, skipCheck: true });
  assert.deepEqual([free.outcome, free.slug], ["saved", "brand-new-fixture-show"]);
  fake.addCmsSeries("hired-as-his-secretary-claimed-as-his-wife", "Hired as His Secretary, Claimed as His Wife", [90]);
  const c = await filmTitle("The Cold CEO");
  const cold = await assignCrazydramasSlug(producer(), c.title.id, { root: c.root, skipCheck: true });
  assert.deepEqual([cold.outcome, cold.slug], ["linked", "hired-as-his-secretary-claimed-as-his-wife"]);
});

// ---- the import --------------------------------------------------------------------------------------------------------

const fakeProbe = async (link: string): Promise<VideoFacts | null> => {
  const n = Number(path.basename(link).match(/^ep(\d+)/)?.[1]);
  const frames = ({ 1: 120, 2: 150, 3: 180 } as Record<number, number>)[n];
  return { width: 720, height: 1280, fps: 30, frames, duration_s: frames / 30 };
};

function workspaceWithout(slugMeta: "no_slug" | "no_file"): { root: string; metaFile: string } {
  const root = mkdtempSync(path.join(tmpdir(), "cd-slug-import-"));
  temps.push(root);
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  const metaFile = path.join(root, "low-quality", "fixture-film", "cut", "film-meta.json");
  if (slugMeta === "no_file") rmSync(metaFile);
  else {
    const meta = JSON.parse(readFileSync(metaFile, "utf8")) as Record<string, unknown>;
    delete meta.crazydramas_slug;
    writeFileSync(metaFile, JSON.stringify({ ...meta, display_title_en: "Ghostly Night Bus" }, null, 1));
  }
  return { root, metaFile };
}

test("the import picks a slug for a film whose film-meta names none: checked, saved on the title, written into film-meta with every other key, and carried by the film_meta asset", async () => {
  const { root, metaFile } = workspaceWithout("no_slug");
  const before = JSON.parse(readFileSync(metaFile, "utf8")) as Record<string, unknown>;
  const read = reader({ "ghostly-night-bus": { title: "Ghostly Night Bus Returns" } });
  const who = producer();
  const r = await importFilm(who, { source_ref: "low-quality/fixture-film", mode: "import" }, { producer_id: who.producerId!, created_by: who.userId }, { root, quietMs: 0, probe: fakeProbe, slugReader: read });
  assert.equal(r.state, "IMPORTED");
  assert.ok(!r.warnings.some((w) => /slug/.test(w)), r.warnings.join(" | "));
  const title = (await fixtureData.getTitle(staff(), r.title_id)).title;
  assert.equal(title.crazydramas_slug, "ghostly-night-bus-2", "the derived slug was another series: the next free one");
  const after = JSON.parse(readFileSync(metaFile, "utf8")) as Record<string, unknown>;
  assert.equal(after.crazydramas_slug, "ghostly-night-bus-2");
  for (const [k, v] of Object.entries(before)) assert.deepEqual(after[k], v, `film-meta keeps ${k}`);
  const asset = (await fixtureData.listFilmAssets(staff(), r.title_id)).find((a) => a.kind === "film_meta");
  assert.equal((asset?.meta as { crazydramas_slug?: string }).crazydramas_slug, "ghostly-night-bus-2", "the copied film-meta carries it");
  // Nothing else in the film folder changed: the plan, the index and the episodes are the fixture's.
  assert.equal(readFileSync(path.join(root, "low-quality", "fixture-film", "cut", "cuts.json"), "utf8"), readFileSync(path.join(FIXTURE_ROOT, "low-quality", "fixture-film", "cut", "cuts.json"), "utf8"));
});

test("the import with no film-meta at all writes a minimal one; with crazydramas not answering it finishes with a warning and no slug, and the upload form tries again", async () => {
  const { root, metaFile } = workspaceWithout("no_file");
  const who = producer();
  const r = await importFilm(who, { source_ref: "low-quality/fixture-film", mode: "import" }, { producer_id: who.producerId!, created_by: who.userId }, { root, quietMs: 0, probe: fakeProbe, slugReader: reader({}) });
  assert.equal((await fixtureData.getTitle(staff(), r.title_id)).title.crazydramas_slug, "fixture-film", "the folder's title as the slug");
  assert.ok(existsSync(metaFile));
  assert.equal(parseFilmMeta(JSON.parse(readFileSync(metaFile, "utf8"))).crazydramas_slug, "fixture-film");

  resetFixtureStore();
  resetImportRegistry();
  const down = workspaceWithout("no_slug");
  const before = readFileSync(down.metaFile, "utf8");
  const r2 = await importFilm(who, { source_ref: "low-quality/fixture-film", mode: "import" }, { producer_id: who.producerId!, created_by: who.userId }, { root: down.root, quietMs: 0, probe: fakeProbe, slugReader: reader({}, { down: true }) });
  assert.equal(r2.state, "IMPORTED", "a slug that could not be checked never fails the import");
  assert.ok(r2.warnings.some((w) => /no crazydramas slug was picked: crazydramas did not answer/.test(w) && /upload form tries again/.test(w)), r2.warnings.join(" | "));
  assert.equal((await fixtureData.getTitle(staff(), r2.title_id)).title.crazydramas_slug ?? null, null);
  assert.equal(readFileSync(down.metaFile, "utf8"), before);
});

test("the checked-in fixture film names its slug, so importing it asks crazydramas nothing about slugs and writes nothing into the fixture workspace", async () => {
  const before = readFileSync(path.join(FIXTURE_ROOT, "low-quality", "fixture-film", "cut", "film-meta.json"), "utf8");
  const read = reader({});
  const who = producer();
  await importFilm(who, { source_ref: "low-quality/fixture-film", mode: "import" }, { producer_id: who.producerId!, created_by: who.userId }, { root: FIXTURE_ROOT, quietMs: 0, probe: fakeProbe, slugReader: read });
  assert.deepEqual(read.asked, []);
  assert.equal(readFileSync(path.join(FIXTURE_ROOT, "low-quality", "fixture-film", "cut", "film-meta.json"), "utf8"), before);
});
