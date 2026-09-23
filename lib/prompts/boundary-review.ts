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
// The calibration of the second pass (phase 2.1, 2026-09-23) found the
// model reading rule 7 backwards (an option whose END tiles carry the card
// "contains the card, so it must be avoided") and rule 8 as any two
// captions, choosing an option its own options_seen had faulted, and the
// reading block calling tile 6 the cut of the dense strip too. So rule 7
// now states its target positively, rule 8 says the SAME line, the check
// refuses a pick the model's own options_seen contradicts, and the reading
// block names the dense strip's cut tile from that strip's own layout.
//
// Its second round (by-eye-v4) found the model choosing a LATER option
// after the card when its own options_seen marked an earlier one as the
// first frame after it (2324.933, twice), and refusing with confidence 0
// on a why of "placeholder" and two of seven options_seen entries
// (2785.5). So selfContradiction also names the earlier option that is
// rule 7's target, and a refusal must still cover every option and name
// the image it could not read (refusalProblem): every strip is rendered
// and attached before the call, so a blank refusal is a repair, not an
// answer.
//
// The Claude arms (by-eye-v5, "The frame judge on Claude, measured") found
// two more holes. The reviewer chose an option whose own entry showed no
// card while another option's entry showed the source's card (3276.333:
// Sonnet's cut put the confession and the card ten seconds into the next
// episode, unflagged; 4313.4: Opus buried the card eighteen seconds inside
// the episode), so selfContradiction refuses a chosen `none` beside any
// other entry's card and says which way the card lands; and a document
// handed between two men was called "a grab" by Sonnet's skeptic and
// tie-break (3983.433, the only bad override of the Claude arms), so the
// reading block defines a grab. The judge's calls ask for tool_choice auto
// (`toolChoice`): a forced call skips the thinking.
//
// Schemas use .nullable(), never .optional(): lib/llm.ts emits strict JSON
// schema where every key is required.

import { z } from "zod";
import type { LlmProvider, LlmSystemBlock } from "@/lib/llm";
import { asLlmImage, cutIndexOf, cutTileOf, inCardSpan, type CardSpan, type OptionsBoundary, type StripImage, type StripLayout } from "@/lib/segment/strips";

/** Bumped when the rules, the prompt text or a schema changes; part of every verify_boundaries idempotency key. */
export const BOUNDARY_RULE_VERSION = "by-eye-v5";

/** The standing decisions: 1-6 verbatim from pick_by_eye.workflow.js, 7-8 from the second pass. Not preferences. */
export const BOUNDARY_RULES = [
  "Standing decisions, not preferences:",
  "1. Episodes run CONTINUOUS. No intro card, no recap, no narrator. Episode N+1 starts on the frame after episode N ends.",
  "2. NEVER cut inside a physical action - mid-punch, mid-throw, mid-fall.",
  "3. The physical payoff belongs at the END of an episode. If someone is thrown into a pool, the episode must end AFTER they hit the water and go under - not before the throw, and not on a line of dialogue about it. Handing the payoff to the next episode wastes the hook.",
  "4. After an impact, leave roughly 1.0-1.5s of aftermath (follow-through, reaction) so the blow reads. A cut 0.5s after contact lands but never registers.",
  "5. The cut must end on an open question AND be somewhere a cold viewer can start and tell who is on screen within about 10 seconds.",
  "6. A break landing after the tension has already resolved is weak however clean it looks.",
  '7. If the source shows its own episode break - a flare or light leak with a vertical "TO BE CONTINUED" card, or a fade to black - that is where the original episode ended. The best cut is the FIRST frame after the source\'s card: the option whose END tiles finish on the card and whose cut tile is already the next shot. The card belongs at the END of this episode, so a card before the cut is the target, not a fault. Only two things are faults: a cut tile that still shows the card, flare or fade (the next episode opens on it), and a cut a second or more after the card ends (the card is buried inside an episode with more story after it).',
  "8. If the SAME subtitle line (the same words) shows on the last tile before the cut AND on the cut tile, the cut splits a spoken line; do not choose it, whatever the dialogue list says: the transcript misses voice-overs and shouted lines, the burned captions do not. One line ending before the cut and a different line starting after it is not a split.",
].join("\n");

/** What a grab is for rules 2-4, in the reading block and every schema that asks for a physical action: Sonnet 5's skeptic and tie-break called a document handed between two men "a grab/pass action" and overrode the right cut (3983.433). */
export const GRAB_DEFINITION = "A grab means seizing a person (an arm, a collar, hair) or snatching something by force; handing over, receiving, holding or reading an object is not a physical action for rules 2-4.";

/** The physical actions an options_seen entry or a verdict may name across the cut, with the grab defined. */
export const ACTION_LIST = "a punch, slap, push, grab, throw, fall, collision or something flying (a grab seizes a person - an arm, a collar, hair - or snatches something by force; handing over, receiving, holding or reading an object is not one)";

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

/** A dense strip as the reading block needs it: its tiles, its layout and the cut time at its centre. */
export type DenseLayout = Pick<StripImage, "tiles" | "cols" | "step" | "t">;

/**
 * The dense strip's own tile facts, for the reading block: which tile is
 * its cut (the centre tile at `t`, the red-framed one when annotated), in
 * which row, and where the option strips' cut tile number falls in it. The
 * calibration's tie-break claimed the card sat on the dense strip's cut
 * tile because the block said "tile 6" of every strip: in the pipeline's
 * 31-tile dense strip the cut is tile 16 and tile 6 is a second before it.
 */
export function denseReadingLine(dense: DenseLayout, optionCutTile: number, opts: { annotated?: boolean } = {}): string {
  const index = cutIndexOf(dense.tiles, dense.t);
  const k = index + 1;
  const row = Math.floor(index / dense.cols) + 1;
  const col = (index % dense.cols) + 1;
  const offset = Math.round((k - optionCutTile) * dense.step * 1000) / 1000;
  const six = offset > 0 ? `its tile ${optionCutTile} is ${secs(offset)} BEFORE the cut` : offset < 0 ? `its tile ${optionCutTile} is ${secs(-offset)} AFTER the cut` : `its tile ${optionCutTile} is the cut`;
  return `- In the DENSE strip (${dense.tiles.length} tiles ${dense.step} s apart, ${dense.cols} per row) the cut is tile ${k} (row ${row}, tile ${col} of that row, ${opts.annotated ? "the red-framed tile" : "the centre tile"}); ${six}. Its tiles 1-${index} are THIS episode, tile ${k} on the NEXT.`;
}

/**
 * READING THE STRIPS AND THE FACTS: the block the second pass adds to every
 * prompt that attaches a strip. The tile numbers follow from the layout; for
 * the pipeline's default (11 tiles, 6 per row, 0.5 s) the cut is tile 6, the
 * last of the first row. That holds for the OPTION strips only: a dense
 * strip attached to the call gets its own line from its own layout.
 */
export function readingBlock(layout: Pick<StripLayout, "window" | "step" | "cols">, opts: { annotated?: boolean; dense?: DenseLayout | null } = {}): string {
  const f = stripFacts(layout);
  const where = f.last_of_row ? `the LAST tile of the ${f.row === 1 ? "FIRST" : `row ${f.row}`} row` : `tile ${((f.cut - 1) % layout.cols) + 1} of row ${f.row}`;
  const rest = f.last_of_row && f.row === 1 ? "tile " + f.cut + " and the whole second row" : `tile ${f.cut} and every tile after it`;
  return [
    "READING THE STRIPS AND THE FACTS",
    `- In every OPTION strip the cut is tile ${f.cut}, ${where}. Tiles 1-${f.before} are the last ${secs(f.before_s)} of THIS episode; ${rest} are the first ${secs(f.from_s)} of the NEXT one. ends_on describes only tiles 1-${f.before} of the chosen option's own image, opens_on only tile ${f.cut} onward. Describe only what that image shows - never what another option's image or the dialogue list shows.`,
    ...(opts.dense ? [denseReadingLine(opts.dense, f.cut, { annotated: opts.annotated })] : []),
    ...(opts.annotated
      ? [
          "- Every strip is labelled: the header names the option and its cut time, each tile carries its own time in the top-left corner, tiles before the cut are marked END and tiles from the cut on are marked NEXT, and the cut tile has a red frame. Read the times off the tiles; the option list repeats them.",
        ]
      : []),
    `- "motion" comes from a motion detector, not a person. It also fires on flares, card transitions, fades, camera moves and walking. Only a punch, slap, push, grab, throw, fall, collision or something flying counts as a physical action for rules 2-4; a blink, a head turn, a hand gesture, a walk or a camera move does not. ${GRAB_DEFINITION} Judge from the frames; the motion numbers are never the time of an impact.`,
    "- The dialogue list is whisper's transcript: times are where lines START, it misses voice-overs and shouting, and a line can be many seconds from the cut. It is never evidence of what is on screen.",
  ].join("\n");
}

/** How to read a strip: the Workflow's stripHowTo, with the images attached instead of Read, then the reading block (with the dense strip's own line when one is attached). */
export function stripHowTo(layout: Pick<StripLayout, "window" | "step" | "cols">, opts: { annotated?: boolean; dense?: DenseLayout | null } = {}): string {
  return [
    "Each option's strip is attached to this message as an image, in the order the options are listed. LOOK at the frames.",
    `An option strip is a grid of frames ${layout.step}s apart, ${layout.cols} per row, read left to right then top to bottom.`,
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
  caption_across_cut: z.boolean().describe("true only when the SAME burned-in subtitle line (the same words) shows on the last tile before the cut AND on the cut tile (rule 8); one line ending before the cut and a different line starting after it is false"),
  card_or_flare: z
    .enum(["none", "before_cut", "across_cut", "after_cut"])
    .describe(
      "where a flare, light leak, fade to black or TO BE CONTINUED card appears in this image, if at all (rule 7): none; before_cut = the card ends before the cut and the cut tile is the next shot (what rule 7 asks for); across_cut = the cut tile still shows the card, flare or fade (the next episode would open on it); after_cut = the card shows on tiles after the cut (the cut comes before the source's break)"
    ),
  physical_action_across_cut: z.string().nullable().describe(`a physical action in progress on the cut tile - ${ACTION_LIST}; null when none`),
});

/** True when an options_seen entry names a physical action across the cut (a model sometimes writes "none" for null). */
export function namesAction(entry: Pick<OptionSeen, "physical_action_across_cut">): boolean {
  const text = entry.physical_action_across_cut?.trim() ?? "";
  return text !== "" && !/^(none|null|no|n\/a|-|nothing)$/i.test(text);
}

/** An option the reviewer may choose (in range, not on a card), with its time: what selfContradiction ranks "earlier" by. */
export type ChoosableOption = { key: string; t: number };

/**
 * What the reviewer's own options_seen entry for its chosen option says
 * against the choice, or null: the calibration had the model flag a caption
 * across the cut (2429, 1325.967, 3866.967, 115.367) or a card on the cut
 * tile and choose that option anyway, and one of those was a real rule-8
 * split. A deterministic check catches exactly that. With the choosable
 * options given, a chosen option marked `before_cut` while an EARLIER
 * choosable option is marked the same, clean of captions and actions, is
 * refused too: rule 7's target is the FIRST frame after the card, and the
 * later one buries it (2324.933 chose opt6 two seconds after the card over
 * opt5, both marked before_cut in its own entries). And a chosen option
 * marked `none` while ANOTHER option's entry shows the card is on the
 * wrong side of the source's break (3276.333: the card ten seconds into the
 * next episode; 4313.4: the card buried eighteen seconds inside the
 * episode): refused, with the way the card lands named from the listed
 * times (`listed`, every option with its time) when they are given.
 */
export function selfContradiction(out: Pick<BoundaryPick, "options_seen" | "chosen_key">, choosable?: ChoosableOption[], listed?: ChoosableOption[]): string | null {
  const own = out.options_seen.find((s) => s.key === out.chosen_key);
  if (!own) return null;
  const close = "; choose another option or refuse with confidence 0";
  if (own.caption_across_cut) return `your own options_seen says ${own.key} shows the same subtitle line on the last tile before the cut and on the cut tile, a split spoken line (rule 8)${close}`;
  if (own.card_or_flare === "across_cut") return `your own options_seen says ${own.key} still shows the card, flare or fade on its cut tile, so the next episode would open on it (rule 7)${close}`;
  if (own.card_or_flare === "after_cut") return `your own options_seen says ${own.key} shows the card after its cut, so the cut comes before the source's break and buries the card (rule 7)${close}`;
  if (namesAction(own)) return `your own options_seen says ${own.key} cuts inside a physical action (${own.physical_action_across_cut!.trim()}; rule 2)${close}`;
  if (own.card_or_flare === "before_cut") {
    const timeOf = (key: string) => choosable?.find((c) => c.key === key)?.t;
    const ownT = timeOf(own.key);
    const ownIndex = out.options_seen.indexOf(own);
    const earlier = (s: OptionSeen) => {
      if (!choosable) return out.options_seen.indexOf(s) < ownIndex;
      const t = timeOf(s.key);
      return t !== undefined && ownT !== undefined && t < ownT - 1e-9;
    };
    const first = out.options_seen.find((s) => s.key !== own.key && s.card_or_flare === "before_cut" && !s.caption_across_cut && !namesAction(s) && earlier(s));
    if (first) return `your own options_seen says ${first.key} is also after the card and earlier; rule 7's target is the FIRST frame after the card; choose it or explain with confidence 0`;
  }
  if (own.card_or_flare === "none") {
    const showing = out.options_seen.filter((s) => s.key !== own.key && s.card_or_flare !== "none");
    if (showing.length) return cardElsewhere(own, showing, listed ?? choosable);
  }
  return null;
}

/** The refusal for a chosen option that shows no card while other entries do, naming which way the card lands against the chosen time when the option times are known. */
function cardElsewhere(own: OptionSeen, showing: OptionSeen[], times: ChoosableOption[] | undefined): string {
  const timeOf = (key: string) => times?.find((c) => c.key === key)?.t;
  const ownT = timeOf(own.key);
  const keys = showing.map((s) => `${s.key} (${s.card_or_flare})`).join(", ");
  let where = "near your cut";
  if (ownT !== undefined) {
    const before = showing.some((s) => {
      const t = timeOf(s.key);
      return t !== undefined && t < ownT - 1e-9 && (s.card_or_flare === "before_cut" || s.card_or_flare === "across_cut");
    });
    const after = showing.some((s) => {
      const t = timeOf(s.key);
      return t !== undefined && t > ownT + 1e-9 && (s.card_or_flare === "after_cut" || s.card_or_flare === "across_cut");
    });
    if (before && !after) where = `before your cut at ${ownT}s, so the card would be buried inside this episode with more story after it`;
    else if (after && !before) where = `after your cut at ${ownT}s, so the source's break would play inside the next episode`;
  }
  const target = showing.find((s) => s.card_or_flare === "before_cut" && !s.caption_across_cut && !namesAction(s));
  const ask = target ? `choose ${target.key}, which your entries mark as the first frame after the card` : `no listed option is marked as the first frame after the card, so refuse with confidence 0 and name the option whose strip shows the card and where the card ends`;
  return `your own options_seen says ${keys} show${showing.length === 1 ? "s" : ""} the source's card, flare or fade while ${own.key} shows none: the card lands ${where} (rule 7: the best cut is the first frame after the card); ${ask}`;
}

const PLACEHOLDER_WHY = /^(placeholder|n\/?a|none|null|tbd|todo|refused?|no|-+|\.+)$/i;

/**
 * Why a refusal (confidence 0) is not yet an answer, or null: the
 * calibration recorded a why of "placeholder" as a refusal and handed it
 * to a person. Studio renders and attaches every strip before the call,
 * so a refusal must name the image that is missing or unreadable, in at
 * least 20 characters of real content; or, the other honest refusal, the
 * option whose strip shows the source's card when no listed option is the
 * first frame after it (4313.4: the right cut was between two options).
 */
export function refusalProblem(why: string): string | null {
  const text = why.trim();
  const names = /\b(image|strip|opt\d+|tile|unreadable|missing|blank|corrupt|garbled|card|flare|fade)/i.test(text);
  if (text.length < 20 || PLACEHOLDER_WHY.test(text) || !names) {
    return 'confidence 0 is a refusal to judge: every option strip was rendered and attached to this call before it was made, so why must say which image is missing or unreadable and what is wrong with it (at least 20 characters naming the image, e.g. "image 3 (opt3) shows no tiles"), or which option\'s strip shows the source\'s card when no listed option is the first frame after it; or else judge the strips and choose an option';
  }
  return null;
}

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
        "Your choice must agree with your own entry for it: an option whose entry shows the same caption on both sides of the cut, the card on or after its cut tile, or a physical action across the cut cannot be chosen. When more than one option's entry says the card ends before its cut (before_cut), rule 7's target is the EARLIEST of them: the first frame after the card; a later one buries the card inside the episode.",
        "When ANY option's entry shows the card, flare or fade, the source's break is at this boundary and the cut belongs on the first frame after it: an option whose own entry shows none is on the wrong side of the break (the card buried inside this episode, or playing inside the next) and cannot be chosen. Choose the earliest option marked before_cut; when no listed option is the first frame after the card, refuse with confidence 0 and name the option whose strip shows the card and where the card ends.",
        "A refusal (confidence 0) is for a strip that is missing or unreadable, or for a card that no listed option follows, and its why names that image and what is wrong with it; every strip was rendered and attached before this call, so a refusal with no such image is not an answer.",
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
  const listed: ChoosableOption[] = boundary.options.map((o) => ({ key: o.key, t: o.t }));
  const choosable: ChoosableOption[] = listed.filter((o) => !(range && (o.t < range.lo - 1e-9 || o.t > range.hi + 1e-9)) && !(input.card_spans && inCardSpan(o.t, input.card_spans)));
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
    // The judge thinks before it answers: a forced tool call skips the thinking (the probe of 2026-09-23).
    toolChoice: "auto" as const,
    cacheSystem: true,
    prompt_version: BOUNDARY_RULE_VERSION,
    check: (out: BoundaryPick) => {
      if (out.confidence < 0 || out.confidence > 1) return "confidence is a number from 0 to 1";
      const seen = out.options_seen.map((s) => s.key);
      const missing = keys.filter((k) => !seen.includes(k));
      const unknown = seen.filter((k) => !keys.includes(k));
      const dup = seen.filter((k, i) => seen.indexOf(k) !== i);
      if (missing.length || unknown.length || dup.length) return `options_seen must have exactly one entry per option (${keys.join(", ")}): missing ${JSON.stringify(missing)}, unknown ${JSON.stringify(unknown)}, repeated ${JSON.stringify(dup)}`;
      // A refusal chooses nothing and apply_vision never applies it, but it must still be a real one: every strip was attached.
      if (out.confidence === 0) return refusalProblem(out.why);
      const o = boundary.options.find((x) => x.key === out.chosen_key);
      if (!o) return `chosen_key ${JSON.stringify(out.chosen_key)} is not one of ${keys.join(", ")}`;
      if (Math.abs(out.chosen_t - o.t) > 0.0005) return `chosen_t must be exactly ${o.t} for ${o.key} (copied from the option list), not ${out.chosen_t}`;
      if (range && (o.t < range.lo - 1e-9 || o.t > range.hi + 1e-9)) return `${o.key} at ${o.t}s is outside the allowed range ${range.lo}-${range.hi}s (an episode would leave the ${input.band[0]}-${input.band[1]} s band); choose an option inside it, or refuse with confidence 0 and say why`;
      const card = input.card_spans ? inCardSpan(o.t, input.card_spans) : null;
      if (card) return `${o.key} at ${o.t}s is inside the source's own card ${card.from_s}-${card.to_s}s: the next episode would open on the card (rule 7); choose the first frame after it or another option, or refuse with confidence 0 and say why`;
      return selfContradiction(out, choosable, listed);
    },
  };
}
