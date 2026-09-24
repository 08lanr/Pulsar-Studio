// The crazydramas slug, picked by Studio (decision 2026-09-23 "Upload
// automation: poster, slug, series text"; Ruobin: "Studio does routine steps
// itself — never tell the user to edit a JSON file, run Update, or paste SQL
// for routine work"). A title with no `crazydramas_slug` gets one on import,
// and again when its upload form opens if the import could not reach
// crazydramas:
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
// ledger) the slug is locked: ad links point at crazydramas.com/drama/<slug>.

import { systemSession, type Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { workspaceRoot } from "@/lib/data/storage";
import { writeFilmMetaSlug, type FilmMetaSlugWrite } from "@/lib/film-import/film-meta";
import type { Title } from "@/lib/types";
import { crazydramasTransport } from "./pick";
import { CD_SLUG } from "./publish-types";
import { crazydramasStudioMode, studioClient } from "./studio-client";
import { checkCrazydramasTitle } from "./sweep";
import { PLATFORM } from "./types";

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
  return slug.length > 0 && slug.length <= CD_SLUG_MAX && CD_SLUG.test(slug);
}

// ---- reading a slug on crazydramas -----------------------------------------------------------------------------

/** One read of a slug: free (404), a series, or no answer. */
export type SlugRead =
  | { status: 404 }
  | { status: 200; id: string; title: string; original_title: string | null; managed_by: "studio" | "cms" | null }
  | { status: "error"; error: string };

export type SlugReader = (slug: string) => Promise<SlugRead>;

/**
 * The read the pick uses: the authenticated Studio read when the mode allows
 * it (it sees drafts, so a 404 there is truly free), the public read
 * otherwise (or when crazydramas refuses the token). Fixture mode asks the
 * fake only.
 */
export const crazydramasSlugReader: SlugReader = async (slug) => {
  if (crazydramasStudioMode().read !== "off") {
    const r = await studioClient().getSeries(slug);
    if (r.ok) {
      const s = r.data.series;
      return { status: 200, id: s.id, title: s.title, original_title: s.original_title ?? null, managed_by: s.managed_by === "studio" || s.managed_by === "cms" ? s.managed_by : null };
    }
    if (r.status === 404 && r.code === "series_not_found") return { status: 404 };
    if (!(r.status === 401 || r.status === 403 || r.status === 503)) return { status: "error", error: r.error };
  }
  try {
    const p = await crazydramasTransport().series(slug);
    if (p.http_status === 404) return { status: 404 };
    return { status: 200, id: p.drama.id, title: p.drama.title, original_title: null, managed_by: p.drama.managed_by ?? null };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : "crazydramas did not answer." };
  }
};

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
export async function pickSlug(base: string, opts: { names: readonly string[]; read: SlugReader; heldByOther?: (dramaId: string) => boolean; start?: number; maxTries?: number }): Promise<SlugPick> {
  const tried: string[] = [];
  const held = opts.heldByOther ?? (() => false);
  const last = (opts.start ?? 1) + (opts.maxTries ?? SLUG_MAX_TRIES) - 1;
  for (let k = opts.start ?? 1; k <= last; k++) {
    const slug = slugCandidate(base, k);
    tried.push(slug);
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

// ---- the title's slug ---------------------------------------------------------------------------------------------

export type AssignResult = {
  /** saved: a new slug, free on crazydramas; linked: the show's own slug; kept: the title already had one. */
  outcome: "saved" | "linked" | "kept";
  slug: string;
  /** The series a `linked` slug names. */
  series?: { title: string; managed_by: "studio" | "cms" | null } | null;
  /** What happened to cut/film-meta.json. */
  film_meta: "written" | "created" | "unchanged" | "not_imported" | "no_workspace" | "not_written";
  film_meta_note?: string | null;
  tried: string[];
};

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

/** Why the slug can no longer change, in words; null while it may. */
export async function slugLockReason(titleId: string): Promise<string | null> {
  const data = getData();
  const sys = systemSession();
  const [link, rows] = await Promise.all([data.getPlatformLink(sys, titleId, PLATFORM), data.getCdPublications(sys, titleId)]);
  if (link) return `the series exists on crazydramas as ${link.slug}; ad links point at crazydramas.com/drama/${link.slug}, so the slug no longer changes`;
  if (rows.length) return "episodes were uploaded under this slug; ad links depend on it, so it no longer changes";
  return null;
}

function languageOf(locale: string | null | undefined): string {
  const code = (locale ?? "en").split(/[-_]/)[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(code) ? code : "en";
}

/** Write the slug into the film's film-meta, when the title came from the workspace. Never throws. */
function recordInFilmMeta(title: Title, slug: string, root: string | null | undefined): { film_meta: AssignResult["film_meta"]; film_meta_note: string | null } {
  if (!title.source_ref) return { film_meta: "not_imported", film_meta_note: null };
  const ws = root ?? workspaceRoot();
  if (!ws) return { film_meta: "no_workspace", film_meta_note: null };
  let w: FilmMetaSlugWrite;
  try {
    w = writeFilmMetaSlug(ws, title.source_ref, slug, { display_title_en: title.name_en ?? title.name_zh, language: languageOf(title.source_locale) });
  } catch (e) {
    return { film_meta: "not_written", film_meta_note: `cut/film-meta.json was not written: ${(e as Error).message}` };
  }
  if (w.written) return { film_meta: w.created ? "created" : "written", film_meta_note: null };
  if (w.reason === "unchanged") return { film_meta: "unchanged", film_meta_note: null };
  return { film_meta: "not_written", film_meta_note: w.detail ?? (w.reason === "no_cut_dir" ? "the film folder has no cut/ folder" : null) };
}

export type AssignOptions = {
  /** A slug the person typed; absent, Studio picks one. */
  slug?: string | null;
  /** WORKSPACE_ROOT override (the import passes its own). */
  root?: string | null;
  /** The reader (tests inject one). */
  read?: SlugReader;
  /** The film's folder name, one more name the working-name table may know. */
  folder?: string | null;
  /** Skip the check that refreshes the section's reading (the import runs its own at the end). */
  skipCheck?: boolean;
};

/**
 * Give the title its crazydramas slug (who may: the caller checked — the
 * import runs as the system, the route needs the title's approver or a staff
 * administrator). With `slug`, that one is checked; without, one is picked.
 * Throws SlugError: `slug_locked` (the draft series exists), `bad_slug`,
 * `slug_taken` (a typed slug another series has; `suggestion` is the next
 * free one), `crazydramas_unreachable` (Retry), `slug_exhausted`.
 */
export async function assignCrazydramasSlug(session: Session, titleId: string, opts: AssignOptions = {}): Promise<AssignResult> {
  const data = getData();
  const sys = systemSession();
  const title = (await data.getTitle(session, titleId)).title; // a foreign title is not found
  const current = title.crazydramas_slug?.trim() || null;
  const typed = opts.slug?.trim() || null;
  const read = opts.read ?? crazydramasSlugReader;
  const names = [title.name_en, title.name_zh].filter((n): n is string => !!n);

  if (typed === null && current) {
    // The title already has one (film-meta may not): film-meta brought up to date, nothing asked of crazydramas.
    return { outcome: "kept", slug: current, series: null, ...recordInFilmMeta(title, current, opts.root), tried: [] };
  }
  const locked = await slugLockReason(titleId);
  if (locked && typed !== current) throw new SlugError(409, "slug_locked", `The slug is locked: ${locked}.`, { slug: current });
  if (typed !== null && !isCdSlug(typed)) throw new SlugError(400, "bad_slug", "A slug is lowercase letters and digits joined by single hyphens, at most 80 characters (e.g. the-midnight-contract).");

  const links = await data.listPlatformLinks(sys, PLATFORM);
  const heldByOther = (dramaId: string) => links.some((l) => l.cd_drama_id.toLowerCase() === dramaId.toLowerCase() && l.title_id !== titleId);

  let pick: SlugPick;
  if (typed !== null) {
    pick = await pickSlug(typed, { names, read, heldByOther, maxTries: 1 });
    if (pick.outcome === "exhausted") {
      // Taken by another series: say which, and offer the next free one (asked now, so the offer is true).
      const r = await read(typed);
      const next = await pickSlug(typed, { names, read, heldByOther, start: 2 });
      const suggestion = next.outcome === "free" || next.outcome === "link" ? next.slug : null;
      throw new SlugError(409, "slug_taken", `${typed} is another series on crazydramas${r.status === 200 ? ` ("${r.title}")` : ""}.${suggestion ? ` ${suggestion} is free.` : ""}`, { suggestion, existing: r.status === 200 ? { slug: typed, title: r.title } : null });
    }
  } else {
    // 1. The show is already on the site under a slug of its own: the working-name table, then the public catalog.
    const known = knownLiveSlug([...names, opts.folder ?? title.source_ref?.split("/").pop() ?? null]);
    let found: SlugPick | null = null;
    if (known) {
      const r = await read(known);
      if (r.status === "error") found = { outcome: "unreachable", slug: known, error: r.error, tried: [known] };
      else if (r.status === 200 && !heldByOther(r.id)) found = { outcome: "link", slug: known, series: { id: r.id, title: r.title, managed_by: r.managed_by }, tried: [known] };
    }
    if (!found && !opts.read) {
      try {
        const keys = new Set(names.map(titleKey).filter(Boolean));
        const twin = (await crazydramasTransport().catalog()).find((d) => keys.has(titleKey(d.title)) && !heldByOther(d.id));
        if (twin) found = { outcome: "link", slug: twin.slug, series: { id: twin.id, title: twin.title, managed_by: twin.managed_by ?? null }, tried: [twin.slug] };
      } catch {
        // The catalog is a shortcut; the reads below decide whether crazydramas answers at all.
      }
    }
    // 2. The display title as a slug (then the folder's name, when the title has nothing Latin in it).
    if (!found) {
      const base = [title.name_en, title.source_ref?.split("/").pop() ?? null, title.name_zh].map(deriveSlug).find(Boolean) || "series";
      found = await pickSlug(base, { names, read, heldByOther });
    }
    pick = found;
  }

  if (pick.outcome === "unreachable") {
    throw new SlugError(503, "crazydramas_unreachable", `crazydramas did not answer, so Studio could not check the slug ${pick.slug} is free (${pick.error.replace(/[.。]\s*$/, "")}). Nothing was saved; try again.`, { slug: pick.slug });
  }
  if (pick.outcome === "exhausted") {
    throw new SlugError(409, "slug_exhausted", `Every slug from ${pick.tried[0]} to ${pick.slug} is another series on crazydramas; type one.`, { tried: pick.tried.length });
  }

  const slug = pick.slug;
  const saved = slug === current ? title : await data.setTitleImport(sys, titleId, { crazydramas_slug: slug });
  const meta = recordInFilmMeta(saved, slug, opts.root);
  if (!opts.skipCheck) {
    // The section's reading follows at once (a linked show's check makes the link; a free slug reads "not uploaded").
    await checkCrazydramasTitle(sys, titleId, { force: true }).catch((e) => console.warn(`[crazydramas] after the slug ${slug}, the check failed: ${(e as Error).message}`));
  }
  return {
    outcome: pick.outcome === "link" ? "linked" : "saved",
    slug,
    series: pick.outcome === "link" ? { title: pick.series.title, managed_by: pick.series.managed_by } : null,
    ...meta,
    tried: pick.tried,
  };
}

/** The import's step (failure-soft): a film with no slug gets one; a failure is a warning, never a failed import. */
export async function slugOnImport(titleId: string, opts: { root: string; folder: string; hasMetaSlug: boolean; read?: SlugReader }): Promise<{ slug: string | null; warning: string | null }> {
  if (opts.hasMetaSlug) return { slug: null, warning: null };
  try {
    const r = await assignCrazydramasSlug(systemSession(), titleId, { root: opts.root, folder: opts.folder, read: opts.read, skipCheck: true });
    const note = r.film_meta_note ? ` (${r.film_meta_note})` : "";
    console.log(`[crazydramas] slug for ${titleId}: ${r.slug} (${r.outcome}; film-meta ${r.film_meta})${note}`);
    return { slug: r.slug, warning: r.film_meta === "not_written" ? `the crazydramas slug ${r.slug} is on the title; cut/film-meta.json was not written${note}` : null };
  } catch (e) {
    const why = isSlugError(e) ? e.message : e instanceof Error ? e.message : String(e);
    return { slug: null, warning: `no crazydramas slug was picked: ${why} The upload form tries again when it opens.` };
  }
}
