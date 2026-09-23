// verify_boundaries, the reviewer's half: where one episode of a cut-only
// film ends and the next begins, chosen by LOOKING at the option strips.
// A faithful port of the Look phase of the pipeline's
// pick_by_eye.workflow.js (drama-remix/scripts/cut-only, 2026-09-22): the
// same standing rules word for word, the same output fields, the same
// precondition (never judge from dialogue alone). What changes is only how
// the evidence arrives: the Workflow's agent opened review/options.json and
// Read each strip itself; here the strips ride on the call as images, in
// option order, and the option facts are written into the user message.
//
// Schemas use .nullable(), never .optional(): lib/llm.ts emits strict JSON
// schema where every key is required.

import { z } from "zod";
import type { LlmProvider, LlmSystemBlock } from "@/lib/llm";
import { asLlmImage, type OptionsBoundary, type StripImage, type StripLayout } from "@/lib/segment/strips";

/** Bumped when the rules, the prompt text or a schema changes; part of every verify_boundaries idempotency key. */
export const BOUNDARY_RULE_VERSION = "by-eye-v1";

/** The standing decisions, verbatim from pick_by_eye.workflow.js. Not preferences. */
export const BOUNDARY_RULES = [
  "Standing decisions, not preferences:",
  "1. Episodes run CONTINUOUS. No intro card, no recap, no narrator. Episode N+1 starts on the frame after episode N ends.",
  "2. NEVER cut inside a physical action - mid-punch, mid-throw, mid-fall.",
  "3. The physical payoff belongs at the END of an episode. If someone is thrown into a pool, the episode must end AFTER they hit the water and go under - not before the throw, and not on a line of dialogue about it. Handing the payoff to the next episode wastes the hook.",
  "4. After an impact, leave roughly 1.0-1.5s of aftermath (follow-through, reaction) so the blow reads. A cut 0.5s after contact lands but never registers.",
  "5. The cut must end on an open question AND be somewhere a cold viewer can start and tell who is on screen within about 10 seconds.",
  "6. A break landing after the tension has already resolved is weak however clean it looks.",
].join("\n");

/** Film-specific facts a reviewer must know (the Workflow's `film_notes`), e.g. how the source marks its own episode breaks. */
export function filmNotesBlock(notes: string | null | undefined): string {
  const text = notes?.trim();
  return text ? `About this film:\n${text}` : "";
}

/** How to read a strip: the Workflow's stripHowTo, with the images attached instead of Read. */
export function stripHowTo(layout: Pick<StripLayout, "cols" | "step">): string {
  return [
    "Each option's strip is attached to this message as an image, in the order the options are listed. LOOK at the frames.",
    `A strip is a grid of frames ${layout.step}s apart, ${layout.cols} per row, read left to right then top to bottom.`,
    "Each option below lists the timestamp of every tile in that same order.",
    "The proposed cut falls at the CENTRE tile: the episode ENDS on the frames before it, and the next episode STARTS on the frames from it onward.",
  ].join("\n");
}

export const BoundaryPickSchema = z.object({
  chosen_key: z.string().describe("e.g. opt3"),
  chosen_t: z.number().describe("the option t in seconds, copied exactly from the option list"),
  ends_on: z.string().describe("what the viewer physically SEES in the last second of the episode"),
  opens_on: z.string().describe("what the viewer physically SEES in the first second of the next episode"),
  why: z.string(),
  rejected: z.string().nullable().describe("why the runner-up option is worse; null when there is no other option"),
  payoff_in_episode: z.boolean().describe("true if the nearest physical payoff lands INSIDE this episode rather than the next"),
  confidence: z.number().describe("0 to 1. Exactly 0 means you refused to judge (a strip missing or unreadable) and chose nothing"),
});

export type BoundaryPick = z.infer<typeof BoundaryPickSchema>;

export type BoundaryReviewInput = {
  boundary: OptionsBoundary;
  /** One strip per option, in option order (lib/segment/strips boundaryStrips). */
  strips: StripImage[];
  layout: StripLayout;
  band: [number, number];
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

/** The option facts pick_cuts.py emitted, one block per option, naming the image that shows it. */
export function renderOptions(boundary: OptionsBoundary, strips: StripImage[]): string {
  return boundary.options
    .map((o, i) => {
      const s = strips[i];
      const action =
        o.in_action === true
          ? "INSIDE an action"
          : o.in_action === false
            ? `not inside an action${o.since_action != null ? `; last action ${o.since_action}s before` : ""}${o.until_action != null ? `, next ${o.until_action}s after` : ""}`
            : "(no motion reading)";
      return [
        `${o.key} at ${fmtT(o.t)}${o.is_dp_pick ? " [is_dp_pick]" : ""} - image ${i + 1}`,
        `  tiles: ${s ? s.tiles.join(", ") : "(no strip)"}`,
        `  ${action}`,
        `  line before: ${o.line_before ? JSON.stringify(o.line_before) : "(none)"}`,
        `  line after: ${o.line_after ? JSON.stringify(o.line_after) : "(none)"}`,
      ].join("\n");
    })
    .join("\n");
}

export function buildBoundaryReview(input: BoundaryReviewInput) {
  const { boundary, strips } = input;
  if (strips.length !== boundary.options.length) throw new Error(`buildBoundaryReview: ${strips.length} strips for ${boundary.options.length} options at ${boundary.boundary_s}`);
  const keys = boundary.options.map((o) => o.key);
  const system: LlmSystemBlock[] = [
    {
      text: [
        "You are choosing where one episode of a vertical mini-drama ends and the next begins.",
        "",
        "You are given one boundary and its options, between 1 and 8, each a legal cut point (a shot change clear of speech). Exactly one is marked is_dp_pick: the planner's own choice, which knows nothing about the picture.",
        "",
        stripHowTo(input.layout),
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
        `Every episode must be ${input.band[0]}-${input.band[1]} s long; the planner's positions for the neighbouring boundaries already satisfy that, so judge this boundary on the picture.`,
        "",
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
    "",
    "OPTIONS",
    renderOptions(boundary, strips),
    "",
    "DIALOGUE in the 45 s before the boundary (whisper; times are where each line starts)",
    renderDialogue(boundary.before),
    "",
    "DIALOGUE in the 45 s after",
    renderDialogue(boundary.after),
    "",
    `Choose one of ${keys.join(", ")}.`,
  ].join("\n");
  return {
    name: "verify_boundaries_look",
    description: "Record which option ends this episode, what the viewer sees on either side of the cut, and why.",
    system,
    user,
    images: strips.map(asLlmImage),
    schema: BoundaryPickSchema,
    provider: input.provider,
    model: input.model,
    maxTokens: 4000,
    effort: "medium" as const,
    cacheSystem: true,
    prompt_version: BOUNDARY_RULE_VERSION,
    check: (out: BoundaryPick) => {
      if (out.confidence < 0 || out.confidence > 1) return "confidence is a number from 0 to 1";
      if (out.confidence === 0) return null; // a refusal chooses nothing; apply_vision never applies it
      const o = boundary.options.find((x) => x.key === out.chosen_key);
      if (!o) return `chosen_key ${JSON.stringify(out.chosen_key)} is not one of ${keys.join(", ")}`;
      if (Math.abs(out.chosen_t - o.t) > 0.0005) return `chosen_t must be exactly ${o.t} for ${o.key} (copied from the option list), not ${out.chosen_t}`;
      return null;
    },
  };
}
