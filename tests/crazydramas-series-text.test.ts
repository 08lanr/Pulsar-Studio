// The series text Studio drafts (decision 2026-09-23 "Upload automation:
// poster, slug, series text"; lib/crazydramas/series-text.ts and
// lib/prompts/series-text.ts): what the model may read of the film (the first
// fifteen minutes and a sample of the rest, never the last 20%), the answer's
// zod rules (a tagline of at most 80 characters, 2–4 sentences, 1–3 genres),
// the canned fixture answer, one studio.jobs row per draft with its cost,
// reused while the transcript has not changed and redrawn on "Draft again",
// and empty fields with a note when there is no model key or no transcript.
// No network: the model call is a stand-in.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { systemSession } from "@/lib/auth";
import {
  CANNED_SERIES_TEXT,
  draftSeriesText,
  EXCLUDED_TAIL,
  HEAD_SECONDS,
  loadTitleTranscript,
  SAMPLE_PIECES,
  selectTranscript,
  tidyGenres,
  transcriptSha,
} from "@/lib/crazydramas/series-text";
import { SeriesTextReplySchema } from "@/lib/crazydramas/publish-types";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { localPathOf } from "@/lib/data/storage";
import type { callStructured } from "@/lib/llm";
import { buildSeriesText, SeriesTextSchema, sentenceCount, type TranscriptPiece } from "@/lib/prompts/series-text";
import type { Title } from "@/lib/types";
import { producer, staff } from "./seed-minute";

const sys = systemSession();
const temps: string[] = [];
const ENV = ["DEMO_REPLAY", "DEEPSEEK_API_KEY", "ADS_TEXT_PROVIDER"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  resetFixtureStore();
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  const dir = mkdtempSync(path.join(tmpdir(), "cd-text-"));
  temps.push(dir);
  process.env.STUDIO_LOCAL_MEDIA_DIR = dir;
});

afterEach(() => {
  resetFixtureStore();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete process.env.STUDIO_LOCAL_MEDIA_DIR;
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** One line every 10 s for `minutes`, each naming its own time so a leak past the cutoff is visible in the prompt. */
function film(minutes: number): TranscriptPiece[] {
  return Array.from({ length: minutes * 6 }, (_, i) => ({ start_s: i * 10, end_s: i * 10 + 8, text: `line at ${i * 10} seconds` }));
}

// ---- what the model reads -----------------------------------------------------------------------------------------------

test("the draft's inputs exclude the last 20% of the film: the first 15 minutes in full, then a spaced sample that stops at the 80% mark", () => {
  const pieces = film(60); // a 60-minute film: the cutoff is at 48:00
  const sel = selectTranscript(pieces, 3600);
  assert.equal(sel.cutoff_s, 3600 * (1 - EXCLUDED_TAIL));
  assert.equal(sel.head_until_s, HEAD_SECONDS);
  assert.ok(sel.head.length > 0 && sel.head.every((p) => p.end_s <= HEAD_SECONDS), "the opening ends by 15:00");
  assert.equal(sel.head[0].start_s, 0);
  assert.ok(sel.sample.length > 0 && sel.sample.length <= SAMPLE_PIECES);
  assert.ok(sel.sample.every((p) => p.start_s >= HEAD_SECONDS && p.end_s <= 2880), "the sample stays inside 15:00–48:00");
  for (let i = 1; i < sel.sample.length; i++) assert.ok(sel.sample[i].start_s > sel.sample[i - 1].start_s, "in order");
  assert.ok(sel.sample[sel.sample.length - 1].start_s > 2400, "the sample reaches well into the second half, just not the ending");

  // The prompt itself carries nothing from the last fifth.
  const call = buildSeriesText({ display_title: "Ghostly Night Bus", language: "en", ...sel });
  const seconds = [...call.user.matchAll(/line at (\d+) seconds/g)].map((m) => Number(m[1]));
  assert.ok(seconds.length > 0);
  assert.ok(Math.max(...seconds) < 2880, `the latest line in the prompt is at ${Math.max(...seconds)} s`);
  assert.doesNotMatch(call.user, /line at (29\d\d|3[0-5]\d\d) seconds/);

  // A short film: 80% comes before 15 minutes, so the opening itself stops there.
  const short = selectTranscript(film(10), 600);
  assert.equal(short.head_until_s, 480);
  assert.ok(short.head.every((p) => p.end_s <= 480));
  assert.deepEqual(short.sample, []);
  // A line that runs across the 80% mark is left out whole.
  const across = selectTranscript([{ start_s: 0, end_s: 5, text: "a" }, { start_s: 950, end_s: 1000, text: "b" }, { start_s: 1190, end_s: 1210, text: "c" }], 1500);
  assert.deepEqual(across.sample.map((p) => p.text), ["b"]);
  assert.equal(transcriptSha(pieces, 3600), transcriptSha(film(60), 3600), "the same transcript, the same key");
  assert.notEqual(transcriptSha(pieces, 3600), transcriptSha(film(59), 3540));
});

test("the answer is validated with zod: a tagline of at most 80 characters, a 2–4 sentence description, 1–3 genres; the catalog's spelling wins", () => {
  assert.ok(SeriesTextSchema.safeParse(CANNED_SERIES_TEXT).success);
  assert.equal(SeriesTextSchema.safeParse({ ...CANNED_SERIES_TEXT, tagline: "x".repeat(81) }).success, false);
  assert.equal(SeriesTextSchema.safeParse({ ...CANNED_SERIES_TEXT, genres: [] }).success, false);
  assert.equal(SeriesTextSchema.safeParse({ ...CANNED_SERIES_TEXT, genres: ["Romance", "Mafia", "Revenge", "Thriller"] }).success, false);
  assert.equal(SeriesTextSchema.safeParse({ ...CANNED_SERIES_TEXT, extra: 1 }).success, true, "zod strips unknown keys; the reply names only the three");
  const check = buildSeriesText({ display_title: "X", language: "en", head: [], sample: [], head_until_s: 0, cutoff_s: 0, duration_s: 0 }).check;
  assert.equal(check(CANNED_SERIES_TEXT), null);
  assert.match(check({ ...CANNED_SERIES_TEXT, description: "Only one sentence here and it is long enough to pass the length." }) ?? "", /2-4 sentences, not 1/);
  assert.match(check({ ...CANNED_SERIES_TEXT, tagline: "\"Quoted.\"" }) ?? "", /quotation marks/);
  assert.equal(sentenceCount("A debt. A contract. A vow she can't break."), 3);
  assert.deepEqual(tidyGenres(["romance", "BILLIONAIRE", "romance", "second chance", "Revenge"]), ["Romance", "Billionaire", "Second Chance"]);
  assert.ok(SeriesTextReplySchema.safeParse({ status: "demo", tagline: "x", description: "y", genres: [], note: null }).success);
});

// ---- the draft ---------------------------------------------------------------------------------------------------------------

async function titleWithTranscript(minutes = 60): Promise<Title> {
  const who = producer();
  const title = await fixtureData.createImportedTitle(sys, { producer_id: who.producerId!, source_ref: "low-quality/ghostly-night-bus", display_title_en: "Ghostly Night Bus", crazydramas_slug: "ghostly-night-bus", created_by: who.userId });
  const whisper = { language: "en", duration: minutes * 60, model: "medium", segments: film(minutes).map((p) => ({ start: p.start_s, end: p.end_s, text: p.text, words: [] })) };
  const bytes = Buffer.from(JSON.stringify(whisper));
  const stored = `local/${title.id}/ws/ghostly-night-bus/whisper-00000000.json`;
  mkdirSync(path.dirname(localPathOf(stored)), { recursive: true });
  writeFileSync(localPathOf(stored), bytes);
  await fixtureData.putFilmAsset(sys, { title_id: title.id, kind: "transcript", storage_path: stored, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, origin: "workspace", source_ref: "low-quality/ghostly-night-bus/cut/index/whisper.json", meta: {} });
  return title;
}

type Call = Parameters<typeof callStructured>[0];

function fakeModel(answers: object[]): typeof callStructured & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = async (call: Call) => {
    calls.push(call);
    const data = call.schema.parse(answers[Math.min(calls.length - 1, answers.length - 1)]);
    return { data, usage: { input_tokens: 5000, output_tokens: 300, cache_read_tokens: 0, cache_write_tokens: 0 }, cost_cents: 1, provider: call.provider!, model: call.model!, turns: 1 };
  };
  return Object.assign(fn as unknown as typeof callStructured, { calls });
}

test("fixture mode (demo replay) answers the canned draft and calls nothing", async () => {
  const t = await titleWithTranscript();
  const r = await draftSeriesText(producer(), t.id);
  assert.equal(r.status, "demo");
  assert.equal(r.tagline, CANNED_SERIES_TEXT.tagline);
  assert.equal(r.description, CANNED_SERIES_TEXT.description);
  assert.deepEqual(r.genres, ["Romance", "Billionaire"]);
  assert.equal((await fixtureData.latestJobByTarget(staff(), "title", t.id, "draft_series_text")), null, "no job row: nothing was called");
  SeriesTextReplySchema.parse(r);
});

test("with no model key the fields stay empty with a one-line note; with no transcript too", async () => {
  process.env.DEMO_REPLAY = "0";
  const t = await titleWithTranscript();
  const r = await draftSeriesText(producer(), t.id);
  assert.deepEqual([r.status, r.tagline, r.description, r.genres], ["unavailable", null, null, []]);
  assert.match(r.note ?? "", /No deepseek key on this server \(DEEPSEEK_API_KEY\).*write them here/);
  process.env.DEEPSEEK_API_KEY = "test-key-never-sent";
  const who = producer();
  const bare = await fixtureData.createImportedTitle(sys, { producer_id: who.producerId!, source_ref: "low-quality/empty", display_title_en: "Empty", crazydramas_slug: null, created_by: who.userId });
  const none = await draftSeriesText(producer(), bare.id, { call: fakeModel([CANNED_SERIES_TEXT]) });
  assert.equal(none.status, "unavailable");
  assert.match(none.note ?? "", /no transcript yet/);
});

test("a real draft is one studio.jobs row on ADS_TEXT_PROVIDER with its cost; the same transcript reuses it; Draft again calls anew; the reply never carries the job or its cost", async () => {
  process.env.DEMO_REPLAY = "0";
  process.env.DEEPSEEK_API_KEY = "test-key-never-sent";
  const t = await titleWithTranscript();
  const model = fakeModel([
    { tagline: "  Last stop. First bite. No one gets off.  ", description: "A night-shift driver takes the last bus through a town that should be empty. Every stop brings a passenger who died years ago. Tonight one of them wants her seat.", genres: ["paranormal", "thriller", "mystery", "horror"].slice(0, 3) },
    { tagline: "The last bus runs on borrowed souls.", description: "She drives the route nobody else will take. The passengers pay in secrets. One of them knows hers.", genres: ["Paranormal"] },
  ]);
  const first = await draftSeriesText(producer(), t.id, { call: model });
  assert.equal(first.status, "drafted");
  assert.equal(first.tagline, "Last stop. First bite. No one gets off.");
  assert.deepEqual(first.genres, ["Paranormal", "Thriller", "Mystery"]);
  assert.deepEqual(Object.keys(first).sort(), ["description", "genres", "note", "status", "tagline"], "the text alone: no job id, no cost");
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].provider, "deepseek", "ADS_TEXT_PROVIDER, DeepSeek unless said otherwise");
  assert.equal(model.calls[0].model, "deepseek-flash", "the provider's fast tier");
  const seen = [...model.calls[0].user.matchAll(/line at (\d+) seconds/g)].map((m) => Number(m[1]));
  assert.ok(Math.max(...seen) < 2880, `never the last fifth: the latest line sent is at ${Math.max(...seen)} s of 3600`);

  const job = await fixtureData.latestJobByTarget(staff(), "title", t.id, "draft_series_text");
  assert.equal(job?.status, "done");
  assert.equal(job?.cost_cents, 1);
  assert.equal(job?.provider, "deepseek");
  assert.match(job?.idempotency_key ?? "", new RegExp(`^series_text:series-text-v1:${t.id}:[0-9a-f]{16}:a1$`));
  assert.equal((job?.input as { cutoff_s: number }).cutoff_s, 2880);

  const reopened = await draftSeriesText(producer(), t.id, { call: model });
  assert.equal(reopened.status, "reused");
  assert.equal(reopened.tagline, first.tagline);
  assert.equal(model.calls.length, 1, "reopening the form spends nothing");

  const again = await draftSeriesText(producer(), t.id, { again: true, call: model });
  assert.equal(again.status, "drafted");
  assert.equal(again.tagline, "The last bus runs on borrowed souls.");
  assert.equal(model.calls.length, 2);
  const second = await fixtureData.latestJobByTarget(staff(), "title", t.id, "draft_series_text");
  assert.match(second?.idempotency_key ?? "", /:a2$/, "Draft again is the next attempt");
  const reopenedAgain = await draftSeriesText(producer(), t.id, { call: model });
  assert.equal(reopenedAgain.tagline, again.tagline, "the newest draft is the one the form reopens with");

  process.env.ADS_TEXT_PROVIDER = "anthropic";
  const noKey = await draftSeriesText(producer(), t.id, { again: true, call: model });
  assert.equal(noKey.status, "unavailable", "runJob refuses a provider with no key before any call; the form says so");
  assert.match(noKey.note ?? "", /ANTHROPIC_API_KEY/);
  assert.equal(model.calls.length, 2);
});

test("the transcript comes from the imported ASR index on the film's timeline; a title with neither an index nor script lines has none", async () => {
  const t = await titleWithTranscript(30);
  const tr = await loadTitleTranscript(t.id);
  assert.equal(tr?.source, "asr_index");
  assert.equal(tr?.duration_s, 1800);
  assert.equal(tr?.pieces.length, 180);
  const who = producer();
  const bare = await fixtureData.createImportedTitle(sys, { producer_id: who.producerId!, source_ref: "low-quality/none", display_title_en: "None", crazydramas_slug: null, created_by: who.userId });
  assert.equal(await loadTitleTranscript(bare.id), null);
});

// ---- the spoiler line and untimed episodes (review of the upload automation, 2026-09-24) -------------------------------

test("the title's spoiler line cuts the draft's inputs too: nothing from it on reaches the model, and a new line is a new draft", async () => {
  // The spoiler line before the 80% mark wins; after it, the 80% mark does.
  const sel = selectTranscript(film(60), 3600, 1200);
  assert.equal(sel.cutoff_s, 1200);
  assert.equal(sel.head_until_s, HEAD_SECONDS);
  assert.ok([...sel.head, ...sel.sample].every((p) => p.end_s <= 1200), "nothing past the spoiler line");
  assert.equal(selectTranscript(film(60), 3600, 3500).cutoff_s, 2880, "a line after the 80% mark changes nothing");
  assert.equal(selectTranscript(film(10), 600, 300).head_until_s, 300, "the opening itself stops at a line inside it");
  assert.equal(transcriptSha(film(60), 3600, null), transcriptSha(film(60), 3600), "no line: the same key as before");
  assert.notEqual(transcriptSha(film(60), 3600, 1200), transcriptSha(film(60), 3600), "a line is part of the key");

  process.env.DEMO_REPLAY = "0";
  process.env.DEEPSEEK_API_KEY = "test-key-never-sent";
  const t = await titleWithTranscript();
  await fixtureData.setTitleAdRules(sys, t.id, { spoiler_from_s: 1200, exclusions: [] });
  const model = fakeModel([CANNED_SERIES_TEXT]);
  const first = await draftSeriesText(producer(), t.id, { call: model });
  assert.equal(first.status, "drafted");
  const seen = [...model.calls[0].user.matchAll(/line at (\d+) seconds/g)].map((m) => Number(m[1]));
  assert.ok(Math.max(...seen) < 1200, `the latest line sent is at ${Math.max(...seen)} s, before the spoiler line`);
  const job = await fixtureData.latestJobByTarget(staff(), "title", t.id, "draft_series_text");
  assert.equal((job?.input as { cutoff_s: number }).cutoff_s, 1200);
  await fixtureData.setTitleAdRules(sys, t.id, { spoiler_from_s: 900, exclusions: [] });
  const moved = await draftSeriesText(producer(), t.id, { call: model });
  assert.equal(moved.status, "drafted", "a moved spoiler line is not the draft that was reused");
  assert.equal(model.calls.length, 2);
});

test("episodes with neither a film window nor a length get a nominal one in order, so the last episode never lands in the opening", async () => {
  const who = producer();
  const title = await fixtureData.createTitle(sys, { name_zh: "无时长", name_en: "No Lengths", producer_id: who.producerId! });
  const { ingestEpisodeFile } = await import("@/lib/ingest");
  const srt = (n: number) => `1\n00:00:01,000 --> 00:00:04,000\nepisode ${n} line\n`;
  for (let n = 1; n <= 10; n++) await fixtureData.addEpisodeFromIngest(sys, title.id, n, ingestEpisodeFile(new TextEncoder().encode(srt(n)), `ep${n}.srt`), { subtitlePath: null, videoPath: null });
  const tr = await loadTitleTranscript(title.id);
  assert.ok(tr);
  const starts = tr!.pieces.map((p) => p.start_s);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] > starts[i - 1], "each episode after the one before");
  const sel = selectTranscript(tr!.pieces, tr!.duration_s);
  const sent = [...sel.head, ...sel.sample].map((p) => p.text).join(" ");
  assert.doesNotMatch(sent, /episode (9|10) line/, "the last fifth of the episodes stays out");
  assert.match(sent, /episode 1 line/);
});
