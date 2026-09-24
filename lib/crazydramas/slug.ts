// The crazydramas slug: every rule about it, pure and client-safe. Two
// callers need that: the launch screens and the TikTok ad link
// (lib/tiktok/ad-url.ts) test a slug with the very rule the crazydramas reads
// use (lib/crazydramas/types.ts re-exports CRAZYDRAMAS_SLUG and isMockSlug),
// and the slug Studio picks on import (decision 2026-09-23 "Upload
// automation: poster, slug, series text") derives and checks its candidates
// here. Nothing here may import a server module: the part that reads
// crazydramas and saves the slug on the title is lib/crazydramas/slug-assign.ts.
//
// How Studio picks one (Ruobin: "Studio does routine steps itself — never
// tell the user to edit a JSON file, run Update, or paste SQL for routine
// work"). A title with no `crazydramas_slug` gets one on import, and again
// when its upload form opens if the import could not reach crazydramas:
//
//   1. the show's own slug when it is already on the site: the working-name
//      table of STUDIO_API.md (`KNOWN_LIVE_SERIES`) or the public catalog,
//      matched by title (case, spacing and punctuation ignored);
//   2. else the display title as a slug — lowercase ASCII words joined by
//      hyphens, at most 80 characters, crazydramas' own rule — read on
//      crazydramas (the authenticated read, which sees drafts, or the public
//      one without a token): 404 is free; 200 with the same title is the show
//      itself, linked read-only by the existing link rules (the check makes
//      the link on its first 200 read); 200 with another series is taken, and
//      `-2`, `-3`, … are tried until one is free.
//
// The slug is saved on the title and written into the film's
// `cut/film-meta.json` (every other key kept; lib/film-import/film-meta.ts).
// A read that fails is `unreachable`: nothing is saved, and the screens say so
// and offer Retry. Once the draft series exists (a link, or any upload in the
// ledger) the slug is locked: ad links point at crazydramas.com/watch/<slug>.

/** A crazydramas slug: lowercase words joined by hyphens (`forced-to-marry-the-mafia-boss`). */
export const CRAZYDRAMAS_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Series the edge cache mixes into the catalog for design work; never real. */
export function isMockSlug(slug: string): boolean {
  return slug.startsWith("mock-");
}

/** crazydramas' slug limit (STUDIO_API.md, PUT series). */
export const CD_SLUG_MAX = 80;
/** How many suffixes are tried before Studio gives up (a title shared by that many series is not a slug problem). */
export const SLUG_MAX_TRIES = 30;

/**
 * The shows that were live before Studio could write (STUDIO_API.md, "Which
 * series Studio may change", 2026-09-23): the working name (the pipeline's
 * folder name) and the live slug. Read by the slug pick (a film of one of
 * these links to the live series instead of a new slug) and by the series
 * write's check that the show is not already live under another name.
 */
export const KNOWN_LIVE_SERIES: readonly { working: string; slug: string }[] = [
  { working: "Forced to Marry the Mafia Boss", slug: "forced-to-marry-the-mafia-boss" },
  { working: "he mocked her crush on him and sent her", slug: "he-mocked-her-crush-on-him-and-sent-her" },
  { working: "he treated our love like a prank", slug: "he-treated-our-love-like-a-prank" },
  { working: "My New billionare husband", slug: "my-new-billionaire-husband" },
  { working: "One night with the billionare who hated women", slug: "one-night-with-the-billionaire-who-hated-women" },
  { working: "Ever Since I Played That Game Paranormal", slug: "ever-since-i-played-that-game-paranormal" },
  { working: "she returned with her son", slug: "i-came-back-with-his-abandoned-son-to-ruin-his-wedding" },
  { working: "the cold ceo", slug: "hired-as-his-secretary-claimed-as-his-wife" },
];

/** crazydramas titleKey: case, spacing and punctuation ignored. */
export function titleKey(title: string | null | undefined): string {
  return (title ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// ---- deriving ------------------------------------------------------------------------------------------------

/** Letters NFKD does not take apart into a base letter and a mark. */
const FOLD: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", đ: "d", ð: "d", ł: "l", þ: "th", ı: "i" };

/**
 * A display title as a crazydramas slug: accents folded to ASCII (é → e,
 * ß → ss), apostrophes dropped inside a word (Can't → cant), `&` read as
 * "and", every other run of non-letters a single hyphen, lowercase, at most
 * 80 characters cut at a word boundary. Empty when nothing Latin is left (a
 * title in Chinese alone): the caller tries the next name. Pure.
 */
export function deriveSlug(text: string | null | undefined): string {
  const folded = (text ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[ßæœøđðłþı]/g, (c) => FOLD[c] ?? c)
    .replace(/(\p{L})['’‘`´](\p{L})/gu, "$1$2")
    .replace(/&/g, " and ");
  const words = folded.split(/[^a-z0-9]+/).filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > CD_SLUG_MAX) {
      if (!out) out = w.slice(0, CD_SLUG_MAX);
      break;
    }
    out = next;
  }
  return out;
}

/** The k-th candidate: the slug itself for k = 1, then `<slug>-k`, the base cut back so the whole stays within 80 characters. Pure. */
export function slugCandidate(base: string, k: number): string {
  if (k <= 1) return base;
  const tail = `-${k}`;
  const room = CD_SLUG_MAX - tail.length;
  const cut = base.length > room ? base.slice(0, room).replace(/-+$/, "") : base;
  return `${cut}${tail}`;
}

/** Is it a slug crazydramas accepts (lowercase letters and digits joined by single hyphens, at most 80)? */
export function isCdSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= CD_SLUG_MAX && CRAZYDRAMAS_SLUG.test(slug);
}

// ---- checking candidates -------------------------------------------------------------------------------------

/** One read of a slug: free (404), a series, or no answer. */
export type SlugRead =
  | { status: 404 }
  | { status: 200; id: string; title: string; original_title: string | null; managed_by: "studio" | "cms" | null }
  | { status: "error"; error: string };

export type SlugReader = (slug: string) => Promise<SlugRead>;

export type SlugPick =
  /** Nothing on crazydramas under it (404). */
  | { outcome: "free"; slug: string; tried: string[] }
  /** The show itself is there under it (the same title): the title links to it, read-only by the link rules. */
  | { outcome: "link"; slug: string; series: { id: string; title: string; managed_by: "studio" | "cms" | null }; tried: string[] }
  /** crazydramas did not answer: nothing is saved; Retry. */
  | { outcome: "unreachable"; slug: string; error: string; tried: string[] }
  /** Every suffix up to SLUG_MAX_TRIES is another series. */
  | { outcome: "exhausted"; slug: string; tried: string[] };

/**
 * Is the series the show this title is? The same title (or original title),
 * as crazydramas' own guard compares them, and no other title's link holds it
 * (a series another title holds is that title's; this one takes a suffix and
 * its series write meets the title guard, which names the show).
 */
function sameShow(read: Extract<SlugRead, { status: 200 }>, names: readonly string[], heldByOther: (dramaId: string) => boolean): boolean {
  const keys = new Set(names.map(titleKey).filter(Boolean));
  const match = keys.has(titleKey(read.title)) || (!!read.original_title && keys.has(titleKey(read.original_title)));
  return match && !heldByOther(read.id);
}

/**
 * Pick the slug from `base`: `base`, then `base-2`, `base-3`, … until one is
 * free (404) or is the show itself (200, the same title). Pure over the
 * injected reader.
 */
export async function pickSlug(base: string, opts: { names: readonly string[]; read: SlugReader; heldByOther?: (dramaId: string) => boolean; takenInStudio?: (slug: string) => boolean; start?: number; maxTries?: number }): Promise<SlugPick> {
  const tried: string[] = [];
  const held = opts.heldByOther ?? (() => false);
  const last = (opts.start ?? 1) + (opts.maxTries ?? SLUG_MAX_TRIES) - 1;
  for (let k = opts.start ?? 1; k <= last; k++) {
    const slug = slugCandidate(base, k);
    tried.push(slug);
    // Another Studio title already carries it (not uploaded yet, so crazydramas answers 404): taken all the same.
    if (opts.takenInStudio?.(slug)) continue;
    const r = await opts.read(slug);
    if (r.status === "error") return { outcome: "unreachable", slug, error: r.error, tried };
    if (r.status === 404) return { outcome: "free", slug, tried };
    if (sameShow(r, opts.names, held)) return { outcome: "link", slug, series: { id: r.id, title: r.title, managed_by: r.managed_by }, tried };
  }
  return { outcome: "exhausted", slug: slugCandidate(base, last), tried };
}

/** The live slug of a show the working-name table knows, by any of the names (title, folder); null otherwise. Pure. */
export function knownLiveSlug(names: readonly (string | null | undefined)[]): string | null {
  const keys = new Set(names.map(titleKey).filter(Boolean));
  return KNOWN_LIVE_SERIES.find((k) => keys.has(titleKey(k.working)) || keys.has(titleKey(k.slug)))?.slug ?? null;
}

// ---- refusals ------------------------------------------------------------------------------------------------

/** A refusal the slug route answers as `{error, code, ...}` with `status`. */
export class SlugError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SlugError";
  }
  body(): Record<string, unknown> {
    return { ...this.details, error: this.message, code: this.code };
  }
}

export function isSlugError(e: unknown): e is SlugError {
  return e instanceof SlugError || (typeof e === "object" && e !== null && (e as { name?: string }).name === "SlugError");
}
