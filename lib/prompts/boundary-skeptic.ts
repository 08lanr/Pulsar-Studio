// verify_boundaries, the skeptic's half: an adversarial check on the
// reviewer's pick, from the same frames. A faithful port of the Verify
// phase of pick_by_eye.workflow.js: the same rules, the same six checks, the
// same "do not manufacture a disagreement" close, the same verdict fields.
// The Workflow's skeptic could also pull frames from the source with ffmpeg
// and read index/candidates.json itself; through the API it sees the option
// strips, a dense 10 fps strip around the chosen cut when the runner made
// one (lib/segment/strips renderDenseStrip), and the legal cuts near the
// boundary listed as text. A better_t must be one of those listed times:
// the pipeline (`pick_cuts.py --choices`) refuses any other, and a skeptic
// that named a bare shot change (He Hated All Women 5298.0) needed a person
// and `candidates.py --allow` before it could apply.

import { z } from "zod";
import type { LlmProvider, LlmSystemBlock } from "@/lib/llm";
import type { CutCandidate } from "@/lib/film-import/types";
import { asLlmImage, isListedTime, type OptionsBoundary, type StripImage, type StripLayout } from "@/lib/segment/strips";
import { BOUNDARY_RULES, BOUNDARY_RULE_VERSION, filmNotesBlock, renderOptions, stripHowTo, type BoundaryPick } from "./boundary-review";

export const BoundaryVerdictSchema = z.object({
  agree: z.boolean(),
  fault: z.string().nullable().describe("the specific rule broken, or null"),
  better_key: z.string().nullable().describe("a strictly better listed option's key, or null"),
  better_t: z
    .number()
    .nullable()
    .describe("the better cut's time in seconds: that option's t, or a legal cut from the list when no listed option fixes the fault; null when you agree or can name no fix"),
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
  /** Legal cuts within 30 s of the boundary (index/candidates.json), or [] when the film has no index here. */
  legal_cuts: CutCandidate[];
  layout: StripLayout;
  band: [number, number];
  film_notes: string | null;
  provider: LlmProvider;
  model: string;
};

/** The legal cuts a skeptic may name, one line each, so a better_t is a time the pipeline will accept. */
export function renderLegalCuts(cuts: CutCandidate[], optionTimes: number[]): string {
  if (!cuts.length) return "  (no index here: only the listed options are legal)";
  return cuts
    .map((c) => {
      const listed = isListedTime(c.t, optionTimes) ? " (a listed option)" : "";
      const action = c.in_action ? "inside an action" : `clear; last action ${c.since_action}s before, next ${c.until_action}s after`;
      return `  ${c.t}s${listed}: ${action}; before: ${JSON.stringify(c.line_before)}; after: ${JSON.stringify(c.line_after)}`;
    })
    .join("\n");
}

export function buildBoundarySkeptic(input: BoundarySkepticInput) {
  const { boundary, strips, pick, dense } = input;
  if (strips.length !== boundary.options.length) throw new Error(`buildBoundarySkeptic: ${strips.length} strips for ${boundary.options.length} options at ${boundary.boundary_s}`);
  const optionTimes = boundary.options.map((o) => o.t);
  const legalTimes = [...optionTimes, ...input.legal_cuts.map((c) => c.t)];
  const system: LlmSystemBlock[] = [
    {
      text: [
        "Adversarial check on an episode boundary chosen by another reviewer. Your job is to REFUTE it if you can.",
        "",
        stripHowTo(input.layout),
        dense
          ? `The last image is a DENSE strip around the chosen cut: frames ${dense.step}s apart, ${dense.cols} per row, the chosen cut at the centre tile. Use it to place an impact or a shot change to the tenth of a second.`
          : "",
        "",
        BOUNDARY_RULES,
        filmNotesBlock(input.film_notes),
        "",
        "Look at the chosen option's strip AND at every other option's strip yourself. Check specifically:",
        "- does the chosen cut fall inside a physical action?",
        "- does a payoff this episode set up actually land in the NEXT episode instead?",
        "- is the chosen cut less than about 1 second after an impact, so it never reads?",
        "- can a cold viewer starting at the chosen point tell who is on screen?",
        "- is their description of what is on screen actually correct?",
        "- is another listed option strictly better on rules 2-4?",
        "",
        "Default to agree=false if you find a concrete fault you can name from the frames. Do not manufacture",
        "a disagreement over taste: if the choice is sound, say so and set agree=true.",
        "",
        "When you disagree: name the fault, and the fix when there is one. A fix is a listed option (better_key and its exact t as better_t) or, when no listed option fixes it, one of the LEGAL CUTS listed below as better_t. Nothing else is a legal cut; a time not in those lists cannot be applied. A fault with no fix is allowed (better_key and better_t null): the boundary is then sent back to a person rather than applied.",
        "When you agree, leave fault, better_key and better_t null.",
      ]
        .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
        .join("\n"),
      cache: true,
    },
  ];
  const user = [
    `BOUNDARY ${boundary.boundary_s}s. The images attached before this text are the option strips, in this order${dense ? ", then the dense strip" : ""}.`,
    "",
    "OPTIONS",
    renderOptions(boundary, strips),
    dense ? `\nDENSE STRIP around ${dense.t}s - image ${strips.length + 1}\n  tiles: ${dense.tiles.join(", ")}` : "",
    "",
    `The other reviewer chose ${pick.chosen_key} at ${pick.chosen_t}s.`,
    `They said the episode ends on: ${pick.ends_on}`,
    `and the next opens on: ${pick.opens_on}`,
    `Their reasoning: ${pick.why}`,
    pick.rejected ? `They rejected the runner-up because: ${pick.rejected}` : "",
    "",
    `LEGAL CUTS within 30 s (index/candidates.json: shot changes clear of speech; every episode must stay ${input.band[0]}-${input.band[1]} s)`,
    renderLegalCuts(input.legal_cuts, optionTimes),
  ]
    .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
    .join("\n");
  return {
    name: "verify_boundaries_verify",
    description: "Record whether the chosen boundary holds up against the frames, the fault when it does not, and a better legal time when one exists.",
    system,
    user,
    images: [...strips, ...(dense ? [dense] : [])].map(asLlmImage),
    schema: BoundaryVerdictSchema,
    provider: input.provider,
    model: input.model,
    maxTokens: 4000,
    effort: "medium" as const,
    cacheSystem: true,
    prompt_version: BOUNDARY_RULE_VERSION,
    check: (out: BoundaryVerdict) => {
      if (out.agree) {
        if (out.better_key !== null || out.better_t !== null) return "you agreed: better_key and better_t must be null";
        return null;
      }
      if (out.better_key !== null) {
        const o = boundary.options.find((x) => x.key === out.better_key);
        if (!o) return `better_key ${JSON.stringify(out.better_key)} is not a listed option (${boundary.options.map((x) => x.key).join(", ")})`;
        if (out.better_t === null || Math.abs(out.better_t - o.t) > 0.0005) return `better_t must be exactly ${o.t} for ${o.key}, not ${out.better_t}`;
        if (o.key === pick.chosen_key) return `better_key ${o.key} is the option you are disputing; name a different one, a legal cut, or no fix`;
        return null;
      }
      if (out.better_t !== null) {
        if (!isListedTime(out.better_t, legalTimes)) return `better_t ${out.better_t} is not a listed option or a legal cut from the list; only those can be applied`;
        if (Math.abs(out.better_t - pick.chosen_t) <= 0.0015) return `better_t ${out.better_t} is the time you are disputing; name a different one or no fix`;
      }
      return null;
    },
  };
}
