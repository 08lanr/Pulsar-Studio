// Forced alignment for "auto-sync from audio": estimate each cue's true
// start/end from the source audio while KEEPING the written Chinese text.
// Provider-based; resolved from STUDIO_ALIGN_PROVIDER, honest unavailable
// state otherwise — alignments are never fabricated.
//
// The first real provider is "local-whisper" (scripts/align_cues.py):
// faster-whisper on CPU transcribes the episode's own audio with word
// timestamps and each cue's characters are matched to the transcript, so
// the known text is fitted to the audio rather than re-transcribed and
// guessed. Configuration in docs/audio-alignment.md.

import { spawn } from "node:child_process";
import path from "node:path";
import { resolveUploadPath } from "@/lib/data/storage";

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

const ALIGN_TIMEOUT_MS = 8 * 60 * 1000;

const localWhisper: AlignmentProvider = {
  name: "local-whisper",
  async alignCues({ videoPath, cues }) {
    const python = process.env.STUDIO_ALIGN_PYTHON || "python";
    const script = path.join(process.cwd(), "scripts", "align_cues.py");
    const job = JSON.stringify({
      video: resolveUploadPath(videoPath),
      cues,
      model: process.env.STUDIO_WHISPER_MODEL || "small",
    });
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(python, [script], { env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += String(d)));
      p.stderr.on("data", (d) => (stderr += String(d)));
      const timer = setTimeout(() => {
        p.kill();
        reject(new Error("alignment timed out after 8 minutes"));
      }, ALIGN_TIMEOUT_MS);
      p.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`could not run ${python}: ${e.message}`));
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`alignment failed: ${stderr.slice(-400) || `exit ${code}`}`));
      });
      p.stdin.write(job, "utf-8");
      p.stdin.end();
    });
    const parsed = JSON.parse(out) as { proposals: AlignmentProposal[] };
    return parsed.proposals;
  },
};

/** Resolve the configured provider. */
export function alignmentProvider(): AlignmentProvider | null {
  if (process.env.STUDIO_ALIGN_PROVIDER === "local-whisper") return localWhisper;
  return null;
}

export function alignmentAvailability(): AlignmentAvailability {
  const p = alignmentProvider();
  if (p) return { available: true, provider: p.name };
  const wanted = process.env.STUDIO_ALIGN_PROVIDER;
  return {
    available: false,
    reason: wanted
      ? `STUDIO_ALIGN_PROVIDER="${wanted}" is not a known provider (known: local-whisper); see docs/audio-alignment.md`
      : "no alignment provider configured (set STUDIO_ALIGN_PROVIDER; see docs/audio-alignment.md)",
  };
}
