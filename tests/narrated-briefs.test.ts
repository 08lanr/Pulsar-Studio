// The narrated route's briefs and the voice prediction (decision 2026-09-23
// "Narrated mode in Studio"): the prep brief is READ from the synced
// PREP-BRIEF.md and filled (every placeholder, absolute paths for a project
// under high-quality/, the story-specific parts only when a run replaces
// them, Studio's READY_GPU rule on top); the window sentence takes the
// file's three forms; the script-read brief is Studio's output contract
// until drama-remix commits one; and the TTS prediction uses
// tts_narration.py's own sig formula — this test reads that line from the
// canonical script and fails if it changes.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pipelinePython, pythonAvailable } from "@/lib/python";
import { absolutizeBriefPaths, fillPrepBrief, readPrepBrief, textBlockAfter, unfilledPlaceholders, windowText } from "@/lib/segment/narrated/briefs";
import { canonicalSkipThrough } from "@/lib/segment/narrated/stages";
import { predictRender, pyLen, ttsSig } from "@/lib/segment/narrated/voice";

const canonical = canonicalSkipThrough();
const haveBrief = existsSync(path.join(canonical, "PREP-BRIEF.md"));

const fill = {
  film: "C:/ws/projects/high-quality/lbl-s01e05",
  proj: "high-quality/lbl-s01e05",
  projectsRoot: "C:/ws/projects",
  dramaRemixRoot: "C:/ws/drama-remix",
  srcFile: "original.mp4",
  scripts: "SCRIPT-S01E05.md (and ../lbl-e04/SCRIPT-S01E04.md for the cast)",
  n: 36,
  p: 35,
  window: "the FIRST episode of source episode 5. Start at or after 140 s (2:20). End at or before ~392 s (6:32), on a shot cut",
  story: "She meets her new tenant.",
  series: "Love Between Lines",
  sourceLabel: "S01E05",
  runId: "12345678-aaaa-bbbb-cccc-000000000000",
};

test("the committed PREP-BRIEF.md splits into its header paragraph and its text block, and fills with nothing left over", (t) => {
  if (!haveBrief) return t.skip("no drama-remix checkout with PREP-BRIEF.md on this machine");
  const tpl = readPrepBrief(canonical);
  assert.match(tpl.header, /^You are preparing ONE episode of the narrated "[^"]+" remix/);
  assert.ok(tpl.header.includes("{N}") && tpl.header.includes("{window}") && tpl.header.includes("{story}"));
  assert.match(tpl.body, /^PROJECT: /);
  assert.match(tpl.body, /STEPS/);
  assert.match(tpl.sha, /^[0-9a-f]{64}$/);

  const text = fillPrepBrief(tpl, fill);
  assert.deepEqual(unfilledPlaceholders(text), []);
  assert.match(text, /PROJECT: C:\/ws\/projects\/high-quality\/lbl-s01e05\./, "PROJECT is the film itself");
  assert.match(text, /Episode: \*\*ep36\*\* \(source S01E05\), the FIRST episode/);
  assert.match(text, /Story in this window: She meets her new tenant\./);
  assert.match(text, /narrated "Love Between Lines" remix/);
  assert.ok(!/(^|\s)\.\.\/\.\.\/drama-remix\//m.test(text), "no depth-relative drama-remix path is left");
  assert.match(text, /C:\/ws\/drama-remix\/references\/episode-build-runbook\.md/);
  assert.match(text, /C:\/ws\/projects\/love-between-lines\/PROCESS-EPISODE\.md/, "a sibling project resolves under projects/, not under high-quality/");
  assert.match(text, /Do not create ep36\/READY_GPU/, "Studio starts the GPU lane after the prep review");
  assert.match(text, /Write ep36\/PREP\.md covering/);
  assert.match(text, /NEVER run tts_narration\.py/, "the brief's own prohibitions are kept word for word");

  const custom = fillPrepBrief(tpl, { ...fill, names: "canon spellings are in glossary.json.\n- The heroine is Ada.", workedExample: "The worked example: ../lbl-e04/ep30/PREP.md." });
  assert.match(custom, /NAMES: canon spellings are in glossary\.json\.\n- The heroine is Ada\./);
  assert.ok(!custom.includes("The man behind Qin is **Boss Yu**"), "the committed NAMES bullets are replaced");
  assert.match(custom, /^5\. The worked example: C:\/ws\/projects\/lbl-e04\/ep30\/PREP\.md\./m);
  assert.match(custom, /^SHARED-FILE DISCIPLINE/m, "the section after NAMES is intact");
});

test("the brief pieces are read from the markdown, never assumed", () => {
  const md = "# X\n\n## The brief\n\n```text\nPROJECT: a/{PROJ}\n{N}\n```\n";
  assert.equal(textBlockAfter(md, /^## The brief\s*$/m), "PROJECT: a/{PROJ}\n{N}");
  assert.equal(textBlockAfter("# nothing", /^## The brief\s*$/m), null);
  const dir = mkdtempSync(path.join(tmpdir(), "studio-brief-"));
  try {
    assert.throws(() => readPrepBrief(dir), /not there/);
    writeFileSync(path.join(dir, "PREP-BRIEF.md"), md);
    assert.throws(() => readPrepBrief(dir), /header paragraph/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(absolutizeBriefPaths("read ../lbl-e03/edl/ep24.json and ../../drama-remix/references/x.md", { projectsRoot: "C:\\ws\\projects", dramaRemixRoot: "C:\\ws\\drama-remix" }), "read C:/ws/projects/lbl-e03/edl/ep24.json and C:/ws/drama-remix/references/x.md");
});

test("the window sentence takes PREP-BRIEF.md's three forms", () => {
  assert.equal(windowText({ src_in: 149, src_out: 392 }, { first: true, last: false, sourceLabel: "S01E04" }), "the FIRST episode of source episode 4. Start at or after 149 s (2:29). End at or before ~392 s (6:32), on a shot cut");
  assert.equal(windowText({ src_in: 392, src_out: 587 }, { first: false, last: false, sourceLabel: "S01E04" }), "start at or after ~392 s (6:32) and end at or before ~587 s (9:47), on shot cuts");
  assert.equal(windowText({ src_in: 2271, src_out: 2577 }, { first: false, last: true, sourceLabel: "S01E04" }), "the LAST episode of source episode 4. Start at or after ~2271 s (37:51) and end at or before 2577 s (42:57), on a shot cut");
  assert.match(windowText({ src_in: 0, src_out: 200.5 }, { first: true, last: true, sourceLabel: "" }), /^the ONLY episode\. Start at or after 0 s \(0:00\) and end at or before 200\.5 s/);
});

test("the TTS prediction uses tts_narration.py's own sig formula, read from the canonical script", (t) => {
  const file = path.join(canonical, "tts_narration.py");
  if (!existsSync(file)) return t.skip("no drama-remix checkout on this machine");
  const src = readFileSync(file, "utf8");
  // If this line changes, the prediction (lib/segment/narrated/voice.ts ttsSig) must change with it.
  assert.match(src, /sig = hashlib\.sha1\(\(voice_id \+ "\|" \+ MODEL \+ "\|" \+ text\)\.encode\(\)\)\.hexdigest\(\)\[:10\]/);
  assert.match(src, /MODEL = __import__\("os"\)\.environ\.get\("ELEVEN_MODEL", "eleven_multilingual_v2"\)/, "the default the run must always override with ELEVEN_MODEL");
  const text = "I didn't know yet — he was my tenant.";
  if (pythonAvailable()) {
    const r = spawnSync(pipelinePython(), ["-c", "import hashlib,sys;print(hashlib.sha1(('v1|eleven_v3|'+sys.argv[1]).encode()).hexdigest()[:10])", text], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
    if (r.status === 0) assert.equal(ttsSig("v1", "eleven_v3", text), r.stdout.trim(), "the same sig as Python for a line with an em dash");
  }
  assert.equal(pyLen("a—b😀"), 4, "characters are counted as Python counts them");
});

test("the prediction bills only the lines whose take is missing or was made from other words, voice or model", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "studio-tts-"));
  try {
    const nf = path.join(dir, "narration.json");
    writeFileSync(nf, JSON.stringify({ lines: [{ id: "N1", text: "First line." }, { id: "N2", text: "Second line, reworded." }, { id: "N3", text: "Third." }, { id: "C1", text: "not a narration line" }] }));
    const takes = path.join(dir, "narration");
    mkdirSync(takes);
    writeFileSync(path.join(takes, "N1.mp3"), "x");
    writeFileSync(path.join(takes, "N1.mp3.sig"), ttsSig("jess", "eleven_v3", "First line."));
    writeFileSync(path.join(takes, "N2.mp3"), "x");
    writeFileSync(path.join(takes, "N2.mp3.sig"), ttsSig("jess", "eleven_v3", "Second line."));
    const p = predictRender(nf, "jess", "eleven_v3");
    assert.equal(p.lines, 3);
    assert.deepEqual(p.render.map((r) => r.id), ["N2", "N3"]);
    assert.equal(p.chars, "Second line, reworded.".length + "Third.".length);
    assert.equal(p.kept, 1);
    assert.equal(predictRender(nf, "jess", "eleven_multilingual_v2").render.length, 3, "a missing ELEVEN_MODEL would re-bill every line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
