// verify_boundaries, the skeptic's half: an adversarial check on the
// reviewer's pick, from the same frames. A port of the Verify phase of
// pick_by_eye.workflow.js: the same rules, the same six checks, the same
// verdict fields. The Workflow's skeptic could also pull frames from the
// source with ffmpeg and read index/candidates.json itself; through the API
// it sees the option strips, a dense 10 fps strip around the chosen cut when
// the runner made one (lib/segment/strips renderDenseStrip), and the legal
// cuts it has actually looked at, listed as text.
//
// The second pass (decision 2026-09-23, "The frame judge, second pass"):
// the first calibration's API skeptic named a fix nine times and none was
// right, and every one broke a standing rule; the Workflow's skeptic, which
// could verify its claims with ffmpeg, was right when it disagreed. So the
// close of the prompt changes from "default to agree=false if you find a
// fault" to "disagree only for a fault you can SEE, cited by image and tile
// time", a fix may only be a time the skeptic has looked at (a listed option
// or a legal cut inside one of its images, inside the allowed range), the
// verdict records what the chosen strip shows before the verdict, and
// lib/segment/vision.ts guards every override and tie-breaks it blind.
//
// The second calibration (phase 2.1, round two) had the skeptic see a rule
// break and waive it ("would normally trip rule 8 - but..."), cite another
// option's strip for a fault on the chosen cut, and cite an END tile under
// the card as a rule-7 fault when that tile is exactly rule 7's target. So
// the verdict now records, before `agree`, what the chosen cut's own images
// show for rules 8, 7 and 2 (verdictContradiction ties the verdict to it),
// names the rule a fault breaks (`fault_rule`), and citationProblem checks
// that the cited image shows the CHOSEN cut and that the cited tile can
// carry the claimed rule (faultRuleProblem: rule 7 at or after the cut,
// rule 8 on the last tile before the cut or the cut tile, rules 2 and 4
// within 1.5 s of it).

import { z } from "zod";
import type { LlmProvider, LlmSystemBlock } from "@/lib/llm";
import type { CutCandidate } from "@/lib/film-import/types";
import { SEEN_TOLERANCE_S, asLlmImage, cutIndexOf, inCardSpan, isListedTime, type CardSpan, type OptionsBoundary, type StripImage, type StripLayout } from "@/lib/segment/strips";
import { BOUNDARY_RULES, BOUNDARY_RULE_VERSION, filmNotesBlock, namesAction, rangeLine, renderOptions, stripFacts, stripHowTo, type BoundaryPick, type BoundaryRange } from "./boundary-review";

/** The standing decisions a cited fault can break, by number (rule 1 is the format, never a fault of one cut). */
export const FAULT_RULES = ["2", "3", "4", "5", "6", "7", "8"] as const;
export const FaultRuleSchema = z.enum(FAULT_RULES);
export type FaultRule = z.infer<typeof FaultRuleSchema>;

const CardOrFlareSchema = z.enum(["none", "before_cut", "across_cut", "after_cut"]);

export const BoundaryVerdictSchema = z.object({
  chosen_strip_shows: z.string().describe("what the chosen option's own image shows: the tiles before the cut, then the cut tile and after - written before the verdict"),
  chosen_caption_across_cut: z.boolean().describe("true only when the SAME burned-in subtitle line (the same words) shows on the last tile before the chosen cut AND on its cut tile (rule 8), read off the chosen option's own strip or the dense strip; one line ending before the cut and a different line starting after it is false"),
  chosen_card_or_flare: CardOrFlareSchema.describe(
    "where a flare, light leak, fade to black or TO BE CONTINUED card appears in the chosen cut's own images, if at all (rule 7): none; before_cut = the card ends before the cut and the cut tile is the next shot (what rule 7 asks for); across_cut = the cut tile still shows the card, flare or fade (the next episode would open on it); after_cut = the card shows on tiles after the cut (the cut comes before the source's break)"
  ),
  chosen_action_across_cut: z.string().nullable().describe("a punch, slap, push, grab, throw, fall, collision or something flying that is in progress on the chosen cut's cut tile; null when none"),
  agree: z.boolean(),
  fault: z.string().nullable().describe("the specific rule broken, in words, or null"),
  fault_rule: FaultRuleSchema.nullable().describe("the standing decision the cited tile breaks: 2 (inside a physical action), 3 (the payoff lands in the next episode), 4 (no aftermath after an impact), 5 (no open question, or a cold viewer cannot tell who is on screen), 6 (the tension had already resolved), 7 (the card, flare or fade on the cut tile), 8 (the same caption on both sides of the cut); null when you agree"),
  fault_image: z.number().int().nullable().describe("the image number (1-based, as listed) where the fault shows: the chosen option's own strip or the dense strip; null when you agree"),
  fault_tile_t: z.number().nullable().describe("the tile time in that image where the fault shows, copied from its tile list; null when you agree"),
  fault_tile_shows: z.string().nullable().describe("what is in that tile; null when you agree"),
  better_key: z.string().nullable().describe("a strictly better listed option's key, or null"),
  better_t: z
    .number()
    .nullable()
    .describe("the better cut's time in seconds: that option's t, or a legal cut from the LEGAL CUTS list when no listed option fixes the fault; null when you agree or can name no fix"),
  reason: z.string(),
});

export type BoundaryVerdict = z.infer<typeof BoundaryVerdictSchema>;

export type BoundarySkepticInput = {
  boundary: OptionsBoundary;
  /** The same option strips the reviewer saw, in option order. */
  strips: StripImage[];
  pick: BoundaryPick;
  /** A 10 fps strip around `pick.chosen_t` (renderDenseStrip), or null when the runner made none. */
  dense: StripImage | null;
  /** Legal cuts the skeptic has looked at (lib/segment/strips legalCutsInView), or [] when the film has no index here. */
  legal_cuts: CutCandidate[];
  layout: StripLayout;
  band: [number, number];
  range?: BoundaryRange | null;
  /** The source's card spans: a fix inside one is refused (rule 7); the guard in lib/segment/vision.ts checks it again. */
  card_spans?: CardSpan[] | null;
  film_notes: string | null;
  provider: LlmProvider;
  model: string;
};

/** The legal cuts a skeptic may name, one line each, so a better_t is a time the pipeline will accept and the skeptic has seen. */
export function renderLegalCuts(cuts: CutCandidate[], optionTimes: number[]): string {
  if (!cuts.length) return "  (none beyond the listed options: only a listed option can be a fix)";
  return cuts
    .map((c) => {
      const listed = isListedTime(c.t, optionTimes) ? " (a listed option)" : "";
      const motion = c.in_action ? "motion detector: moving at the cut" : `motion detector: still at the cut (motion ${c.since_action}s before, ${c.until_action}s after)`;
      return `  ${c.t}s${listed}: ${motion}`;
    })
    .join("\n");
}

/** The fix rule with this boundary's range filled in (the diagnosis's text; the system block carries it once with the range named as the boundary facts', so the cached prefix does not change per boundary). */
export function fixRule(range: Pick<BoundaryRange, "lo" | "hi">): string {
  return `A fix must be a time you have looked at: a listed option (better_key and its exact t) or a legal cut inside one of the attached images, and it must keep this cut between ${range.lo}s and ${range.hi}s. If the only fix is a time you have not seen, give no fix - the boundary then goes to a person.`;
}

/**
 * Where a cited fault tile cannot carry the rule it is cited for, or null.
 * The calibration's false results: a "rule 7" fault on an END tile under
 * the card (3033.867: that tile is rule 7's target), a "rule 8" fault on a
 * tile that is neither side of the cut, a tie-break "buried" card read off
 * an END tile. Rule 7 shows on the cut tile or after it; rule 8 on the last
 * tile before the cut or the cut tile; rules 2 and 4 within 1.5 s of the cut.
 */
export function faultRuleProblem(rule: FaultRule | null, tileT: number, img: Pick<StripImage, "tiles">, cutT: number, field = "fault_tile_t"): string | null {
  if (rule === null) return null;
  const tol = SEEN_TOLERANCE_S + 1e-9;
  if (rule === "7") {
    if (tileT < cutT - tol) {
      return `${field} ${tileT} is an END tile, before the cut at ${cutT}s: a rule-7 fault is the card, flare or fade still on the CUT tile, or on a tile after it, so cite a tile at or after the cut. A card that ends before the cut, with the cut tile already the next shot, is the target: the card belongs at the END of this episode, so a card before the cut is the target, not a fault`;
    }
    return null;
  }
  if (rule === "8") {
    const idx = cutIndexOf(img.tiles, cutT);
    const allowed = [img.tiles[idx - 1], img.tiles[idx]].filter((t): t is number => t !== undefined);
    if (!allowed.some((t) => Math.abs(t - tileT) <= tol)) return `${field} ${tileT} cannot show a split line: a rule-8 fault is the SAME subtitle line on the last tile before the cut AND on the cut tile, so cite one of those two tiles of that image (${allowed.join(" or ")})`;
    return null;
  }
  if (rule === "2" || rule === "4") {
    const away = Math.round(Math.abs(tileT - cutT) * 1000) / 1000;
    if (away > 1.5 + 1e-9) return `${field} ${tileT} is ${away} s from the cut at ${cutT}s: a rule-${rule} fault (${rule === "2" ? "a cut inside a physical action" : "no aftermath after an impact"}) shows within 1.5 s of the cut`;
    return null;
  }
  return null;
}

/** Which attached images show the CHOSEN cut: its own option strip and the dense strip, 1-based, with the cut time. */
export type CitationContext = {
  chosen_image: number;
  dense_image: number | null;
  cut_t: number;
};

/** The citation context of a skeptic call: the chosen option's strip (by its time) and the dense strip after every option strip. */
export function citationContextOf(strips: Pick<StripImage, "t">[], chosenT: number, dense: boolean): CitationContext | null {
  const i = strips.findIndex((s) => Math.abs(s.t - chosenT) <= 0.0015);
  if (i < 0) return null;
  return { chosen_image: i + 1, dense_image: dense ? strips.length + 1 : null, cut_t: chosenT };
}

/**
 * Where the skeptic's citation is wrong, or null: both fields or neither, an
 * attached image, a tile of that image; with a context, the image must show
 * the chosen cut (its own strip or the dense strip, never another option's)
 * and the tile must be able to carry the claimed rule (faultRuleProblem).
 */
export function citationProblem(out: Pick<BoundaryVerdict, "fault_image" | "fault_tile_t"> & Partial<Pick<BoundaryVerdict, "fault_rule">>, images: Pick<StripImage, "tiles">[], ctx?: CitationContext | null): string | null {
  if (out.fault_image === null && out.fault_tile_t === null) return null;
  if (out.fault_image === null || out.fault_tile_t === null) return "cite both fault_image and fault_tile_t, or neither";
  const img = images[out.fault_image - 1];
  if (!img) return `fault_image ${out.fault_image} is not an attached image (1-${images.length})`;
  if (!img.tiles.some((t) => Math.abs(t - out.fault_tile_t!) <= SEEN_TOLERANCE_S + 1e-9)) return `fault_tile_t ${out.fault_tile_t} is not a tile of image ${out.fault_image} (its tiles: ${img.tiles.join(", ")})`;
  if (!ctx) return null;
  if (out.fault_image !== ctx.chosen_image && out.fault_image !== ctx.dense_image) {
    return `fault_image ${out.fault_image} does not show the chosen cut at ${ctx.cut_t}s: a fault must show on the chosen option's own strip (image ${ctx.chosen_image})${ctx.dense_image ? ` or the dense strip (image ${ctx.dense_image})` : ""}, not on another option's strip, whose cut is another time`;
  }
  return faultRuleProblem(out.fault_rule ?? null, out.fault_tile_t, img, ctx.cut_t);
}

/**
 * What the skeptic's own chosen_* observations say against its verdict, or
 * null: the calibration had it write that the same caption sits on both
 * sides of the cut "which would normally trip rule 8 - but..." and agree
 * (2541.067, a real split), so agreeing over an observed fault is refused,
 * and a rule-8 or rule-7 fault the observation does not show is refused too.
 */
export function verdictContradiction(out: Pick<BoundaryVerdict, "agree" | "fault_rule" | "chosen_caption_across_cut" | "chosen_card_or_flare" | "chosen_action_across_cut">): string | null {
  if (out.agree) {
    const close = "; set agree=false and cite the tile (fault_image, fault_tile_t, fault_rule)";
    if (out.chosen_caption_across_cut) return `your own chosen_caption_across_cut says the same subtitle line shows on the last tile before the chosen cut and on its cut tile, a split spoken line (rule 8)${close}`;
    if (out.chosen_card_or_flare === "across_cut") return `your own chosen_card_or_flare says the cut tile still shows the card, flare or fade, so the next episode would open on it (rule 7)${close}`;
    if (out.chosen_card_or_flare === "after_cut") return `your own chosen_card_or_flare says the card shows after the chosen cut, so the cut comes before the source's break and buries the card (rule 7)${close}`;
    if (namesAction({ physical_action_across_cut: out.chosen_action_across_cut })) return `your own chosen_action_across_cut says the chosen cut is inside a physical action (${out.chosen_action_across_cut!.trim()}; rule 2)${close}`;
    return null;
  }
  if (out.fault_rule === "8" && !out.chosen_caption_across_cut) {
    return "your own chosen_caption_across_cut says no subtitle line runs across the chosen cut, which contradicts a rule-8 fault; set it true only if the SAME line shows on the last tile before the cut AND on the cut tile, otherwise name the rule the tile really breaks or set agree=true";
  }
  if (out.fault_rule === "7" && (out.chosen_card_or_flare === "none" || out.chosen_card_or_flare === "before_cut")) {
    const seen = out.chosen_card_or_flare === "none" ? "no card, flare or fade shows in the chosen cut's images" : "the card ends before the cut and the cut tile is already the next shot, which is what rule 7 asks for (the card belongs at the END of this episode, so a card before the cut is the target, not a fault)";
    return `your own chosen_card_or_flare says ${seen}, which contradicts a rule-7 fault; set it across_cut or after_cut only if a tile at or after the cut shows the card, otherwise name the rule the tile really breaks or set agree=true`;
  }
  return null;
}

export function buildBoundarySkeptic(input: BoundarySkepticInput) {
  const { boundary, strips, pick, dense } = input;
  if (strips.length !== boundary.options.length) throw new Error(`buildBoundarySkeptic: ${strips.length} strips for ${boundary.options.length} options at ${boundary.boundary_s}`);
  const optionTimes = boundary.options.map((o) => o.t);
  const legalTimes = [...optionTimes, ...input.legal_cuts.map((c) => c.t)];
  const images = [...strips, ...(dense ? [dense] : [])];
  const annotated = images.every((s) => s.annotated);
  const range = input.range ?? null;
  const rangeWords = range ? `between ${range.lo}s and ${range.hi}s` : `so that both episodes stay ${input.band[0]}-${input.band[1]} s long`;
  const citation = citationContextOf(strips, pick.chosen_t, dense !== null);
  const system: LlmSystemBlock[] = [
    {
      text: [
        "Adversarial check on an episode boundary chosen by another reviewer. Your job is to REFUTE it if you can.",
        "",
        stripHowTo(input.layout, { annotated, dense }),
        dense
          ? `The last image is a DENSE strip around the chosen cut: frames ${dense.step}s apart, ${dense.cols} per row, the chosen cut at the tile the READING block names for it (not tile ${stripFacts(input.layout).cut}). Use it to place an impact or a shot change to the tenth of a second.`
          : "",
        "",
        BOUNDARY_RULES,
        filmNotesBlock(input.film_notes),
        "",
        "First write chosen_strip_shows: what the chosen option's own image shows before the cut and from the cut tile on, in your own words, before any verdict.",
        "Then record, from the chosen cut's own images only: chosen_caption_across_cut (the SAME subtitle line on the last tile before the cut and on the cut tile), chosen_card_or_flare (where a card, flare or fade sits against the cut, if at all) and chosen_action_across_cut (a physical action in progress on the cut tile, or null).",
        "Your verdict must agree with those three: an observed split caption, a card on or after the cut tile, or an action across the cut is a fault you must dispute, never waive; and a rule-8 or rule-7 fault you did not observe there cannot be cited.",
        "",
        "Look at the chosen option's strip AND at every other option's strip yourself. Check specifically:",
        "- does the chosen cut fall inside a physical action?",
        "- does a payoff this episode set up actually land in the NEXT episode instead?",
        "- is the chosen cut less than about 1 second after an impact, so it never reads?",
        "- can a cold viewer starting at the chosen point tell who is on screen?",
        "- does their reasoning rest on something the frames do not show?",
        "- does the next episode open on the source's own card or the flare into it (rule 7)? A card that ends before the cut, with the cut tile already the next shot, is the target, not a fault.",
        "- does the SAME subtitle line show on the last tile before the cut and on the cut tile (rule 8)? One line ending before the cut and a different line starting after it is not a split.",
        "- is another listed option strictly better on rules 2-4?",
        "",
        "Disagree only for a fault you can SEE: name the image number and the tile time where it shows, and what is in that tile. A fault taken from the other reviewer's description, from the dialogue list or from the motion numbers is not a fault. Do not manufacture a disagreement over taste: if the choice is sound, or the frames do not settle it, set agree=true and say what is uncertain in reason.",
        "A fault names the rule it breaks (fault_rule) and shows on an image of the CHOSEN cut: the chosen option's own strip or the dense strip, never another option's strip, whose cut is another time. A rule-7 fault is the card, flare or fade still on the cut tile or after it, so it cites a tile at or after the cut (an END tile under the card is the target, not a fault); a rule-8 fault cites the last tile before the cut or the cut tile; a rule-2 or rule-4 fault lies within 1.5 s of the cut.",
        "",
        "A fix must be a time you have looked at: a listed option (better_key and its exact t) or a legal cut inside one of the attached images, and it must keep this cut between the lo and hi the boundary facts give. If the only fix is a time you have not seen, give no fix - the boundary then goes to a person. Nothing else is a legal cut; a time not in those lists cannot be applied. A fault with no fix is allowed (better_key and better_t null).",
        "When you agree, leave fault, fault_rule, fault_image, fault_tile_t, fault_tile_shows, better_key and better_t null.",
      ]
        .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
        .join("\n"),
      cache: true,
    },
  ];
  const user = [
    `BOUNDARY ${boundary.boundary_s}s. The images attached before this text are the option strips, in this order${dense ? ", then the dense strip" : ""}.`,
    rangeLine(input.band, range),
    range ? fixRule(range) : "",
    "",
    "OPTIONS",
    renderOptions(boundary, strips, range, input.card_spans),
    dense ? `\nDENSE STRIP around ${dense.t}s - image ${strips.length + 1}\n  tiles: ${dense.tiles.join(", ")}` : "",
    "",
    `The other reviewer chose ${pick.chosen_key} at ${pick.chosen_t}s${citation ? ` (its own strip is image ${citation.chosen_image}${citation.dense_image ? `; the dense strip is image ${citation.dense_image}` : ""})` : ""}.`,
    `They said the episode ends on: ${pick.ends_on}`,
    `and the next opens on: ${pick.opens_on}`,
    `Their reasoning: ${pick.why}`,
    pick.rejected ? `They rejected the runner-up because: ${pick.rejected}` : "",
    "",
    `LEGAL CUTS you have looked at (index/candidates.json: shot changes clear of speech, ${rangeWords}, each shown in one of the images)`,
    renderLegalCuts(input.legal_cuts, optionTimes),
  ]
    .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
    .join("\n");
  return {
    name: "verify_boundaries_verify",
    description: "Record what the chosen strip shows and what its own images say for rules 8, 7 and 2, whether the chosen boundary holds up against the frames, the fault with its rule and the image and tile that show it when it does not, and a better legal time the skeptic has seen when one exists.",
    system,
    user,
    images: images.map(asLlmImage),
    schema: BoundaryVerdictSchema,
    provider: input.provider,
    model: input.model,
    maxTokens: 6000,
    effort: "medium" as const,
    cacheSystem: true,
    prompt_version: BOUNDARY_RULE_VERSION,
    check: (out: BoundaryVerdict) => {
      const contradiction = verdictContradiction(out);
      if (contradiction) return contradiction;
      if (out.agree) {
        if (out.better_key !== null || out.better_t !== null) return "you agreed: better_key and better_t must be null";
        return null;
      }
      if (out.fault_rule === null) return `name fault_rule: the standing decision (${FAULT_RULES.join(", ")}) the fault breaks`;
      const cited = citationProblem(out, images, citation);
      if (cited) return cited;
      const onCard = (t: number) => (input.card_spans ? inCardSpan(t, input.card_spans) : null);
      if (out.better_key !== null) {
        const o = boundary.options.find((x) => x.key === out.better_key);
        if (!o) return `better_key ${JSON.stringify(out.better_key)} is not a listed option (${boundary.options.map((x) => x.key).join(", ")})`;
        if (out.better_t === null || Math.abs(out.better_t - o.t) > 0.0005) return `better_t must be exactly ${o.t} for ${o.key}, not ${out.better_t}`;
        if (o.key === pick.chosen_key) return `better_key ${o.key} is the option you are disputing; name a different one, a legal cut, or no fix`;
        if (range && (o.t < range.lo - 1e-9 || o.t > range.hi + 1e-9)) return `${o.key} at ${o.t}s is outside the allowed range ${range.lo}-${range.hi}s; name a fix inside it, or no fix`;
        const card = onCard(o.t);
        if (card) return `${o.key} at ${o.t}s is inside the source's own card ${card.from_s}-${card.to_s}s: the next episode would open on the card (rule 7); name a fix outside it, or no fix`;
        return null;
      }
      if (out.better_t !== null) {
        if (!isListedTime(out.better_t, legalTimes)) return `better_t ${out.better_t} is not a listed option or a legal cut you have looked at (the LEGAL CUTS list); only those can be applied - give no fix if none of them is right`;
        if (Math.abs(out.better_t - pick.chosen_t) <= 0.0015) return `better_t ${out.better_t} is the time you are disputing; name a different one or no fix`;
        if (range && (out.better_t < range.lo - 1e-9 || out.better_t > range.hi + 1e-9)) return `better_t ${out.better_t} is outside the allowed range ${range.lo}-${range.hi}s; name a fix inside it, or no fix`;
        const card = onCard(out.better_t);
        if (card) return `better_t ${out.better_t} is inside the source's own card ${card.from_s}-${card.to_s}s: the next episode would open on the card (rule 7); name a fix outside it, or no fix`;
      }
      return null;
    },
  };
}
