// The slug Studio picks, the server half (decision 2026-09-23 "Upload
// automation: poster, slug, series text"): reading a candidate on
// crazydramas, saving the pick on the title and in the film's
// cut/film-meta.json, and the import's failure-soft step. The rules it
// follows (deriving, candidates, the working-name table, the pick itself)
// are pure and live in lib/crazydramas/slug.ts, which client screens import
// too; this module reads the data layer and the file system, so no client
// module may import it.

import { systemSession, type Session } from "@/lib/auth";
import { getData } from "@/lib/data";
import { workspaceRoot } from "@/lib/data/storage";
import { writeFilmMetaSlug, type FilmMetaSlugWrite } from "@/lib/film-import/film-meta";
import type { Title } from "@/lib/types";
import { crazydramasTransport } from "./pick";
import { deriveSlug, isCdSlug, isSlugError, knownLiveSlug, pickSlug, SlugError, titleKey, type SlugPick, type SlugReader } from "./slug";
import { crazydramasStudioMode, studioClient } from "./studio-client";
import { checkCrazydramasTitle } from "./sweep";
import { PLATFORM } from "./types";

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

/** Why the slug can no longer change, in words; null while it may. */
export async function slugLockReason(titleId: string): Promise<string | null> {
  const data = getData();
  const sys = systemSession();
  const [link, rows] = await Promise.all([data.getPlatformLink(sys, titleId, PLATFORM), data.getCdPublications(sys, titleId)]);
  if (link) return `the series exists on crazydramas as ${link.slug}; ad links point at crazydramas.com/watch/${link.slug}, so the slug no longer changes`;
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
  if (locked && typed !== null && typed !== current) {
    // Putting the slug back to the series the title is linked to is always safe: it is the title's own series (a
    // title whose slug was changed away from it is held there, and every write is refused until it is back).
    const link = await data.getPlatformLink(sys, titleId, PLATFORM);
    if (link && typed === link.slug) {
      const saved = await data.setTitleImport(sys, titleId, { crazydramas_slug: typed });
      const meta = recordInFilmMeta(saved, typed, opts.root);
      if (!opts.skipCheck) await checkCrazydramasTitle(sys, titleId, { force: true }).catch((e) => console.warn(`[crazydramas] after the slug ${typed}, the check failed: ${(e as Error).message}`));
      return { outcome: "linked", slug: typed, series: null, ...meta, tried: [] };
    }
  }
  if (locked && typed !== current) throw new SlugError(409, "slug_locked", `The slug is locked: ${locked}.`, { slug: current });
  if (typed !== null && !isCdSlug(typed)) throw new SlugError(400, "bad_slug", "A slug is lowercase letters and digits joined by single hyphens, at most 80 characters (e.g. the-midnight-contract).");

  const links = await data.listPlatformLinks(sys, PLATFORM);
  const heldByOther = (dramaId: string) => links.some((l) => l.cd_drama_id.toLowerCase() === dramaId.toLowerCase() && l.title_id !== titleId);
  // Another Studio title's slug is taken even while crazydramas has no series under it yet (two titles of one name, or
  // one film imported by two companies, would otherwise both save it and the second find itself locked out).
  const studioSlugs = new Map((await data.listTitlesWithPlatformSlug(sys, PLATFORM)).filter((t) => t.id !== titleId && t.crazydramas_slug?.trim()).map((t) => [t.crazydramas_slug!.trim(), t.name_en || t.name_zh] as const));
  const takenInStudio = (slug: string) => studioSlugs.has(slug);

  let pick: SlugPick;
  if (typed !== null) {
    if (takenInStudio(typed)) {
      const next = await pickSlug(typed, { names, read, heldByOther, takenInStudio, start: 2 });
      const suggestion = next.outcome === "free" || next.outcome === "link" ? next.slug : null;
      throw new SlugError(409, "slug_taken", `${typed} is already the slug of another Studio title ("${studioSlugs.get(typed)}").${suggestion ? ` ${suggestion} is free.` : ""}`, { suggestion, existing: null });
    }
    pick = await pickSlug(typed, { names, read, heldByOther, takenInStudio, maxTries: 1 });
    if (pick.outcome === "exhausted") {
      // Taken by another series: say which, and offer the next free one (asked now, so the offer is true).
      const r = await read(typed);
      const next = await pickSlug(typed, { names, read, heldByOther, takenInStudio, start: 2 });
      const suggestion = next.outcome === "free" || next.outcome === "link" ? next.slug : null;
      throw new SlugError(409, "slug_taken", `${typed} is another series on crazydramas${r.status === 200 ? ` ("${r.title}")` : ""}.${suggestion ? ` ${suggestion} is free.` : ""}`, { suggestion, existing: r.status === 200 ? { slug: typed, title: r.title } : null });
    }
  } else {
    // 1. The show is already on the site under a slug of its own: the working-name table, then the public catalog.
    const known = knownLiveSlug([...names, opts.folder ?? title.source_ref?.split("/").pop() ?? null]);
    let found: SlugPick | null = null;
    if (known && !takenInStudio(known)) {
      const r = await read(known);
      if (r.status === "error") found = { outcome: "unreachable", slug: known, error: r.error, tried: [known] };
      else if (r.status === 200 && !heldByOther(r.id)) found = { outcome: "link", slug: known, series: { id: r.id, title: r.title, managed_by: r.managed_by }, tried: [known] };
    }
    if (!found && !opts.read) {
      try {
        const keys = new Set(names.map(titleKey).filter(Boolean));
        const twin = (await crazydramasTransport().catalog()).find((d) => keys.has(titleKey(d.title)) && !heldByOther(d.id) && !takenInStudio(d.slug));
        if (twin) found = { outcome: "link", slug: twin.slug, series: { id: twin.id, title: twin.title, managed_by: twin.managed_by ?? null }, tried: [twin.slug] };
      } catch {
        // The catalog is a shortcut; the reads below decide whether crazydramas answers at all.
      }
    }
    // 2. The display title as a slug (then the folder's name, when the title has nothing Latin in it).
    if (!found) {
      const base = [title.name_en, title.source_ref?.split("/").pop() ?? null, title.name_zh].map(deriveSlug).find(Boolean) || "series";
      found = await pickSlug(base, { names, read, heldByOther, takenInStudio });
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
