// A film run's settings (`film_runs.settings` jsonb): the one validator both
// backends apply at create time, and the narrated route's defaults (decision
// 2026-09-23 "Narrated mode in Studio"; narrated spec N2). The type lives in
// lib/types.ts (every layer reads it); this module is the rule set.
//
// Every key is optional on the row. A cut-only run reads the pipeline's own
// defaults for a missing one (lib/segment/stages.ts); a narrated run reads
// `resolveNarratedSettings`, which fills N2's defaults and folds in every
// `intake` decision, oldest first — the intake stage waits for what a new source
// cannot default (the sheet premise, the season), and the person's answer is
// a decision, never an edit of the row, so who set what stays on record.
//
// Unknown keys are kept as JSON (the pipeline grows settings between
// phases); a known key of the wrong shape is `invalid` in both backends.

import { invalid } from "@/lib/data/errors";
import type { FilmRun, FilmRunDecision, FilmRunSettings, Json, NarratedBriefOverrides, NarratedSeason } from "@/lib/types";

export type { FilmRunSettings, NarratedBriefOverrides, NarratedSeason };

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A season key and a prior project's folder: lowercase words joined by `-` or `_`; a prior project may sit one bucket deep (`high-quality/lbl-e05`). */
const SERIES_KEY = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const PROJECT_REF = /^(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\/)?_?[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
/** An ElevenLabs voice id: 20 alphanumerics today; anything key-shaped (`sk_…`, long) is refused so a key never lands on the row. */
const VOICE_ID = /^[A-Za-z0-9]{12,32}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/;

// ---- the narrated defaults (N2) -------------------------------------------------------------------------

export const NARRATED_DEFAULTS = {
  vision: "handoff" as const,
  threads: 2,
  creative: "session" as const,
  writer_model: "claude-opus-5-5",
  session_max_turns: 400,
  tts_model: "eleven_v3",
  tts_char_budget: 20_000,
  tts_episode_soft_cap: 3_000,
  episode_target: [165, 260] as [number, number],
  reframe_review: "optional" as const,
};

/** The bucket every narrated run lives in (amendment 4: new sources only, under `projects/high-quality/<slug>/`). */
export const NARRATED_BUCKET = "high-quality";

// ---- the validator ------------------------------------------------------------------------------------------

function num(out: FilmRunSettings, k: keyof FilmRunSettings, min: number, integer = false): void {
  const v = out[k];
  if (v === undefined || v === null) return;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || (integer && !Number.isInteger(v))) throw invalid(`settings.${String(k)} must be ${integer ? "an integer" : "a number"} >= ${min}`);
}

function text(v: unknown, what: string, max: number): void {
  if (v === undefined || v === null) return;
  if (typeof v !== "string" || v.length > max) throw invalid(`${what} must be text of at most ${max} characters`);
}

function pair(v: unknown, what: string): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0) || v[0] >= v[1]) throw invalid(`${what} must be [low, high] seconds with low < high`);
}

function validateSeason(v: unknown): void {
  if (v === undefined) return;
  if (!isPlainObject(v)) throw invalid("settings.season must be {series_key, first_episode_n, prior_projects}");
  if (typeof v.series_key !== "string" || !SERIES_KEY.test(v.series_key)) throw invalid("settings.season.series_key must be lowercase words joined by hyphens (love-between-lines)");
  if (typeof v.first_episode_n !== "number" || !Number.isInteger(v.first_episode_n) || v.first_episode_n < 1) throw invalid("settings.season.first_episode_n must be a whole number from 1");
  if (v.prior_projects !== undefined) {
    if (!Array.isArray(v.prior_projects) || !v.prior_projects.every((p) => typeof p === "string" && PROJECT_REF.test(p))) {
      throw invalid("settings.season.prior_projects must be project folders under the workspace (lbl-e04, high-quality/lbl-e05)");
    }
  }
  text(v.series_title, "settings.season.series_title", 120);
  if (v.title_source_ref !== undefined && v.title_source_ref !== null && (typeof v.title_source_ref !== "string" || !PROJECT_REF.test(v.title_source_ref))) {
    throw invalid("settings.season.title_source_ref must be the source ref of an imported title (love-between-lines)");
  }
}

/** A clean copy of the settings, or `invalid`: known keys typed, unknown keys kept as JSON. */
export function validateFilmRunSettings(settings: FilmRunSettings | null | undefined): FilmRunSettings {
  if (settings === null || settings === undefined) return {};
  if (!isPlainObject(settings)) throw invalid("settings must be an object");
  const out: FilmRunSettings = { ...(settings as FilmRunSettings) };
  num(out, "target_s", 1);
  num(out, "threads", 1);
  num(out, "to_s", 1);
  pair(out.band, "settings.band");
  for (const k of ["no_delogo", "allow_dirty", "claim_existing", "extend"] as const) {
    if (out[k] !== undefined && typeof out[k] !== "boolean") throw invalid(`settings.${k} must be a boolean`);
  }
  if (out.vision !== undefined && out.vision !== "api" && out.vision !== "handoff") throw invalid("settings.vision must be api or handoff");
  if (out.watermark_region !== undefined && out.watermark_region !== null && !/^\s*\d*\.?\d+\s*(,\s*\d*\.?\d+\s*){3}$/.test(String(out.watermark_region))) {
    throw invalid("settings.watermark_region must be x0,y0,x1,y1 fractions");
  }

  // The narrated route's keys (N2).
  for (const k of ["reader_model", "writer_model"] as const) {
    const v = out[k];
    if (v !== undefined && v !== null && (typeof v !== "string" || !MODEL_ID.test(v))) throw invalid(`settings.${k} must be a model id`);
  }
  if (out.creative !== undefined && out.creative !== "session" && out.creative !== "handoff") throw invalid("settings.creative must be session or handoff");
  num(out, "session_max_turns", 1, true);
  text(out.sheet_premise, "settings.sheet_premise", 8000);
  text(out.narrator, "settings.narrator", 80);
  if (out.voice_id !== undefined && out.voice_id !== null && (typeof out.voice_id !== "string" || !VOICE_ID.test(out.voice_id))) {
    throw invalid("settings.voice_id must be an ElevenLabs voice id (never a key)");
  }
  if (out.tts_model !== undefined && (typeof out.tts_model !== "string" || !MODEL_ID.test(out.tts_model))) throw invalid("settings.tts_model must be an ElevenLabs model id (eleven_v3)");
  num(out, "tts_char_budget", 0, true);
  num(out, "tts_episode_soft_cap", 0, true);
  validateSeason(out.season);
  text(out.source_label, "settings.source_label", 40);
  pair(out.episode_target, "settings.episode_target");
  if (out.scan !== undefined) {
    const s = out.scan as unknown;
    if (!isPlainObject(s) || typeof s.t0 !== "number" || !Number.isFinite(s.t0) || s.t0 < 0 || (s.t1 !== null && s.t1 !== undefined && (typeof s.t1 !== "number" || !Number.isFinite(s.t1) || s.t1 <= s.t0))) {
      throw invalid("settings.scan must be {t0, t1} seconds with t0 >= 0 and t1 after t0 (t1 null = the source's length)");
    }
  }
  if (out.intro !== undefined && out.intro !== null) {
    const i = out.intro as unknown;
    if (!isPlainObject(i) || typeof i.src !== "string" || !i.src.trim() || typeof i.ss !== "number" || i.ss < 0 || typeof i.t !== "number" || i.t <= 0) {
      throw invalid("settings.intro must be {src, ss, t}: the title card's source shot");
    }
  }
  if (out.reframe_review !== undefined && out.reframe_review !== "optional" && out.reframe_review !== "required") throw invalid("settings.reframe_review must be optional or required");
  if (out.deliver_to !== undefined && out.deliver_to !== null) throw invalid("settings.deliver_to must be null: Studio never writes deliver_to.txt (no OneDrive copy from a Studio build)");
  if (out.brief !== undefined) {
    const b = out.brief as unknown;
    if (!isPlainObject(b)) throw invalid("settings.brief must be {names, worked_example, scripts}");
    text(b.names, "settings.brief.names", 8000);
    text(b.worked_example, "settings.brief.worked_example", 2000);
    text(b.scripts, "settings.brief.scripts", 500);
  }
  return JSON.parse(JSON.stringify(out)) as FilmRunSettings;
}

// ---- the narrated settings a stage reads ------------------------------------------------------------------------

/** What every narrated stage reads: N2's defaults filled in, the intake answer folded over the row. */
export type NarratedSettings = {
  vision: "api" | "handoff";
  threads: number;
  reader_model: string | null;
  creative: "session" | "handoff";
  writer_model: string;
  session_max_turns: number;
  sheet_premise: string | null;
  narrator: string | null;
  voice_id: string | null;
  tts_model: string;
  tts_char_budget: number;
  tts_episode_soft_cap: number;
  season: { series_key: string | null; first_episode_n: number | null; prior_projects: string[]; series_title: string | null; title_source_ref: string | null };
  source_label: string | null;
  episode_target: [number, number];
  scan: { t0: number; t1: number | null };
  intro: { src: string; ss: number; t: number } | null;
  reframe_review: "optional" | "required";
  brief: { names: string | null; worked_example: string | null; scripts: string | null };
  allow_dirty: boolean;
};

/**
 * Lay `over` on `under`: key by key, `season` and `brief` one level deep (a
 * list inside them, like `prior_projects`, is replaced whole). Pure.
 */
export function foldSettings(under: FilmRunSettings, over: FilmRunSettings): FilmRunSettings {
  const out: FilmRunSettings = { ...under, ...over };
  for (const k of ["season", "brief"] as const) {
    const a = under[k] as unknown;
    const b = over[k] as unknown;
    if (isPlainObject(a) && isPlainObject(b)) (out as Record<string, unknown>)[k] = { ...a, ...b };
  }
  return out;
}

/**
 * Every intake decision's `settings` (`{kind: "intake", settings}`), folded
 * oldest to newest: each answer adds to the ones before it (the season and
 * the premise first, a raised `tts_char_budget` later), a later key wins key
 * by key, `season` and `brief` merge one level deep. Each answer is checked
 * over what came before it and `base` (the row's settings, so a season
 * answer may name only the number the intake asked for): an invalid one is
 * skipped, never a reason to drop the valid ones. {} when there is none.
 */
export function intakePatch(decisions: readonly FilmRunDecision[], base: FilmRunSettings = {}): FilmRunSettings {
  let acc: FilmRunSettings = {};
  for (const d of decisions) {
    if (d.action !== "intake") continue;
    const data = d.data;
    const patch = isPlainObject(data) && isPlainObject((data as Record<string, unknown>).settings) ? ((data as Record<string, unknown>).settings as FilmRunSettings) : null;
    if (!patch) continue;
    const next = foldSettings(acc, patch);
    try {
      validateFilmRunSettings(foldSettings(base, next));
    } catch {
      continue;
    }
    acc = JSON.parse(JSON.stringify(next)) as FilmRunSettings;
  }
  return acc;
}

const str = (v: Json | undefined): string | null => (typeof v === "string" && v.trim() ? v : null);

/** N2's defaults over the row's settings and every intake answer folded (a later answer wins key by key; `season` and `brief` merge one level deep). */
export function resolveNarratedSettings(run: Pick<FilmRun, "settings" | "decisions">): NarratedSettings {
  const patch = intakePatch(run.decisions ?? [], run.settings ?? {});
  const s: FilmRunSettings = { ...(run.settings ?? {}), ...patch };
  const seasonRow = (isPlainObject(run.settings?.season) ? run.settings.season : {}) as Partial<NarratedSeason>;
  const seasonPatch = (isPlainObject(patch.season) ? patch.season : {}) as Partial<NarratedSeason>;
  const season = { ...seasonRow, ...seasonPatch };
  const briefRow = (isPlainObject(run.settings?.brief) ? run.settings.brief : {}) as NarratedBriefOverrides;
  const briefPatch = (isPlainObject(patch.brief) ? patch.brief : {}) as NarratedBriefOverrides;
  const brief = { ...briefRow, ...briefPatch };
  const scan = isPlainObject(s.scan) ? (s.scan as { t0: number; t1: number | null }) : { t0: 0, t1: null };
  return {
    vision: s.vision === "api" ? "api" : NARRATED_DEFAULTS.vision,
    threads: typeof s.threads === "number" ? s.threads : NARRATED_DEFAULTS.threads,
    reader_model: str(s.reader_model),
    creative: s.creative === "handoff" ? "handoff" : NARRATED_DEFAULTS.creative,
    writer_model: str(s.writer_model) ?? NARRATED_DEFAULTS.writer_model,
    session_max_turns: typeof s.session_max_turns === "number" ? s.session_max_turns : NARRATED_DEFAULTS.session_max_turns,
    sheet_premise: str(s.sheet_premise),
    narrator: str(s.narrator),
    voice_id: str(s.voice_id),
    tts_model: str(s.tts_model) ?? NARRATED_DEFAULTS.tts_model,
    tts_char_budget: typeof s.tts_char_budget === "number" ? s.tts_char_budget : NARRATED_DEFAULTS.tts_char_budget,
    tts_episode_soft_cap: typeof s.tts_episode_soft_cap === "number" ? s.tts_episode_soft_cap : NARRATED_DEFAULTS.tts_episode_soft_cap,
    season: {
      series_key: typeof season.series_key === "string" ? season.series_key : null,
      first_episode_n: typeof season.first_episode_n === "number" ? season.first_episode_n : null,
      prior_projects: Array.isArray(season.prior_projects) ? season.prior_projects.filter((p): p is string => typeof p === "string") : [],
      series_title: typeof season.series_title === "string" && season.series_title.trim() ? season.series_title : null,
      title_source_ref: typeof season.title_source_ref === "string" && season.title_source_ref.trim() ? season.title_source_ref : null,
    },
    source_label: str(s.source_label),
    episode_target: Array.isArray(s.episode_target) && s.episode_target.length === 2 ? [Number(s.episode_target[0]), Number(s.episode_target[1])] : NARRATED_DEFAULTS.episode_target,
    scan: { t0: typeof scan.t0 === "number" ? scan.t0 : 0, t1: typeof scan.t1 === "number" ? scan.t1 : null },
    intro: isPlainObject(s.intro) ? (s.intro as { src: string; ss: number; t: number }) : null,
    reframe_review: s.reframe_review === "required" ? "required" : NARRATED_DEFAULTS.reframe_review,
    brief: { names: str(brief.names ?? undefined), worked_example: str(brief.worked_example ?? undefined), scripts: str(brief.scripts ?? undefined) },
    allow_dirty: s.allow_dirty === true,
  };
}

/**
 * What a new source cannot default, in the words the intake's wait shows:
 * the sheet premise (the minute-sheet readers need the cast, place and era)
 * and the season's key and first number (numbering is continuous and unique
 * per key). The voice defaults from a prior project's manifest, so it is
 * missing only when there is none (`voiceFromPrior` null).
 */
export function missingNarratedSettings(s: NarratedSettings, voiceFromPrior: string | null): string[] {
  const out: string[] = [];
  if (!s.sheet_premise) out.push("sheet_premise");
  if (!s.season.series_key) out.push("season.series_key");
  if (s.season.first_episode_n === null) out.push("season.first_episode_n");
  if (!s.voice_id && !voiceFromPrior) out.push("voice_id");
  return out;
}

/** `S01E05` from a source file name (`…s01e05….mp4`), else null. */
export function sourceLabelOf(sourcePath: string): string | null {
  const m = /s(\d{1,2})e(\d{1,3})/i.exec(sourcePath.replace(/\\/g, "/").split("/").pop() ?? "");
  return m ? `S${m[1].padStart(2, "0")}E${m[2].padStart(2, "0")}` : null;
}
