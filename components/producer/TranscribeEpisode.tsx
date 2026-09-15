"use client";

// The transcribe action for a script-less episode on Materials (decision
// 2026-09-15): one explicit button — never silent — that reads the audio
// track into timed subtitles and refreshes the page when the lines land.
// Rendered only when the episode has a video and no lines yet; when no
// provider is configured the button is disabled with portal words and the
// technical reason on hover, the auto-sync pattern.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/api-client";
import { useT } from "@/components/locale";

type Props = {
  titleId: string;
  episodeNumber: number;
  available: boolean;
  /** Developer-facing reason when unavailable; shown on hover only. */
  reason?: string;
};

type Reply = {
  error?: string;
  code?: string;
  summary?: { lines: number; scenes: number; language: string | null };
  warnings?: string[];
};

export default function TranscribeEpisode({ titleId, episodeNumber, available, reason }: Props) {
  const { tt } = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  async function transcribe() {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<Reply>(`/api/titles/${titleId}/episodes/${episodeNumber}/transcribe`, {});
      if (r.error) {
        setError(r.code === "asr_unavailable" ? tt("tr.unavailable") : tt("tr.failed", { detail: r.error }));
        return;
      }
      setDone(r.summary?.lines ?? 0);
      router.refresh();
    } catch (e) {
      setError(tt("tr.failed", { detail: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  }

  if (done !== null) return <p className="hint" role="status">{tt("tr.done", { n: done })}</p>;
  return (
    <div className="ep-transcribe">
      <button
        type="button"
        className="btn btn-outline btn-sm"
        disabled={busy || !available}
        title={!available ? reason : undefined}
        onClick={transcribe}
      >
        {busy ? <><span className="spinner" /> {tt("tr.busy")}</> : tt("tr.cta")}
      </button>
      <span className="hint">{available ? tt("tr.hint") : tt("tr.unavailable")}</span>
      {error && <p className="err" role="alert">{error}</p>}
    </div>
  );
}
