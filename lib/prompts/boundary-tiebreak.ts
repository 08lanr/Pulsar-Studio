// The blind tie-break (decision 2026-09-23, "The frame judge, second pass").
// When the skeptic disputes the reviewer's cut and names a fix that passes
// every guard (a time it has seen, both episodes in band, not inside a
// card, a legal cut), a third call is shown the two candidate cuts as A and
// B, each with its dense strip (and its option strip when it is a listed
// option), in an order derived from the run and the boundary, with no
// reasoning from either side and no word on which side proposed which. It
// records what each side's images show, then which cut satisfies the
// payoff rule, or neither. lib/segment/vision.ts applies the skeptic's fix
// only when the tie-break picks it; a "neither" sends the boundary to a
// person.

import { z } from "zod";
import type { LlmProvider, LlmSystemBlock } from "@/lib/llm";
import { asLlmImage, type CardSpan, type OptionsBoundary, type StripImage, type StripLayout } from "@/lib/segment/strips";
import { BOUNDARY_RULES, BOUNDARY_RULE_VERSION, cardMark, filmNotesBlock, motionReading, rangeLine, stripHowTo, type BoundaryRange } from "./boundary-review";

export const TIEBREAK_RULE_VERSION = `${BOUNDARY_RULE_VERSION}:tiebreak-v1`;

export const TiebreakSchema = z.object({
  a_shows: z.string().describe("what cut A's images show: the tiles before the cut, then the cut tile and after"),
  b_shows: z.string().describe("what cut B's images show: the tiles before the cut, then the cut tile and after"),
  winner: z.enum(["A", "B", "neither"]).describe("the cut that satisfies rules 2-4 and 7-8 better; neither when both break one or the frames do not settle it"),
  evidence_image: z.number().int().nullable().describe("the image number (1-based) that decides it, or null"),
  evidence_tile_t: z.number().nullable().describe("the tile time in that image that decides it, or null"),
  reason: z.string(),
});

export type TiebreakVerdict = z.infer<typeof TiebreakSchema>;

export type TiebreakSide = {
  label: "A" | "B";
  t: number;
  /** The listed option this time is, when it is one. */
  option_key: string | null;
  /** The images for this side, in the order attached: the option strip when listed, then the dense strip. */
  images: StripImage[];
};

export type BoundaryTiebreakInput = {
  boundary: OptionsBoundary;
  sides: [TiebreakSide, TiebreakSide];
  layout: StripLayout;
  band: [number, number];
  range?: BoundaryRange | null;
  /** The source's card spans: a side inside one is marked (rule 7). */
  card_spans?: CardSpan[] | null;
  film_notes: string | null;
  provider: LlmProvider;
  model: string;
};

export function buildBoundaryTiebreak(input: BoundaryTiebreakInput) {
  const { boundary, sides } = input;
  const images = sides.flatMap((s) => s.images);
  if (!images.length || sides.some((s) => !s.images.length)) throw new Error(`buildBoundaryTiebreak: every side needs at least one image at ${boundary.boundary_s}`);
  const annotated = images.every((s) => s.annotated);
  const system: LlmSystemBlock[] = [
    {
      text: [
        "Two candidate cuts, A and B, were proposed for the same episode boundary of a vertical mini-drama by two reviewers who disagree. You see only the frames. You are not told who proposed which, and you are given no reasoning from either side.",
        "",
        stripHowTo(input.layout, { annotated }),
        "A DENSE strip shows frames 0.1s apart, 10 per row, with the cut at its centre tile; an option strip shows 0.5s steps with the cut at its centre tile. Each side's images are listed with their tile times.",
        "",
        BOUNDARY_RULES,
        filmNotesBlock(input.film_notes),
        "",
        "First write a_shows and b_shows from each side's own images: what the tiles before the cut show, then the cut tile and after.",
        "Then answer which cut satisfies the payoff rule: the episode ends AFTER its physical payoff with about 1-1.5 s of aftermath (rules 3-4), never inside an action (rule 2), never opening the next episode on the source's card or the flare into it (rule 7), never splitting a burned-in caption (rule 8), and ending on an open question a cold viewer can enter (rules 5-6).",
        "Pick neither when both break a rule, or when the frames do not settle it. Cite the image and tile that decide it.",
      ]
        .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
        .join("\n"),
      cache: true,
    },
  ];
  let n = 0;
  const sideBlock = (s: TiebreakSide) => {
    const opt = s.option_key ? boundary.options.find((o) => o.key === s.option_key) ?? null : null;
    const lines = [`CUT ${s.label} at ${s.t}s${opt ? ` (listed option ${opt.key}; ${motionReading(opt)})` : " (a legal cut from the index)"}`];
    const card = cardMark(s.t, input.card_spans);
    if (card) lines.push(card);
    for (const img of s.images) {
      n += 1;
      lines.push(`  image ${n}: ${img.key === "dense" ? `dense strip, ${img.step}s steps` : `option strip, ${img.step}s steps`}, cut at the centre tile; tiles: ${img.tiles.join(", ")}`);
    }
    return lines.join("\n");
  };
  const user = [`BOUNDARY ${boundary.boundary_s}s. The images attached before this text belong to the two cuts, in this order.`, rangeLine(input.band, input.range), "", sideBlock(sides[0]), "", sideBlock(sides[1]), "", "Which cut, A or B, satisfies the payoff rule - or neither?"].join("\n");
  return {
    name: "verify_boundaries_tiebreak",
    description: "Record what each candidate cut's images show, then which cut satisfies the payoff rule, or neither, with the image and tile that decide it.",
    system,
    user,
    images: images.map(asLlmImage),
    schema: TiebreakSchema,
    provider: input.provider,
    model: input.model,
    maxTokens: 4000,
    effort: "medium" as const,
    cacheSystem: true,
    prompt_version: TIEBREAK_RULE_VERSION,
    check: (out: TiebreakVerdict) => {
      if (!out.a_shows.trim() || !out.b_shows.trim()) return "a_shows and b_shows must each describe that side's images before the verdict";
      if (out.evidence_image !== null) {
        const img = images[out.evidence_image - 1];
        if (!img) return `evidence_image ${out.evidence_image} is not an attached image (1-${images.length})`;
        if (out.evidence_tile_t !== null && !img.tiles.some((t) => Math.abs(t - out.evidence_tile_t!) <= 0.051)) return `evidence_tile_t ${out.evidence_tile_t} is not a tile of image ${out.evidence_image}`;
      }
      return null;
    },
  };
}
