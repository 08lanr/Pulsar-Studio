import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCaption, titleRestatesHook } from "@/lib/meta/publish";
import type { ClipLibraryRow } from "@/lib/launch/clip-posts";

// The caption summarised the plot twice (decision 2026-10-04). A short-drama
// title IS a plot summary, so hook + title said the same thing in two
// sentences. The cases below are the captions Studio actually posted on
// 2026-10-02 and 2026-10-03, which is what Ruobin was reading.

const clip = (label: string, title_name: string, over: Partial<ClipLibraryRow> = {}): ClipLibraryRow => ({
  id: "c", external_id: "clip_c", producer_id: "company", producer_name: "CrazyDramas",
  title_id: "t", title_name, episode_id: null, episode_label: null, label,
  kind: "video", value: "c", file_path: "stored/c.mp4", sha256: "a".repeat(64),
  media_url: null, spark_code: null, post_url: null, ...over,
} as ClipLibraryRow);

test("the captions that read as the same sentence twice now drop the title", () => {
  // Posted 2026-10-02 as two lines; the title adds nothing the hook has not said.
  const flirt = clip("The guy I loved told me to flirt with his rival. So I did.",
    "He Told Me to Flirt With His Rival. Then I Fell For Him");
  assert.equal(defaultCaption(flirt), "The guy I loved told me to flirt with his rival. So I did.");

  const flirt2 = clip("He told her to flirt with his rival. The rival noticed her first.",
    "He Told Me to Flirt With His Rival. Then I Fell For Him");
  assert.equal(defaultCaption(flirt2), "He told her to flirt with his rival. The rival noticed her first.");

  // "begged" and "begging" are the same word once stemmed, which is what makes
  // this one a restatement rather than a new fact.
  const humiliated = clip("He humiliated me to make another girl laugh. A month later he begged me to come back. I said no.",
    "He Humiliated Me in Front of the Whole School, Now He's Begging For Me Back");
  assert.equal(defaultCaption(humiliated), "He humiliated me to make another girl laugh. A month later he begged me to come back. I said no.");
});

test("a title that tells you something new keeps its line", () => {
  // Posted 2026-10-02. The hook is one scene; the title is the whole arc, and
  // shares no words with it — it is worth reading.
  const cheer = clip("My secret boyfriend told the whole party I wasn't his type.",
    "Dumped for the Cheer Queen, I Came Back and Took Her Crown");
  assert.equal(defaultCaption(cheer),
    "My secret boyfriend told the whole party I wasn't his type.\nDumped for the Cheer Queen, I Came Back and Took Her Crown");
});

test("an episode number is always worth a second line", () => {
  // The hook can never carry it, so a numbered clip keeps the line even when
  // the words repeat.
  const numbered = clip("He told me to flirt with his rival. So I did.",
    "He Told Me to Flirt With His Rival. Then I Fell For Him", { episode_label: "3" });
  assert.equal(defaultCaption(numbered),
    "He told me to flirt with his rival. So I did.\nHe Told Me to Flirt With His Rival. Then I Fell For Him · Episode 3");
});

test("a clip with no hook still gets the title, never its internal reference", () => {
  const bare = clip("clip_c", "Ghostly Night Bus");
  assert.equal(defaultCaption(bare), "Ghostly Night Bus");
  // And a hook-less clip never compares nothing against the title.
  assert.equal(titleRestatesHook("", "Ghostly Night Bus"), false);
  assert.equal(titleRestatesHook("a hook", ""), false);
});

test("the restatement test asks only whether the title adds anything", () => {
  // A long hook that happens to contain a short title is still a restatement…
  assert.equal(titleRestatesHook("She boarded the last night bus and everyone on it was already dead.", "Ghostly Night Bus"), true);
  // …while a short hook under a long title is not, because the title is mostly new.
  assert.equal(titleRestatesHook("The bus was full.", "Offered to the Dragon King, I'm the Only One Who Can Break His Curse"), false);
});
