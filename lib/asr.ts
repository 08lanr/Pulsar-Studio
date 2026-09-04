// ASR is a v1.1 job, not a V1 one (docs/decisions.md: subtitle files are the
// front door; transcribing a video is the fallback when a producer has no
// script). This stub exists so the ingest route and the title page can ask
// "can we transcribe?" today and get a stable "no" with a reason, and so the
// job it becomes already has a name: kind 'transcribe_episode', which
// supabase/migrations/0002_transcribe.sql adds to studio.job_kind. No V1
// code may write a jobs row with that kind (lib/types.ts JobKind).
//
// When it lands: an external ASR API (provider open) on the stored video,
// then an LLM speaker-attribution pass from the character notes, every line
// flagged for a human check, usage.audio_minutes and cost on the job row.

import type { JobKind } from "@/lib/types";

export const ASR_JOB_KIND: Extract<JobKind, "transcribe_episode"> = "transcribe_episode";

export type TranscribeResult =
  | { available: false; reason: string }
  | {
      available: true;
      /** Same shape lib/ingest returns, so the ingest path is shared. */
      lines: { seq: number; start_ms: number; end_ms: number; text_zh: string; speaker: string | null }[];
      warnings: string[];
    };

export function isAsrAvailable(): boolean {
  return false;
}

/** Always unavailable in V1. Callers show the "upload a subtitle file" state. */
export async function transcribeEpisode(_input: {
  titleId: string;
  episodeId: string;
  videoPath: string;
}): Promise<TranscribeResult> {
  return {
    available: false,
    reason: "Transcription from video arrives in v1.1; upload an SRT, VTT or ASS file for this episode.",
  };
}
