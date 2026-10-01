// Ad types (decision 2026-09-25, "Ad types on clips"). Every clip — a
// finished ad Ruobin uploads, a 60-second ad, a window the cutter made — may
// say what KIND of ad it is, so the library and later the results can be read
// by type ("this is a hook ad"). The field is optional everywhere: null means
// nobody has classified the clip yet, never a guess.
//
// This is not the launch angle (lib/angles.ts: how an ad is produced and what
// budget it reserves) and not the clip's `moment` / `source` (how the cutter
// chose a window and where the bytes came from). It is the person's label.
//
// The ids are also the check constraint of studio.clips.ad_format
// (supabase/migrations/0023_clip_ad_format.sql, 0024_quick_hook_ads.sql);
// change them together.
//
// The quick hook ad (decision 2026-10-01, "Quick hook ads") replaces the hook
// ad: Ruobin, "this replaces hook ads in drama remix. they aren't doing well
// anyways". `hook_ad` stays a valid label so the ads already filed under it
// keep their type and their results, but it is no longer offered for a new
// ad (`AD_FORMAT_CHOICES`).

export const AD_FORMATS = ["hook_ad", "narration_trailer", "direct_cuts_trailer", "clip", "quick_hook"] as const;

export type AdFormat = (typeof AD_FORMATS)[number];

export type AdFormatInfo = {
  id: AdFormat;
  /** Locale keys (locales/_keys/ad-format.json): `adFormat.<id>` and `adFormat.<id>.desc`. */
  label_en: string;
  description_en: string;
};

export const AD_FORMAT_INFO: Record<AdFormat, AdFormatInfo> = {
  hook_ad: {
    id: "hook_ad",
    label_en: "Hook ad",
    description_en: "Retired (replaced by the quick hook ad): one whole scene of the film, played as it is (15-60 s).",
  },
  narration_trailer: {
    id: "narration_trailer",
    label_en: "Narration trailer",
    description_en: "The heroine narrates the plot in first person over the film, with one or two kept dialogue scenes.",
  },
  direct_cuts_trailer: {
    id: "direct_cuts_trailer",
    label_en: "Direct-cuts trailer",
    description_en: "The same story spine as the narration trailer, carried by the characters' own lines, no narrator.",
  },
  clip: {
    id: "clip",
    label_en: "Clip",
    description_en: "A window cut from one episode (what Studio's own cutter makes).",
  },
  quick_hook: {
    id: "quick_hook",
    label_en: "Quick hook ad",
    description_en: "The most gripping 2-3 seconds of the story first, then the scene that leads up to it, cut before the payoff, with a line of text on screen.",
  },
};

/** The types a person may choose for an ad now: every type but the retired hook ad (a clip that has it keeps it). */
export const AD_FORMAT_CHOICES: readonly AdFormat[] = AD_FORMATS.filter((f) => f !== "hook_ad");

export function isAdFormat(value: unknown): value is AdFormat {
  return typeof value === "string" && (AD_FORMATS as readonly string[]).includes(value);
}

/**
 * studio.clips.ad_format arrives with migration 0023. On a database without it
 * PostgREST answers PGRST204 ("Could not find the 'ad_format' column of
 * 'clips' in the schema cache") and Postgres 42703 ("column ... does not
 * exist"); lib/data/supabase.ts turns either into AD_FORMAT_MIGRATION_MESSAGE.
 */
export function adFormatColumnMissing(error: { code?: string | null; message?: string | null }): boolean {
  const message = error.message ?? "";
  return (error.code === "PGRST204" || error.code === "42703" || /column/i.test(message)) && /ad_format/.test(message);
}

/** A database with 0023 but not 0024 refuses `quick_hook` by its check constraint (Postgres 23514). */
export function quickHookFormatRefused(error: { code?: string | null; message?: string | null }): boolean {
  return error.code === "23514" && /clips_ad_format_check/.test(error.message ?? "");
}

export const QUICK_HOOK_MIGRATION_MESSAGE =
  "this database does not know the quick hook ad yet: apply supabase/migrations/0024_quick_hook_ads.sql once (paste it into the Supabase SQL editor), then try again";

export const AD_FORMAT_MIGRATION_MESSAGE =
  "this database has no studio.clips.ad_format column yet: apply supabase/migrations/0023_clip_ad_format.sql once (paste it into the Supabase SQL editor), then try again";
