// The crazydramas chip and section helpers (components/producer/CrazydramasChip):
// every state the match can answer has a tone and words in both locales
// with no number in them, the Import page's unlinked wording, every verdict
// has a pill and words, the price, seconds, delta and checked-time
// formatting, and the saved public bodies carry no playback id. The match
// itself is the core's (tests/crazydramas/*); this file covers only what
// the UI derives from it.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { VERDICT_PILL, checkedAtText, chipHintKey, chipKey, chipReading, chipTone, fmtDelta, fmtPriceCents, fmtSeconds } from "@/components/producer/CrazydramasChip";
import { CRAZYDRAMAS_STATES, EPISODE_VERDICTS } from "@/lib/crazydramas/match";
import en from "@/locales/en.json";
import zh from "@/locales/zh.json";

const EN = en as Record<string, string>;
const ZH = zh as Record<string, string>;
/** A complete three-episode reading's counts, for the chip-reading cases. */
const COUNTS = { missing: 0, extra: 0, not_ready: 0, same_length: 3, close: 0, different_length: 0, unknown: 0, identical: 0, studio: 3, live: 3, ready: 3 };

test("every chip state has a tone, words in both locales and no digit in them (a status board carries no numbers)", () => {
  const tones = new Set<string>();
  for (const state of CRAZYDRAMAS_STATES) {
    tones.add(chipTone(state));
    const key = chipKey(state);
    assert.ok(EN[key], `en words for ${state}`);
    assert.ok(ZH[key], `zh words for ${state}`);
    assert.doesNotMatch(EN[key], /\d/, `no number on the catalog chip (${state})`);
    assert.doesNotMatch(ZH[key], /\d/, `no number on the catalog chip (${state})`);
    const hint = chipHintKey(state);
    if (hint) assert.ok(EN[hint] && ZH[hint], `hint words for ${state}`);
  }
  assert.equal(chipTone("live_complete"), "is-live");
  assert.equal(chipTone("read_failed"), "is-bad");
  assert.equal(chipTone("not_linked"), "is-none");
  assert.equal(chipTone("not_checked"), "is-wait");
  for (const s of ["live_partial", "live_differs", "live_unverified", "local_newer"] as const) assert.equal(chipTone(s), "is-warn");
  assert.ok(tones.size >= 4, "the states are not one colour");
});

test("an unlinked film on the Import page says what to do; elsewhere it only says it is not linked; a complete series with older renders says so in words", () => {
  assert.equal(chipKey("not_linked", "import"), "cd.chip.not_linked.import");
  assert.equal(chipKey("not_linked"), "cd.chip.not_linked");
  assert.equal(EN["cd.chip.not_linked.import"], "Not linked: add a crazydramas slug");
  assert.equal(chipKey("live_complete", "import"), "cd.chip.live_complete");
  assert.equal(chipHintKey("not_live"), "cd.chip.not_live.hint");
  assert.equal(EN["cd.chip.not_live.hint"], "not uploaded, or draft");
  assert.equal(chipHintKey("live_complete"), null);
  assert.equal(chipHintKey("live_complete", true), "cd.chip.live_complete.hint", "an episode that reads close: still complete, said with a qualifier");
  assert.equal(EN["cd.chip.live_complete.hint"], "some older renders");
  assert.doesNotMatch(EN["cd.chip.live_complete.hint"] + ZH["cd.chip.live_complete.hint"], /\d/, "no count on the chip");
  assert.equal(chipHintKey("live_differs", true), null, "older is a qualifier of complete only");
  assert.deepEqual(chipReading({ state: "live_complete", stale: false, counts: { ...COUNTS, close: 2 } }), { state: "live_complete", stale: false, older: true });
  assert.deepEqual(chipReading({ state: "live_complete", stale: true, counts: COUNTS }), { state: "live_complete", stale: true, older: false });
  assert.deepEqual(chipReading({ state: "live_differs", stale: false, counts: { ...COUNTS, close: 2 } }), { state: "live_differs", stale: false, older: false });
  assert.ok(EN["cd.check.preview.link"] && ZH["cd.check.preview.link"], "the staff-preview note links to the staff page");
});

test("every verdict has a pill and words, and the evidence label on the checked time is the observed one", () => {
  for (const v of EPISODE_VERDICTS) {
    assert.ok(VERDICT_PILL[v], `pill for ${v}`);
    assert.ok(EN[`cd.verdict.${v}`] && ZH[`cd.verdict.${v}`], `words for ${v}`);
  }
  assert.equal(EN["research.evidence.observed"], "Observed");
  assert.equal(ZH["research.evidence.observed"], "实测");
});

test("price, seconds, delta and the checked time format deterministically", () => {
  assert.equal(fmtPriceCents(999), "$9.99");
  assert.equal(fmtPriceCents(0), "$0.00");
  assert.equal(fmtPriceCents(null), "—");
  assert.equal(fmtSeconds(116.567), "116.567");
  assert.equal(fmtSeconds(112), "112");
  assert.equal(fmtSeconds(124.1), "124.1");
  assert.equal(fmtSeconds(1.23456), "1.235");
  assert.equal(fmtSeconds(null), null);
  assert.equal(fmtDelta(3), "+3");
  assert.equal(fmtDelta(-14), "−14");
  assert.equal(fmtDelta(0), "0");
  assert.equal(fmtDelta(null), null);
  assert.equal(checkedAtText("2026-09-23T07:40:12.345Z"), "2026-09-23 07:40 UTC");
  assert.equal(checkedAtText(null), null);
  assert.equal(checkedAtText("not a time"), "not a time");
});

test("the saved public bodies carry no playback id or thumbnail url (plan A1.3)", () => {
  const dir = path.join(process.cwd(), "tests", "fixtures", "crazydramas");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const name of ["catalog.json", "drama-forced-to-marry-the-mafia-boss.json", "not-found.json"]) assert.ok(files.includes(name), name);
  for (const f of files) {
    const text = readFileSync(path.join(dir, f), "utf8");
    assert.doesNotMatch(text, /playbackId|thumbnailUrl|previewPlaybackId/, `${f} is stripped`);
    JSON.parse(text);
  }
  const catalog = JSON.parse(readFileSync(path.join(dir, "catalog.json"), "utf8")) as { dramas: { slug: string; posterUrl: string }[] };
  assert.ok(catalog.dramas.every((d) => !d.slug.startsWith("mock-")), "the saved catalog was read with pulsar_mock=0");
  assert.equal(catalog.dramas.filter((d) => d.posterUrl.includes("-placeholder")).length, 3, "three live series carry a placeholder poster (plan A3)");
  const series = JSON.parse(readFileSync(path.join(dir, "drama-forced-to-marry-the-mafia-boss.json"), "utf8")) as { drama: { episodes: { episodeNumber: number; durationSeconds: number; isPublished: boolean }[] } };
  assert.equal(series.drama.episodes.length, 52);
  assert.ok(series.drama.episodes.every((e, i) => e.episodeNumber === i + 1 && e.isPublished), "numbered 1..52, every one published");
});
