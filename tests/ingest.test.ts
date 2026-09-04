// Ingest layer tests. Run with `npm test` (node:test via tsx). The fixtures
// in tests/fixtures/ are small synthetic Chinese samples, one per format,
// so a regression in any parser shows up as a wrong speaker or a lost line
// rather than a silent shape change the workbench would render anyway.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { detectFormat, ingestEpisodeFile } from "@/lib/ingest";
import { parseSubtitles } from "@/lib/ingest/subtitles";
import { parseScriptText } from "@/lib/ingest/script-text";
import { segmentScenes } from "@/lib/ingest/scenes";
import { parseTimestamp, splitSpeaker } from "@/lib/ingest/text";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures");
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const readBytes = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));

test("parseTimestamp: comma and dot ms, hour-less, centiseconds", () => {
  assert.equal(parseTimestamp("00:00:01,500"), 1500);
  assert.equal(parseTimestamp("00:00:01.500"), 1500);
  assert.equal(parseTimestamp("01:02.250"), 62_250);
  assert.equal(parseTimestamp("0:00:01.50"), 1500);
  assert.equal(parseTimestamp("1:00:00,000"), 3_600_000);
  assert.equal(parseTimestamp("00:00:01.5"), 1500);
  assert.equal(parseTimestamp("abc"), null);
});

test("splitSpeaker: prefixes become the speaker, plain colons do not", () => {
  assert.deepEqual(splitSpeaker("张伟：你好"), { text: "你好", speaker: "张伟" });
  assert.deepEqual(splitSpeaker("李娜: 我在等你。"), { text: "我在等你。", speaker: "李娜" });
  assert.deepEqual(splitSpeaker("[张伟] 等我干什么？"), { text: "等我干什么？", speaker: "张伟" });
  assert.deepEqual(splitSpeaker("（李娜）这不是你的吗？"), { text: "这不是你的吗？", speaker: "李娜" });
  assert.deepEqual(splitSpeaker("Zhang Wei: fine"), { text: "fine", speaker: "Zhang Wei" });
  // Too long to be a name, a clock time, a URL, a stage direction.
  assert.deepEqual(splitSpeaker("我昨天就已经跟你说过了：不行。"), { text: "我昨天就已经跟你说过了：不行。" });
  assert.deepEqual(splitSpeaker("现在是12:30，你该走了。"), { text: "现在是12:30，你该走了。" });
  assert.deepEqual(splitSpeaker("http://example.com"), { text: "http://example.com" });
  assert.deepEqual(splitSpeaker("（沉默）"), { text: "（沉默）" });
});

test("SRT: two-character conversation, tags stripped, multi-line joined", () => {
  const r = parseSubtitles(read("conversation.srt"), "srt");
  assert.equal(r.format, "srt");
  assert.equal(r.cues.length, 10);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.cues[0].start_ms, 1000);
  assert.equal(r.cues[0].end_ms, 2500);
  assert.equal(r.cues[2].text, "等我干什么？");
  assert.equal(r.cues[2].raw, "<i>等我干什么？</i>");
  assert.equal(r.cues[3].text, "这不是你的东西吗？");
  assert.equal(r.cues[7].text, "你当然不记得，\n你那时候昏迷着。");
  assert.equal(r.cues[9].index, 10);
  assert.equal(r.cues[0].speaker, undefined);
});

test("SRT: speaker prefixes in the text", () => {
  const r = parseSubtitles(read("prefixed.srt"), "srt");
  const speakers = r.cues.map((c) => c.speaker ?? null);
  assert.deepEqual(speakers, ["张伟", "李娜", "张伟", "李娜", null, null, null, "王医生", null, "Zhang Wei"]);
  assert.equal(r.cues[0].text, "你怎么还没走？");
  assert.equal(r.cues[2].text, "等我干什么？");
  assert.equal(r.cues[3].text, "这不是你的东西吗？");
  assert.equal(r.cues[5].text, "我昨天就已经跟你说过了：不行。");
  assert.equal(r.cues[6].text, "现在是12:30，你该走了。");
  assert.equal(r.cues[8].text, "（沉默）");
});

test("SRT: BOM and CRLF are stripped (bytes and string paths)", () => {
  const bytes = readBytes("bom-crlf.srt");
  assert.equal(bytes[0], 0xef);
  assert.equal(bytes[1], 0xbb);
  assert.equal(bytes[2], 0xbf);

  const fromBytes = ingestEpisodeFile(bytes, "bom-crlf.srt");
  assert.equal(fromBytes.format, "srt");
  assert.equal(fromBytes.lines.length, 6);
  assert.equal(fromBytes.lines[0].speaker, "张伟");
  assert.equal(fromBytes.lines[0].text_zh, "你怎么还没走？");
  assert.equal(fromBytes.lines[5].text_zh, "三年前，\n你在医院。");
  assert.ok(!fromBytes.lines.some((l) => l.text_zh.includes("\r")));

  const fromString = ingestEpisodeFile(fs.readFileSync(path.join(FIXTURES, "bom-crlf.srt"), "utf8"), "bom-crlf.srt");
  assert.equal(fromString.lines.length, 6);
  assert.equal(fromString.lines[0].start_ms, 1000);
});

test("VTT: voice tags give the speaker; hour-less timestamps; settings ignored", () => {
  const r = parseSubtitles(read("conversation.vtt"), "vtt");
  assert.equal(r.format, "vtt");
  assert.equal(r.cues.length, 10);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.cues[0].speaker, "张伟");
  assert.equal(r.cues[0].text, "你怎么还没走？");
  assert.equal(r.cues[0].start_ms, 1000);
  assert.equal(r.cues[1].end_ms, 4000); // "align:start position:10%" after the end time
  assert.equal(r.cues[1].text, "我在等你。"); // closing </v> removed
  assert.equal(r.cues[2].speaker, "张伟"); // <v.loud 张伟> with a class
  assert.equal(r.cues[2].text, "等我干什么？");
  assert.equal(r.cues[4].speaker, undefined);
  assert.equal(r.cues[7].start_ms, 17_100); // with hours
  assert.equal(r.cues[7].text, "你当然不记得，\n你那时候昏迷着。");
});

test("ASS: Name field is the speaker, override blocks stripped, Comment skipped", () => {
  const r = parseSubtitles(read("conversation.ass"), "ass");
  assert.equal(r.format, "ass");
  assert.equal(r.cues.length, 10); // the Comment: line is not a cue
  assert.deepEqual(r.warnings, []);
  assert.equal(r.cues[0].speaker, "张伟");
  assert.equal(r.cues[0].start_ms, 1000);
  assert.equal(r.cues[0].end_ms, 2500);
  assert.equal(r.cues[2].text, "等我干什么？"); // {\i1}...{\i0}
  assert.equal(r.cues[3].text, "这不是你的东西吗？"); // {\an8}
  assert.equal(r.cues[4].speaker, undefined); // empty Name
  assert.equal(r.cues[4].text, "……你从哪儿找到的？");
  assert.equal(r.cues[7].text, "你当然不记得，\n你那时候昏迷着。"); // \N
  assert.equal(r.cues[8].text, "所以是你救了我？"); // {\pos(540,1700)} has a comma inside
  assert.equal(r.cues[9].text, "不是我，是他。"); // comma inside the Text field
});

test("ASS: honours the Format line's column order", () => {
  const ass = [
    "[Events]",
    "Format: Start, End, Name, Style, Text",
    "Dialogue: 0:00:01.00,0:00:02.00,李娜,Default,你好，张伟。",
    "Dialogue: 0:00:02.50,0:00:03.00,张伟,Default,你好。",
  ].join("\n");
  const r = parseSubtitles(ass, "ass");
  assert.equal(r.cues.length, 2);
  assert.equal(r.cues[0].speaker, "李娜");
  assert.equal(r.cues[0].text, "你好，张伟。");
  assert.equal(r.cues[1].start_ms, 2500);
});

test("warnings: overlap, zero duration, non-monotonic, empty cue dropped", () => {
  const r = parseSubtitles(read("overlap.srt"), "srt");
  assert.equal(r.cues.length, 5);
  assert.deepEqual(
    r.cues.map((c) => c.index),
    [1, 2, 3, 4, 5]
  );
  const has = (re: RegExp) => r.warnings.some((w) => re.test(w));
  assert.ok(has(/cue 2 .*overlaps cue 1/), r.warnings.join("\n"));
  assert.ok(has(/cue 3 .*zero or negative duration/), r.warnings.join("\n"));
  assert.ok(has(/cue 4 .*starts before cue 3/), r.warnings.join("\n"));
  assert.ok(has(/cue 5 .*empty .*dropped/), r.warnings.join("\n"));
  assert.equal(r.cues[4].text, "最后一句。");
});

test("scenes: a 4-second silence splits the episode", () => {
  const r = ingestEpisodeFile(read("conversation.srt"), "conversation.srt");
  assert.equal(r.hasTimecodes, true);
  assert.deepEqual(r.scenes, [
    { number: 1, start_ms: 1000, end_ms: 9500, from_seq: 1, to_seq: 5 },
    { number: 2, start_ms: 13_600, end_ms: 22_000, from_seq: 6, to_seq: 10 },
  ]);
  // A larger gap threshold keeps it as one scene.
  const one = ingestEpisodeFile(read("conversation.srt"), "conversation.srt", { gapMs: 5000 });
  assert.equal(one.scenes.length, 1);
  assert.equal(one.scenes[0].to_seq, 10);
});

test("segmentScenes: minLines, explicit breaks, overlapping ends", () => {
  const items = [
    { seq: 1, start_ms: 0, end_ms: 1000 },
    { seq: 2, start_ms: 5000, end_ms: 6000, scene_break: true }, // break too early: scene 1 has 1 line
    { seq: 3, start_ms: 6100, end_ms: 9000 },
    { seq: 4, start_ms: 7000, end_ms: 8000 }, // ends before the previous cue does
    { seq: 5, start_ms: 12_000, end_ms: 13_000 }, // gap -> new scene, last, allowed to be short
  ];
  const scenes = segmentScenes(items, { gapMs: 2500, minLines: 2 });
  assert.deepEqual(scenes, [
    { number: 1, start_ms: 0, end_ms: 9000, from_seq: 1, to_seq: 4 },
    { number: 2, start_ms: 12_000, end_ms: 13_000, from_seq: 5, to_seq: 5 },
  ]);
  assert.deepEqual(segmentScenes([]), []);
  // minLines 1 honours the explicit break immediately.
  assert.equal(segmentScenes(items, { minLines: 1 }).length, 3);
});

test("txt: script with 第一场 / 第二场 markers, no timecodes", () => {
  const r = ingestEpisodeFile(read("script.txt"), "script.txt");
  assert.equal(r.format, "txt");
  assert.equal(r.hasTimecodes, false);
  assert.equal(r.lines.length, 7);
  assert.deepEqual(
    r.lines.map((l) => l.speaker),
    ["张伟", "李娜", null, "张伟", "李娜", "王医生", "李娜"]
  );
  assert.equal(r.lines[2].text_zh, "（张伟愣住）"); // stage direction kept, no speaker
  assert.equal(r.lines[5].text_zh, "他醒了。");
  assert.ok(r.lines.every((l) => l.start_ms === null && l.end_ms === null));
  assert.deepEqual(r.scenes, [
    { number: 1, start_ms: null, end_ms: null, from_seq: 1, to_seq: 5 },
    { number: 2, start_ms: null, end_ms: null, from_seq: 6, to_seq: 7 },
  ]);
  assert.deepEqual(r.warnings, []);
});

test("parseScriptText: headings are recorded, separators skipped", () => {
  const r = parseScriptText(read("script.txt"));
  assert.equal(r.hasTimecodes, false);
  assert.deepEqual(r.headings, [
    { seq: 1, text: "第一集 / 第一场 咖啡馆 日 内" },
    { seq: 6, text: "第二场 医院走廊 夜 内" },
  ]);
  assert.ok(!r.lines.some((l) => l.text === "---"));
  assert.equal(r.lines[0].scene_break, true);
  assert.equal(r.lines[1].scene_break, undefined);
  assert.equal(parseScriptText("").warnings[0], "no dialogue lines found");
});

test("format detection: extension first, then content", () => {
  assert.equal(detectFormat(read("conversation.srt"), "ep01.srt"), "srt");
  assert.equal(detectFormat(read("conversation.vtt"), "ep01.vtt"), "vtt");
  assert.equal(detectFormat(read("conversation.ass"), "ep01.ass"), "ass");
  assert.equal(detectFormat(read("conversation.ass"), "ep01.SSA"), "ass");
  // No usable extension: sniff.
  assert.equal(detectFormat(read("conversation.srt"), "ep01"), "srt");
  assert.equal(detectFormat(read("conversation.vtt"), "download.bin"), "vtt");
  assert.equal(detectFormat(read("conversation.ass"), "download.bin"), "ass");
  assert.equal(detectFormat(read("bom-crlf.srt"), "download.bin"), "srt");
  // .txt holding subtitle content is still a subtitle file.
  assert.equal(detectFormat(read("conversation.srt"), "ep01.txt"), "srt");
  assert.equal(detectFormat(read("script.txt"), "ep01.txt"), "txt");
  assert.equal(detectFormat(read("script.txt"), "ep01.md"), "txt");
});

test("ingestEpisodeFile: line shape mirrors studio.lines", () => {
  const r = ingestEpisodeFile(read("conversation.vtt"), "ep01.vtt");
  assert.equal(r.format, "vtt");
  assert.deepEqual(Object.keys(r.lines[0]).sort(), ["end_ms", "seq", "speaker", "start_ms", "text_zh"]);
  assert.deepEqual(r.lines[0], { seq: 1, start_ms: 1000, end_ms: 2500, text_zh: "你怎么还没走？", speaker: "张伟" });
  assert.equal(r.lines[4].speaker, null);
  assert.deepEqual(r.lines.map((l) => l.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(r.scenes.length, 2);
});
