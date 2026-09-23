// The film index: what the mini-drama-system pipeline leaves in a film's
// `cut/` folder, typed as it really is on disk (decision 2026-09-22, "the
// workspace import"; shapes recorded from the three delivered films on
// 2026-09-23). Pure types, no runtime: the zod parsers in ./manifest.ts
// produce these, the scanner in ./scan.ts reports against them, and the
// data layer and the import job read them without pulling zod in.
//
// Film time is always seconds from the start of the stitched source film.
// Field names follow the pipeline's own files, not the build spec, where the
// two differ (the plan file carries `source_duration`, `target`, `band`,
// `pinned`, `pin_from`, `moves`, `final_end_is_boundary` beside `episodes`;
// a vision verdict carries `fault`, `better_key`, `better_t`; a candidate
// carries `exception` on an `--allow` cut, and the file lists `allowed`).

// ---- review/cuts-0-<end>-DELIVERED.json ---------------------------------------------------

/** One planned episode: `[start, end)` in film time; `dur` is the pipeline's own rounding of end - start. */
export type DeliveredEpisode = {
  n: number;
  start: number;
  end: number;
  dur: number;
  ends_after_line: string;
  next_opens_on: string;
};

/**
 * The delivered plan (`review/cuts-0-<end>-DELIVERED.json`). The newest by
 * numeric `<end>` is the one that counts (Mafia King keeps 0-1800,
 * 0-1936.533 and 0-5959.067 side by side). The first delivery of a film
 * (cuts-0-1800) has no `fps`, `pinned`, `pin_from`, `moves` or
 * `final_end_is_boundary`; later ones do.
 */
export type DeliveredPlan = {
  source_duration: number;
  target: number;
  fps: number | null;
  band: [number, number];
  pinned: number | null;
  pin_from: string | null;
  moves: unknown[];
  final_end_is_boundary: boolean | null;
  episodes: DeliveredEpisode[];
};

// ---- index/ ----------------------------------------------------------------------------------

/** One whisper word: the text keeps its leading space, `s`/`e` in film seconds, `p` the probability. */
export type WhisperWord = { w: string; s: number; e: number; p: number };

export type WhisperSegment = { start: number; end: number; text: string; words: WhisperWord[] };

/** `index/whisper.json`: faster-whisper medium over the whole film (1,631 / 1,115 / 2,535 segments on the three films). */
export type WhisperIndex = {
  language: string;
  duration: number;
  model: string;
  threads: number | null;
  segments: WhisperSegment[];
};

/** `index/motion.json` beat: a burst of motion energy above the film's threshold, at 10 fps. */
export type MotionBeat = { t: number; energy: number };

/** `index/motion.json`; `track` (one energy value per 0.1 s) is kept when present, it is large. */
export type MotionIndex = {
  fps: number;
  width: number | null;
  from: number | null;
  to: number | null;
  threshold: number;
  percentile: number | null;
  beats: MotionBeat[];
  track: number[] | null;
};

/** `index/candidates.json` row: a legal cut point with what surrounds it. `exception` marks an `--allow` cut. */
export type CutCandidate = {
  t: number;
  in_action: boolean;
  motion: number;
  since_action: number;
  until_action: number;
  action_energy: number;
  gap_before: number;
  gap_after: number;
  settle: number;
  line_before: string;
  line_after: string;
  line_before_end: number;
  line_after_start: number;
  exception: string | null;
};

/** `index/candidates.json`. `allowed` lists the `--allow` exceptions (absent on films indexed before that flag existed). */
export type CandidatesIndex = {
  source_whisper: string | null;
  shot_cuts: number;
  legal: number;
  rejected: Record<string, number>;
  min_clear: number;
  allowed: { t: number; why: string }[];
  beats_used: number | null;
  candidates: CutCandidate[];
};

/** `index/source.json`: what ffprobe measured on the source film. */
export type SourceFacts = {
  source: string | null;
  fps: number;
  width: number;
  height: number;
  duration: number;
};

// ---- review/vision/*.json --------------------------------------------------------------------

/** The reviewer's pick for one boundary: the option key and time it chose, what the episode ends and opens on. */
export type VisionPick = {
  chosen_key: string;
  chosen_t: number;
  ends_on: string;
  opens_on: string;
  why: string;
  payoff_in_episode: boolean;
  confidence: number;
  rejected: string | null;
};

/** The skeptic's verdict. `better_t` is set when it disagrees and names a time; `fault` may be an empty string. */
export type VisionVerdict = {
  agree: boolean;
  reason: string;
  fault: string | null;
  better_key: string | null;
  better_t: number | null;
};

/** One judged boundary; `source_file` names the record file it came from. */
export type VisionBoundary = {
  boundary_s: number;
  pick: VisionPick;
  verdict: VisionVerdict | null;
  source_file: string;
};

/** How a delivered boundary was decided (which of the pipeline's records explains it). */
export type BoundaryDecision =
  /** The reviewer's `chosen_t` is the delivered end. */
  | "chosen"
  /** The skeptic's `better_t` is the delivered end (apply_vision took the override). */
  | "skeptic"
  /** A band-fix note moved it here (a person re-judged the pair; not a first-pass vision pick). */
  | "band_fix"
  /** No record explains this end. */
  | "none";

/** One delivered episode end, with the record that explains it. */
export type BoundaryNote = {
  /** The episode this boundary ends. */
  n: number;
  /** Film time of the boundary (= the episode's planned end). */
  end: number;
  decision: BoundaryDecision;
  vision: VisionBoundary | null;
  /** The band-fix paragraph that names this boundary, when one does. */
  band_fix_note: string | null;
};

// ---- cut/film-meta.json (hand-written) -------------------------------------------------------

/** A film window an ad may never use. `kind` is a free label (stinger, recap, card, ...). */
export type FilmMetaExclusion = {
  from_s: number;
  to_s: number;
  why: string;
  kind: string | null;
};

/** The one hand-written file per film (decision 2026-09-22): what the pipeline cannot know. */
export type FilmMeta = {
  display_title_en: string;
  /** The series' own title, when it differs from the crazydramas one. */
  source_title_en: string | null;
  crazydramas_slug: string | null;
  language: string;
  /** Film time from which every moment is a spoiler; the seed writes 50% of the runtime. */
  spoiler_from_s: number | null;
  exclusions: FilmMetaExclusion[];
  /** The live crazydramas poster's file stem under `poster/final/` (for example `forced-to-marry-c`). */
  live_poster: string | null;
  notes: string | null;
};

// ---- the whole index of one film -------------------------------------------------------------

/** Everything the import and the ad engine read for a film, parsed. Absent files are null; a present but invalid one is a problem. */
export type FilmIndex = {
  /** `<group>/<film>` under WORKSPACE_ROOT, forward slashes. */
  source_ref: string;
  delivered: DeliveredPlan;
  /** `review/<file>` of the plan that was used. */
  delivered_file: string;
  /** SHA-256 (hex) of that plan file's bytes: the import's idempotency key and the K_CHANGED test. */
  delivered_sha256: string;
  whisper: WhisperIndex | null;
  /** `index/scdet.txt`: shot-cut times in film seconds, ascending. Null when the file is absent. */
  shot_cuts: number[] | null;
  motion: MotionIndex | null;
  candidates: CandidatesIndex | null;
  source: SourceFacts | null;
  /** Every judged boundary from `review/vision/*.json`, superseded files skipped, deduped by `chosen_t`. */
  vision: VisionBoundary[];
  /** The band-fix `.md` notes, whole. */
  band_fix_notes: string[];
  /** One note per delivered episode end (episodes 1..N-1; the final end is the end of the film). */
  boundaries: BoundaryNote[];
  meta: FilmMeta | null;
  /** `poster/final/*.jpg|png` as source refs, sorted by name. */
  posters: string[];
  /** Files that were present but could not be read as what they should be (a reason each). */
  problems: string[];
};

// ---- the scanner's report --------------------------------------------------------------------

/**
 * READY | RENDERING | NOT_DELIVERED | NO_MANIFEST come from the disk alone;
 * IMPORTED and K_CHANGED are decided by the caller from what it has stored
 * (`applyImportState` in ./scan.ts).
 */
export type FilmScanState = "READY" | "RENDERING" | "NOT_DELIVERED" | "NO_MANIFEST" | "K_CHANGED" | "IMPORTED";

/** Why a film is not READY, as a code the UI can put into words, plus the facts. */
export type ScanReason =
  /** The folder has no `cut/` (a narrated project, or one that never started). */
  | { code: "no_cut_dir" }
  /** No `review/cuts-0-*-DELIVERED.json`. */
  | { code: "no_delivered" }
  /** The newest plan file does not parse. */
  | { code: "bad_delivered"; file: string; detail: string }
  /** A render is writing this file now. */
  | { code: "part_file"; file: string }
  /** Something in `eps/` was written less than `quietMs` ago (a render may be between files). */
  | { code: "recent_write"; file: string; seconds_ago: number }
  /** `eps/` is missing or holds no `epNN.mp4`. */
  | { code: "no_episode_files" }
  /** The `epNN.mp4` files are not exactly 1..N. */
  | { code: "episode_gap"; missing: number[]; duplicates: number[] }
  /** N differs from the plan's episode count. */
  | { code: "count_mismatch"; planned: number; found: number }
  /** A file is a cloud placeholder (OneDrive online-only): its bytes are not on disk. */
  | { code: "placeholder"; file: string }
  /** The film was imported and its plan has not changed since. */
  | { code: "imported" }
  /** The plan (or its file) changed since the import. */
  | { code: "plan_changed" }
  /** The plan is the same but these episodes' files changed size since the import (a re-render). */
  | { code: "files_changed"; episodes: number[] };

/** One `epNN.mp4` in `cut/eps/`: file facts only (the plan's window is in `delivered`). */
export type ScannedEpisode = {
  n: number;
  /** `<source_ref>/cut/eps/epNN.mp4`. */
  file: string;
  name: string;
  bytes: number;
  mtime_ms: number;
};

/** Pixel size and frame rate, from `index/source.json` or from ffprobe of one hardlinked sample. */
export type ScannedVideo = {
  width: number;
  height: number;
  fps: number;
  duration_s: number | null;
  from: "source.json" | "probe";
};

export type FilmScan = {
  source_ref: string;
  /** The folder name (`mafia-king`). */
  folder: string;
  display_title: string;
  state: FilmScanState;
  reason: ScanReason | null;
  episodes: ScannedEpisode[];
  /** The newest plan by numeric end, when one parses. */
  delivered: { file: string; end: number; count: number; sha256: string; plan: DeliveredPlan } | null;
  totals: { count: number; bytes: number };
  video: ScannedVideo | null;
  language: string | null;
  /** The live poster (film-meta `live_poster`), else the first under `poster/final/`, as a source ref. */
  poster: string | null;
  posters: string[];
  meta: FilmMeta | null;
  /** Files in `eps/` that are neither `epNN.mp4` nor a `.part` render. */
  ignored: string[];
  /** Non-fatal findings (an invalid film-meta.json, a probe that failed). */
  warnings: string[];
};

// ---- the file system the scanner and the loader read through ----------------------------------

export type ScanDirent = { name: string; kind: "dir" | "file" | "symlink" | "other" };

export type ScanStat = {
  size: number;
  mtime_ms: number;
  /** 512-byte blocks allocated (libuv fills it from the allocation size on Windows); null when unknown. */
  blocks: number | null;
  is_directory: boolean;
};

/**
 * What the scanner needs from a file system, so a test can point it at a
 * temp dir or a fake. `readdir` reports a junction as `symlink`; `stat`
 * follows links and answers null for a missing path; `realpath` resolves
 * junctions (`fs.realpathSync.native` on Windows). `link` is a hardlink and
 * may throw across volumes; `copy` is the fallback.
 */
export interface ScanFs {
  readdir(dir: string): Promise<ScanDirent[]>;
  stat(path: string): Promise<ScanStat | null>;
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  link(src: string, dst: string): Promise<void>;
  copy(src: string, dst: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}
