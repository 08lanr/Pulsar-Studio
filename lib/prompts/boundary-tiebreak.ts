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
//
// The calibration (phase 2.1) had the tie-break answer "neither" without
// placing a fault on either side: once by repeating a split-caption claim
// the frames did not show (a false hand-off of the delivered cut), once by
// misreading the dense strip's cut tile. So the verdict now cites the tile
// of the losing side's own images where its fault shows - both sides for
// "neither" - and the check refuses a verdict without it; the reading
// block names the dense strip's cut tile from its own layout.

import { z } from "zod";
import type { LlmProvider, LlmSystemBlock } from "@/lib/llm";
import { SEEN_TOLERANCE_S, asLlmImage, cutIndexOf, type CardSpan, type OptionsBoundary, type StripImage, type StripLayout } from "@/lib/segment/strips";
import { BOUNDARY_RULES, BOUNDARY_RULE_VERSION, cardMark, filmNotesBlock, motionReading, rangeLine, stripFacts, stripHowTo, type BoundaryRange } from "./boundary-review";

export const TIEBREAK_RULE_VERSION = `${BOUNDARY_RULE_VERSION}:tiebreak-v2`;

export const TiebreakSchema = z.object({
  a_shows: z.string().describe("what cut A's images show: the tiles before the cut, then the cut tile and after"),
  b_shows: z.string().describe("what cut B's images show: the tiles before the cut, then the cut tile and after"),
  a_fault_tile_t: z.number().nullable().describe("the tile time, copied from one of cut A's OWN images, where A breaks a rule (an action across the cut, no aftermath, the card or flare on the cut tile, the same caption on both sides); null when A breaks none"),
  b_fault_tile_t: z.number().nullable().describe("the same for cut B, from B's own images; null when B breaks none"),
  winner: z.enum(["A", "B", "neither"]).describe("the cut that satisfies rules 2-4 and 7-8 better; neither only when BOTH break a rule that shows on a tile of their own images (both fault tiles cited)"),
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

const isTileOf = (t: number, images: Pick<StripImage, "tiles">[]) => images.some((img) => img.tiles.some((x) => Math.abs(x - t) <= SEEN_TOLERANCE_S + 1e-9));

/** The 1-based cut tile of an attached image, from its own tiles (the option strip's centre, the dense strip's centre). */
const cutTileNumber = (img: Pick<StripImage, "tiles" | "t">) => cutIndexOf(img.tiles, img.t) + 1;

/** The strip layouts the tie-break attaches, in the images' own steps and columns: an option strip and, when one is attached, a dense strip. */
export function tiebreakLayoutLine(images: Pick<StripImage, "key" | "tiles" | "cols" | "step" | "t">[], layout: Pick<StripLayout, "window" | "step" | "cols">): string {
  const option = images.find((i) => i.key !== "dense");
  const dense = images.find((i) => i.key === "dense");
  return [
    option ? `An option strip shows ${option.tiles.length} frames ${option.step}s apart, ${option.cols} per row, the cut at tile ${cutTileNumber(option)}.` : `An option strip shows frames ${layout.step}s apart, ${layout.cols} per row, the cut at tile ${stripFacts(layout).cut}.`,
    dense ? `A DENSE strip shows ${dense.tiles.length} frames ${dense.step}s apart, ${dense.cols} per row, the cut at tile ${cutTileNumber(dense)}.` : null,
    "Each side's images are listed with their tile times.",
  ]
    .filter((l): l is string => l !== null)
    .join(" ");
}

/** Where a side's cited fault tile is wrong, or null: it must be a tile of that side's own images. */
export function faultTileProblem(side: TiebreakSide, t: number | null): string | null {
  if (t === null) return null;
  if (!isTileOf(t, side.images)) return `${side.label.toLowerCase()}_fault_tile_t ${t} is not a tile of cut ${side.label}'s own images (its tiles: ${side.images.map((i) => `${i.tiles[0]}..${i.tiles[i.tiles.length - 1]}`).join(", ")})`;
  return null;
}

export function buildBoundaryTiebreak(input: BoundaryTiebreakInput) {
  const { boundary, sides } = input;
  const images = sides.flatMap((s) => s.images);
  if (!images.length || sides.some((s) => !s.images.length)) throw new Error(`buildBoundaryTiebreak: every side needs at least one image at ${boundary.boundary_s}`);
  const annotated = images.every((s) => s.annotated);
  const dense = images.find((i) => i.key === "dense") ?? null;
  const system: LlmSystemBlock[] = [
    {
      text: [
        "Two candidate cuts, A and B, were proposed for the same episode boundary of a vertical mini-drama by two reviewers who disagree. You see only the frames. You are not told who proposed which, and you are given no reasoning from either side.",
        "",
        stripHowTo(input.layout, { annotated, dense }),
        tiebreakLayoutLine(images, input.layout),
        "",
        BOUNDARY_RULES,
        filmNotesBlock(input.film_notes),
        "",
        "First write a_shows and b_shows from each side's own images: what the tiles before the cut show, then the cut tile and after.",
        "Then, for each side, the tile of its OWN images where it breaks a rule (a_fault_tile_t, b_fault_tile_t), or null when it breaks none.",
        "Then answer which cut satisfies the payoff rule: the episode ends AFTER its physical payoff with about 1-1.5 s of aftermath (rules 3-4), never inside an action (rule 2), never opening the next episode on the source's card or the flare into it (rule 7; a card that ends before the cut is the target), never splitting one burned-in caption across the cut (rule 8; a different line on each side is not a split), and ending on an open question a cold viewer can enter (rules 5-6).",
        "The losing side must carry a fault tile: a cut is not worse because the other is better, it is worse because a tile of its own images shows the rule it breaks. A cut that hands the payoff to the next episode (rule 3) or lands after the tension has resolved (rule 6) breaks a rule too: its fault tile is the one that shows the payoff still to come, or already over. Pick neither only when both cuts break a rule, each with its fault tile cited. Cite the image and tile that decide it.",
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
      lines.push(`  image ${n}: ${img.key === "dense" ? `dense strip, ${img.step}s steps` : `option strip, ${img.step}s steps`}, cut at tile ${cutTileNumber(img)}; tiles: ${img.tiles.join(", ")}`);
    }
    return lines.join("\n");
  };
  const user = [`BOUNDARY ${boundary.boundary_s}s. The images attached before this text belong to the two cuts, in this order.`, rangeLine(input.band, input.range), "", sideBlock(sides[0]), "", sideBlock(sides[1]), "", "Which cut, A or B, satisfies the payoff rule - or neither?"].join("\n");
  return {
    name: "verify_boundaries_tiebreak",
    description: "Record what each candidate cut's images show and the tile where each breaks a rule, then which cut satisfies the payoff rule, or neither, with the image and tile that decide it.",
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
      const [a, b] = sides;
      const aProblem = faultTileProblem(a, out.a_fault_tile_t);
      if (aProblem) return aProblem;
      const bProblem = faultTileProblem(b, out.b_fault_tile_t);
      if (bProblem) return bProblem;
      // The losing side carries the fault; "neither" carries one on each side. A hand-off with no tile to look at is what this check exists to refuse.
      if (out.winner === "A" && out.b_fault_tile_t === null) return "winner A: cite b_fault_tile_t, the tile of cut B's own images where B breaks a rule; if B breaks none, it is not the loser";
      if (out.winner === "B" && out.a_fault_tile_t === null) return "winner B: cite a_fault_tile_t, the tile of cut A's own images where A breaks a rule; if A breaks none, it is not the loser";
      if (out.winner === "neither" && (out.a_fault_tile_t === null || out.b_fault_tile_t === null)) return "neither: cite a_fault_tile_t AND b_fault_tile_t, the tile of each side's own images where it breaks a rule; a side that breaks none is the winner";
      if (out.evidence_image !== null) {
        const img = images[out.evidence_image - 1];
        if (!img) return `evidence_image ${out.evidence_image} is not an attached image (1-${images.length})`;
        if (out.evidence_tile_t !== null && !img.tiles.some((t) => Math.abs(t - out.evidence_tile_t!) <= SEEN_TOLERANCE_S + 1e-9)) return `evidence_tile_t ${out.evidence_tile_t} is not a tile of image ${out.evidence_image}`;
      }
      return null;
    },
  };
}
