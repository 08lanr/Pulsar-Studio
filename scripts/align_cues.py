# -*- coding: utf-8 -*-
"""Forced alignment for the subtitle studio's auto-sync (lib/align.ts
"local-whisper" provider).

stdin:  {"video": "<absolute media path>", "cues": [{"line_id", "start_ms",
         "end_ms", "text_zh"}, ...], "model": "small"}
stdout: {"proposals": [{"line_id", "old_start_ms", "old_end_ms",
         "new_start_ms", "new_end_ms", "confidence"}, ...]}

We already trust the written Chinese text; only the clock is in question.
faster-whisper transcribes the audio with word timestamps, and each cue's
characters are matched to a window of transcribed characters (greedy,
in order, anchored after the previous cue) — the window's first/last word
times become the proposal, the character-overlap ratio its confidence.
Cues that fail to match are omitted rather than guessed.
"""

import json
import re
import sys

PUNCT = re.compile(r"[\s，。！？、：；「」『』（）\(\)\[\]…·—～\-,.!?:;\"']+")


def clean(s):
    return PUNCT.sub("", s)


def main():
    job = json.load(sys.stdin)
    from faster_whisper import WhisperModel

    model = WhisperModel(job.get("model") or "small", device="cpu", compute_type="int8")
    segments, _info = model.transcribe(
        job["video"], language="zh", word_timestamps=True, vad_filter=True, beam_size=5
    )

    # One flat stream of (char, start_ms, end_ms), each word's chars sharing its window.
    chars = []
    for seg in segments:
        for w in seg.words or []:
            for ch in clean(w.word):
                chars.append((ch, int(w.start * 1000), int(w.end * 1000)))

    proposals = []
    cursor = 0
    for cue in job["cues"]:
        target = clean(cue["text_zh"])
        if not target or not chars:
            continue
        n = len(target)
        best = None  # (score, at)
        lo = max(0, cursor - n * 2)
        hi = min(len(chars), cursor + n * 30 + 40)
        for at in range(lo, max(lo + 1, hi - max(1, n // 2))):
            window = [c[0] for c in chars[at : at + n]]
            hits = sum(1 for a, b in zip(target, window) if a == b)
            score = hits / n
            if best is None or score > best[0]:
                best = (score, at)
            if score >= 0.9:
                break
        if not best or best[0] < 0.5:
            continue
        score, at = best
        end_at = min(len(chars) - 1, at + n - 1)
        start_ms = chars[at][1]
        end_ms = max(chars[end_at][2], start_ms + 300)
        cursor = end_at + 1
        proposals.append(
            {
                "line_id": cue["line_id"],
                "old_start_ms": cue["start_ms"],
                "old_end_ms": cue["end_ms"],
                "new_start_ms": start_ms,
                "new_end_ms": end_ms,
                "confidence": round(score, 3),
            }
        )

    json.dump({"proposals": proposals}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
