// Export renderer tests. Run with `npm test` (node:test via tsx). The
// subtitle and CSV cases pin byte-level details a player or Excel would
// choke on silently (comma vs dot, BOM, CRLF, quoting); the HTML cases
// render the fixture's frozen ep1 snapshot and the pack and check that the
// documents are self-contained — no "http" anywhere, since partners open
// them from mainland China where an external asset stalls the page.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fixtureData } from "@/lib/data/fixture";
import { producer as producerSession, seedMinute } from "./seed-minute";
import type { Clip, Variant, VersionSnapshot } from "@/lib/types";
import {
  briefHtml,
  contentDisposition,
  csvRowsFromSnapshot,
  diffDocumentHtml,
  exportFilename,
  packageHtml,
  slugify,
  srtTime,
  toCsv,
  toCues,
  toSrt,
  toVtt,
  vttTime,
} from "@/lib/export";

// The frozen snapshot comes from the real pipeline over the V2 seed: replay
// the first pass on the founder's minute, finalize, read the export
// snapshot. Built once (test files run in their own process).
const ready = (async () => {
  const seeded = await seedMinute({ adapt: true });
  const producer = producerSession();
  const wb = await fixtureData.getWorkbench(producer, seeded.id, 1);
  await fixtureData.finalizeVersion(producer, wb.version!.id);
  const snap = await fixtureData.getExportSnapshot(producer, seeded.id, 1);
  const detail = await fixtureData.getTitle(producer, seeded.id);
  return { title: detail.title, episode: wb.episode, version: snap.version, snapshot: snap.snapshot, titleId: seeded.id, adaptationId: detail.adaptation.id };
})();

// Synthetic pack rows for the brief/package renderers (the V2 seed ships none).
let vSeq = 0;
function makeVariant(kind: Variant["kind"], text_en: string, opts: Partial<Variant> = {}): Variant {
  vSeq += 1;
  return {
    id: `00000000-0000-4000-8000-9000000000${String(vSeq).padStart(2, "0")}`,
    external_id: `var_test${String(vSeq).padStart(9, "0")}`,
    title_id: "00000000-0000-4000-8000-990000000001",
    adaptation_id: "00000000-0000-4000-8000-990000000002",
    kind,
    text_en,
    text_zh: null,
    rationale_en: null,
    rationale_zh: null,
    tags: [],
    selected: false,
    status: "candidate",
    model: null,
    prompt_version: null,
    job_id: null,
    created_by: null,
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    ...opts,
  };
}
const VARIANTS: Variant[] = [
  makeVariant("title", "Xiang Yuan", { selected: true }),
  makeVariant("title", "The Chairman's Granddaughter"),
  makeVariant("hook", "She walked in late. He never forgot her.", { selected: true }),
  makeVariant("hook", "Have we met before?"),
  makeVariant("description", "A late arrival, a familiar face, a boardroom secret."),
  makeVariant("thumbnail_concept", "Lobby handshake, held one beat too long."),
  makeVariant("ad_angle", "secret identity"),
  makeVariant("hook", "Dismissed option", { status: "dismissed" }),
];
const CLIPS: Clip[] = [
  {
    id: "00000000-0000-4000-8000-900000000101",
    external_id: "clip_test00000001",
    title_id: "00000000-0000-4000-8000-990000000001",
    episode_id: "00000000-0000-4000-8000-900000000102",
    adaptation_id: null,
    rank: 1,
    start_ms: 14000,
    end_ms: 24000,
    scene_ids: [],
    hook_en: "So you're the famous Xiang Yuan.",
    why_en: "Recognition beat, plays with zero context.",
    why_zh: "初见即似曾相识，无需上下文。",
    opening_text_en: "Have we met?",
    cut_length_s: 10,
    angle: "secret_identity",
    status: "shortlisted",
    model: null,
    prompt_version: null,
    job_id: null,
    created_at: "2026-09-04T00:00:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-900000000103",
    external_id: "clip_test00000002",
    title_id: "00000000-0000-4000-8000-990000000001",
    episode_id: "00000000-0000-4000-8000-900000000102",
    adaptation_id: null,
    rank: 2,
    start_ms: 42500,
    end_ms: 47500,
    scene_ids: [],
    hook_en: "Doesn't she look like — you know, that guy?",
    why_en: "Whispered gossip; instant intrigue.",
    why_zh: "窃窃私语，悬念拉满。",
    opening_text_en: null,
    cut_length_s: 5,
    angle: "cliffhanger",
    status: "dismissed",
    model: null,
    prompt_version: null,
    job_id: null,
    created_at: "2026-09-04T00:00:00.000Z",
  },
];

const LINES = [
  { start_ms: 1200, end_ms: 3450, text_en: "No, no, no. Not now.", change_type: "tighten", merges: [] },
  { start_ms: 3850, end_ms: 6000, text_en: null, change_type: "cut", merges: [] },
  { start_ms: 6400, end_ms: 7000, text_en: "And now I've lost signal.\nPerfect.", change_type: "tone", merges: ["src-8"] },
  { start_ms: null, end_ms: null, text_en: "Untimed line", change_type: "rewrite", merges: [] },
  { start_ms: 3_600_000, end_ms: 3_601_005, text_en: "Past the hour", change_type: "keep", merges: [] },
];
const SOURCES = [{ id: "src-8", start_ms: 7000, end_ms: 9250 }];

test("timecodes: SRT comma, VTT dot, hour carry, rounding", () => {
  assert.equal(srtTime(1200), "00:00:01,200");
  assert.equal(vttTime(1200), "00:00:01.200");
  assert.equal(srtTime(3_601_005), "01:00:01,005");
  assert.equal(vttTime(0), "00:00:00.000");
  assert.equal(srtTime(999.6), "00:00:01,000");
});

test("toCues: cut and untimed lines drop, merged spans widen, order by start", () => {
  const cues = toCues(LINES, SOURCES);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues[0], { start_ms: 1200, end_ms: 3450, text: "No, no, no. Not now." });
  assert.equal(cues[1].start_ms, 6400);
  assert.equal(cues[1].end_ms, 9250, "merged cue takes the absorbed line's end");
  assert.equal(cues[2].text, "Past the hour");
});

test("toSrt: renumbered cues, comma milliseconds, blank-line separated", () => {
  const srt = toSrt(LINES, SOURCES);
  assert.equal(
    srt,
    [
      "1",
      "00:00:01,200 --> 00:00:03,450",
      "No, no, no. Not now.",
      "",
      "2",
      "00:00:06,400 --> 00:00:09,250",
      "And now I've lost signal.",
      "Perfect.",
      "",
      "3",
      "01:00:00,000 --> 01:00:01,005",
      "Past the hour",
      "",
    ].join("\n"),
  );
  assert.ok(!srt.includes("\r"));
});

test("toVtt: WEBVTT header, dot milliseconds, NOTE sanitised", () => {
  const vtt = toVtt(LINES, SOURCES, "ver_abc --> test\n\nsecond");
  assert.ok(vtt.startsWith("WEBVTT\n\n"));
  assert.ok(vtt.includes("NOTE ver_abc -- > test\nsecond\n\n"));
  assert.ok(vtt.includes("1\n00:00:01.200 --> 00:00:03.450\nNo, no, no. Not now.\n"));
  assert.ok(!/\d{2}:\d{2}:\d{2},/.test(vtt), "no comma timecodes in VTT");
  assert.equal(toVtt([]), "WEBVTT\n\n");
});

test("toCsv: BOM, CRLF, every field quoted, quotes doubled, newlines kept inside a cell", () => {
  const csv = toCsv([
    {
      seq: 1,
      start: "0:01",
      end: "0:03",
      speaker: "林晚",
      text_zh: "别啊，别在这时候熄火。",
      text_en: 'She said "no".',
      back_translation_zh: "回译",
      change_type: "tighten",
      tags: "tighter;humor",
      rationale_zh: "第一行\n第二行",
      rationale_en: "",
      line_id: "ln_x",
      adapted_line_id: "rw_y",
      scene_id: "sc_z",
    },
  ]);
  assert.ok(csv.startsWith("\uFEFF\"seq\",\"start\""));
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[0].split(",").length, 14);
  assert.ok(csv.includes('"She said ""no""."'));
  assert.ok(csv.includes('"第一行\n第二行"'));
  assert.ok(csv.endsWith("\r\n"));
  assert.equal(lines[lines.length - 1], "");
});

test("csvRowsFromSnapshot: one row per adapted line, external ids only, seq order", async () => {
  const { title, episode, version, snapshot } = await ready;
  void episode; void version; void snapshot;
  const rows = csvRowsFromSnapshot(snapshot);
  const adaptedCount = snapshot.scenes.reduce((n, s) => n + s.adapted_lines.length, 0);
  assert.equal(rows.length, adaptedCount);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].seq > rows[i - 1].seq);
  for (const r of rows) {
    assert.match(r.line_id, /^ln_/);
    assert.match(r.adapted_line_id, /^rw_/);
    assert.match(r.scene_id, /^sc_/);
    assert.ok(r.text_zh.length > 0);
  }
  const csv = toCsv(rows);
  assert.ok(!/[0-9a-f]{8}-0000-4000-8000-[0-9a-f]{12}/.test(csv), "no uuid leaves the repo");
});

test("diffDocumentHtml: self-contained, both locales, header carries version id + sha + state, major changes first", async () => {
  const { title, episode, version, snapshot } = await ready;
  void episode; void version; void snapshot;
  for (const locale of ["zh", "en"] as const) {
    const html = diffDocumentHtml({ title, episode, snapshot, locale, version, producer_name: "星海影视" });
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(!html.toLowerCase().includes("http"), `${locale}: no external host`);
    assert.ok(!html.includes("<script"));
    assert.ok(html.includes(snapshot.version.external_id));
    assert.ok(html.includes(version.snapshot_sha256 as string));
    assert.ok(html.includes(locale === "zh" ? "已批准" : "Approved"));
    assert.ok(html.includes(locale === "zh" ? "为什么这样改编" : "Why this version"));
    assert.ok(html.includes("break-before: page"));
    for (const s of snapshot.scenes) assert.ok(html.includes(`id="${s.external_id}"`));
    const majorIdx = html.indexOf(locale === "zh" ? "<h2>重大改动</h2>" : "<h2>Major changes</h2>");
    const firstScene = html.indexOf('<section class="scene"');
    assert.ok(majorIdx > 0 && majorIdx < firstScene, "major changes section precedes the scenes");
    assert.ok(!/[0-9a-f]{8}-0000-4000-8000-[0-9a-f]{12}/.test(html), "no uuid in the document");
  }
});

test("diffDocumentHtml: a draft without a version row says draft and prints no hash", async () => {
  const { title, episode, version, snapshot } = await ready;
  void episode; void version; void snapshot;
  const html = diffDocumentHtml({ title, episode, snapshot, locale: "en" });
  assert.ok(html.includes(">Draft<"));
  assert.ok(!html.includes("sha256</dt>"));
});

test("diffDocumentHtml: escapes markup in content", async () => {
  const { title, episode, version, snapshot } = await ready;
  void episode; void version; void snapshot;
  const hostile: VersionSnapshot = {
    ...snapshot,
    scenes: [
      {
        ...snapshot.scenes[0],
        context_zh: "<img src=x>",
        context_en: "<img src=x>",
        adapted_lines: snapshot.scenes[0].adapted_lines.map((a, n) =>
          n === 0 ? { ...a, text_en: '<script>alert("x")</script>' } : a,
        ),
      },
    ],
  };
  const html = diffDocumentHtml({ title, episode, snapshot: hostile, locale: "en" });
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&lt;img src=x&gt;"));
});

test("briefHtml: ranked clip table without dismissed clips, selected picks, no external host", async () => {
  const { title, episode, version, snapshot } = await ready;
  void episode; void version; void snapshot;
  const html = briefHtml({ title, clips: CLIPS, variants: VARIANTS, episodes: [episode] });
  assert.ok(!html.toLowerCase().includes("http"));
  const live = CLIPS.filter((c) => c.status !== "dismissed");
  for (const c of live) assert.ok(html.includes(c.external_id));
  for (const c of CLIPS.filter((c) => c.status === "dismissed")) assert.ok(!html.includes(c.external_id));
  const selTitle = VARIANTS.find((v) => v.kind === "title" && v.selected);
  const selHook = VARIANTS.find((v) => v.kind === "hook" && v.selected);
  assert.ok(selTitle && html.includes(selTitle.text_en));
  assert.ok(selHook && html.includes(selHook.text_en));
  assert.ok(html.includes("<table>"));
  const zh = briefHtml({ title, clips: CLIPS, variants: VARIANTS, locale: "zh" });
  assert.ok(zh.includes("推荐广告片段"));
  const empty = briefHtml({ title, clips: [], variants: [] });
  assert.ok(empty.includes("No clip suggestions yet"));
});

test("packageHtml: every kind sectioned, pick leads, dismissed dropped, no external host", async () => {
  const { title, episode, version, snapshot } = await ready;
  void episode; void version; void snapshot;
  const html = packageHtml({ title, variants: VARIANTS });
  assert.ok(!html.toLowerCase().includes("http"));
  for (const h of ["Title options", "Short descriptions", "Thumbnail concepts", "Hooks", "Ad angles"]) {
    assert.ok(html.includes(`<h2>${h}</h2>`), h);
  }
  const dismissed = VARIANTS.filter((v) => v.status === "dismissed");
  assert.ok(dismissed.length > 0);
  for (const v of dismissed) assert.ok(!html.includes(v.external_id));
  const selTitle = VARIANTS.find((v) => v.kind === "title" && v.selected)!;
  const otherTitle = VARIANTS.find((v) => v.kind === "title" && !v.selected)!;
  assert.ok(html.indexOf(selTitle.external_id) < html.indexOf(otherTitle.external_id), "platform pick leads");
});

test("filename: ascii slug, episode + version segments, disposition with UTF-8 fallback", async () => {
  const { title, episode, version, snapshot } = await ready;
  void episode; void version; void snapshot;
  assert.equal(slugify("Xiang Yuan"), "xiang-yuan");
  assert.equal(slugify("爱在旅途"), "");
  assert.equal(slugify("  Café: Après / Ski!! "), "cafe-apres-ski");
  const name = exportFilename({ title, episode: 1, version_external_id: version.external_id, format: "diff" });
  assert.match(name, /^xiang-yuan-ttl_[a-z2-7]{13}-ep01-ver_[a-z2-7]{13}-diff\.html$/);
  assert.equal(exportFilename({ title, format: "brief" }), `xiang-yuan-${title.external_id}-brief.html`);
  assert.equal(
    exportFilename({ title: { name_en: null, name_zh: "爱在旅途", external_id: "ttl_abc" }, episode: 12, format: "srt" }),
    "ttl_abc-ep12-srt.srt",
  );
  const cd = contentDisposition("a.srt", "爱在旅途 第1集.srt");
  assert.ok(cd.startsWith('attachment; filename="a.srt"; filename*=UTF-8\'\''));
  assert.ok(!/[^\x20-\x7e]/.test(cd), "header value is ASCII");
  assert.equal(contentDisposition("a.srt", "a.srt"), 'attachment; filename="a.srt"');
});
