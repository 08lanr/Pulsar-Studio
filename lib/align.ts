// Forced alignment for "auto-sync from audio": estimate each cue's true
// start/end from the source audio while KEEPING the written Chinese text.
// This is the timing sibling of lib/asr.ts (which transcribes text and is
// likewise a v1.1 stub): the provider sits behind an interface, resolved
// from configuration, and with nothing configured the studio shows an
// honest disabled state — never fabricated alignments.
//
// To enable a provider set STUDIO_ALIGN_PROVIDER and its credentials in
// .env.local (documented in docs/audio-alignment.md). The first provider
// will implement `AlignmentProvider` against WhisperX/stable-ts-style
// forced alignment: audio in, per-cue {start_ms, end_ms, confidence} out.

export type AlignmentCue = {
  line_id: string;
  start_ms: number;
  end_ms: number;
  text_zh: string;
};

export type AlignmentProposal = {
  line_id: string;
  old_start_ms: number;
  old_end_ms: number;
  new_start_ms: number;
  new_end_ms: number;
  /** 0..1; how sure the aligner is about this cue's boundaries. */
  confidence: number;
};

export interface AlignmentProvider {
  name: string;
  alignCues(input: { videoPath: string; cues: AlignmentCue[] }): Promise<AlignmentProposal[]>;
}

export type AlignmentAvailability = { available: true; provider: string } | { available: false; reason: string };

/** Resolve the configured provider; none exists in V1. */
export function alignmentProvider(): AlignmentProvider | null {
  // When a provider lands it registers here, keyed on STUDIO_ALIGN_PROVIDER.
  return null;
}

export function alignmentAvailability(): AlignmentAvailability {
  const p = alignmentProvider();
  if (p) return { available: true, provider: p.name };
  const wanted = process.env.STUDIO_ALIGN_PROVIDER;
  return {
    available: false,
    reason: wanted
      ? `STUDIO_ALIGN_PROVIDER="${wanted}" is set but no such provider is implemented yet`
      : "no alignment provider configured (set STUDIO_ALIGN_PROVIDER; see docs/audio-alignment.md)",
  };
}
