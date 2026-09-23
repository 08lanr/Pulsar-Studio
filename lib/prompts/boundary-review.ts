// verify_boundaries, the reviewer's half: where one episode of a cut-only
// film ends and the next begins, chosen by LOOKING at the option strips.
// A port of the Look phase of the pipeline's pick_by_eye.workflow.js
// (drama-remix/scripts/cut-only, 2026-09-22): rules 1-6 word for word, the
// same output fields, the same precondition (never judge from dialogue
// alone). What changes is how the evidence arrives: the Workflow's agent
// opened review/options.json and Read each strip itself; here the strips
// ride on the call as images, in option order, and the option facts are
// written into the user message.
//
// The second pass (decision 2026-09-23, "The frame judge, second pass")
// adds what the Workflow's agents got from tools and STATE.md and the API
// model was never told: the source's own card marks the original break
// (rule 7), a caption on both sides of the cut is a split line (rule 8), a
// block on how to read a strip (which tile is the cut, which tiles are this
// episode and which the next), the motion flag as a detector reading and
// not a fact, the neighbours and the range this cut must lie in, and a
// schema that records what each option's strip shows BEFORE the choice.
// The Workflow's RULES are not mirrored here: that repo is read-only from
// Studio, so rules 7-8 wait for their own commit there.
//
// Schemas use .nullable(), never .optional(): lib/llm.ts emits strict JSON
// schema where every key is required.

import { z } from "zod";
import type { LlmProvider, LlmSystemBlock } from "@/lib/llm";
import { asLlmImage, cutTileOf, inCardSpan, type CardSpan, type OptionsBoundary, type StripImage, type StripLayout } from "@/lib/segment/strips";

/** Bumped when the rules, the prompt text or a schema changes; part of every verify_boundaries idempotency key. */
export const BOUNDARY_RULE_VERSION = "by-eye-v2";

/** The standing decisions: 1-6 verbatim from pick_by_eye.workflow.js, 7-8 from the second pass. Not preferences. */
export const BOUNDARY_RULES = [
  "Standing decisions, not preferences:",
  "1. Episodes run CONTINUOUS. No intro card, no recap, no narrator. Episode N+1 starts on the frame after episode N ends.",
  "2. NEVER cut inside a physical action - mid-punch, mid-throw, mid-fall.",
  "3. The physical payoff belongs at the END of an episode. If someone is thrown into a pool, the episode must end AFTER they hit the water and go under - not before the throw, and not on a line of dialogue about it. Handing the payoff to the next episode wastes the hook.",
  "4. After an impact, leave roughly 1.0-1.5s of aftermath (follow-through, reaction) so the blow reads. A cut 0.5s after contact lands but never registers.",
  "5. The cut must end on an open question AND be somewhere a cold viewer can start and tell who is on screen within about 10 seconds.",
  "6. A break landing after the tension has already resolved is weak however clean it looks.",
  '7. If the source shows its own episode break - a flare or light leak with a vertical "TO BE CONTINUED" card, or a fade to black - that is where the original episode ended. Cut on the FIRST frame after it (the hard cut to the next shot). Never start an episode on the card, the flare into it or any part of it, and do not leave the card inside an episode with more story after it.',
  "8. A burned-in subtitle that shows on tiles on BOTH sides of the cut means the cut splits a spoken line. Do not choose that option, whatever the dialogue list says: the transcript misses voice-overs and shouted lines, the burned captions do not.",
].join("\n");

/** Film-specific facts a reviewer must know (the Workflow's `film_notes`), e.g. how the source marks its own episode breaks. */
export function filmNotesBlock(notes: string | null | undefined): string {
  const text = notes?.trim();
  return text ? `About this film:\n${text}` : "";
}

const secs = (n: number) => `${Math.round(n * 1000) / 1000} s`;

/** The tile facts of the layout: the cut tile (1-based), how many tiles come before it and how many from it on, in tiles and seconds. */
export function stripFacts(layout: Pick<StripLayout, "window" | "step" | "cols">): { cut: number; count: number; before: number; from: number; before_s: number; from_s: number; row: number; last_of_row: boolean } {
  const { index, count } = cutTileOf(layout);
  const cut = index + 1;
  return { cut, count, before: index, from: count - index, before_s: index * layout.step, from_s: (count - index) * layout.step, row: Math.floor(index / layout.cols) + 1, last_of_row: (index + 1) % layout.cols === 0 };
}

/**
 * READING THE STRIPS AND THE FACTS: the block the second pass adds to every
 * prompt that attaches a strip. The tile numbers follow from the layout; for
 * the pipeline's default (11 tiles, 6 per row, 0.5 s) the cut is tile 6, the
 * last of the first row.
 */
export function readingBlock(layout: Pick<StripLayout, "window" | "step" | "cols">, opts: { annotated?: boolean } = {}): string {
  const f = stripFacts(layout);
  const where = f.last_of_row ? `the LAST tile of the ${f.row === 1 ? "FIRST" : `row ${f.row}`} row` : `tile ${((f.cut - 1) % layout.cols) + 1} of row ${f.row}`;
  const rest = f.last_of_row && f.row === 1 ? "tile " + f.cut + " and the whole second row" : `tile ${f.cut} and every tile after it`;
  return [
    "READING THE STRIPS AND THE FACTS",
    `- In every strip the cut is tile ${f.cut}, ${where}. Tiles 1-${f.before} are the last ${secs(f.before_s)} of THIS episode; ${rest} are the first ${secs(f.from_s)} of the NEXT one. ends_on describes only tiles 1-${f.before} of the chosen option's own image, opens_on only tile ${f.cut} onward. Describe only what that image shows - never what another option's image or the dialogue list shows.`,
    ...(opts.annotated
      ? [
          "- Every strip is labelled: the header names the option and its cut time, each tile carries its own time in the top-left corner, tiles before the cut are marked END and tiles from the cut on are marked NEXT, and the cut tile has a red frame. Read the times off the tiles; the option list repeats them.",
        ]
      : []),
    '- "motion" comes from a motion detector, not a person. It also fires on flares, card transitions, fades, camera moves and walking. Only a punch, slap, push, grab, throw, fall, collision or something flying counts as a physical action for rules 2-4; a blink, a head turn, a hand gesture, a walk or a camera move does not. Judge from the frames; the motion numbers are never the time of an impact.',
    "- The dialogue list is whisper's transcript: times are where lines START, it misses voice-overs and shouting, and a line can be many seconds from the cut. It is never evidence of what is on screen.",
  ].join("\n");
}

/** How to read a strip: the Workflow's stripHowTo, with the images attached instead of Read, then the reading block. */
export function stripHowTo(layout: Pick<StripLayout, "window" | "step" | "cols">, opts: { annotated?: boolean } = {}): string {
  return [
    "Each option's strip is attached to this message as an image, in the order the options are listed. LOOK at the frames.",
    `A strip is a grid of frames ${layout.step}s apart, ${layout.cols} per row, read left to right then top to bottom.`,
    "Each option below lists the timestamp of every tile in that same order.",
    "The proposed cut falls at the CENTRE tile: the episode ENDS on the frames before it, and the next episode STARTS on the frames from it onward.",
    "",
    readingBlock(layout, opts),
  ].join("\n");
}

/** What one option's own strip shows, recorded before the choice (observation first: a model that does not think would otherwise write the choice as its first token and the description to fit it). */
export const OptionSeenSchema = z.object({
  key: z.string().describe("the option key this line describes, e.g. opt3"),
  ends_on: z.string().describe("what the tiles BEFORE the cut of this option's own image show, physically"),
  opens_on: z.string().describe("what the cut tile and the tiles after it show, physically"),
  caption_across_cut: z.boolean().describe("true when the same burned-in subtitle shows on a tile before the cut AND on the cut tile or after it (rule 8)"),
  card_or_flare: z.enum(["none", "before_cut", "across_cut", "after_cut"]).describe("where a flare, light leak, fade to black or TO BE CONTINUED card appears in this image, if at all (rule 7)"),
  physical_action_across_cut: z.string().nullable().describe("a punch, slap, push, grab, throw, fall, collision or something flying that is in progress on the cut tile; null when none"),
});

export type OptionSeen = z.infer<typeof OptionSeenSchema>;

export const BoundaryPickSchema = z.object({
  options_seen: z.array(OptionSeenSchema).describe("one entry per listed option, in option order, written from that option's own image BEFORE choosing"),
  chosen_key: z.string().describe("e.g. opt3"),
  chosen_t: z.number().describe("the option t in seconds, copied exactly from the option list"),
  ends_on: z.string().describe("what the viewer physically SEES in the last second of the episode (tiles before the cut of the chosen option's image)"),
  opens_on: z.string().describe("what the viewer physically SEES in the first second of the next episode (the cut tile onward)"),
  why: z.string(),
  rejected: z.string().nullable().describe("why the runner-up option is worse; null when there is no other option"),
  payoff_in_episode: z.boolean().describe("true if the nearest physical payoff lands INSIDE this episode rather than the next"),
  confidence: z.number().describe("0 to 1. Exactly 0 means you refused to judge (a strip missing or unreadable) and chose nothing"),
});

export type BoundaryPick = z.infer<typeof BoundaryPickSchema>;

/** The planner's neighbours of the boundary and the range a cut must lie in so both episodes stay in band (lib/segment/strips neighboursOf, allowedRange). */
export type BoundaryRange = { prev: number; next: number; lo: number; hi: number };

export type BoundaryReviewInput = {
  boundary: OptionsBoundary;
  /** One strip per option, in option order (lib/segment/strips boundaryStrips), annotated or raw. */
  strips: StripImage[];
  layout: StripLayout;
  band: [number, number];
  /** The neighbours and the allowed range; without it the prompt states the band alone (a synthetic call). */
  range?: BoundaryRange | null;
  /** The source's card spans (lib/segment/strips loadCardSpans): an option inside one is marked and refused (rule 7). */
  card_spans?: CardSpan[] | null;
  film_notes: string | null;
  /** The frame judge's gateway (visionProviderStatus); both are set together so resolveCall cannot cross vendors. */
  provider: LlmProvider;
  model: string;
};

const fmtT = (t: number) => `${t}s`;

/** One line per dialogue segment of the 45 s window, as the options file quotes them. */
export function renderDialogue(lines: { t: number; text: string }[]): string {
  return lines.length ? lines.map((l) => `  [${fmtT(l.t)}] ${l.text}`).join("\n") : "  (no dialogue)";
}

/** The motion detector's reading for an option, relabelled as a reading and not a fact (the first pass rendered `INSIDE an action` and the model took it as one). */
export function motionReading(o: Pick<OptionsBoundary["options"][number], "in_action" | "since_action" | "until_action">): string {
  if (o.in_action === true) return "motion detector: moving at the cut (a flare, card, fade or camera move also triggers it - check the frames)";
  if (o.in_action === false) {
    const parts = [o.since_action != null ? `motion ${o.since_action}s before` : null, o.until_action != null ? `${o.until_action}s after` : null].filter(Boolean);
    return `motion detector: still at the cut${parts.length ? ` (${parts.join(", ")})` : ""}`;
  }
  return "motion detector: (no reading)";
}

/** The line that marks an option inside the source's card span, or null: an episode opening there opens on the card (rule 7). */
export function cardMark(t: number, cards: CardSpan[] | null | undefined): string | null {
  const card = cards ? inCardSpan(t, cards) : null;
  return card ? `  ON THE CARD: ${fmtT(t)} is inside the source's own card ${card.from_s}-${card.to_s}s; the next episode would open on the card (rule 7). The first frame after it is ${card.to_s}s.` : null;
}

/** The option facts pick_cuts.py emitted, one block per option, naming the image that shows it; an option outside the allowed range or inside a card span is marked. The dialogue lines are in the DIALOGUE block with their times, not here. */
export function renderOptions(boundary: OptionsBoundary, strips: StripImage[], range?: Pick<BoundaryRange, "lo" | "hi"> | null, cards?: CardSpan[] | null): string {
  return boundary.options
    .map((o, i) => {
      const s = strips[i];
      const out = range && (o.t < range.lo - 1e-9 || o.t > range.hi + 1e-9) ? `  OUT OF RANGE: ${fmtT(o.t)} is outside ${range.lo}-${range.hi}s; it would leave an episode outside the band` : null;
      const card = cardMark(o.t, cards);
      return [`${o.key} at ${fmtT(o.t)}${o.is_dp_pick ? " [is_dp_pick]" : ""} - image ${i + 1}`, `  tiles: ${s ? s.tiles.join(", ") : "(no strip)"}`, `  ${motionReading(o)}`, ...(out ? [out] : []), ...(card ? [card] : [])].join("\n");
    })
    .join("\n");
}

/** The sentence the second pass puts in the boundary facts: the band, the planner's neighbours and the range this cut must lie in. */
export function rangeLine(band: [number, number], range: BoundaryRange | null | undefined): string {
  if (!range) return `Every episode must be ${band[0]}-${band[1]} s long.`;
  return `Every episode must be ${band[0]}-${band[1]} s long. The planner's neighbouring boundaries are at ${range.prev}s and ${range.next}s, so this cut must lie between ${range.lo}s and ${range.hi}s.`;
}

export function buildBoundaryReview(input: BoundaryReviewInput) {
  const { boundary, strips } = input;
  if (strips.length !== boundary.options.length) throw new Error(`buildBoundaryReview: ${strips.length} strips for ${boundary.options.length} options at ${boundary.boundary_s}`);
  const keys = boundary.options.map((o) => o.key);
  const annotated = strips.length > 0 && strips.every((s) => s.annotated);
  const system: LlmSystemBlock[] = [
    {
      text: [
        "You are choosing where one episode of a vertical mini-drama ends and the next begins.",
        "",
        "You are given one boundary and its options, between 1 and 8, each a legal cut point (a shot change clear of speech). Exactly one is marked is_dp_pick: the planner's own choice, which knows nothing about the picture.",
        "",
        stripHowTo(input.layout, { annotated }),
        "",
        "HARD PRECONDITION: if an option's strip is missing from the images, will not read, or does not show the tiles listed for it, STOP. Do not judge from the dialogue. Answer with why in the why field",
        "and set confidence to 0. Judging blind is the exact failure this pass exists to prevent.",
        "",
        "LOOK AT EVERY OPTION STRIP before deciding. Do not decide from the dialogue alone - the whole reason",
        "this pass exists is that the transcript cannot show a punch landing or a body hitting water.",
        "",
        BOUNDARY_RULES,
        filmNotesBlock(input.film_notes),
        "",
        `Every episode must be ${input.band[0]}-${input.band[1]} s long. The boundary facts below name the planner's neighbouring boundaries and the range this cut must lie in; an option outside that range, or inside the source's own card, is marked and cannot be chosen.`,
        "",
        "First fill options_seen: one entry per option, from that option's own image only, before you choose.",
        "Judge the options as PAIRS: what the episode ends on, and what the next one opens on. In ends_on and",
        "opens_on describe what you SEE in the frames, physically and concretely - not what the dialogue says.",
        "Set payoff_in_episode true only if the nearest physical payoff completes inside this episode.",
        "Copy chosen_t EXACTLY from the option list; do not round it.",
      ]
        .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
        .join("\n"),
      cache: true,
    },
  ];
  const user = [
    `BOUNDARY ${boundary.boundary_s}s (the planner's pick is ${boundary.dp_pick ?? boundary.boundary_s}s). The images attached before this text are the option strips, in this order.`,
    rangeLine(input.band, input.range),
    "",
    "OPTIONS",
    renderOptions(boundary, strips, input.range, input.card_spans),
    "",
    "DIALOGUE in the 45 s before the boundary (whisper; times are where each line starts)",
    renderDialogue(boundary.before),
    "",
    "DIALOGUE in the 45 s after",
    renderDialogue(boundary.after),
    "",
    `Choose one of ${keys.join(", ")}.`,
  ].join("\n");
  const range = input.range;
  return {
    name: "verify_boundaries_look",
    description: "Record what each option's strip shows, then which option ends this episode, what the viewer sees on either side of the cut, and why.",
    system,
    user,
    images: strips.map(asLlmImage),
    schema: BoundaryPickSchema,
    provider: input.provider,
    model: input.model,
    maxTokens: 6000,
    effort: "medium" as const,
    cacheSystem: true,
    prompt_version: BOUNDARY_RULE_VERSION,
    check: (out: BoundaryPick) => {
      if (out.confidence < 0 || out.confidence > 1) return "confidence is a number from 0 to 1";
      if (out.confidence === 0) return null; // a refusal chooses nothing; apply_vision never applies it
      const seen = out.options_seen.map((s) => s.key);
      const missing = keys.filter((k) => !seen.includes(k));
      const unknown = seen.filter((k) => !keys.includes(k));
      const dup = seen.filter((k, i) => seen.indexOf(k) !== i);
      if (missing.length || unknown.length || dup.length) return `options_seen must have exactly one entry per option (${keys.join(", ")}): missing ${JSON.stringify(missing)}, unknown ${JSON.stringify(unknown)}, repeated ${JSON.stringify(dup)}`;
      const o = boundary.options.find((x) => x.key === out.chosen_key);
      if (!o) return `chosen_key ${JSON.stringify(out.chosen_key)} is not one of ${keys.join(", ")}`;
      if (Math.abs(out.chosen_t - o.t) > 0.0005) return `chosen_t must be exactly ${o.t} for ${o.key} (copied from the option list), not ${out.chosen_t}`;
      if (range && (o.t < range.lo - 1e-9 || o.t > range.hi + 1e-9)) return `${o.key} at ${o.t}s is outside the allowed range ${range.lo}-${range.hi}s (an episode would leave the ${input.band[0]}-${input.band[1]} s band); choose an option inside it, or refuse with confidence 0 and say why`;
      const card = input.card_spans ? inCardSpan(o.t, input.card_spans) : null;
      if (card) return `${o.key} at ${o.t}s is inside the source's own card ${card.from_s}-${card.to_s}s: the next episode would open on the card (rule 7); choose the first frame after it or another option, or refuse with confidence 0 and say why`;
      return null;
    },
  };
}
