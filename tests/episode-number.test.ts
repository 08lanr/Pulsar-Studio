// Filename → episode number (lib/ingest/episode-number): the guesses the
// bulk uploader makes for a producer dropping a whole season at once, and
// the exact rule the workspace scanner uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { guessEpisodeNumber, isPartialFile, parseWorkspaceEpisodeFile } from "@/lib/ingest/episode-number";

test("Chinese episode markers", () => {
  assert.equal(guessEpisodeNumber("向园 第3集.srt"), 3);
  assert.equal(guessEpisodeNumber("第 12 集 终版.ass"), 12);
  assert.equal(guessEpisodeNumber("爱在旅途第107话.vtt"), 107);
});

test("western patterns", () => {
  assert.equal(guessEpisodeNumber("xiangyuan-S01E04.srt"), 4);
  assert.equal(guessEpisodeNumber("show.ep07.final.vtt"), 7);
  assert.equal(guessEpisodeNumber("Episode 21.txt"), 21);
  assert.equal(guessEpisodeNumber("drama_E09.ssa"), 9);
});

test("bare trailing number, ignoring years and resolutions", () => {
  assert.equal(guessEpisodeNumber("xiangyuan-02.srt"), 2);
  assert.equal(guessEpisodeNumber("2026 export 05.srt"), 5);
  assert.equal(guessEpisodeNumber("drama.1080p.03.srt"), 3);
});

test("nothing usable returns null", () => {
  assert.equal(guessEpisodeNumber("final draft.srt"), null);
  assert.equal(guessEpisodeNumber("字幕.srt"), null);
});

test("a render still being written is never an episode", () => {
  assert.equal(guessEpisodeNumber("ep30.mp4"), 30);
  assert.equal(guessEpisodeNumber("ep30.part.mp4"), null, "the pipeline's in-progress file used to parse as 30");
  assert.equal(guessEpisodeNumber("ep30.mp4.part"), null);
  assert.equal(guessEpisodeNumber("第3集.PART.mp4"), null);
  assert.equal(isPartialFile("ep30.part.mp4"), true);
  assert.equal(isPartialFile("ep30.mp4"), false);
  assert.equal(isPartialFile("party.mp4"), false);
});

test("the workspace's own file names are exact: epNN.mp4 and nothing else", () => {
  assert.equal(parseWorkspaceEpisodeFile("ep07.mp4"), 7);
  assert.equal(parseWorkspaceEpisodeFile("ep52.mp4"), 52);
  assert.equal(parseWorkspaceEpisodeFile("ep30.part.mp4"), null);
  assert.equal(parseWorkspaceEpisodeFile("Ep07.mp4"), null);
  assert.equal(parseWorkspaceEpisodeFile("ep07.mov"), null);
  assert.equal(parseWorkspaceEpisodeFile("ep07.mp4.bak"), null);
  assert.equal(parseWorkspaceEpisodeFile("eps.zip"), null);
  assert.equal(parseWorkspaceEpisodeFile("ep0.mp4"), null);
});
