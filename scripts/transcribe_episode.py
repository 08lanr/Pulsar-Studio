# -*- coding: utf-8 -*-
"""Transcription for lib/asr.ts's "local-whisper" provider (decision
2026-09-15: transcription is an explicit button, never silent).

stdin:  {"video": "<absolute media path>", "model": "small",
         "language": "zh" | null}
stdout: {"language": "zh", "duration_s": 61.9, "segments": [{"start_ms",
         "end_ms", "text", "words": [{"w", "start_ms", "end_ms"}, ...]}, ...]}

faster-whisper on CPU with word timestamps and VAD; language is
auto-detected when not given. The word stream is the payload — lib/asr.ts
builds subtitle cues from it (gaps, sentence ends, length caps), so this
script stays a thin, honest reading of the audio. Sibling of
scripts/align_cues.py, which fits KNOWN text to audio; this one has no text
to trust and writes down what it hears.
"""

import json
import sys


def main():
    job = json.load(sys.stdin)
    from faster_whisper import WhisperModel

    model = WhisperModel(job.get("model") or "small", device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        job["video"],
        language=job.get("language") or None,
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
    )

    out = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        out.append(
            {
                "start_ms": int(seg.start * 1000),
                "end_ms": int(seg.end * 1000),
                "text": text,
                "words": [
                    {"w": w.word, "start_ms": int(w.start * 1000), "end_ms": int(w.end * 1000)}
                    for w in (seg.words or [])
                ],
            }
        )

    json.dump(
        {
            "language": info.language,
            "duration_s": round(float(info.duration or 0.0), 3),
            "segments": out,
        },
        sys.stdout,
        ensure_ascii=False,
    )


if __name__ == "__main__":
    main()
