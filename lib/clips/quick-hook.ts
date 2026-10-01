// Quick hook ads (decision 2026-10-01, "Quick hook ads"): the format the big
// short-drama apps run, which replaces the hook ad. The most gripping 2-3
// seconds of the story first (the bait), then the scene that leads up to
// it (the body), cut before the payoff, with one line of text on screen.
// One build makes many variants at once — every bait × every body × every
// text — each its own file and its own clips row, so the Ads tab ranks them
// one by one and the code in the file name (H2-B1-X3) says which bait, body
// and text each one used. This file is the pick and the words, pure and
// unit-tested; the render is lib/clips/montage-render.ts (with the text
// drawn) and the build lib/clips/quick-hook-run.ts.
//
// The pick, in plain words (meant to be clean, not clever; Ruobin improves it):
// - Only what an ad may show, by the montage's own rule (usableWindow): a
//   clip stops at the title's spoiler line and steps around its exclusions;
//   without a spoiler line the last fifth of the episodes stays out.
// - A bait is the end of a strong clip: its last spoken line, with a quarter
//   second either side, 1.8-3.5 s (find_clips closes a moment where it
//   lands). Without lines, the clip's last 3 s. Strongest clips first, one
//   per episode before a second from the same one, at most four.
// - A body is a clip played from its start, 10-40 s, never through the
//   bait's own frames: for the bait's own clip that is the lead-up to the
//   bait, cut just before it (the flash-forward); other bodies are the
//   strongest clips, the opening first. At most three bodies per bait.
// - No edge cuts through a spoken line when a gap is near (snapStart /
//   snapEnd, as the montage does). The whole ad is at most 45 s.
// - The text is drawn at the top of the picture from the first frame until
//   2.5 s after the bait ends; a person writes it (the page suggests lines
//   from the clips' own opening text and hooks).

import type { AdFormat } from "@/lib/ad-formats";
import type { AdRules, Clip, ClipSource, MontagePiece } from "@/lib/types";
import { MONTAGE_DEFAULTS, montageKey, snapEnd, snapStart, usableWindow, type MontageClip, type MontageEpisode } from "./montage";

export type QuickHookOptions = {
  baitMinMs: number;
  baitMaxMs: number;
  /** Kept before a bait line's start and after its end. */
  leadMs: number;
  bodyMinMs: number;
  bodyMaxMs: number;
  /** The whole ad, at most. */
  maxMs: number;
  /** A body keeps at least this away from its bait's frames when they share an episode. */
  gapMs: number;
  hooksMax: number;
  bodiesMax: number;
  textsMax: number;
  /** One build makes at most this many files. */
  variantsMax: number;
  /** Without a spoiler line, this share of the last episodes stays out of the ad. */
  endingShare: number;
  /** How long the text stays on screen after the bait ends. */
  overlayHoldMs: number;
};

/** How long the text stays on screen after the bait ends. */
export const OVERLAY_HOLD_MS = 2_500;

export const QUICK_HOOK_DEFAULTS: QuickHookOptions = {
  baitMinMs: 1_800,
  baitMaxMs: 3_500,
  leadMs: 250,
  bodyMinMs: 10_000,
  bodyMaxMs: 40_000,
  maxMs: 45_000,
  gapMs: 500,
  hooksMax: 4,
  bodiesMax: 3,
  textsMax: 3,
  variantsMax: 24,
  endingShare: 0.2,
  overlayHoldMs: OVERLAY_HOLD_MS,
};
/** The text a person may write for one variant, at most. */
export const OVERLAY_MAX_CHARS = 72;
/** About this many characters fit one line of the drawn text at its size. */
export const OVERLAY_LINE_CHARS = 24;
export const OVERLAY_MAX_LINES = 3;

export type QuickHookClip = MontageClip & Partial<Pick<Clip, "opening_text_en" | "ad_format">>;
export type QuickHookInput = { episodes: MontageEpisode[]; clips: QuickHookClip[]; rules: AdRules | null };

export type QuickHookVariant = {
  /** "H2-B1-X3": which bait, body and text (numbered within the build). */
  code: string;
  hook: number;
  body: number;
  text: number;
  /** The bait (role hook), then the body (role scene). */
  pieces: MontagePiece[];
  duration_ms: number;
  /** The text drawn on the picture. */
  overlay: string;
  /** How long the text stays on screen, from the first frame. */
  overlay_ms: number;
  /** The TikTok ad text: the bait clip's hook, else the body's, else the drawn text. */
  ad_text: string;
  source: ClipSource;
  /** A short fingerprint of the pieces and the text: the same variant is the same file. */
  key: string;
};

export type QuickHookPlan = { variants: QuickHookVariant[]; hooks: number; bodies: number; texts: number };
export type QuickHookRefusalCode = "no_clips" | "too_few" | "no_text";
export type QuickHookRefusal = { code: QuickHookRefusalCode; message: string; usable: number; held_back: number };
export type QuickHookPlanResult = ({ ok: true } & QuickHookPlan) | ({ ok: false } & QuickHookRefusal);

type Window = { clip: QuickHookClip; episode: MontageEpisode; start: number; end: number };
type Span = { start: number; end: number };

const STORY = 1e9;
const storyOf = (w: Window, ms: number) => w.episode.number * STORY + ms;

/** A quick hook ad's row: a joined ad (moment montage) labelled quick_hook. */
export function isQuickHook(c: { moment?: string | null; ad_format?: AdFormat | null }): boolean {
  return c.moment === "montage" && c.ad_format === "quick_hook";
}

/** Where a variant's file is stored: the code and the fingerprint in its name, which the Ads tab shows. */
export const quickHookFile = (titleId: string, code: string, key: string) => `${titleId}/quick-hooks/quick-hook-${code}-${key}.mp4`;

/** The variant code of a stored quick hook file ("H2-B1-X3"), or null. */
export function quickHookCode(path: string | null | undefined): string | null {
  return path?.match(/quick-hook-(H\d+-B\d+-X\d+)-[0-9a-f]{16}\.mp4$/)?.[1] ?? null;
}

/** The drawn text in lines of about OVERLAY_LINE_CHARS, or null when it does not fit OVERLAY_MAX_LINES. */
export function wrapOverlay(text: string): string[] | null {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return null;
  const lines: string[] = [];
  for (const w of words) {
    if (w.length > OVERLAY_LINE_CHARS) return null;
    const last = lines[lines.length - 1];
    if (last !== undefined && last.length + 1 + w.length <= OVERLAY_LINE_CHARS) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  return lines.length <= OVERLAY_MAX_LINES ? lines : null;
}

/** Why a text cannot be drawn, in plain words, or null. */
export function overlayIssue(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "write the line of text the ad shows";
  if (t.length > OVERLAY_MAX_CHARS) return `the text on screen is ${t.length} characters; keep it to ${OVERLAY_MAX_CHARS}`;
  if (!wrapOverlay(t)) return `the text on screen must fit ${OVERLAY_MAX_LINES} lines of about ${OVERLAY_LINE_CHARS} characters`;
  return null;
}

/** Lines the page offers as the text: the clips' own suggested opening text, then their hooks, strongest first, ones that fit. */
export function suggestOverlayTexts(clips: readonly QuickHookClip[], max = QUICK_HOOK_DEFAULTS.textsMax): string[] {
  const usable = clips.filter((c) => c.status !== "dismissed" && c.moment !== "montage" && c.source !== "upload").sort((a, b) => a.rank - b.rank);
  const out: string[] = [];
  for (const t of [...usable.map((c) => c.opening_text_en ?? ""), ...usable.map((c) => c.hook_en)]) {
    const line = t.replace(/\s+/g, " ").trim();
    if (line && !overlayIssue(line) && !out.some((o) => o.toLowerCase() === line.toLowerCase())) out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

/** The bait of a window: its last spoken line with a lead either side, else its last 3 s; null when too short. */
export function baitOf(w: { start: number; end: number; episode: Pick<MontageEpisode, "cues"> }, o: QuickHookOptions = QUICK_HOOK_DEFAULTS): Span | null {
  const inside = w.episode.cues.filter((c) => c.start_ms >= w.start && c.end_ms <= w.end);
  const last = inside[inside.length - 1];
  let end = w.end;
  let start = end - 3_000;
  if (last) {
    end = Math.min(w.end, last.end_ms + o.leadMs);
    start = Math.max(w.start, last.start_ms - o.leadMs);
  }
  if (end - start > o.baitMaxMs) start = end - o.baitMaxMs;
  if (end - start < o.baitMinMs) start = Math.max(w.start, end - o.baitMinMs);
  start = Math.max(w.start, start);
  return end - start >= o.baitMinMs ? { start: Math.round(start), end: Math.round(end) } : null;
}

/** A body from a window: from its start, outside the bait's frames when they share an episode, cut to fit; null when too short. */
function bodyOf(w: Window, bait: { episode_id: string; span: Span }, room: number, o: QuickHookOptions): Span | null {
  let parts: Array<[number, number]> = [[w.start, Math.min(w.end, w.start + Math.min(o.bodyMaxMs, room))]];
  if (w.episode.id === bait.episode_id) {
    const [a, b] = [bait.span.start - o.gapMs, bait.span.end + o.gapMs];
    parts = parts.flatMap(([s, e]): Array<[number, number]> => (b <= s || a >= e ? [[s, e]] : ([[s, Math.min(e, a)], [Math.max(s, b), e]] as Array<[number, number]>).filter(([p, q]) => q > p)));
  }
  const part = parts.find(([s, e]) => e - s >= o.bodyMinMs);
  if (!part) return null;
  const end = snapEnd(part[0], part[1], w.episode.cues, o.bodyMinMs);
  const start = snapStart(part[0], end, w.episode.cues, o.bodyMinMs);
  return end - start >= o.bodyMinMs ? { start: Math.round(start), end: Math.round(end) } : null;
}

const pieceOf = (w: Window, role: "hook" | "scene", s: Span): MontagePiece => ({
  role, clip_id: w.clip.id, clip_external_id: w.clip.external_id, episode_id: w.episode.id, episode_number: w.episode.number, start_ms: s.start, end_ms: s.end,
});

/** The pick. Pure: the same clips, lines, rules and texts give the same variants. */
export function planQuickHooks(input: QuickHookInput, texts: readonly string[], options: Partial<QuickHookOptions> = {}): QuickHookPlanResult {
  const o = { ...QUICK_HOOK_DEFAULTS, ...options };
  const lines = [...new Set(texts.map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t && !overlayIssue(t)))].slice(0, o.textsMax);
  const episodes = new Map(input.episodes.filter((e) => e.has_video).map((e) => [e.id, e]));
  const lastNumber = Math.max(0, ...input.episodes.map((e) => e.number));
  const lastEpisode = Math.max(1, Math.ceil(lastNumber * (1 - o.endingShare)));
  const windowRule = { ...MONTAGE_DEFAULTS, minPieceMs: o.baitMinMs, endingShare: o.endingShare };
  const windows: Window[] = [];
  let total = 0;
  let held = 0;
  for (const clip of input.clips) {
    if (clip.status === "dismissed" || clip.moment === "montage" || clip.source === "upload") continue;
    const episode = episodes.get(clip.episode_id);
    if (!episode) continue;
    total += 1;
    const w = usableWindow(clip, episode, input.rules, lastEpisode, windowRule);
    if (w === "held") held += 1;
    else if (w) windows.push({ clip, episode, ...w });
  }
  if (!total) return refuse("no_clips", 0, 0);
  if (!lines.length) return refuse("no_text", windows.length, held);

  // Baits: strongest first, later in the story first among equals, one per episode before a second from any.
  const ranked = [...windows].sort((a, b) => a.clip.rank - b.clip.rank || storyOf(b, b.end) - storyOf(a, a.end));
  const baitOrder = [...ranked.filter((w, i) => ranked.findIndex((x) => x.episode.id === w.episode.id) === i), ...ranked.filter((w, i) => ranked.findIndex((x) => x.episode.id === w.episode.id) !== i)];
  // Bodies: the opening first, then the strongest, earlier in the story first among equals.
  const bodyOrder = [...windows].sort((a, b) => Number(b.clip.moment === "opening") - Number(a.clip.moment === "opening") || a.clip.rank - b.clip.rank || storyOf(a, a.start) - storyOf(b, b.start));

  const bodyCodes = new Map<string, number>();
  const pairs: Array<{ h: number; b: number; bait: MontagePiece; body: MontagePiece; baitW: Window; bodyW: Window }> = [];
  let hooks = 0;
  for (const bw of baitOrder) {
    if (hooks >= o.hooksMax) break;
    const span = baitOf(bw, o);
    if (!span) continue;
    const bait = pieceOf(bw, "hook", span);
    const room = o.maxMs - (span.end - span.start);
    const mine: Array<{ w: Window; s: Span }> = [];
    // The bait's own lead-up first (the flash-forward), then the strongest other clips.
    for (const w of [bw, ...bodyOrder.filter((x) => x !== bw)]) {
      if (mine.length >= o.bodiesMax) break;
      const s = bodyOf(w, { episode_id: bw.episode.id, span }, room, o);
      if (s && !mine.some((m) => m.w.episode.id === w.episode.id && m.s.start < s.end && s.start < m.s.end)) mine.push({ w, s });
    }
    if (!mine.length) continue;
    hooks += 1;
    for (const m of mine) {
      const id = `${m.w.episode.id}:${m.s.start}-${m.s.end}`;
      if (!bodyCodes.has(id)) bodyCodes.set(id, bodyCodes.size + 1);
      pairs.push({ h: hooks, b: bodyCodes.get(id)!, bait, body: pieceOf(m.w, "scene", m.s), baitW: bw, bodyW: m.w });
    }
  }
  if (!pairs.length) return refuse("too_few", windows.length, held);

  // Spread the pairs (every bait with its first body before any bait's second), then every text for each.
  const order = pairs.map((p, i) => ({ p, i, nth: pairs.slice(0, i).filter((q) => q.h === p.h).length })).sort((a, b) => a.nth - b.nth || a.i - b.i).map((x) => x.p);
  const kept = order.slice(0, Math.max(1, Math.floor(o.variantsMax / lines.length)));
  const variants: QuickHookVariant[] = [];
  for (const p of kept) {
    lines.forEach((text, x) => {
      const pieces = [p.bait, p.body];
      const code = `H${p.h}-B${p.b}-X${x + 1}`;
      variants.push({
        code, hook: p.h, body: p.b, text: x + 1, pieces,
        duration_ms: pieces.reduce((n, q) => n + q.end_ms - q.start_ms, 0),
        overlay: text,
        overlay_ms: p.bait.end_ms - p.bait.start_ms + o.overlayHoldMs,
        ad_text: p.baitW.clip.hook_en.trim() || p.bodyW.clip.hook_en.trim() || text,
        source: p.baitW.clip.source === "script" && p.bodyW.clip.source === "script" ? "script" : "footage",
        key: montageKey([...pieces, { episode_id: `text:${text}`, start_ms: 0, end_ms: 0 }]),
      });
    });
  }
  return { ok: true, variants, hooks, bodies: bodyCodes.size, texts: lines.length };
}

function refuse(code: QuickHookRefusalCode, usable: number, held: number): QuickHookPlanResult {
  const message = code === "no_clips"
    ? "This title has no ad clips yet. Cut clips on its episodes first (Ad clips, Cut clips again), then build the quick hook ads."
    : code === "no_text"
      ? `Write at least one line of text for the ads to show (up to ${OVERLAY_MAX_CHARS} characters).`
      : `A quick hook ad needs a bait of about 3 s and a scene of at least 10 s from before the spoiler line. This title has ${usable} usable ${usable === 1 ? "clip" : "clips"}${held ? ` (${held} more ${held === 1 ? "comes" : "come"} after the spoiler line or inside a card)` : ""}. Cut clips on more of its early episodes, then try again.`;
  return { ok: false, code, message, usable, held_back: held };
}

/** The row's own sentences (why_en / why_zh), in plain words. */
export function quickHookWhy(v: Pick<QuickHookVariant, "code" | "pieces">): { en: string; zh: string } {
  const [bait, body] = v.pieces;
  const own = bait.clip_id !== null && bait.clip_id === body.clip_id;
  return {
    en: `Quick hook ${v.code}: ${((bait.end_ms - bait.start_ms) / 1000).toFixed(1)} s from episode ${bait.episode_number} first, then ${own ? "the scene that leads up to it" : `a scene from episode ${body.episode_number}`}, with the text on screen.`,
    zh: `快速钩子 ${v.code}：先放第 ${bait.episode_number} 集的 ${((bait.end_ms - bait.start_ms) / 1000).toFixed(1)} 秒，再接${own ? "引出这一刻的那场戏" : `第 ${body.episode_number} 集的一场戏`}，画面上有一行字。`,
  };
}
