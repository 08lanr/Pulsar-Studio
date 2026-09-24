// Studio's one write into a film folder outside a segment run (decision
// 2026-09-23 "Upload automation: poster, slug, series text"): the
// crazydramas slug Studio picked, written into `cut/film-meta.json` — the one
// file of a film Studio may hand-write (lib/segment/handoff.ts writes the
// whole form; this writes one key). Every other key of the file is kept as it
// is, in its order, unknown ones included; a film with no film-meta gets a
// minimal one that parses (display title, language, the slug, a note saying
// who wrote it). Nothing else in the folder is touched, and a file that does
// not parse as a JSON object is left alone (the slug still lives on the
// title; the answer says why the file was not written).
//
// The write is a temp file beside the target and a rename, so a reader (the
// scanner, a person's editor) never sees half a file.

import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeSourceRef } from "@/lib/data/film-import";
import { FilmMetaSchema } from "./manifest";

export type FilmMetaSlugWrite =
  | { written: true; file: string; created: boolean }
  | { written: false; reason: "no_cut_dir" | "unreadable" | "outside_root" | "unchanged"; detail?: string };

/** Where a film's film-meta lives (the cut-only route: `<film>/cut/film-meta.json`), inside the root, or null. */
export function filmMetaPath(root: string, sourceRef: string): string | null {
  let ref: string;
  try {
    ref = normalizeSourceRef(sourceRef);
  } catch {
    return null;
  }
  const abs = path.resolve(root, ...ref.split("/"), "cut", "film-meta.json");
  const rel = path.relative(path.resolve(root), abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return abs;
}

/** The raw object of a film-meta file (BOM stripped), or null when it is not a JSON object. */
function readObject(file: string): Record<string, unknown> | null {
  try {
    const text = readFileSync(file, "utf8");
    const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The object with `crazydramas_slug` set: in place when the key is there,
 * else right after `display_title_en` (where the pipeline's files carry it),
 * else at the end. Every other key keeps its value and its place. Pure.
 */
export function withSlug(meta: Record<string, unknown>, slug: string): Record<string, unknown> {
  if ("crazydramas_slug" in meta) return Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, k === "crazydramas_slug" ? slug : v]));
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [k, v] of Object.entries(meta)) {
    out[k] = v;
    if (k === "display_title_en") {
      out.crazydramas_slug = slug;
      placed = true;
    }
  }
  if (!placed) out.crazydramas_slug = slug;
  return out;
}

/** A minimal film-meta that parses (FilmMetaSchema): the display title, the slug, the language and who wrote it. */
export function minimalFilmMeta(input: { display_title_en: string; slug: string; language: string; now?: Date }): Record<string, unknown> {
  const meta = {
    display_title_en: input.display_title_en.trim() || input.slug,
    crazydramas_slug: input.slug,
    language: input.language.trim().length >= 2 ? input.language.trim() : "en",
    exclusions: [],
    notes: `Written by Pulsar Studio on ${(input.now ?? new Date()).toISOString().slice(0, 10)}: the crazydramas slug it picked and checked.`,
  };
  FilmMetaSchema.parse(meta);
  return meta;
}

/**
 * Write the slug into `<root>/<sourceRef>/cut/film-meta.json`, keeping every
 * other key. `fallback` makes the file when there is none (the display title
 * and language the title carries). No `cut/` folder, a path outside the root
 * or a file that is not a JSON object: nothing is written.
 */
export function writeFilmMetaSlug(root: string, sourceRef: string, slug: string, fallback: { display_title_en: string; language: string }): FilmMetaSlugWrite {
  const file = filmMetaPath(root, sourceRef);
  if (!file) return { written: false, reason: "outside_root" };
  const cutDir = path.dirname(file);
  if (!existsSync(cutDir) || !statSync(cutDir).isDirectory()) return { written: false, reason: "no_cut_dir" };
  let next: Record<string, unknown>;
  let created = false;
  if (existsSync(file)) {
    const have = readObject(file);
    if (!have) return { written: false, reason: "unreadable", detail: "cut/film-meta.json is not a JSON object; Studio left it as it is" };
    if (have.crazydramas_slug === slug) return { written: false, reason: "unchanged" };
    next = withSlug(have, slug);
  } else {
    next = minimalFilmMeta({ ...fallback, slug });
    created = true;
  }
  const tmp = `${file}.studio-${process.pid}-${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 1)}\n`, "utf8");
    renameSync(tmp, file);
  } finally {
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        // a stray temp file is harmless; the scanner reads only film-meta.json
      }
    }
  }
  return { written: true, file, created };
}
