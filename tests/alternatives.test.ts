// Alternatives, post "take it another direction" (decisions.md 2026-09-04):
// the default click writes TWO takes that pull in different directions; a
// direction tap writes ONE more that leans into the tapped tag. The prompt
// enforces both shapes; the demo replay serves them from the bank so the
// producer portal behaves the same offline.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { replayAlternatives } from "@/lib/demo-replay";
import { DEFAULT_ALTERNATIVES, buildAlternatives, type AlternativesInput } from "@/lib/prompts/alternatives";
import { producer, seedMinute } from "./seed-minute";

afterEach(() => resetFixtureStore());

const promptInput = (extra: Partial<AlternativesInput> = {}): AlternativesInput => ({
  bible: { text: "bible", cache: true },
  episode_number: 1,
  scene: { number: 1, context_zh: null, context_en: null },
  line: { seq: 3, speaker: "向园", text_zh: "路上有点堵车", text_en: "Traffic was brutal.", start_ms: 0, end_ms: 1200, literal_en: null, current_rationale_en: null },
  around: [],
  existing_en: [],
  producer_note: null,
  ...extra,
});

const take = (text_en: string, tags: AlternativesInput["direction"][]) => ({
  text_en,
  back_translation_zh: "",
  rationale_zh: "",
  rationale_en: "",
  tags: tags.filter((t): t is NonNullable<typeof t> => !!t),
  syllables_est: 4,
});

test("the default prompt asks for two takes in different directions and rejects any other count", () => {
  assert.equal(DEFAULT_ALTERNATIVES, 2);
  const p = buildAlternatives(promptInput());
  assert.match(p.user, /Offer exactly 2 alternatives/);
  assert.equal(p.check({ alternatives: [take("a", ["tighter"]), take("b", ["humor"])] }), null);
  assert.match(p.check({ alternatives: [take("a", ["tighter"])] }) ?? "", /exactly 2/);
  assert.match(p.check({ alternatives: [take("a", ["tighter"]), take("b", ["humor"]), take("c", ["idiom"])] }) ?? "", /exactly 2/);
});

test("a direction asks for exactly one take that carries the tapped tag", () => {
  const p = buildAlternatives(promptInput({ direction: "more_emotional" }));
  assert.match(p.user, /Offer exactly 1 alternative/);
  assert.match(p.user, /more_emotional/);
  assert.equal(p.check({ alternatives: [take("a", ["more_emotional", "softened"])] }), null);
  assert.match(p.check({ alternatives: [take("a", ["tighter"])] }) ?? "", /more_emotional/);
  assert.match(p.check({ alternatives: [take("a", ["more_emotional"]), take("b", ["more_emotional"])] }) ?? "", /exactly 1/);
});

test("the demo replay serves two takes, then one more along a tapped direction", async () => {
  const t = await seedMinute({ adapt: true });
  const wb = await fixtureData.getWorkbench(producer(), t.id, 1);
  const line = wb.lines.find((l) => l.text_zh === "路上有点堵车");
  assert.ok(line, "the traffic line is in the founder's minute");
  const adapted = wb.adapted_lines.find((a) => a.line_id === line.id);
  assert.ok(adapted);
  const ctx = { titleId: t.id, episodeNumber: 1 };

  const first = await replayAlternatives(producer(), adapted.id, ctx);
  assert.equal(first.alternatives.length, 2, "one click, two takes");
  assert.equal(first.available, true);
  const directions = first.alternatives.map((a) => a.tags[0]);
  assert.notEqual(directions[0], directions[1], "the two takes lean different ways");

  const again = await replayAlternatives(producer(), adapted.id, ctx);
  assert.equal(again.alternatives.length, 0, "re-clicking adds nothing");
  assert.equal(again.all.length, 2);

  const more = await replayAlternatives(producer(), adapted.id, ctx, { direction: "clarity" });
  assert.equal(more.alternatives.length, 1, "a direction adds exactly one take");
  assert.ok(more.alternatives[0].tags.includes("clarity"), "and it carries the tapped tag when the bank has one");
  assert.equal(more.all.length, 3);

  const spent = await replayAlternatives(producer(), adapted.id, ctx, { direction: "humor" });
  assert.equal(spent.alternatives.length, 0, "once the bank is empty a direction adds nothing");
  assert.equal(spent.available, false, "and says so, so the UI can explain demo mode");
});
