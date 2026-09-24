// The 60-second ad (decision 2026-09-24, the overnight spec's item 16): a
// hook, two to four strong scenes and a cliff, taken from the title's own
// clips (script-ranked by find_clips, or picked from the footage) and joined
// in story order with hard cuts into one 9:16 file of at most 60.0 s. This
// file is the pick and the arithmetic, pure and unit-tested; the render is
// lib/clips/montage-render.ts and the build lib/clips/montage-run.ts.
//
// The pick, in plain words (Ruobin improves it himself; it is meant to be
// clean, not clever):
// - Only what an ad may show: a clip's window stops at the title's spoiler
//   line (ad_rules.spoiler_from_s, film time) and skips its exclusions (the
//   cards and stingers film-meta lists); a title without a spoiler line
//   keeps its last fifth of episodes out, as the series text does.
// - The hook is the title's opening clip (find_clips' trailer-style tease),
//   else the strongest clip of the earliest episode, cut to its first 8 s.
// - The cliff is the strongest clip of the last episode that still has one,
//   cut to its last 10 s (a clip's end is where find_clips closed the
//   moment); when that leaves too little between hook and cliff, a later
//   window is taken instead.
// - The scenes (two to four) sit between the two: the strongest clips
//   (rank 1 of their episode first) nearest to evenly spaced points of the
//   story, each from its own start, sharing what the hook and the cliff
//   leave of the 60 s.
// - No piece cuts through a spoken line when a gap is near: an end that
//   falls inside a line moves back to where the line starts, a start inside
//   one moves on to where it ends.
// Nothing is added to the picture and there is no poster or end card
// (decision 2026-09-22): the ad ends on the cliff's last frame.

import type { AdRules, Clip, ClipSource, MontagePiece, MontageRole } from "@/lib/types";

/** The ceiling: the finished file holds at most this much, to the frame. */
export const MONTAGE_MAX_MS = 60_000;
/** Montage rows rank from here up within their hook's episode (studio.clips is unique on episode × rank). */
export const MONTAGE_RANK_BASE = 1001;

export type MontageOptions = {
  /** The whole ad, at most. */
  maxMs: number;
  /** The hook's longest cut, from its clip's start. */
  hookMs: number;
  /** The cliff's longest cut, up to its clip's end. */
  cliffMs: number;
  /** A scene slot is not opened for less than this (a shorter clip still fills its slot whole). */
  sceneMinMs: number;
  sceneMaxMs: number;
  /** A window shorter than this is not a moment. */
  minPieceMs: number;
  scenesMin: number;
  scenesMax: number;
  /** Without a spoiler line, this share of the last episodes stays out of the ad. */
  endingShare: number;
};

export const MONTAGE_DEFAULTS: MontageOptions = {
  maxMs: MONTAGE_MAX_MS,
  hookMs: 8_000,
  cliffMs: 10_000,
  sceneMinMs: 4_000,
  sceneMaxMs: 20_000,
  minPieceMs: 1_500,
  scenesMin: 2,
  scenesMax: 4,
  endingShare: 0.2,
};

export type MontageCue = { start_ms: number; end_ms: number };

export type MontageEpisode = {
  id: string;
  number: number;
  has_video: boolean;
  duration_ms: number | null;
  /** The episode's place in the film (film time), when it was imported; the spoiler line and the exclusions need it. */
  film_start_ms: number | null;
  /** The spoken lines, episode time. */
  cues: MontageCue[];
};

export type MontageClip = Pick<Clip, "id" | "external_id" | "episode_id" | "rank" | "start_ms" | "end_ms" | "hook_en" | "status" | "moment" | "source">;

export type MontageInput = { episodes: MontageEpisode[]; clips: MontageClip[]; rules: AdRules | null };

export type MontagePlan = {
  pieces: MontagePiece[];
  duration_ms: number;
  /** The ad's text: the hook clip's own, else the first piece's that has one ("" from footage). */
  hook_en: string;
  /** `script` when every piece came from a script-ranked clip. */
  source: ClipSource;
  /** The episodes it draws on, in story order, once each. */
  episodes: number[];
  /** A short fingerprint of the pieces: the same pick is the same build. */
  key: string;
};

export type MontageRefusalCode = "no_clips" | "too_few";
export type MontageRefusal = { code: MontageRefusalCode; message: string; usable: number; held_back: number };
export type MontagePlanResult = ({ ok: true } & MontagePlan) | ({ ok: false } & MontageRefusal);

type Window = { clip: MontageClip; episode: MontageEpisode; start: number; end: number };

const STORY = 1e9; // episode number × this + ms: story order across episodes
const storyOf = (w: { episode: MontageEpisode }, ms: number) => w.episode.number * STORY + ms;

/** The part of a clip an ad may use, or why none: `held` = past the spoiler line or inside an exclusion. */
function usableWindow(clip: MontageClip, episode: MontageEpisode, rules: AdRules | null, lastEpisode: number, o: MontageOptions): { start: number; end: number } | "held" | null {
  let start = Math.max(0, clip.start_ms);
  let end = clip.end_ms;
  if (episode.duration_ms && episode.duration_ms > 0) end = Math.min(end, episode.duration_ms);
  if (end - start < o.minPieceMs) return null;
  const filmStart = episode.film_start_ms;
  const spoiler = rules?.spoiler_from_s != null && filmStart != null ? rules.spoiler_from_s * 1000 - filmStart : null;
  if (spoiler !== null) {
    if (spoiler - start < o.minPieceMs) return "held";
    end = Math.min(end, spoiler);
  } else if (episode.number > lastEpisode) return "held";
  let parts: Array<[number, number]> = [[start, end]];
  if (filmStart != null) {
    for (const x of rules?.exclusions ?? []) {
      const a = x.from_s * 1000 - filmStart;
      const b = x.to_s * 1000 - filmStart;
      parts = parts.flatMap(([s, e]): Array<[number, number]> => (b <= s || a >= e ? [[s, e]] : [[s, Math.min(e, a)], [Math.max(s, b), e]].filter(([p, q]) => q > p) as Array<[number, number]>));
    }
  }
  const best = parts.sort((p, q) => q[1] - q[0] - (p[1] - p[0]) || p[0] - q[0])[0];
  if (!best || best[1] - best[0] < o.minPieceMs) return "held";
  [start, end] = best;
  return { start, end };
}

/** An end inside a spoken line moves back to where the line starts, when the piece keeps at least `min`. */
export function snapEnd(start: number, end: number, cues: readonly MontageCue[], min: number): number {
  const cut = cues.find((c) => c.start_ms < end && end < c.end_ms);
  return cut && cut.start_ms - start >= min ? cut.start_ms : end;
}

/** A start inside a spoken line moves on to where the line ends, when the piece keeps at least `min`. */
export function snapStart(start: number, end: number, cues: readonly MontageCue[], min: number): number {
  const cut = cues.find((c) => c.start_ms < start && start < c.end_ms);
  return cut && end - cut.end_ms >= min ? cut.end_ms : start;
}

type Span = { episode_id: string; start: number; end: number };

/** The first stretch of a window between two story positions and outside every taken span of its episode, at least `min` long. */
function freePart(w: Window, lo: number, hi: number, taken: readonly Span[], min: number): Span | null {
  const base = w.episode.number * STORY;
  let parts: Array<[number, number]> = [[Math.max(w.start, lo - base), Math.min(w.end, hi - base)]];
  for (const t of taken) {
    if (t.episode_id !== w.episode.id) continue;
    parts = parts.flatMap(([s, e]): Array<[number, number]> => (t.end <= s || t.start >= e ? [[s, e]] : ([[s, Math.min(e, t.start)], [Math.max(s, t.end), e]] as Array<[number, number]>).filter(([p, q]) => q > p)));
  }
  const ok = parts.find(([s, e]) => e - s >= min);
  return ok ? { episode_id: w.episode.id, start: ok[0], end: ok[1] } : null;
}

function piece(w: Window, role: MontageRole, start: number, end: number, o: MontageOptions): MontagePiece {
  const min = Math.max(o.minPieceMs, Math.round((end - start) * 0.6));
  const e = snapEnd(start, end, w.episode.cues, min);
  const s = snapStart(start, e, w.episode.cues, min);
  return { role, clip_id: w.clip.id, clip_external_id: w.clip.external_id, episode_id: w.episode.id, episode_number: w.episode.number, start_ms: Math.round(s), end_ms: Math.round(e) };
}

/** FNV-1a over the pieces, twice seeded: 16 hex characters, the same on server and client. */
export function montageKey(pieces: readonly Pick<MontagePiece, "episode_id" | "start_ms" | "end_ms">[]): string {
  const text = pieces.map((p) => `${p.episode_id}:${p.start_ms}-${p.end_ms}`).join("|");
  const run = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
    return h.toString(16).padStart(8, "0");
  };
  return run(2166136261) + run(0x811c9dc5 ^ 0x5bd1e995);
}

const byRank = (a: Window, b: Window) => a.clip.rank - b.clip.rank || storyOf(a, a.start) - storyOf(b, b.start);

/** The pick. Pure: the same clips, lines and rules give the same ad. */
export function planMontage(input: MontageInput, options: Partial<MontageOptions> = {}): MontagePlanResult {
  const o = { ...MONTAGE_DEFAULTS, ...options };
  const episodes = new Map(input.episodes.filter((e) => e.has_video).map((e) => [e.id, e]));
  const lastNumber = Math.max(0, ...input.episodes.map((e) => e.number));
  const lastEpisode = Math.max(1, Math.ceil(lastNumber * (1 - o.endingShare)));
  const windows: Window[] = [];
  let total = 0;
  let held = 0;
  for (const clip of input.clips) {
    if (clip.status === "dismissed" || clip.moment === "montage") continue;
    const episode = episodes.get(clip.episode_id);
    if (!episode) continue;
    total += 1;
    const w = usableWindow(clip, episode, input.rules, lastEpisode, o);
    if (w === "held") held += 1;
    else if (w) windows.push({ clip, episode, ...w });
  }
  if (!total) return refuse("no_clips", 0, 0);
  windows.sort((a, b) => storyOf(a, a.start) - storyOf(b, b.start) || a.clip.rank - b.clip.rank);

  // The hook: the opening, else the strongest clip of the earliest episode.
  const openings = windows.filter((w) => w.clip.moment === "opening").sort(byRank);
  const first = windows[0]?.episode.number;
  const hookW = openings[0] ?? windows.filter((w) => w.episode.number === first).sort(byRank)[0];
  if (!hookW) return refuse("too_few", windows.length, held);
  const hook = piece(hookW, "hook", hookW.start, Math.min(hookW.end, hookW.start + o.hookMs), o);
  const hookEnd = storyOf(hookW, hook.end_ms);

  const cutCliff = (w: Window) => piece(w, "cliff", Math.max(w.start, w.end - o.cliffMs), w.end, o);
  const hookSpan: Span = { episode_id: hook.episode_id, start: hook.start_ms, end: hook.end_ms };

  /**
   * The scenes for one cliff: up to four, each the strongest clip nearest to an evenly spaced point between hook and
   * cliff, cut from the part of its window that is after the hook, before the cliff and outside every piece already
   * taken (clips of one episode often overlap, so a window is trimmed rather than dropped). A part long enough for a
   * full scene is preferred to a stronger clip's scrap.
   */
  const pickScenes = (cliffW: Window, cliff: MontagePiece) => {
    const lo = hookEnd;
    const hi = storyOf(cliffW, cliff.start_ms);
    const room = o.maxMs - (hook.end_ms - hook.start_ms) - (cliff.end_ms - cliff.start_ms);
    const slots = Math.max(o.scenesMin, Math.min(o.scenesMax, Math.floor(room / o.sceneMinMs)));
    const share = Math.min(o.sceneMaxMs, Math.floor(room / slots));
    const taken: Span[] = [hookSpan, { episode_id: cliff.episode_id, start: cliff.start_ms, end: cliff.end_ms }];
    const chosen: Array<{ w: Window; part: Span; span: Span }> = [];
    const from = hookW.episode.number;
    const to = cliffW.episode.number;
    for (let i = 0; i < slots; i++) {
      const target = from + ((to - from) * (i + 1)) / (slots + 1);
      const best = windows
        .filter((w) => w !== hookW && w !== cliffW && !chosen.some((c) => c.w === w))
        .map((w) => ({ w, part: freePart(w, lo, hi, taken, o.minPieceMs) }))
        .filter((x): x is { w: Window; part: Span } => x.part !== null)
        .sort((a, b) => Number(a.part.end - a.part.start < o.sceneMinMs) - Number(b.part.end - b.part.start < o.sceneMinMs)
          || a.w.clip.rank - b.w.clip.rank
          || Math.abs(a.w.episode.number - target) - Math.abs(b.w.episode.number - target)
          || storyOf(a.w, a.part.start) - storyOf(b.w, b.part.start))[0];
      if (!best) break;
      const span: Span = { episode_id: best.w.episode.id, start: best.part.start, end: Math.min(best.part.end, best.part.start + share) };
      chosen.push({ ...best, span });
      taken.push(span);
    }
    return { chosen, room, taken };
  };

  // The cliff: the strongest clip of the last episode that has one after the hook; then later windows first — the
  // first that leaves room for two scenes.
  const after = windows.filter((w) => w !== hookW && storyOf(w, cutCliff(w).start_ms) >= hookEnd);
  if (!after.length) return refuse("too_few", windows.length, held);
  const lastWith = Math.max(...after.map((w) => w.episode.number));
  const cliffOrder = [
    ...after.filter((w) => w.episode.number === lastWith).sort(byRank),
    ...after.filter((w) => w.episode.number !== lastWith).sort((a, b) => storyOf(b, b.end) - storyOf(a, a.end) || a.clip.rank - b.clip.rank),
  ];
  let found: { cliffW: Window; cliff: MontagePiece; picked: ReturnType<typeof pickScenes> } | null = null;
  for (const w of cliffOrder) {
    const cliff = cutCliff(w);
    const picked = pickScenes(w, cliff);
    if (picked.chosen.length >= o.scenesMin) { found = { cliffW: w, cliff, picked }; break; }
  }
  if (!found) return refuse("too_few", windows.length, held);
  const { cliffW, cliff } = found;
  const { chosen, room, taken } = found.picked;
  chosen.sort((a, b) => storyOf(a.w, a.span.start) - storyOf(b.w, b.span.start));

  // What the equal shares leave of the 60 s goes to the scenes that can take more, in story order, never into
  // another piece.
  let left = room - chosen.reduce((n, c) => n + c.span.end - c.span.start, 0);
  for (const c of chosen) {
    if (left <= 0) break;
    const next = taken.filter((t) => t !== c.span && t.episode_id === c.span.episode_id && t.start >= c.span.end).map((t) => t.start);
    const limit = Math.min(c.part.end, ...next);
    const more = Math.min(left, limit - c.span.end, o.sceneMaxMs - (c.span.end - c.span.start));
    if (more > 0) { c.span.end += more; left -= more; }
  }
  const scenes = chosen.map((c) => c.w);
  const scenePieces = chosen.map((c) => piece(c.w, "scene", c.span.start, c.span.end, o));
  const pieces = [hook, ...scenePieces, cliff];
  const duration = pieces.reduce((n, p) => n + (p.end_ms - p.start_ms), 0);
  const hookText = hookW.clip.hook_en.trim() || [...scenes, cliffW].map((w) => w.clip.hook_en.trim()).find(Boolean) || "";
  const used = [hookW, ...scenes, cliffW];
  return {
    ok: true,
    pieces,
    duration_ms: duration,
    hook_en: hookText,
    source: used.every((w) => w.clip.source === "script") ? "script" : "footage",
    episodes: [...new Set(pieces.map((p) => p.episode_number))],
    key: montageKey(pieces),
  };
}

function refuse(code: MontageRefusalCode, usable: number, held: number): MontagePlanResult {
  const message = code === "no_clips"
    ? "This title has no ad clips yet. Cut clips on its episodes first (Ad clips, Cut clips again), then build the 60-second ad."
    : `A 60-second ad needs a hook, at least two scenes and a cliff: four separate moments from before the spoiler line. This title has ${usable} usable ${usable === 1 ? "clip" : "clips"}${held ? ` (${held} more ${held === 1 ? "comes" : "come"} after the spoiler line or inside a card)` : ""}. Cut clips on more of its early episodes, then try again.`;
  return { ok: false, code, message, usable, held_back: held };
}

export type FramedPiece = MontagePiece & { start_frame: number; frames: number };

/**
 * Whole frames at the source's rate: each piece starts on the frame nearest
 * its start and holds the frames up to the one nearest its end, and the
 * whole never exceeds `maxMs` (rounding can add half a frame per piece; the
 * longest scene gives the excess back, from its end). Each piece's times are
 * rewritten to its frames.
 */
export function framePieces(pieces: readonly MontagePiece[], fps: number, maxMs = MONTAGE_MAX_MS): FramedPiece[] {
  if (!(fps > 0)) throw new Error("the frame rate must be positive");
  const out: FramedPiece[] = pieces.map((p) => {
    const a = Math.round((p.start_ms * fps) / 1000);
    const b = Math.round((p.end_ms * fps) / 1000);
    return { ...p, start_frame: a, frames: Math.max(1, b - a) };
  });
  const cap = Math.floor((maxMs * fps) / 1000 + 1e-9);
  let over = out.reduce((n, p) => n + p.frames, 0) - cap;
  while (over > 0) {
    const pool = out.filter((p) => p.role === "scene" && p.frames > 1);
    const target = (pool.length ? pool : out.filter((p) => p.frames > 1)).sort((a, b) => b.frames - a.frames)[0];
    if (!target) break;
    const take = Math.min(over, target.frames - 1);
    target.frames -= take;
    over -= take;
  }
  return out.map((p) => ({ ...p, start_ms: Math.round((p.start_frame * 1000) / fps), end_ms: Math.round(((p.start_frame + p.frames) * 1000) / fps) }));
}

/**
 * Why a finished 60-second ad cannot be written as a clips row, or null. Both
 * data-layer backends ask the same questions (`titleOfEpisode` answers which
 * title an episode belongs to, null when there is no such episode).
 */
export function montageClipProblem(
  input: { title_id: string; pieces: readonly MontagePiece[]; render_path: string; render_sha256: string; duration_ms: number },
  titleOfEpisode: (episodeId: string) => string | null,
): string | null {
  if (!input.pieces?.length) return "a 60-second ad needs its pieces";
  if (input.pieces.some((p) => titleOfEpisode(p.episode_id) !== input.title_id)) return "every piece of the ad must come from the title's own episodes";
  if (input.pieces.some((p) => !(p.start_ms >= 0 && p.end_ms > p.start_ms))) return "every piece of the ad needs its range";
  if (!input.render_path) return "a 60-second ad needs its finished file";
  if (!/^[0-9a-f]{64}$/.test(input.render_sha256 ?? "")) return "render checksum must be a sha256";
  if (!(input.duration_ms > 0) || input.duration_ms > MONTAGE_MAX_MS) return "a 60-second ad runs at most 60 seconds";
  return null;
}

/** "1, 2, 5" — the episodes a montage draws on, for the Clips table's Episode column. */
export function montageEpisodesLabel(pieces: readonly Pick<MontagePiece, "episode_number">[] | null | undefined): string {
  return [...new Set((pieces ?? []).map((p) => p.episode_number))].sort((a, b) => a - b).join(", ");
}

/** The row's own sentences (why_en / why_zh), in plain words. */
export function montageWhy(plan: Pick<MontagePlan, "pieces" | "episodes">): { en: string; zh: string } {
  const scenes = plan.pieces.filter((p) => p.role === "scene").length;
  const eps = [...plan.episodes].sort((a, b) => a - b).join(", ");
  return {
    en: `A 60-second ad: a hook, ${scenes} scenes and a cliff from episodes ${eps}, joined with hard cuts in story order.`,
    zh: `60 秒广告：一个开场钩子、${scenes} 个场景和一个悬念结尾，取自第 ${eps} 集，按剧情顺序硬切拼接。`,
  };
}
