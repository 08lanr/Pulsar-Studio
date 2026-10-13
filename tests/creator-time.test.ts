// The Queue's time picker means the account's own wall clock (decision 2026-10-12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { utcToZoned, zonedToUtc } from "@/lib/creators/time";
import { cannedCaptions } from "@/lib/creators/captions";
import { captionOptionProblem } from "@/lib/prompts/creator";

test("a San Francisco wall time is the right instant, across daylight saving", () => {
  assert.equal(zonedToUtc("2026-10-14T08:30", "America/Los_Angeles"), "2026-10-14T15:30:00.000Z"); // PDT
  assert.equal(zonedToUtc("2026-12-01T08:30", "America/Los_Angeles"), "2026-12-01T16:30:00.000Z"); // PST
  assert.equal(utcToZoned("2026-10-14T15:30:00.000Z", "America/Los_Angeles"), "2026-10-14T08:30");
  assert.equal(zonedToUtc("tomorrow", "America/Los_Angeles"), null);
});

test("demo captions pass the caption rules", () => {
  const options = cannedCaptions([{ description: "Chloe at a café table by the window: blazer, latte" } as never]);
  assert.equal(options.length, 3);
  for (const o of options) assert.equal(captionOptionProblem(o), null, o);
  assert.match(options[0], /^chloe at a café table by the window 🤍$/);
  assert.match(captionOptionProblem("link in bio: chloe.com") ?? "", /link/);
  assert.match(captionOptionProblem("#a #b #c #d") ?? "", /hashtags/);
});
