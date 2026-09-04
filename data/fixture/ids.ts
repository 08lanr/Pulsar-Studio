// Stable identifiers and the row builders the fixture files share.
//
// Every uuid is hand-constructed from a table block and an ordinal so the
// same row has the same id across reloads, tests and screenshots, and so a
// route can be hit by id in a demo. They are valid v4-shaped uuids (version
// nibble 4, variant nibble 8) but carry no randomness on purpose. External
// ids are derived from a deterministic hash so they look like the database's
// core.ext_id() output (prefix + 13 base32 characters) without being minted
// by hand one at a time.

import type {
  AdaptTag,
  AdaptedLine,
  AuthorKind,
  ChangeType,
  Character,
  Episode,
  Line,
  LineAlternative,
  Scene,
  SceneStatus,
} from "@/lib/types";

// ---- who and when ----------------------------------------------------------------

/** lib/auth.ts fixture personas. */
export const STAFF_USER_ID = "00000000-0000-4000-8000-0000000000f1";
export const PRODUCER_USER_ID = "00000000-0000-4000-8000-0000000000f2";
export const PRODUCER_ID = "00000000-0000-4000-8000-000000000001";

/** One timeline, so created_at / updated_at / job timestamps tell a coherent story. */
export const AT = {
  producer: "2026-08-20T06:00:00.000Z",
  title: "2026-08-24T02:10:00.000Z",
  ingest1: "2026-08-25T01:30:00.000Z",
  ingest2: "2026-08-25T01:42:00.000Z",
  ingest3: "2026-08-25T01:55:00.000Z",
  ingest4: "2026-08-25T02:01:00.000Z",
  understand: "2026-08-25T02:05:00.000Z",
  firstPass1: "2026-08-26T03:00:00.000Z",
  firstPass2: "2026-08-27T03:20:00.000Z",
  alternatives: "2026-08-28T08:15:00.000Z",
  edited: "2026-08-29T09:30:00.000Z",
  pack: "2026-08-30T05:10:00.000Z",
  clips: "2026-08-30T05:40:00.000Z",
  submitted: "2026-08-31T09:20:00.000Z",
  decided1: "2026-09-01T03:05:00.000Z",
  decided2: "2026-09-01T03:18:00.000Z",
  updated: "2026-09-02T07:40:00.000Z",
} as const;

export const MODEL = "claude-sonnet-4-5";
export const PROMPT_VERSION = "v1";

// ---- uuids -----------------------------------------------------------------------

/** `block` names the table, `n` the row; both hex-padded into a v4-shaped uuid. */
export function uuid(block: number, n: number): string {
  const b = block.toString(16).padStart(8, "0");
  const t = n.toString(16).padStart(12, "0");
  return `${b}-0000-4000-8000-${t}`;
}

const B = {
  title: 0x10,
  episode: 0x11,
  character: 0x20,
  scene: 0x21,
  line: 0x22,
  adaptation: 0x23,
  version: 0x24,
  adaptedLine: 0x25,
  alternative: 0x26,
  variant: 0x27,
  clip: 0x28,
  job: 0x29,
} as const;

export const TITLE_ID = uuid(B.title, 1);
export const ADAPTATION_ID = uuid(B.adaptation, 1);
export const episodeId = (n: number) => uuid(B.episode, n);
export const characterId = (n: number) => uuid(B.character, n);
export const sceneId = (ep: number, n: number) => uuid(B.scene, ep * 100 + n);
export const lineId = (ep: number, seq: number) => uuid(B.line, ep * 1000 + seq);
export const versionId = (ep: number, v: number) => uuid(B.version, ep * 100 + v);
export const adaptedLineId = (ep: number, v: number, seq: number) =>
  uuid(B.adaptedLine, v * 100000 + ep * 1000 + seq);
export const alternativeId = (ep: number, seq: number, k: number) =>
  uuid(B.alternative, ep * 10000 + seq * 10 + k);
export const variantId = (n: number) => uuid(B.variant, n);
export const clipId = (n: number) => uuid(B.clip, n);
export const jobId = (n: number) => uuid(B.job, n);

// ---- external ids -------------------------------------------------------------------

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** prefix + 13 base32 chars from a deterministic hash of `seed` (FNV-1a, then xorshift). */
export function ext(prefix: string, seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let x = h || 0x9e3779b9;
  let out = "";
  for (let i = 0; i < 13; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out += BASE32[x & 31];
  }
  return `${prefix}_${out}`;
}

// ---- episode builder -------------------------------------------------------------------

/**
 * One line of dialogue and, when the scene has a first pass, its adaptation.
 * Keeping zh and en on the same object is what makes the fixture readable as
 * a script rather than as two tables to cross-reference by seq.
 */
export type LineSpec = {
  /** Speaker as name_zh; resolved to a character row when one matches. */
  s: string;
  zh: string;
  /** literal_en, written by first_pass. */
  lit?: string;
  /** text_en. Omit when the scene has no first pass; null = cut. */
  en?: string | null;
  /** key_phrase_en: the substring of the English that carries the change. */
  key?: string;
  /** back_translation_zh; defaults to the source text for keep/literal lines. */
  bt?: string;
  type?: ChangeType;
  /** [rationale_zh, rationale_en] */
  why?: [string, string];
  /** [tone_note_zh, tone_note_en] */
  tone?: [string, string];
  tags?: AdaptTag[];
  major?: boolean;
  /** An editor overwrote the AI text: `en` becomes ai_text_en, this becomes text_en. */
  edited?: string;
  alts?: Array<{ en: string; bt: string; why: [string, string]; tags?: AdaptTag[] }>;
};

export type SceneSpec = {
  number: number;
  /** null when the episode is untimed. */
  start_ms: number | null;
  context_zh?: string;
  context_en?: string;
  status: SceneStatus;
  lines: LineSpec[];
};

export type BuiltEpisode = {
  episode: Episode;
  scenes: Scene[];
  lines: Line[];
  adapted_lines: AdaptedLine[];
  alternatives: LineAlternative[];
};

/** A rough syllable count from vowel groups; what the model would report. */
export function syllables(en: string | null | undefined): number | null {
  if (!en) return null;
  return (en.toLowerCase().match(/[aeiouy]+/g) ?? []).length;
}

const LINE_GAP_MS = 400;
const SCENE_GAP_MS = 4000;

function cueDuration(zh: string): number {
  return Math.min(4200, Math.max(1300, 500 + zh.length * 230));
}

type BuildOpts = {
  episode: Episode;
  characters: Character[];
  scenes: SceneSpec[];
  /** The version adapted lines belong to; omit for an ingest-only episode. */
  version?: { id: string; number: number; at: string; editedAt: string };
  alternativesJobId?: (seq: number) => string | null;
};

export function buildEpisode(o: BuildOpts): BuiltEpisode {
  const ep = o.episode.number;
  const byName = new Map(o.characters.map((c) => [c.name_zh, c.id]));
  const scenes: Scene[] = [];
  const lines: Line[] = [];
  const adapted: AdaptedLine[] = [];
  const alternatives: LineAlternative[] = [];
  let seq = 0;
  let cursor = 0;

  for (const sc of o.scenes) {
    const timed = o.episode.has_timecodes && sc.start_ms !== null;
    // The spec's start_ms is a floor: a scene never starts before the previous one ends plus a gap.
    if (timed) cursor = scenes.length ? Math.max(sc.start_ms as number, cursor + SCENE_GAP_MS) : (sc.start_ms as number);
    const sid = sceneId(ep, sc.number);
    const sceneStart = timed ? cursor : null;
    let sceneEnd: number | null = null;

    for (const l of sc.lines) {
      seq += 1;
      const start = timed ? cursor : null;
      const end = timed ? cursor + cueDuration(l.zh) : null;
      if (timed) {
        cursor = end as number;
        sceneEnd = end;
        cursor += LINE_GAP_MS;
      }
      const id = lineId(ep, seq);
      lines.push({
        id,
        external_id: ext("ln", `${ep}:${seq}`),
        title_id: o.episode.title_id,
        scene_id: sid,
        seq,
        speaker: l.s,
        character_id: byName.get(l.s) ?? null,
        start_ms: start,
        end_ms: end,
        duration_ms: start !== null && end !== null ? end - start : null,
        text_zh: l.zh,
        literal_en: l.lit ?? null,
        merged_into_id: null,
        created_at: o.episode.created_at,
      });

      if (o.version && l.en !== undefined) {
        const v = o.version;
        const type: ChangeType = l.type ?? (l.en === null ? "cut" : "rewrite");
        const isEdited = l.edited !== undefined;
        const text_en = isEdited ? (l.edited as string) : l.en;
        const authored_by: AuthorKind = isEdited ? "editor" : "ai";
        const bt =
          l.bt ?? (type === "keep" || type === "literal" ? l.zh : null);
        const alId = adaptedLineId(ep, v.number, seq);
        adapted.push({
          id: alId,
          external_id: ext("rw", `${ep}:${v.number}:${seq}`),
          title_id: o.episode.title_id,
          version_id: v.id,
          scene_id: sid,
          line_id: id,
          merges: [],
          seq,
          start_ms: start,
          end_ms: end,
          text_en,
          key_phrase_en: l.key ?? null,
          back_translation_zh: bt,
          change_type: type,
          is_major: l.major ?? false,
          rationale_zh: l.why?.[0] ?? null,
          rationale_en: l.why?.[1] ?? null,
          tone_note_zh: l.tone?.[0] ?? null,
          tone_note_en: l.tone?.[1] ?? null,
          tags: l.tags ?? [],
          syllables_est: syllables(text_en),
          authored_by,
          model: MODEL,
          prompt_version: PROMPT_VERSION,
          ai_text_en: l.en,
          ai_rationale_zh: l.why?.[0] ?? null,
          edited_by: isEdited ? STAFF_USER_ID : null,
          created_at: v.at,
          updated_at: isEdited ? v.editedAt : v.at,
        });

        l.alts?.forEach((a, i) => {
          alternatives.push({
            id: alternativeId(ep, seq, i + 1),
            external_id: ext("alt", `${ep}:${v.number}:${seq}:${i + 1}`),
            title_id: o.episode.title_id,
            version_id: v.id,
            adapted_line_id: alId,
            seq: i + 1,
            text_en: a.en,
            back_translation_zh: a.bt,
            rationale_zh: a.why[0],
            rationale_en: a.why[1],
            tags: a.tags ?? [],
            syllables_est: syllables(a.en),
            model: MODEL,
            prompt_version: PROMPT_VERSION,
            job_id: o.alternativesJobId?.(seq) ?? null,
            chosen: false,
            chosen_by: null,
            chosen_at: null,
            created_at: AT.alternatives,
          });
        });
      }
    }

    scenes.push({
      id: sid,
      external_id: ext("sc", `${ep}:${sc.number}`),
      title_id: o.episode.title_id,
      episode_id: o.episode.id,
      number: sc.number,
      start_ms: sceneStart,
      end_ms: sceneEnd,
      context_zh: sc.context_zh ?? null,
      context_en: sc.context_en ?? null,
      status: sc.status,
      status_by: sc.status === "approved" ? STAFF_USER_ID : null,
      status_at: sc.status === "approved" ? AT.edited : null,
      created_at: o.episode.created_at,
    });
  }

  const last = lines[lines.length - 1];
  const episode: Episode = {
    ...o.episode,
    duration_ms: o.episode.has_timecodes && last?.end_ms != null ? last.end_ms + 1500 : null,
  };
  return { episode, scenes, lines, adapted_lines: adapted, alternatives };
}

/** The cue at `seq` of a built episode (clip ranges are quoted from real cues). */
export function cueRange(built: BuiltEpisode, fromSeq: number, toSeq: number): { start_ms: number; end_ms: number } {
  const a = built.lines.find((l) => l.seq === fromSeq);
  const b = built.lines.find((l) => l.seq === toSeq);
  if (!a || !b || a.start_ms === null || b.end_ms === null) {
    throw new Error(`fixture: untimed cue range ${fromSeq}-${toSeq} in ep ${built.episode.number}`);
  }
  return { start_ms: a.start_ms, end_ms: b.end_ms };
}
