// Band fixes, by eye: a faithful port of band_fix.workflow.js (drama-remix/
// scripts/cut-only, 2026-09-22). Each first-pass reviewer checks the
// 95-150 s band against the DP positions of its neighbours, not their moved
// positions, so moves that are each right can leave an episode too short or
// too long (`pick_cuts.py --choices` then refuses the plan and names the
// episode; it happened on every film). One judge per GROUP of adjacent
// boundaries picks the best in-band set by looking at the frames; two
// skeptics try to beat it (the payoff lens, the cold-open lens). Never widen
// the band.
//
// Through the API the judge sees the option strips of every boundary in the
// group and the legal cuts between the fixed neighbours as text; the
// Workflow's agents could also pull frames at any time with ffmpeg. The
// arithmetic the Workflow asked the judge to "check yourself" is checked
// here: a set whose lengths leave the band, or a time that is not a listed
// option or a legal cut, goes back for the repair turn.
//
// The result becomes Workflow-shaped records (bandFixToVisionRecords) so
// apply_vision.py applies them with its own rules and audit trail, plus a
// note in the pipeline's own phrasing (bandFixNote) that phase 1's
// parseBandFixNotes reads back.

import { z } from "zod";
import type { LlmProvider, LlmSystemBlock } from "@/lib/llm";
import { asLlmImage, isListedTime, type OptionsBoundary, type OptionsDoc, type StripImage, type StripLayout } from "@/lib/segment/strips";
import { BOUNDARY_RULE_VERSION, filmNotesBlock, renderOptions, stripHowTo, type BoundaryPick } from "./boundary-review";
import type { BoundaryVerdict } from "./boundary-skeptic";

export const BAND_FIX_RULE_VERSION = `${BOUNDARY_RULE_VERSION}:band-fix-v1`;

/** The band as the pipeline states it. */
export type Band = [number, number];

/** One boundary of a conflict group, as the Workflow's `groups[].boundaries[]` describes it. */
export type BandFixBoundary = {
  /** The first pass's boundary_s (the key in options.json and the audit). */
  key: number;
  /** The time the first pass applied (the skeptic's when it disagreed). */
  applied: number;
  conf: number;
  skeptic_agree: boolean;
  /** The listed option times. */
  options: number[];
};

export type BandFixGroup = {
  label: string;
  /** `{ep28: 92.4}`: the episodes out of band now, with their lengths. */
  episodes_out_of_band: Record<string, number>;
  /** The nearest boundaries NOT in the group (or 0 / the duration); they do not move. */
  fixed_before: number;
  fixed_after: number;
  boundaries: BandFixBoundary[];
};

/** The Workflow's rules with the band as rule 7. */
export function bandFixRules(band: Band): string {
  return [
    "1. Episodes run CONTINUOUS: episode N+1 starts on the frame after episode N ends.",
    "2. NEVER cut inside a physical action - mid-punch, mid-throw, mid-fall.",
    "3. The physical payoff belongs at the END of an episode; do not hand the next episode a payoff this one set up.",
    "4. After an impact, leave roughly 1.0-1.5 s of aftermath so the blow reads.",
    "5. The cut must end on an open question AND be somewhere a cold viewer can start and tell who is on screen within about 10 s.",
    "6. A break landing after the tension has already resolved is weak however clean it looks.",
    `7. HARD: every episode must be ${band[0]}-${band[1]} s long. Only legal cuts: a listed option, or a legal cut from the list (a shot change clear of speech).`,
  ].join("\n");
}

/** The Workflow's describe(g), verbatim. */
export function describeGroup(g: BandFixGroup): string {
  return [
    `Group ${g.label}. Out of band now: ${JSON.stringify(g.episodes_out_of_band)}.`,
    `Fixed boundary before the group: ${g.fixed_before} s. Fixed boundary after it: ${g.fixed_after} s. These do not move.`,
    "Boundaries to choose, in order (key = the first pass's boundary_s in options.json and the audit):",
    ...g.boundaries.map(
      (b, i) =>
        `  ${i + 1}. key ${b.key}: first pass applied ${b.applied} (confidence ${b.conf}, skeptic ${b.skeptic_agree ? "agreed" : "DISAGREED - the applied time is the skeptic's"}); listed options ${JSON.stringify(b.options)}`
    ),
  ].join("\n");
}

export const BandFixPickSchema = z.object({
  times: z.array(z.number()).describe("the chosen cut time for each boundary, in the order given"),
  lengths: z.array(z.number()).describe("resulting length of every episode between fixed_before and fixed_after"),
  ends_on: z.array(z.string()).describe("for each chosen cut: what the episode ends on and the next opens on"),
  handed_over: z.string().nullable().describe("honestly: any payoff that now opens the next episode, or null"),
  why: z.string(),
  confidence: z.number().describe("0 to 1; exactly 0 means you could not judge from the frames"),
});

export const BandFixVerdictSchema = z.object({
  agree: z.boolean(),
  better_times: z.array(z.number()).nullable().describe("only if you found a strictly better in-band set: one legal time per boundary, in order; null otherwise"),
  reason: z.string(),
});

export type BandFixPick = z.infer<typeof BandFixPickSchema>;
export type BandFixVerdict = z.infer<typeof BandFixVerdictSchema>;

/** The first-pass record of one boundary, as the audit file holds it (the judge reads what the reviewer and skeptic saw). */
export type FirstPassRecord = { boundary_s: number; pick: BoundaryPick; verdict: BoundaryVerdict | null };

export type BandFixInput = {
  group: BandFixGroup;
  band: Band;
  /** The options entries of the group's boundaries, in group order. */
  boundaries: OptionsBoundary[];
  /** Their strips, one array per boundary in group order (option order within). */
  strips: StripImage[][];
  layout: StripLayout;
  /** Every legal cut between fixed_before and fixed_after (index/candidates.json times). */
  legal_cuts: number[];
  /** The first pass's records for the group's boundaries, when the audit exists. */
  first_pass: FirstPassRecord[];
  film_notes: string | null;
  provider: LlmProvider;
  model: string;
};

/** The episode lengths a set of times gives between the fixed neighbours. */
export function episodeLengths(fixedBefore: number, times: number[], fixedAfter: number): number[] {
  const cuts = [fixedBefore, ...times, fixedAfter];
  return cuts.slice(1).map((t, i) => Math.round((t - cuts[i]) * 1000) / 1000);
}

/**
 * Why a set of times cannot be applied, or null: one time per boundary, in
 * order and strictly increasing, each a listed option of its boundary or a
 * legal cut, every episode between the fixed neighbours inside the band.
 */
export function bandFaults(times: number[], input: Pick<BandFixInput, "group" | "band" | "legal_cuts">): string | null {
  const g = input.group;
  if (times.length !== g.boundaries.length) return `give exactly ${g.boundaries.length} times (one per boundary, in order), not ${times.length}`;
  for (const [i, t] of times.entries()) {
    const b = g.boundaries[i];
    if (!isListedTime(t, [...b.options, ...input.legal_cuts])) return `time ${i + 1} (${t}) is not a listed option of key ${b.key} or a legal cut from the list`;
    if (i > 0 && t <= times[i - 1]) return `time ${i + 1} (${t}) is not after time ${i} (${times[i - 1]})`;
  }
  const lengths = episodeLengths(g.fixed_before, times, g.fixed_after);
  for (const [i, len] of lengths.entries()) {
    if (len < input.band[0] - 1e-9 || len > input.band[1] + 1e-9) return `episode ${i + 1} of the group would be ${len} s; every episode must be ${input.band[0]}-${input.band[1]} s (lengths ${JSON.stringify(lengths)})`;
  }
  return null;
}

function renderFirstPass(records: FirstPassRecord[]): string {
  if (!records.length) return "";
  const lines = records.map((r) => {
    const v = r.verdict;
    return [
      `key ${r.boundary_s}: reviewer chose ${r.pick.chosen_key} at ${r.pick.chosen_t}s (confidence ${r.pick.confidence}, payoff_in_episode ${r.pick.payoff_in_episode})`,
      `  ends on: ${r.pick.ends_on}`,
      `  opens on: ${r.pick.opens_on}`,
      `  why: ${r.pick.why}`,
      v ? `  skeptic ${v.agree ? "agreed" : `DISAGREED${v.better_t != null ? `, better ${v.better_t}s` : ", no fix"}`}: ${v.fault ? `${v.fault} ` : ""}${v.reason}` : "  (no skeptic record)",
    ].join("\n");
  });
  return ["THE FIRST PASS - what each reviewer and skeptic saw and why they chose as they did:", ...lines].join("\n");
}

function renderGroupOptions(input: BandFixInput): string {
  let image = 0;
  return input.boundaries
    .map((b, i) => {
      const strips = input.strips[i];
      const offset = image;
      image += strips.length;
      // renderOptions numbers images from 1 within a boundary; re-number across the group.
      const block = renderOptions(b, strips).replace(/ - image (\d+)/g, (_m, n: string) => ` - image ${offset + Number(n)}`);
      return `key ${b.boundary_s}:\n${block}`;
    })
    .join("\n\n");
}

function howTo(input: BandFixInput, label: string): string {
  return [
    `Group ${label}. ${stripHowTo(input.layout)}`,
    `LEGAL CUTS between ${input.group.fixed_before}s and ${input.group.fixed_after}s (index/candidates.json; shot changes clear of speech): ${input.legal_cuts.length ? input.legal_cuts.join(", ") : "(none beyond the listed options)"}`,
    filmNotesBlock(input.film_notes),
  ]
    .filter(Boolean)
    .join("\n");
}

function shared(input: BandFixInput, label: string): { system: LlmSystemBlock[]; facts: string; images: StripImage[] } {
  const g = input.group;
  if (input.boundaries.length !== g.boundaries.length || input.strips.length !== g.boundaries.length) {
    throw new Error(`band fix ${g.label}: ${g.boundaries.length} boundaries, ${input.boundaries.length} option entries, ${input.strips.length} strip sets`);
  }
  const system: LlmSystemBlock[] = [{ text: [bandFixRules(input.band), "", howTo(input, label)].join("\n"), cache: true }];
  const facts = [describeGroup(g), "", "OPTIONS (the images attached before this text, in this order)", renderGroupOptions(input), "", renderFirstPass(input.first_pass)].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
  return { system, facts, images: input.strips.flat() };
}

export function buildBandFixJudge(input: BandFixInput) {
  const { system, facts, images } = shared(input, input.group.label);
  const user = [
    "Choose where these episodes of a vertical mini-drama break. The first pass chose each boundary well on its own, but together they broke the length band. Pick the best set of cuts for this whole group that keeps EVERY episode between the fixed boundaries in band, by LOOKING at the frames.",
    "",
    facts,
    "",
    "Prefer keeping the stronger first-pass choices and moving the weaker ones as little as the story allows. Check the arithmetic of every length yourself.",
  ].join("\n");
  return {
    name: "band_fix_judge",
    description: "Record the in-band set of cut times for this group of boundaries, the resulting lengths, and what each cut ends and opens on.",
    system,
    user,
    images: images.map(asLlmImage),
    schema: BandFixPickSchema,
    provider: input.provider,
    model: input.model,
    maxTokens: 4000,
    effort: "medium" as const,
    cacheSystem: true,
    prompt_version: BAND_FIX_RULE_VERSION,
    check: (out: BandFixPick) => {
      if (out.confidence < 0 || out.confidence > 1) return "confidence is a number from 0 to 1";
      if (out.confidence === 0) return null;
      const fault = bandFaults(out.times, input);
      if (fault) return fault;
      const lengths = episodeLengths(input.group.fixed_before, out.times, input.group.fixed_after);
      if (out.lengths.length !== lengths.length || out.lengths.some((l, i) => Math.abs(l - lengths[i]) > 0.06)) return `the lengths do not follow from the times and the fixed boundaries: they are ${JSON.stringify(lengths)}`;
      if (out.ends_on.length !== out.times.length) return `give one ends_on per chosen cut (${out.times.length})`;
      return null;
    },
  };
}

export type BandFixLens = 0 | 1;

export function buildBandFixSkeptic(input: BandFixInput, pick: BandFixPick, lens: BandFixLens) {
  const { system, facts, images } = shared(input, `${input.group.label}-v${lens}`);
  const user = [
    "Another judge chose these cuts to fix a length-band conflict. Try to find a STRICTLY better in-band set. If you cannot, agree.",
    "",
    facts,
    "",
    `The judge chose: ${JSON.stringify(pick.times)} giving lengths ${JSON.stringify(pick.lengths)}. Their reasons: ${pick.why} Handed over: ${pick.handed_over || "nothing"}.`,
    lens === 0
      ? "Lens: the physical payoff. Does any chosen cut split an action or hand the next episode a payoff? Read the tiles around each chosen time closely."
      : "Lens: the cold open and the open question. Does each next episode open somewhere a cold viewer can place who is on screen, and does each episode end with the question still open?",
    "Also recheck that every chosen time is legal (a listed option or a legal cut from the list) and that every length is in band.",
  ].join("\n");
  return {
    name: `band_fix_verify_${lens}`,
    description: "Record whether the judge's set stands, or a strictly better in-band set of legal times.",
    system,
    user,
    images: images.map(asLlmImage),
    schema: BandFixVerdictSchema,
    provider: input.provider,
    model: input.model,
    maxTokens: 4000,
    effort: "medium" as const,
    cacheSystem: true,
    prompt_version: BAND_FIX_RULE_VERSION,
    check: (out: BandFixVerdict) => {
      if (out.agree) return out.better_times === null ? null : "you agreed: better_times must be null";
      if (out.better_times === null) return null; // a dispute with no set is reported, never applied (resolveBandFix)
      const fault = bandFaults(out.better_times, input);
      if (fault) return fault;
      if (out.better_times.every((t, i) => Math.abs(t - pick.times[i]) <= 0.0015)) return "better_times is the judge's own set; name a different set or agree";
      return null;
    },
  };
}

// ---- resolving a judged group -------------------------------------------------------------------

export type BandFixJudged = { pick: BandFixPick | null; verdicts: BandFixVerdict[] };

export type BandFixResolution = {
  label: string;
  times: number[] | null;
  lengths: number[] | null;
  source: "judge" | "skeptic-0" | "skeptic-1" | null;
  /** What stops this group from applying, in the wording of apply_vision.py's rules. */
  faults: string[];
};

/**
 * The same three rules apply_vision.py keeps for a boundary, for a group: a
 * skeptic that disagrees AND names a better set wins (the first that does);
 * a skeptic that disagrees without a set is a known fault with no fix, so
 * the group is reported rather than applied; a judge at confidence 0 chose
 * nothing.
 */
export function resolveBandFix(group: BandFixGroup, judged: BandFixJudged): BandFixResolution {
  const faults: string[] = [];
  const { pick } = judged;
  if (!pick || (pick.confidence || 0) === 0) {
    return { label: group.label, times: null, lengths: null, source: null, faults: [`${group.label}: judge refused or returned nothing - ${(pick?.why ?? "").slice(0, 120)}`] };
  }
  let times = pick.times;
  let source: BandFixResolution["source"] = "judge";
  for (const [k, v] of judged.verdicts.entries()) {
    if (v.agree) continue;
    if (v.better_times && v.better_times.length === group.boundaries.length) {
      if (source === "judge") {
        times = v.better_times;
        source = k === 0 ? "skeptic-0" : "skeptic-1";
      }
    } else {
      faults.push(`${group.label}: skeptic ${k} disputes ${JSON.stringify(pick.times)} and names no better set - ${v.reason.slice(0, 160)}`);
    }
  }
  if (faults.length) return { label: group.label, times: null, lengths: null, source: null, faults };
  return { label: group.label, times, lengths: episodeLengths(group.fixed_before, times, group.fixed_after), source, faults: [] };
}

/** A Workflow-output record per boundary of a resolved group, so apply_vision.py applies the fix with its own audit trail (`--from first.json --from band-fix.json`; the later file wins). */
export function bandFixToVisionRecords(group: BandFixGroup, boundaries: OptionsBoundary[], res: BandFixResolution, judged: BandFixJudged) {
  if (!res.times || !judged.pick) return [];
  const pick = judged.pick;
  const reasons = judged.verdicts.map((v, k) => `skeptic ${k} ${v.agree ? "agreed" : "disagreed"}: ${v.reason}`).join(" | ");
  return group.boundaries.map((b, i) => {
    const t = res.times![i];
    const opt = boundaries[i]?.options.find((o) => Math.abs(o.t - t) <= 0.0015);
    return {
      boundary_s: b.key,
      pick: {
        chosen_key: opt?.key ?? "legal_cut",
        chosen_t: t,
        ends_on: pick.ends_on[i] ?? "",
        opens_on: "",
        why: `band fix ${group.label} (${res.source}): ${pick.why}`,
        rejected: null as string | null,
        payoff_in_episode: !(pick.handed_over && pick.handed_over.trim()),
        confidence: pick.confidence,
      },
      verdict: { agree: true, fault: "", better_key: "", reason: reasons || "band fix: no skeptic ran" },
    };
  });
}

/**
 * The note for `review/vision/<date>_band-fix.md`, in the pipeline's own
 * phrasing so phase 1's parseBandFixNotes finds every moved boundary
 * (`A -> B`; a kept time reads `keep B`).
 */
export function bandFixNote(group: BandFixGroup, res: BandFixResolution, judged: BandFixJudged): string {
  const out = Object.entries(group.episodes_out_of_band)
    .map(([ep, len]) => `${ep} (was ${len} s)`)
    .join(", ");
  if (!res.times) return `${out || group.label}: NOT FIXED - ${res.faults.join("; ")}`;
  const moves = group.boundaries.map((b, i) => {
    const t = res.times![i];
    return Math.abs(t - b.applied) <= 0.0015 ? `keep ${t} (boundary ${b.key})` : `boundary ${b.key} moves ${b.applied} -> ${t}`;
  });
  const conf = judged.pick ? judged.pick.confidence : 0;
  return `${out || group.label}: ${moves.join("; ")}. Judged by ${res.source} through the Studio API. ${judged.pick?.why ?? ""} Lengths ${res.lengths!.join(" / ")}. Conf ${conf}.`;
}

// ---- finding the groups from a refused plan ---------------------------------------------------------

export type BandConflictInput = {
  doc: Pick<OptionsDoc, "duration" | "band" | "boundaries">;
  /** review/choices.json: applied time by `String(boundary_s)`. */
  choices: Record<string, number>;
  /** Delivered boundaries pinned outside the options (`--pin-from`); they never move. */
  pins?: number[];
  /** The first-pass records, for conf and skeptic_agree on each boundary. */
  records?: FirstPassRecord[];
};

/**
 * The groups band_fix.workflow.js takes, computed from the applied choices:
 * every episode outside the band marks both its boundaries; consecutive
 * marked boundaries form one group; the fixed neighbours are the nearest
 * unmarked cut points (an applied choice, a pin, 0 or the duration).
 */
export function findBandConflicts(input: BandConflictInput): BandFixGroup[] {
  const [lo, hi] = input.doc.band;
  const movable = input.doc.boundaries
    .map((b) => ({ b, applied: input.choices[String(b.boundary_s)] ?? b.boundary_s }))
    .sort((x, y) => x.applied - y.applied);
  type Cut = { t: number; index: number | null };
  const cuts: Cut[] = [{ t: 0, index: null }, ...(input.pins ?? []).map((t) => ({ t, index: null })), ...movable.map((m, i) => ({ t: m.applied, index: i })), { t: input.doc.duration, index: null }]
    .sort((a, b) => a.t - b.t)
    .filter((c, i, a) => i === 0 || Math.abs(c.t - a[i - 1].t) > 0.0015);
  const byKey = new Map((input.records ?? []).map((r) => [Math.round(r.boundary_s * 1000), r]));
  const groups: BandFixGroup[] = [];
  // A group is a chain of out-of-band episodes joined by a shared boundary
  // (He Hated All Women's ep12 was one episode, its two boundaries one group);
  // its movable cuts are the boundaries to choose, the cut before the first
  // and after the last are the fixed neighbours. A pin or the film's ends
  // never move, so an episode between two fixed cuts has no group.
  let chain: { episodes: Record<string, number>; positions: number[] } | null = null;
  const flush = () => {
    if (chain) {
      const movablePositions = chain.positions.filter((p) => cuts[p].index !== null);
      if (movablePositions.length) {
        const first = movablePositions[0];
        const last = movablePositions[movablePositions.length - 1];
        groups.push({
          label: `g${groups.length + 1}-${movable[cuts[first].index!].b.boundary_s}`,
          episodes_out_of_band: chain.episodes,
          fixed_before: cuts[first - 1].t,
          fixed_after: cuts[last + 1].t,
          boundaries: movablePositions.map((p) => {
            const m = movable[cuts[p].index!];
            const r = byKey.get(Math.round(m.b.boundary_s * 1000));
            return { key: m.b.boundary_s, applied: m.applied, conf: r?.pick.confidence ?? 0, skeptic_agree: r?.verdict?.agree ?? true, options: m.b.options.map((o) => o.t) };
          }),
        });
      }
    }
    chain = null;
  };
  for (let e = 1; e < cuts.length; e++) {
    const len = Math.round((cuts[e].t - cuts[e - 1].t) * 1000) / 1000;
    if (len >= lo && len <= hi) {
      flush();
      continue;
    }
    // Two out-of-band episodes joined by a MOVABLE cut are one problem; joined by a pin they are two.
    if (chain && chain.positions[chain.positions.length - 1] === e - 1 && cuts[e - 1].index !== null) {
      chain.positions.push(e);
    } else {
      flush();
      chain = { episodes: {}, positions: [e - 1, e] };
    }
    chain.episodes[`ep${e}`] = len;
  }
  flush();
  return groups;
}
