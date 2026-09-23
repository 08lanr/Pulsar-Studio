// Transcribe an episode that arrived with no script (decision 2026-09-15;
// the v1.1 slot docs/build-plan.md reserved). The front door is still a
// subtitle file — transcription is an EXPLICIT button on Materials, never
// silent, and only fills an episode that has a video and no lines yet.
//
// Provider-based like lib/align.ts, resolved from STUDIO_ASR_PROVIDER with
// an honest unavailable state otherwise:
//   local-whisper  scripts/transcribe_episode.py (faster-whisper, CPU) —
//                  spends nothing, so it may run in fixture/demo mode the
//                  way the ffmpeg burns do.
//   openai         whisper-1 over the OpenAI API — a REAL model call, so
//                  demo replay refuses it (checked here as well as in the
//                  route; DEMO_REPLAY=0 is the override) and the job row
//                  carries the audio-minute cost. The audio track is
//                  extracted first (16 kHz mono AAC): the endpoint caps
//                  uploads at 25 MB, which an episode master exceeds.
//
// Job bookkeeping runs through the SYSTEM actor like the clip engine
// (renders write through the system actor): producers never gain read
// access to studio.jobs, and a failed run resurrects its own row in either
// backend. The caller's session still authorizes every DATA write — the
// workbench read and attachIngestToEpisode are producer-scoped.
//
// The transcript's word stream becomes subtitle cues here (pure, tested):
// break on silence gaps, sentence ends and length caps, so the timing is
// subtitle-shaped rather than paragraph-shaped. The cues are written as a
// real VTT into storage (script_format 'asr', data-model § episodes), then
// parsed back through lib/ingest — and the parsed lines are restored to
// the EXACT cue text with speaker null, because the generic parser's
// speaker heuristic must never eat machine text ("他说：..." is dialogue,
// not a speaker named 他说). Every line is machine-written and unreviewed;
// the studio is where a human checks them.

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { systemSession, type Session } from "@/lib/auth";
import { runFfmpeg, withSourceFile } from "@/lib/clips/cut";
import { scheduleClipCut } from "@/lib/clips/run";
import { jobIsRunning } from "@/lib/clips/state";
import { DataError, getData } from "@/lib/data";
import { uploadImport } from "@/lib/data/storage";
import { demoReplayActive } from "@/lib/data-source";
import { vttTime } from "@/lib/export/time";
import { ingestEpisodeFile, type IngestResult } from "@/lib/ingest";
import type { Episode, JobKind } from "@/lib/types";

export const ASR_JOB_KIND: Extract<JobKind, "transcribe_episode"> = "transcribe_episode";

// ---- transcript shapes -------------------------------------------------------

const WordSchema = z.object({ w: z.string(), start_ms: z.number().int(), end_ms: z.number().int() });
const SegmentSchema = z.object({
  start_ms: z.number().int(),
  end_ms: z.number().int(),
  text: z.string(),
  words: z.array(WordSchema).default([]),
});
/** Both providers' output is validated with zod before anything downstream reads it (LLM invariant). */
export const TranscriptSchema = z.object({
  language: z.string().nullable().default(null),
  duration_s: z.number().nonnegative().default(0),
  segments: z.array(SegmentSchema),
});

export type AsrWord = z.infer<typeof WordSchema>;
export type AsrSegment = z.infer<typeof SegmentSchema>;
export type AsrTranscript = z.infer<typeof TranscriptSchema>;

export interface AsrProvider {
  name: string;
  /** The model the job row records. */
  model: string;
  /** Integer cents for the job row; local providers spend 0. */
  costCents(durationS: number): number;
  transcribe(input: { mediaAbs: string; workDir: string }): Promise<AsrTranscript>;
}

export type AsrAvailability = { available: true; provider: string } | { available: false; reason: string };

/** Mirrors the alignment provider's ceiling; the route notes the same self-hosted assumption as the burn. */
const ASR_TIMEOUT_MS = 8 * 60 * 1000;
/** Well inside lib/clips/state.ts STALE_RUN_MS, so a live run never reads as dead. */
const HEARTBEAT_MS = 2 * 60 * 1000;

// ---- providers ---------------------------------------------------------------

function whisperModel(): string {
  return process.env.STUDIO_ASR_MODEL || process.env.STUDIO_WHISPER_MODEL || "small";
}

const localWhisper: AsrProvider = {
  name: "local-whisper",
  get model() {
    return `faster-whisper/${whisperModel()}`;
  },
  costCents: () => 0,
  async transcribe({ mediaAbs }) {
    const python = process.env.STUDIO_ASR_PYTHON || process.env.STUDIO_ALIGN_PYTHON || "python";
    const script = path.join(process.cwd(), "scripts", "transcribe_episode.py");
    const job = JSON.stringify({ video: mediaAbs, model: whisperModel(), language: null });
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(python, [script], { env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += String(d)));
      p.stderr.on("data", (d) => (stderr += String(d)));
      const timer = setTimeout(() => {
        p.kill();
        reject(new Error("transcription timed out after 8 minutes"));
      }, ASR_TIMEOUT_MS);
      p.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`could not run ${python}: ${e.message}`));
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`transcription failed: ${stderr.slice(-400) || `exit ${code}`}`));
      });
      p.stdin.write(job, "utf-8");
      p.stdin.end();
    });
    return TranscriptSchema.parse(JSON.parse(out));
  },
};

/** whisper-1 verbose_json; the audio track is extracted first (25 MB endpoint cap). */
const openaiWhisper: AsrProvider = {
  name: "openai",
  model: "whisper-1",
  // $0.006 per audio minute, rounded up to an integer cent (LLM invariant).
  costCents: (durationS) => Math.max(1, Math.ceil((durationS / 60) * 0.6)),
  async transcribe({ mediaAbs, workDir }) {
    const audio = path.join(workDir, "audio.m4a");
    await runFfmpeg(["-y", "-i", mediaAbs, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", audio]);
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const r = (await client.audio.transcriptions.create({
      model: "whisper-1",
      file: createReadStream(audio),
      response_format: "verbose_json",
      timestamp_granularities: ["segment", "word"],
    })) as unknown as {
      language?: string;
      duration?: number;
      segments?: { start: number; end: number; text: string }[];
      words?: { word: string; start: number; end: number }[];
    };
    const words: AsrWord[] = (r.words ?? []).map((w) => ({
      w: w.word,
      start_ms: Math.round(w.start * 1000),
      end_ms: Math.round(w.end * 1000),
    }));
    // File-level words attach to the one segment whose span contains their
    // start; segment ranges from whisper-1 do not overlap, but be explicit
    // so a word is never duplicated across two cues.
    const taken = new Set<number>();
    const segments: AsrSegment[] = (r.segments ?? [])
      .map((s) => {
        const start_ms = Math.round(s.start * 1000);
        const end_ms = Math.round(s.end * 1000);
        const mine: AsrWord[] = [];
        words.forEach((w, i) => {
          if (!taken.has(i) && w.start_ms >= start_ms && w.start_ms < end_ms) {
            taken.add(i);
            mine.push(w);
          }
        });
        return { start_ms, end_ms, text: (s.text ?? "").trim(), words: mine };
      })
      .filter((s) => s.text);
    return TranscriptSchema.parse({ language: r.language ?? null, duration_s: r.duration ?? 0, segments });
  },
};

export function asrProvider(): AsrProvider | null {
  const wanted = process.env.STUDIO_ASR_PROVIDER;
  if (wanted === "local-whisper") return localWhisper;
  if (wanted === "openai") return openaiWhisper;
  return null;
}

export function asrAvailability(): AsrAvailability {
  const wanted = process.env.STUDIO_ASR_PROVIDER;
  if (!wanted) {
    return { available: false, reason: "no transcription provider configured (set STUDIO_ASR_PROVIDER; see docs/transcription.md)" };
  }
  if (wanted === "local-whisper") return { available: true, provider: "local-whisper" };
  if (wanted === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      return { available: false, reason: "STUDIO_ASR_PROVIDER=openai needs OPENAI_API_KEY in .env.local" };
    }
    if (demoReplayActive()) {
      return {
        available: false,
        reason: "openai transcription is a real model call and demo replay is on (DEMO_REPLAY=0 is the explicit override); local-whisper spends nothing and works in demo mode",
      };
    }
    return { available: true, provider: "openai" };
  }
  return { available: false, reason: `STUDIO_ASR_PROVIDER="${wanted}" is not a known provider (known: local-whisper, openai); see docs/transcription.md` };
}

// ---- word stream -> subtitle cues (pure) -------------------------------------

export type AsrCue = { start_ms: number; end_ms: number; text: string };

/** A cue breaks on this much silence between words. */
const CUE_GAP_MS = 600;
/** A cue never runs longer than this on screen. */
const CUE_MAX_MS = 6_500;
/** ...or wider than this many characters (the QC line budget's upper bound). */
const CUE_MAX_CHARS = 42;
/** Sentence-final punctuation ends a cue once it has some substance. */
const SENTENCE_END = /[。！？!?…]$|[.](?!\d)$/;
const CUE_MIN_MS = 300;

function joinWords(words: AsrWord[]): string {
  // faster-whisper and whisper-1 both put the leading space inside each
  // Latin word and none on CJK, so plain concatenation spaces itself.
  return words.map((w) => w.w).join("").replace(/\s+/g, " ").trim();
}

/**
 * Subtitle cues from the transcript: word-accurate boundaries, broken on
 * silence, sentence ends and length caps; a segment without word timestamps
 * falls back to the whole segment as one cue. Cues never overlap — a start
 * is clamped to the previous cue's end — and never last under 300 ms.
 */
export function transcriptToCues(transcript: Pick<AsrTranscript, "segments">): AsrCue[] {
  const cues: AsrCue[] = [];
  const push = (start_ms: number, end_ms: number, text: string) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    const prevEnd = cues.length ? cues[cues.length - 1].end_ms : 0;
    const start = Math.max(start_ms, prevEnd);
    cues.push({ start_ms: start, end_ms: Math.max(end_ms, start + CUE_MIN_MS), text: clean });
  };

  for (const seg of transcript.segments) {
    if (!seg.words.length) {
      push(seg.start_ms, seg.end_ms, seg.text);
      continue;
    }
    let bucket: AsrWord[] = [];
    const flush = () => {
      if (!bucket.length) return;
      push(bucket[0].start_ms, bucket[bucket.length - 1].end_ms, joinWords(bucket));
      bucket = [];
    };
    for (const word of seg.words) {
      if (bucket.length) {
        const startedAt = bucket[0].start_ms;
        const lastEnd = bucket[bucket.length - 1].end_ms;
        const wouldBe = joinWords([...bucket, word]);
        if (
          word.start_ms - lastEnd >= CUE_GAP_MS ||
          word.end_ms - startedAt > CUE_MAX_MS ||
          wouldBe.length > CUE_MAX_CHARS
        ) {
          flush();
        }
      }
      bucket.push(word);
      const text = joinWords(bucket);
      if (SENTENCE_END.test(text) && bucket[bucket.length - 1].end_ms - bucket[0].start_ms >= 1_200) flush();
    }
    flush();
  }
  return cues;
}

/** The cues as a WebVTT the ingest parser reads back; the NOTE names the machine. */
export function cuesToVtt(cues: AsrCue[], note: string): string {
  const head = ["WEBVTT", "", `NOTE ${note.replace(/-->/g, "-- >").replace(/\n\s*\n/g, "\n")}`, ""];
  const body = cues.map((c, i) => `${i + 1}\n${vttTime(c.start_ms)} --> ${vttTime(c.end_ms)}\n${c.text}\n`);
  return head.join("\n") + "\n" + body.join("\n");
}

/**
 * The parsed VTT with every line restored to its EXACT source cue: the
 * generic parser's speaker heuristic must not strip "他说：" or "[Music]"
 * out of machine text, and ASR cannot know speakers — lines land with
 * speaker null until the attribution pass exists. Exported for tests.
 */
export function restoreMachineLines(ingest: IngestResult, cues: AsrCue[]): IngestResult {
  if (ingest.lines.length !== cues.length) {
    throw new DataError("invalid", `transcription round-trip mismatch: ${cues.length} cues parsed to ${ingest.lines.length} lines`);
  }
  return {
    ...ingest,
    lines: ingest.lines.map((l, i) => ({ ...l, speaker: null, text_zh: cues[i].text })),
  };
}

// ---- the run -----------------------------------------------------------------

export type TranscribeOutcome = {
  episode: Episode;
  summary: { lines: number; scenes: number; language: string | null; provider: string; model: string };
  warnings: string[];
  job_id: string;
};

/**
 * Transcribe one script-less episode and attach the result through the
 * normal ingest path. Refuses an episode with no video, an episode that
 * already has lines (a script is never silently replaced), a run already
 * going, and — engine-level, not just in the route — a paid provider under
 * demo replay. `opts.provider` lets tests inject a stub.
 */
export async function runTranscribeEpisode(
  session: Session,
  titleId: string,
  episodeNumber: number,
  opts: { provider?: AsrProvider } = {}
): Promise<TranscribeOutcome> {
  const data = getData();
  const provider = opts.provider ?? asrProvider();
  if (!provider) {
    const avail = asrAvailability();
    throw new DataError("invalid", avail.available ? "no transcription provider" : avail.reason);
  }
  if (provider.name === "openai" && demoReplayActive()) {
    throw new DataError("invalid", "openai transcription is a real model call and demo replay is on (DEMO_REPLAY=0 is the explicit override)");
  }

  const wb = await data.getWorkbench(session, titleId, episodeNumber);
  if (!wb.episode.video_path) throw new DataError("invalid", "this episode has no video — transcription reads the audio track");
  if (wb.lines.length) {
    throw new DataError("conflict", `episode ${episodeNumber} already has a script (${wb.lines.length} lines); transcription only fills an empty episode`);
  }

  // Bookkeeping through the system actor, like the clip engine: producers
  // have no read access to studio.jobs in either backend, and the service
  // role sees a prior failed row so a retry resurrects it in place.
  const sys = systemSession();
  const latest = await data.latestEpisodeJob(sys, titleId, episodeNumber, ASR_JOB_KIND);
  if (jobIsRunning(latest)) throw new DataError("conflict", "a transcription run is already going for this episode");

  const job = await data.recordJob(sys, {
    kind: ASR_JOB_KIND,
    title_id: wb.title.id,
    episode_id: wb.episode.id,
    target_type: "episode",
    target_id: wb.episode.id,
    idempotency_key: `${ASR_JOB_KIND}:${wb.episode.id}:${wb.episode.video_path}:${provider.name}:${provider.model}`,
    provider: provider.name,
    model: provider.model,
    input: { video_path: wb.episode.video_path, provider: provider.name, model: provider.model },
  });

  // The transcription can outlive the 10-minute stale window; heartbeats
  // keep the concurrency guard honest for the whole 8-minute budget.
  const pulse = setInterval(() => void data.heartbeatJob(sys, job.id).catch(() => undefined), HEARTBEAT_MS);
  // The paid call's spend is recorded even when a LATER step fails.
  let billed = 0;
  let usage: { audio_minutes: number } | null = null;
  try {
    const transcript = await withSourceFile(wb.episode.video_path, (srcAbs, workDir) =>
      provider.transcribe({ mediaAbs: srcAbs, workDir })
    );
    billed = provider.costCents(transcript.duration_s);
    usage = { audio_minutes: Math.round((transcript.duration_s / 60) * 100) / 100 };
    const cues = transcriptToCues(transcript);
    if (!cues.length) throw new DataError("invalid", "no speech was found in this episode's audio");

    const vtt = cuesToVtt(cues, `Pulsar Studio machine transcription (asr) | ${provider.name} | ${provider.model} | ${transcript.language ?? "unknown"}`);
    const bytes = new TextEncoder().encode(vtt);
    const ingest = restoreMachineLines(ingestEpisodeFile(bytes, "transcript.vtt"), cues);
    const subtitlePath = await uploadImport(titleId, wb.episode.id, "transcript.vtt", bytes);

    const episode = await data.attachIngestToEpisode(session, titleId, episodeNumber, ingest, {
      subtitlePath,
      scriptFormat: "asr",
    });

    await data.finishJob(sys, job.id, {
      status: "done",
      cost_cents: billed,
      usage,
      output: {
        lines: ingest.lines.length,
        scenes: ingest.scenes.length,
        language: transcript.language,
        provider: provider.name,
        model: provider.model,
        warnings: ingest.warnings,
      },
    });

    // The clips can rank from the script now; force past the completed
    // footage-path run's key. A cutting run that is mid-flight is left
    // alone — the warning tells the producer where the re-rank went.
    const warnings = [...ingest.warnings];
    const cutting = await data.latestEpisodeJob(sys, titleId, episodeNumber, "cut_clips");
    if (jobIsRunning(cutting)) {
      warnings.push("a clip-cutting run was already going; press Cut clips again after it finishes to re-rank from the script");
    } else {
      scheduleClipCut(titleId, episodeNumber, { force: true });
    }

    return {
      episode,
      summary: { lines: ingest.lines.length, scenes: ingest.scenes.length, language: transcript.language, provider: provider.name, model: provider.model },
      warnings,
      job_id: job.id,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Never clobber a done row: if a concurrent run won the race and
    // finished, its record stands and this failure only reaches the caller.
    const cur = await data.latestEpisodeJob(sys, titleId, episodeNumber, ASR_JOB_KIND).catch(() => null);
    if (!(cur && cur.id === job.id && cur.status === "done")) {
      await data.finishJob(sys, job.id, { status: "failed", error: message, cost_cents: billed, usage: usage ?? undefined }).catch(() => undefined);
    }
    throw e;
  } finally {
    clearInterval(pulse);
  }
}
