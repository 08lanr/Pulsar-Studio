// draft_series_text (decision 2026-09-23 "Upload automation: poster, slug,
// series text"): the tagline, description and genres of a series on
// crazydramas, drafted from the film's own transcript so the upload form
// opens filled in. The model reads the first ~15 minutes and a sample of the
// rest — never the last fifth of the film, so it cannot give the ending
// away — and answers in the house style of the live catalog: a tagline of
// one punchy line ("A debt. A contract. A vow she can't break."), a
// spoiler-light description (premise, stakes, a hint; never the ending) and
// one to three genres from the catalog's own words.

import { z } from "zod";

/** The prompt's own version: part of every idempotency key, so a change here drafts again. */
export const SERIES_TEXT_PROMPT_VERSION = "series-text-v1";

export const TAGLINE_MAX = 80;
export const DESCRIPTION_MAX = 700;
export const GENRES_MAX = 3;

/** The live catalog's genre words (2026-09-23). Others are allowed; these come first. */
export const CATALOG_GENRES: readonly string[] = ["Romance", "Mafia", "Billionaire", "Secret Baby", "Revenge", "Campus", "Sports", "Betrayal", "Paranormal", "Mystery", "Thriller"];

/** Taglines in the house style (the live catalog's own voice). */
export const TAGLINE_EXAMPLES: readonly string[] = [
  "A debt. A contract. A vow she can't break.",
  "He hated every woman. Then he met the one who ran.",
  "She came back with his son — and a plan.",
];

/** How many sentences a description holds. */
export function sentenceCount(text: string): number {
  return (text.trim().match(/[^.!?…]+(?:[.!?…]+["'”’)]*|$)/g) ?? []).filter((s) => /\p{L}/u.test(s)).length;
}

export const SeriesTextSchema = z.object({
  tagline: z.string().trim().min(3).max(TAGLINE_MAX).describe(`One punchy line, at most ${TAGLINE_MAX} characters, in the catalog's voice: short clauses, no spoiler, no quotation marks around it`),
  description: z.string().trim().min(40).max(DESCRIPTION_MAX).describe("2-4 sentences: the premise, the stakes and a hint of the turn. Never the ending, never who ends up with whom."),
  genres: z.array(z.string().trim().min(2).max(24)).min(1).max(GENRES_MAX).describe(`1-${GENRES_MAX} genres, the catalog's own words first: ${CATALOG_GENRES.join(", ")}`),
});

export type SeriesTextOutput = z.infer<typeof SeriesTextSchema>;

export type TranscriptPiece = { start_s: number; end_s: number; text: string };

export type SeriesTextInput = {
  display_title: string;
  /** The film's language (the transcript's). */
  language: string;
  /** The opening minutes, in order. */
  head: TranscriptPiece[];
  /** Spaced lines from after the opening, never past `cutoff_s`. */
  sample: TranscriptPiece[];
  head_until_s: number;
  cutoff_s: number;
  duration_s: number;
};

const SYSTEM = `You write the store copy for vertical short dramas on crazydramas.com, a U.S. streaming app for mobile mini-dramas.

You get a film's working title and part of its dialogue transcript: the opening minutes in full and a sample of lines from later on. The transcript is machine speech recognition, so names and words may be misheard; never quote a line that looks garbled, and never invent a character, a twist or an event the lines do not support.

WRITE
- tagline: one punchy line of at most ${TAGLINE_MAX} characters, the catalog's house style — short clauses, rhythm, the hook of the premise. Examples of the voice:
${TAGLINE_EXAMPLES.map((t) => `  "${t}"`).join("\n")}
- description: 2-4 sentences, plain U.S. English, present tense. The premise, what is at stake, a hint of the turn that keeps a viewer watching. Spoiler-light: never the ending, never who ends up with whom, never a late reveal.
- genres: 1-${GENRES_MAX}, the catalog's own words first (${CATALOG_GENRES.join(", ")}); another word only when none fits.

Answer by calling the tool.`;

function mmss(s: number): string {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

function render(pieces: readonly TranscriptPiece[]): string {
  return pieces.map((p) => `[${mmss(p.start_s)}] ${p.text.replace(/\s+/g, " ").trim()}`).join("\n");
}

/** The callStructured arguments (the caller names the provider and model: ADS_TEXT_PROVIDER's fast tier). */
export function buildSeriesText(input: SeriesTextInput) {
  const user = [
    `Working title: ${input.display_title}`,
    `Language of the dialogue: ${input.language}`,
    `The film runs ${mmss(input.duration_s)}. You see the first ${mmss(input.head_until_s)} in full and a sample up to ${mmss(input.cutoff_s)}; the rest is withheld on purpose.`,
    "",
    "OPENING (in full)",
    render(input.head) || "(no dialogue)",
    "",
    "LATER (a sample, in order)",
    render(input.sample) || "(none)",
    "",
    "Write the tagline, the description and the genres.",
  ].join("\n");
  return {
    name: "series_text",
    description: "Record the series' tagline, description and genres for the crazydramas store.",
    system: [{ text: SYSTEM, cache: true }],
    user,
    schema: SeriesTextSchema,
    maxTokens: 1500,
    effort: "medium" as const,
    prompt_version: SERIES_TEXT_PROMPT_VERSION,
    check: (out: SeriesTextOutput) => {
      const n = sentenceCount(out.description);
      if (n < 2 || n > 4) return `The description must be 2-4 sentences, not ${n}`;
      if (/^["'“‘]|["'”’]$/.test(out.tagline)) return "Write the tagline without quotation marks around it";
      return null;
    },
  };
}
