// The series text Studio drafts for "Upload to crazydramas" (decision
// 2026-09-23 "Upload automation: poster, slug, series text"): when the form
// opens for a title with no Studio series yet, its tagline, description and
// genres come pre-filled from the film's transcript — editable, with "Draft
// again" for a new take.
//
// What the model reads: the film's transcript (the imported ASR index,
// `studio.film_assets` kind `transcript`; else the episodes' own script lines
// laid on the film's timeline), cut to the first 15 minutes in full plus
// evenly spaced lines from the rest — and never anything in the last 20% of
// the film (`selectTranscript`), so the ending cannot leak into the store
// copy. Idempotent per title and transcript: the job's key is
// `series_text:<prompt version>:<title>:<transcript sha16>:a<attempt>`, the
// form's reopening reuses the newest draft of the same transcript, and only
// "Draft again" (the next attempt) calls the model again.
//
// The rules every model call follows (CLAUDE.md): a studio.jobs row with the
// usage and cost, the answer validated with zod (lib/prompts/series-text.ts)
// before anything reads it, ADS_TEXT_PROVIDER's fast tier. Fixture mode
// (demo replay) answers with a canned draft and calls nothing; with no key
// for the provider the fields stay empty and one line says why. A producer
// never sees the job row or its cost: the route answers the text alone.

import { createHash } from "node:crypto";
import { systemSession, type Session } from "@/lib/auth";
import { demoReplayActive } from "@/lib/data-source";
import { getData } from "@/lib/data";
import { readStoredBytes } from "@/lib/data/storage";
import { parseWhisper } from "@/lib/film-import/manifest";
import { runJob } from "@/lib/jobs";
import { KEY_VAR, LlmUnavailableError, adsTextProvider, callStructured, isLlmAvailable, modelFor, type LlmProvider } from "@/lib/llm";
import { CATALOG_GENRES, GENRES_MAX, SERIES_TEXT_PROMPT_VERSION, SeriesTextSchema, TAGLINE_MAX, buildSeriesText, type SeriesTextOutput, type TranscriptPiece } from "@/lib/prompts/series-text";
import type { Job, Json } from "@/lib/types";
import type { SeriesTextReply } from "./publish-types";

/** The opening the model reads in full. */
export const HEAD_SECONDS = 15 * 60;
/** The share of the film at the end the model never sees. */
export const EXCLUDED_TAIL = 0.2;
/** Lines sampled from after the opening. */
export const SAMPLE_PIECES = 60;
/** Character budgets, so a long film stays one modest call. */
export const HEAD_MAX_CHARS = 24_000;
export const SAMPLE_MAX_CHARS = 8_000;

export const DRAFT_JOB_KIND = "draft_series_text" as const;

export type TranscriptSelection = { head: TranscriptPiece[]; sample: TranscriptPiece[]; head_until_s: number; cutoff_s: number; duration_s: number };

function capChars(pieces: TranscriptPiece[], max: number): TranscriptPiece[] {
  const out: TranscriptPiece[] = [];
  let used = 0;
  for (const p of pieces) {
    used += p.text.length + 8;
    if (used > max) break;
    out.push(p);
  }
  return out;
}

/**
 * What the model may read of a film `duration_s` long: every piece that ends
 * by min(15 minutes, 80% of the film), then up to SAMPLE_PIECES pieces spaced
 * evenly between there and the 80% mark. A piece that runs past the 80% mark
 * is left out whole. Pure.
 */
export function selectTranscript(pieces: readonly TranscriptPiece[], durationS: number): TranscriptSelection {
  const ordered = pieces.filter((p) => p.text.trim() && Number.isFinite(p.start_s) && Number.isFinite(p.end_s)).slice().sort((a, b) => a.start_s - b.start_s);
  const duration = durationS > 0 ? durationS : ordered.length ? Math.max(...ordered.map((p) => p.end_s)) : 0;
  const cutoff = duration * (1 - EXCLUDED_TAIL);
  const headUntil = Math.min(HEAD_SECONDS, cutoff);
  const head = capChars(ordered.filter((p) => p.end_s <= headUntil), HEAD_MAX_CHARS);
  const rest = ordered.filter((p) => p.start_s >= headUntil && p.end_s <= cutoff);
  const k = Math.min(rest.length, SAMPLE_PIECES);
  const picked: TranscriptPiece[] = [];
  for (let i = 0; i < k; i++) picked.push(rest[Math.floor((i * rest.length) / k)]);
  return { head, sample: capChars(picked, SAMPLE_MAX_CHARS), head_until_s: headUntil, cutoff_s: cutoff, duration_s: duration };
}

/** The transcript's identity: every piece's time and words, in order. */
export function transcriptSha(pieces: readonly TranscriptPiece[], durationS: number): string {
  const h = createHash("sha256");
  h.update(`${Math.round(durationS * 1000)}\n`);
  for (const p of pieces) h.update(`${Math.round(p.start_s * 1000)}|${Math.round(p.end_s * 1000)}|${p.text}\n`);
  return h.digest("hex");
}

export type TitleTranscript = { pieces: TranscriptPiece[]; duration_s: number; language: string; source: "asr_index" | "episode_lines" };

/**
 * The film's transcript on the film's own timeline: the imported ASR index
 * when the title has one; else each episode's script lines shifted by where
 * the episode sits in the film (its film window from the import, else the
 * lengths of the episodes before it). Null when there is nothing to read.
 */
export async function loadTitleTranscript(titleId: string): Promise<TitleTranscript | null> {
  const data = getData();
  const sys = systemSession();
  const episodes = (await data.listTitleEpisodes(sys, titleId)).slice().sort((a, b) => a.number - b.number);
  const filmEnd = episodes.length && episodes.every((e) => typeof e.film_end_ms === "number") ? Math.max(...episodes.map((e) => e.film_end_ms as number)) / 1000 : 0;

  const asset = (await data.listFilmAssets(sys, titleId)).find((a) => a.kind === "transcript");
  if (asset) {
    try {
      const text = (await readStoredBytes(asset.storage_path)).toString("utf8");
      const whisper = parseWhisper(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
      const pieces = whisper.segments.map((s) => ({ start_s: s.start, end_s: s.end, text: s.text }));
      if (pieces.length) return { pieces, duration_s: filmEnd || whisper.duration || Math.max(...pieces.map((p) => p.end_s)), language: whisper.language, source: "asr_index" };
    } catch (e) {
      console.warn(`[crazydramas] the transcript asset of ${titleId} could not be read: ${(e as Error).message}`);
    }
  }

  const pieces: TranscriptPiece[] = [];
  let offset = 0;
  for (const ep of episodes) {
    const start = typeof ep.film_start_ms === "number" ? ep.film_start_ms / 1000 : offset;
    const wb = await data.getWorkbench(sys, titleId, ep.number).catch(() => null);
    for (const l of wb?.lines ?? []) {
      if (l.merged_into_id || l.start_ms === null || l.end_ms === null || !l.text_zh.trim()) continue;
      pieces.push({ start_s: start + l.start_ms / 1000, end_s: start + l.end_ms / 1000, text: l.text_zh });
    }
    const length = typeof ep.film_start_ms === "number" && typeof ep.film_end_ms === "number" ? (ep.film_end_ms - ep.film_start_ms) / 1000 : (ep.duration_ms ?? 0) / 1000;
    offset = start + length;
  }
  if (!pieces.length) return null;
  return { pieces, duration_s: filmEnd || offset || Math.max(...pieces.map((p) => p.end_s)), language: "en", source: "episode_lines" };
}

/** Fixture mode's answer (demo replay: no model, no key, no spend). */
export const CANNED_SERIES_TEXT: SeriesTextOutput = {
  tagline: "One contract. One lie. One marriage she never agreed to.",
  description: "Broke and out of options, she signs a one-year contract to play the wife of a man she has never met. He has rules, a family that wants her gone, and a secret the contract never mentions. The longer she stays, the less the arrangement feels like pretend.",
  genres: ["Romance", "Billionaire"],
};

/** The model's genres in the catalog's own spelling where they match one, without repeats, at most three. Pure. */
export function tidyGenres(genres: readonly string[]): string[] {
  const out: string[] = [];
  for (const g of genres) {
    const clean = g.trim().replace(/\s+/g, " ");
    if (!clean) continue;
    const known = CATALOG_GENRES.find((c) => c.toLowerCase() === clean.toLowerCase());
    const word = known ?? clean.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    if (!out.some((o) => o.toLowerCase() === word.toLowerCase())) out.push(word);
  }
  return out.slice(0, GENRES_MAX);
}

function reply(status: SeriesTextReply["status"], out: SeriesTextOutput | null, note: string | null = null): SeriesTextReply {
  if (!out) return { status, tagline: null, description: null, genres: [], note };
  return { status, tagline: out.tagline.trim().slice(0, TAGLINE_MAX), description: out.description.trim(), genres: tidyGenres(out.genres), note };
}

type DraftInput = { transcript_sha: string; attempt: number; prompt_version: string };

function inputOf(job: Job | null): Partial<DraftInput> {
  const i = job?.input;
  return i && typeof i === "object" && !Array.isArray(i) ? (i as Partial<DraftInput>) : {};
}

export type DraftOptions = {
  /** "Draft again": a new attempt, a new call. */
  again?: boolean;
  /** Tests: the model call (callStructured by default). */
  call?: typeof callStructured;
  /** Tests: the provider (ADS_TEXT_PROVIDER by default). */
  provider?: LlmProvider;
};

/**
 * The draft for the title (the caller checked who may ask: the title's
 * approver or a staff administrator). Returns the text, never the job or its
 * cost. Fixture mode (demo replay): the canned draft. No key or no
 * transcript: empty fields and a note. A model failure throws (the route
 * answers it), with its spend on the failed job row.
 */
export async function draftSeriesText(session: Session, titleId: string, opts: DraftOptions = {}): Promise<SeriesTextReply> {
  const data = getData();
  const sys = systemSession();
  const title = (await data.getTitle(session, titleId)).title; // a foreign title is not found
  if (demoReplayActive() && !opts.call) return reply("demo", CANNED_SERIES_TEXT, "Demo mode: a sample draft, no model was called.");
  const provider = opts.provider ?? adsTextProvider();
  if (!opts.call && !isLlmAvailable(provider)) {
    return reply("unavailable", null, `No ${provider} key on this server (${KEY_VAR[provider]}), so Studio did not draft the tagline, description and genres; write them here.`);
  }
  const transcript = await loadTitleTranscript(titleId);
  if (!transcript) return reply("unavailable", null, "This title has no transcript yet, so Studio did not draft the tagline, description and genres; write them here.");

  const sha = transcriptSha(transcript.pieces, transcript.duration_s);
  const latest = await data.latestJobByTarget(sys, "title", titleId, DRAFT_JOB_KIND);
  const last = inputOf(latest);
  const sameTranscript = last.transcript_sha === sha && last.prompt_version === SERIES_TEXT_PROMPT_VERSION;
  if (!opts.again && sameTranscript && latest?.status === "done" && latest.output) {
    const parsed = SeriesTextSchema.safeParse(latest.output);
    if (parsed.success) return reply("reused", parsed.data);
  }
  const attempt = opts.again ? (sameTranscript ? (last.attempt ?? 1) + 1 : 1) : sameTranscript ? last.attempt ?? 1 : 1;

  const selection = selectTranscript(transcript.pieces, transcript.duration_s);
  const call = buildSeriesText({ display_title: title.name_en ?? title.name_zh, language: transcript.language, ...selection });
  const model = modelFor(provider, "fast");
  const input: Json = {
    transcript_sha: sha,
    attempt,
    prompt_version: SERIES_TEXT_PROMPT_VERSION,
    source: transcript.source,
    duration_s: Math.round(transcript.duration_s),
    head_until_s: Math.round(selection.head_until_s),
    cutoff_s: Math.round(selection.cutoff_s),
    head_pieces: selection.head.length,
    sample_pieces: selection.sample.length,
  };
  const invoke = opts.call ?? callStructured;
  try {
    const r = await runJob<SeriesTextOutput>(sys, {
      kind: DRAFT_JOB_KIND,
      title_id: titleId,
      target_type: "title",
      target_id: titleId,
      idempotency_key: `series_text:${SERIES_TEXT_PROMPT_VERSION}:${titleId}:${sha.slice(0, 16)}:a${attempt}`,
      provider,
      model,
      input,
      run: async () => {
        const res = await invoke({ ...call, provider, model });
        return { output: res.data, usage: res.usage, cost_cents: res.cost_cents, model: res.model, provider: res.provider };
      },
    });
    const valid = SeriesTextSchema.safeParse(r.output);
    if (!valid.success) throw new Error("the stored draft does not validate");
    return reply(r.skipped ? "reused" : "drafted", valid.data);
  } catch (e) {
    if (e instanceof LlmUnavailableError) return reply("unavailable", null, `${e.message}; write the tagline, description and genres here.`);
    throw e;
  }
}
