// Transcription for script-less episodes (decision 2026-09-15): the word
// stream becomes subtitle-shaped cues (gaps, sentence ends, length caps);
// the attach path fills exactly one empty episode and never replaces a
// script; the run writes the transcribe_episode job with its audio-minute
// usage; availability is honest about demo replay and missing keys.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  asrAvailability,
  cuesToVtt,
  restoreMachineLines,
  runTranscribeEpisode,
  transcriptToCues,
  type AsrProvider,
  type AsrTranscript,
  type AsrWord,
} from "@/lib/asr";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { putStoredBytes } from "@/lib/data/storage";
import { ingestEpisodeFile } from "@/lib/ingest";
import { producer, staff } from "./seed-minute";

afterEach(() => resetFixtureStore());

const w = (word: string, start_ms: number, end_ms: number): AsrWord => ({ w: word, start_ms, end_ms });

// ---- transcriptToCues ------------------------------------------------------

test("cues break on silence gaps, keep word-accurate boundaries, and space Latin by its own tokens", () => {
  const cues = transcriptToCues({
    segments: [
      {
        start_ms: 0,
        end_ms: 4_000,
        text: "ignored when words exist",
        words: [w(" Hello", 200, 600), w(" there", 650, 1_000), w(" Okay", 1_700, 2_100), w(" go", 2_150, 2_500)],
      },
    ],
  });
  assert.deepEqual(cues, [
    { start_ms: 200, end_ms: 1_000, text: "Hello there" },
    { start_ms: 1_700, end_ms: 2_500, text: "Okay go" },
  ]);
});

test("cues split when they would run too long or too wide, and CJK joins without spaces", () => {
  const longRun: AsrWord[] = [];
  for (let i = 0; i < 30; i++) longRun.push(w("你好", i * 150, i * 150 + 120));
  const byWidth = transcriptToCues({ segments: [{ start_ms: 0, end_ms: 10_000, text: "", words: longRun }] });
  assert.ok(byWidth.length > 1, "a 60-character run does not fit one cue");
  assert.ok(byWidth.every((c) => c.text.length <= 42));
  assert.ok(byWidth.every((c) => !c.text.includes(" ")), "CJK words concatenate without spaces");

  const slow: AsrWord[] = [w("one", 0, 3_000), w(" two", 3_100, 6_200), w(" three", 6_300, 9_000)];
  const byTime = transcriptToCues({ segments: [{ start_ms: 0, end_ms: 9_000, text: "", words: slow }] });
  assert.ok(byTime.length > 1, "a nine-second mumble splits");
  assert.ok(byTime.every((c) => c.end_ms - c.start_ms <= 6_500));
});

test("sentence-final punctuation ends a cue once it has substance", () => {
  const cues = transcriptToCues({
    segments: [
      {
        start_ms: 0,
        end_ms: 5_000,
        text: "",
        words: [w("回来了。", 0, 1_400), w("你还敢回来", 1_450, 2_800), w("？", 2_800, 2_900), w("走吧", 3_000, 3_600)],
      },
    ],
  });
  assert.equal(cues[0].text, "回来了。");
  assert.equal(cues[1].text, "你还敢回来？");
  assert.equal(cues[2].text, "走吧");
});

test("a segment without word timestamps falls back to one cue; cues never overlap or flash", () => {
  const cues = transcriptToCues({
    segments: [
      { start_ms: 0, end_ms: 2_000, text: " Whole segment. ", words: [] },
      { start_ms: 1_900, end_ms: 1_950, text: "overlaps and is tiny", words: [] },
    ],
  });
  assert.deepEqual(cues[0], { start_ms: 0, end_ms: 2_000, text: "Whole segment." });
  assert.equal(cues[1].start_ms, 2_000, "the second cue starts after the first ends");
  assert.equal(cues[1].end_ms, 2_300, "and lasts at least 300 ms");
});

test("the VTT round-trips through the ingest parser with the machine NOTE intact", () => {
  const cues = [
    { start_ms: 200, end_ms: 1_800, text: "你以为我还会忍气吞声吗" },
    { start_ms: 2_400, end_ms: 4_000, text: "这一次不会了" },
  ];
  const vtt = cuesToVtt(cues, "Pulsar Studio machine transcription (asr) | local-whisper | test | zh");
  assert.match(vtt, /^WEBVTT\n/);
  assert.match(vtt, /NOTE Pulsar Studio machine transcription/);
  const parsed = ingestEpisodeFile(new TextEncoder().encode(vtt), "transcript.vtt");
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.hasTimecodes, true);
  assert.deepEqual(
    parsed.lines.map((l) => [l.start_ms, l.end_ms, l.text_zh]),
    [
      [200, 1_800, "你以为我还会忍气吞声吗"],
      [2_400, 4_000, "这一次不会了"],
    ]
  );
});

// ---- the run over the fixture store ----------------------------------------

const TRANSCRIPT: AsrTranscript = {
  language: "zh",
  duration_s: 61.5,
  segments: [
    { start_ms: 200, end_ms: 1_900, text: "你以为我还会忍气吞声吗", words: [] },
    // The parser's speaker heuristic would eat "他说：" — machine text must survive intact.
    { start_ms: 2_600, end_ms: 4_100, text: "他说：你别走", words: [] },
    { start_ms: 5_000, end_ms: 6_400, text: "把门关上", words: [] },
  ],
};

const stub = (transcript: AsrTranscript = TRANSCRIPT): AsrProvider => ({
  name: "stub",
  model: "stub-1",
  costCents: () => 0,
  transcribe: async () => transcript,
});

async function videoOnlyEpisode() {
  resetFixtureStore();
  const session = producer();
  const title = await fixtureData.createTitle(session, { name_zh: "无字幕剧", name_en: "No Script", producer_id: "ignored" });
  const videoPath = `${title.id}/episode-1/source.mp4`;
  await putStoredBytes(videoPath, Buffer.from("bytes standing in for a video"), "video/mp4");
  const episode = await fixtureData.addVideoOnlyEpisode(session, title.id, 1, videoPath);
  return { session, title, episode };
}

test("transcription fills a video-only episode through the normal ingest path", async () => {
  const { session, title } = await videoOnlyEpisode();
  const r = await runTranscribeEpisode(session, title.id, 1, { provider: stub() });
  assert.equal(r.summary.lines, 3);
  assert.equal(r.summary.language, "zh");
  assert.equal(r.episode.script_format, "asr");
  assert.equal(r.episode.has_timecodes, true);
  assert.ok(r.episode.source_script_path, "the machine VTT is stored as the source script");

  const wb = await fixtureData.getWorkbench(session, title.id, 1);
  assert.equal(wb.lines.length, 3);
  assert.deepEqual(
    wb.lines.map((l) => l.text_zh),
    ["你以为我还会忍气吞声吗", "他说：你别走", "把门关上"],
    "machine text survives the round trip — the speaker heuristic never eats '他说：'"
  );
  assert.ok(wb.lines.every((l) => l.start_ms !== null && l.end_ms !== null && l.speaker === null));
  assert.ok(wb.version, "a draft version opened for the first pass");
  assert.equal(wb.episode.duration_ms, 6_400, "duration derives from the transcript when the episode had none");

  const job = await fixtureData.latestEpisodeJob(session, title.id, 1, "transcribe_episode");
  assert.ok(job && job.status === "done");
  assert.equal(job!.cost_cents, 0, "the stub provider spends nothing");
  // 61.5 s = 1.025 min; two-decimal rounding lands on 1.02 (102.4999… rounds down).
  assert.equal((job!.usage as { audio_minutes: number }).audio_minutes, 1.02);
});

test("transcription refuses an episode that already has a script, has no video, or is already running", async () => {
  const { session, title } = await videoOnlyEpisode();
  await runTranscribeEpisode(session, title.id, 1, { provider: stub() });
  await assert.rejects(
    runTranscribeEpisode(session, title.id, 1, { provider: stub() }),
    /already has a script/,
    "a script is never silently replaced"
  );

  const bare = await fixtureData.createTitle(session, { name_zh: "无视频剧", producer_id: "ignored" });
  const srt = ingestEpisodeFile(new TextEncoder().encode("1\n00:00:00,000 --> 00:00:01,000\n你好\n"), "a.srt");
  await fixtureData.addEpisodeFromIngest(session, bare.id, 1, srt, { subtitlePath: null, videoPath: null });
  await assert.rejects(runTranscribeEpisode(session, bare.id, 1, { provider: stub() }), /has no video/);
});

test("attachIngestToEpisode is producer-scoped and refuses an episode with lines", async () => {
  const { session, title } = await videoOnlyEpisode();
  const srt = ingestEpisodeFile(new TextEncoder().encode("1\n00:00:00,000 --> 00:00:01,000\n第一句\n"), "a.srt");
  const foreign = { ...producer(), producerId: "00000000-0000-4000-8000-00000000ffff" };
  await assert.rejects(fixtureData.attachIngestToEpisode(foreign, title.id, 1, srt, { subtitlePath: null }), /not found/i);

  await fixtureData.attachIngestToEpisode(session, title.id, 1, srt, { subtitlePath: null });
  await assert.rejects(
    fixtureData.attachIngestToEpisode(session, title.id, 1, srt, { subtitlePath: null }),
    /already has a script/
  );
  const wb = await fixtureData.getWorkbench(staff(), title.id, 1);
  assert.equal(wb.lines.length, 1);
  assert.equal(wb.episode.script_format, "srt", "a subtitle attach keeps the parsed format");
});

test("restoreMachineLines refuses a round-trip mismatch instead of misattaching", () => {
  const vtt = cuesToVtt([{ start_ms: 0, end_ms: 1_000, text: "一句" }], "note");
  const parsed = ingestEpisodeFile(new TextEncoder().encode(vtt), "transcript.vtt");
  assert.throws(
    () => restoreMachineLines(parsed, [
      { start_ms: 0, end_ms: 1_000, text: "一句" },
      { start_ms: 2_000, end_ms: 3_000, text: "两句" },
    ]),
    /round-trip mismatch/
  );
});

test("a paid provider is refused at the engine while demo replay is on", async () => {
  const { session, title } = await videoOnlyEpisode();
  const paid: AsrProvider = { ...stub(), name: "openai" };
  await assert.rejects(runTranscribeEpisode(session, title.id, 1, { provider: paid }), /demo replay/);
});

// ---- availability -----------------------------------------------------------

test("availability is honest: unset, unknown, missing key, and demo replay all say why", () => {
  const saved = { provider: process.env.STUDIO_ASR_PROVIDER, key: process.env.OPENAI_API_KEY, replay: process.env.DEMO_REPLAY };
  try {
    delete process.env.STUDIO_ASR_PROVIDER;
    assert.match((asrAvailability() as { reason: string }).reason, /STUDIO_ASR_PROVIDER/);

    process.env.STUDIO_ASR_PROVIDER = "nope";
    assert.match((asrAvailability() as { reason: string }).reason, /not a known provider/);

    process.env.STUDIO_ASR_PROVIDER = "local-whisper";
    assert.deepEqual(asrAvailability(), { available: true, provider: "local-whisper" });

    process.env.STUDIO_ASR_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    assert.match((asrAvailability() as { reason: string }).reason, /OPENAI_API_KEY/);

    process.env.OPENAI_API_KEY = "sk-test";
    delete process.env.DEMO_REPLAY;
    assert.match((asrAvailability() as { reason: string }).reason, /demo replay/, "a real model call is refused in replay mode");

    process.env.DEMO_REPLAY = "0";
    assert.deepEqual(asrAvailability(), { available: true, provider: "openai" });
  } finally {
    if (saved.provider === undefined) delete process.env.STUDIO_ASR_PROVIDER;
    else process.env.STUDIO_ASR_PROVIDER = saved.provider;
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.key;
    if (saved.replay === undefined) delete process.env.DEMO_REPLAY;
    else process.env.DEMO_REPLAY = saved.replay;
  }
});
