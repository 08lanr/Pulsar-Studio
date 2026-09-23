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

import { z } from "zod";
import type { LlmProvider, LlmSystemBlock } from "@/lib/llm";
import type { CutCandidate } from "@/lib/film-import/types";
import { SEEN_TOLERANCE_S, asLlmImage, inCardSpan, isListedTime, type CardSpan, type OptionsBoundary, type StripImage, type StripLayout } from "@/lib/segment/strips";
import { BOUNDARY_RULES, BOUNDARY_RULE_VERSION, filmNotesBlock, rangeLine, renderOptions, stripHowTo, type BoundaryPick, type BoundaryRange } from "./boundary-review";

export const BoundaryVerdictSchema = z.object({
  chosen_strip_shows: z.string().describe("what the chosen option's own image shows: the tiles before the cut, then the cut tile and after - written before the verdict"),
  agree: z.boolean(),
  fault: z.string().nullable().describe("the specific rule broken, or null"),
  fault_image: z.number().int().nullable().describe("the image number (1-based, as listed) where the fault shows; null when you agree"),
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

/** Where the skeptic's cited tile is: null when it is a tile of the cited image, else what is wrong (the repair message). */
export function citationProblem(out: Pick<BoundaryVerdict, "fault_image" | "fault_tile_t">, images: Pick<StripImage, "tiles">[]): string | null {
  if (out.fault_image === null && out.fault_tile_t === null) return null;
  if (out.fault_image === null || out.fault_tile_t === null) return "cite both fault_image and fault_tile_t, or neither";
  const img = images[out.fault_image - 1];
  if (!img) return `fault_image ${out.fault_image} is not an attached image (1-${images.length})`;
  if (!img.tiles.some((t) => Math.abs(t - out.fault_tile_t!) <= SEEN_TOLERANCE_S + 1e-9)) return `fault_tile_t ${out.fault_tile_t} is not a tile of image ${out.fault_image} (its tiles: ${img.tiles.join(", ")})`;
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
  const system: LlmSystemBlock[] = [
    {
      text: [
        "Adversarial check on an episode boundary chosen by another reviewer. Your job is to REFUTE it if you can.",
        "",
        stripHowTo(input.layout, { annotated }),
        dense
          ? `The last image is a DENSE strip around the chosen cut: frames ${dense.step}s apart, ${dense.cols} per row, the chosen cut at the centre tile. Use it to place an impact or a shot change to the tenth of a second.`
          : "",
        "",
        BOUNDARY_RULES,
        filmNotesBlock(input.film_notes),
        "",
        "First write chosen_strip_shows: what the chosen option's own image shows before the cut and from the cut tile on, in your own words, before any verdict.",
        "",
        "Look at the chosen option's strip AND at every other option's strip yourself. Check specifically:",
        "- does the chosen cut fall inside a physical action?",
        "- does a payoff this episode set up actually land in the NEXT episode instead?",
        "- is the chosen cut less than about 1 second after an impact, so it never reads?",
        "- can a cold viewer starting at the chosen point tell who is on screen?",
        "- does their reasoning rest on something the frames do not show?",
        "- does the next episode open on the source's own card or the flare into it, or does a caption run across the cut (rules 7 and 8)?",
        "- is another listed option strictly better on rules 2-4?",
        "",
        "Disagree only for a fault you can SEE: name the image number and the tile time where it shows, and what is in that tile. A fault taken from the other reviewer's description, from the dialogue list or from the motion numbers is not a fault. Do not manufacture a disagreement over taste: if the choice is sound, or the frames do not settle it, set agree=true and say what is uncertain in reason.",
        "",
        "A fix must be a time you have looked at: a listed option (better_key and its exact t) or a legal cut inside one of the attached images, and it must keep this cut between the lo and hi the boundary facts give. If the only fix is a time you have not seen, give no fix - the boundary then goes to a person. Nothing else is a legal cut; a time not in those lists cannot be applied. A fault with no fix is allowed (better_key and better_t null).",
        "When you agree, leave fault, fault_image, fault_tile_t, fault_tile_shows, better_key and better_t null.",
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
    `The other reviewer chose ${pick.chosen_key} at ${pick.chosen_t}s.`,
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
    description: "Record what the chosen strip shows, whether the chosen boundary holds up against the frames, the fault with the image and tile that show it when it does not, and a better legal time the skeptic has seen when one exists.",
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
      if (out.agree) {
        if (out.better_key !== null || out.better_t !== null) return "you agreed: better_key and better_t must be null";
        return null;
      }
      const cited = citationProblem(out, images);
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
