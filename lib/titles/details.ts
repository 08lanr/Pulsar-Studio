// The Title details card (decision 2026-09-24 "Rename a title, choose its
// poster"): the two things a person changes about a title after import — its
// name and its poster — in one place, carried everywhere they show:
//
//   rename: the title's English name (and its Chinese one when that was only
//     the folder's name too); the crazydramas slug follows the new name while
//     it may still change (no series, no upload); the title's own Studio
//     series on crazydramas gets the new name.
//   poster: the picked image becomes the title's cover (kept in the local
//     tier, recorded as a film asset); the title's own Studio series gets it
//     as its poster (normalised and hosted, lib/crazydramas/poster). With no
//     series yet, "Create series" starts from the cover.
//
// A series that is not a draft changes only with `confirmLive` (viewers see it
// at once): without it the Studio side is saved and the answer says what to
// confirm. crazydramas refusing or being unreachable never undoes the Studio
// side; the answer carries crazydramas' words.

import { createHash } from "node:crypto";
import { systemSession, type Session } from "@/lib/auth";
import { POSTER_MAX_UPLOAD_BYTES, imageExt, posterForTitle, type PosterEncoder, type PosterStore } from "@/lib/crazydramas/poster";
import { isCdPublishError, setSeriesFields } from "@/lib/crazydramas/publish";
import { deriveSlug, isSlugError } from "@/lib/crazydramas/slug";
import { assignCrazydramasSlug, slugLockReason, type AssignOptions } from "@/lib/crazydramas/slug-assign";
import type { StudioClient } from "@/lib/crazydramas/studio-client";
import { PLATFORM } from "@/lib/crazydramas/types";
import { DataError, getData } from "@/lib/data";
import { localStoredPath, putStoredBytes } from "@/lib/data/storage";
import type { Title } from "@/lib/types";

export const TITLE_NAME_MAX = 200;

/** What happened on crazydramas: sent, nothing there to change, waiting for the live confirm, or refused (`note`). */
export type SeriesOutcome = "updated" | "no_series" | "confirm_live" | "not_sent";

export type DetailsResult = {
  title: Pick<Title, "id" | "name_en" | "name_zh" | "crazydramas_slug" | "cover_path">;
  /** The slug moved with the name: from → to; `note` when it could not (it stays as it was). */
  slug: { from: string | null; to: string | null; note: string | null };
  crazydramas: SeriesOutcome;
  crazydramas_note: string | null;
  series_status: string | null;
};

type SeriesOpts = { confirmLive?: boolean; client?: StudioClient };

function requireStaffSession(session: Session): void {
  if (session.kind !== "staff") throw new DataError("forbidden", "only staff may change a title's name or poster");
}

/** Send the change to the title's own series, when it has one; never throws. */
async function toSeries(session: Session, titleId: string, fields: { poster_url?: string; title?: string }, opts: SeriesOpts): Promise<Pick<DetailsResult, "crazydramas" | "crazydramas_note" | "series_status">> {
  const link = await getData().getPlatformLink(systemSession(), titleId, PLATFORM);
  if (!link) return { crazydramas: "no_series", crazydramas_note: null, series_status: null };
  try {
    const r = await setSeriesFields(session, titleId, fields, opts);
    return { crazydramas: "updated", crazydramas_note: null, series_status: r.series.status ?? null };
  } catch (e) {
    if (isCdPublishError(e) && e.code === "series_live_confirm") return { crazydramas: "confirm_live", crazydramas_note: e.message, series_status: String(e.details.series_status ?? "") || null };
    if (isCdPublishError(e) && e.code === "series_missing") return { crazydramas: "no_series", crazydramas_note: null, series_status: null };
    return { crazydramas: "not_sent", crazydramas_note: e instanceof Error ? e.message : String(e), series_status: null };
  }
}

const shown = (t: Title): DetailsResult["title"] => ({ id: t.id, name_en: t.name_en, name_zh: t.name_zh, crazydramas_slug: t.crazydramas_slug, cover_path: t.cover_path });

/**
 * Rename the title. The Chinese name follows only when it was the same text
 * as the English one (a folder import names both after the folder). The slug
 * follows while it may change: the new name's slug, or the next free one
 * after it; crazydramas not answering keeps the old one with a note.
 */
export async function renameTitle(session: Session, titleId: string, rawName: string, opts: SeriesOpts & { slugRead?: AssignOptions["read"] } = {}): Promise<DetailsResult> {
  requireStaffSession(session);
  const name = rawName.trim().replace(/\s+/g, " ");
  if (!name) throw new DataError("invalid", "the name is empty");
  if (name.length > TITLE_NAME_MAX) throw new DataError("invalid", `the name is over ${TITLE_NAME_MAX} characters`);
  const data = getData();
  const before = (await data.getTitle(session, titleId)).title;
  const renamed = name !== (before.name_en ?? "");
  if (renamed) {
    const zhFollows = !before.name_zh || before.name_zh === before.name_en;
    await data.updateTitle(session, titleId, { name_en: name, ...(zhFollows ? { name_zh: name } : {}) });
  }

  const slug: DetailsResult["slug"] = { from: before.crazydramas_slug?.trim() || null, to: before.crazydramas_slug?.trim() || null, note: null };
  const wanted = deriveSlug(name);
  if (wanted && wanted !== slug.from) {
    const locked = await slugLockReason(titleId);
    if (locked) {
      slug.note = `the web address stays crazydramas.com/watch/${slug.from}: ${locked}`;
    } else {
      const sys = systemSession();
      const assign = (s: string) => assignCrazydramasSlug(sys, titleId, { slug: s, read: opts.slugRead, skipCheck: true });
      try {
        slug.to = (await assign(wanted)).slug;
      } catch (e) {
        const suggestion = isSlugError(e) && e.code === "slug_taken" ? (e.details.suggestion as string | null) : null;
        if (suggestion) {
          try {
            slug.to = (await assign(suggestion)).slug;
          } catch (again) {
            slug.note = `the web address stays ${slug.from ?? "unset"}: ${(again as Error).message}`;
          }
        } else {
          slug.note = `the web address stays ${slug.from ?? "unset"}: ${(e as Error).message}`;
        }
      }
    }
  }

  const series = renamed || opts.confirmLive ? await toSeries(session, titleId, { title: name }, opts) : { crazydramas: "no_series" as const, crazydramas_note: null, series_status: null };
  const after = (await data.getTitle(session, titleId)).title;
  return { title: shown(after), slug, ...series };
}

/** The picked image becomes the title's cover, then the poster of its own series (when it has one). */
export async function setTitlePoster(session: Session, titleId: string, bytes: Uint8Array, opts: SeriesOpts & { store?: PosterStore; encoder?: PosterEncoder } = {}): Promise<DetailsResult> {
  requireStaffSession(session);
  if (!bytes.length) throw new DataError("invalid", "the picked file is empty");
  if (bytes.length > POSTER_MAX_UPLOAD_BYTES) throw new DataError("invalid", `the picked file is over ${Math.round(POSTER_MAX_UPLOAD_BYTES / (1024 * 1024))} MB`);
  const ext = imageExt(bytes);
  if (ext !== ".jpg" && ext !== ".png" && ext !== ".webp") throw new DataError("invalid", "the poster must be a JPG, PNG or WebP image");
  const data = getData();
  const sys = systemSession();
  const title = (await data.getTitle(session, titleId)).title;
  const sha = createHash("sha256").update(bytes).digest("hex");
  const folder = title.source_ref?.split("/").pop() || title.crazydramas_slug || "title";
  const stored = localStoredPath(title.id, folder, `poster-${sha.slice(0, 8)}${ext}`);
  await putStoredBytes(stored, bytes, ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg");
  await data.putFilmAsset(sys, { title_id: title.id, kind: "poster", storage_path: stored, sha256: sha, bytes: bytes.length, origin: "studio", source_ref: null, meta: { from: "title-details" } });
  if (title.cover_path !== stored) await data.setTitleImport(sys, title.id, { cover_path: stored });

  let series: Pick<DetailsResult, "crazydramas" | "crazydramas_note" | "series_status">;
  if (!(await data.getPlatformLink(sys, titleId, PLATFORM))) {
    series = { crazydramas: "no_series", crazydramas_note: null, series_status: null };
  } else {
    try {
      const poster = await posterForTitle(session, titleId, { kind: "cover" }, { store: opts.store, encoder: opts.encoder });
      series = await toSeries(session, titleId, { poster_url: poster.poster_url }, opts);
    } catch (e) {
      series = { crazydramas: "not_sent", crazydramas_note: e instanceof Error ? e.message : String(e), series_status: null };
    }
  }
  const after = (await data.getTitle(session, titleId)).title;
  return { title: shown(after), slug: { from: after.crazydramas_slug ?? null, to: after.crazydramas_slug ?? null, note: null }, ...series };
}
