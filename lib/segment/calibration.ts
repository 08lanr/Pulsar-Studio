// The pure parts of the calibration CLI (scripts/segment-eval.ts): which
// boundaries a `--boundaries` spec selects, the film notes read off a
// film's STATE.md, and the acceptance bar of decision 2026-09-23 ("The
// frame judge, second pass") applied to a score. Kept out of the script so
// the tests import no side effects (the script loads .env.local).

import type { Score } from "./vision";

/** `--boundaries`: `a-b` is a 1-based index range (inclusive), `#n` one index, anything else a boundary time; comma-separated. */
export function selectBoundaries(all: number[], spec: string): { boundaries: number[]; indices: number[] } {
  const picked = new Set<number>();
  for (const raw of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const range = raw.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) if (i >= 1 && i <= all.length) picked.add(i - 1);
      continue;
    }
    const index = raw.match(/^#(\d+)$/);
    if (index) {
      const i = Number(index[1]);
      if (i >= 1 && i <= all.length) picked.add(i - 1);
      continue;
    }
    const t = Number(raw);
    const i = all.findIndex((b) => Math.abs(b - t) <= 0.0015);
    if (i < 0) throw new Error(`--boundaries: ${raw} is not a boundary of review/options.json`);
    picked.add(i);
  }
  const indices = [...picked].sort((a, b) => a - b);
  return { boundaries: indices.map((i) => all[i]), indices: indices.map((i) => i + 1) };
}

/** The "## Film-specific notes" section of a film's STATE.md, as the Workflow's film_notes; null when there is none. */
export function filmNotesFromState(stateMd: string): string | null {
  const m = stateMd.match(/^## Film-specific notes\s*\n([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m);
  const body = m?.[1]?.trim();
  return body ? body : null;
}

export type BarLine = { line: string; pass: boolean };

/** What the bar reads of a score; the second-round fields (`false_handoffs`, `truth_not_option`, `rule7_vs_delivered`, `cards.errored`) are optional so an older score still prints. */
export type BarScore = Pick<Score, "n" | "applied_agree" | "handoffs" | "person_reviews" | "confidence_gate" | "rule_failures"> &
  Partial<Pick<Score, "false_handoffs" | "truth_not_option" | "rule7_vs_delivered">> & { skeptic: Pick<Score["skeptic"], "bad_overrides">; cards: { boundaries: number; agree: number; errored?: number } };

export type BarOptions = {
  /** Boundaries whose call errored (judgeBoundaries' `errors`): each counts as not agreed and as a person review, never dropped from the denominator. */
  errors?: { boundary_s: number; error: string }[];
  /** Whether the card spans went into the prompt (false is the production by-eye arm: `--no-card-prompt`); undefined leaves it unsaid. */
  card_prompt?: boolean;
};

/**
 * The calibration bar of decision 2026-09-23 on a sample of n boundaries:
 * applied agreement of at least 15/20 on the tuning set (boundaries 1-20)
 * and 14/20 on the held-out set (21-40), zero hard-rule failures, at most 1
 * bad override and 2 person reviews per 20, 9 of 10 card boundaries on the
 * first frame after the card, at most $0.40 per boundary. A sample that
 * starts at index 21 or later is scored as held out. n is the selection
 * (`indices`), so a boundary that errored is a miss and a review, not a
 * smaller denominator; the person-review line counts what reviewState
 * sends to a person: faults, unverified fixes, picks under the confidence
 * gate, and the errors, and names the false hand-offs among them (a
 * reviewer pick that matched and was handed off anyway). The agreement
 * line names the measure's own limits beside the number: truths that are
 * no listed option, and applied cuts on the first frame after a card where
 * the delivered cut buries it (rule 7 against the delivered cut). The
 * hard-rule line says what it cannot check: rule 8, a split caption, is
 * read by eye only. The card line is over the selection: an errored card
 * boundary is a miss.
 */
export function calibrationBar(score: BarScore, indices: number[], costCents: number, opts: BarOptions = {}): BarLine[] {
  const errors = opts.errors ?? [];
  const n = Math.max(indices.length, score.n + errors.length) || 1;
  const heldOut = indices.length > 0 && indices[0] >= 21;
  const need = Math.ceil(((heldOut ? 14 : 15) / 20) * n);
  const per20 = (x: number) => (x * 20) / n;
  const errored = errors.length ? `; ${errors.length} errored, counted as missed: ${errors.map((e) => `${e.boundary_s}s ${e.error}`).join("; ")}` : "";
  const reviews = score.person_reviews + errors.length;
  const lowConfidence = score.person_reviews - score.handoffs;
  const cardArm = opts.card_prompt === undefined ? "" : opts.card_prompt ? "; card spans were in the prompt" : "; card spans NOT in the prompt, as a by-eye run in production";
  const notOption = score.truth_not_option ?? 0;
  const rule7 = score.rule7_vs_delivered ?? 0;
  const falseHandoffs = score.false_handoffs ?? 0;
  const cardErrored = score.cards.errored ?? 0;
  const measure = `; the measure: ${notOption} truth${notOption === 1 ? "" : "s"} not a listed option, ${rule7} applied cut${rule7 === 1 ? "" : "s"} on the first frame after a card the delivered cut buries (rule 7 vs delivered)`;
  // Nothing scored (every boundary errored, or none was asked): no line can pass, and each says so — the smoke of 2026-09-23 printed PASS on hard rules, overrides and cost over an empty set.
  const scored = score.n > 0;
  const unscored = scored ? "" : "; nothing scored, not met";
  return [
    { line: `applied agreement ${score.applied_agree}/${n} (bar ${need}/${n}, ${heldOut ? "held-out 14/20" : "tuning 15/20"}${errored}${measure}${unscored})`, pass: scored && score.applied_agree >= need },
    { line: `hard-rule failures ${score.rule_failures.total} (card ${score.rule_failures.card}, band ${score.rule_failures.band}, unseen ${score.rule_failures.unseen}; bar 0; rule 8, a split caption, is checked by eye only${unscored})`, pass: scored && score.rule_failures.total === 0 },
    { line: `bad overrides ${score.skeptic.bad_overrides} (bar at most 1 per 20${unscored})`, pass: scored && per20(score.skeptic.bad_overrides) <= 1 + 1e-9 },
    {
      line: `person reviews ${reviews} = hand-offs ${score.handoffs} (faults, unverified fixes; ${falseHandoffs} of them false: the reviewer's pick matched and was handed off anyway) + picks under ${score.confidence_gate} confidence ${lowConfidence} + errors ${errors.length} (bar at most 2 per 20, every one reviewState sends to a person; each must be a real fault when checked by eye${unscored})`,
      pass: scored && per20(reviews) <= 2 + 1e-9,
    },
    { line: `card boundaries ${score.cards.agree}/${score.cards.boundaries} on the first frame after the card (bar 9 of 10${cardErrored ? `; ${cardErrored} errored, counted as missed` : ""}${cardArm}${unscored})`, pass: scored && (score.cards.boundaries === 0 || score.cards.agree >= Math.ceil(0.9 * score.cards.boundaries)) },
    { line: `cost ${(costCents / 100 / n).toFixed(3)} $ per boundary (bar 0.40${unscored})`, pass: scored && costCents / 100 / n <= 0.4 },
  ];
}
