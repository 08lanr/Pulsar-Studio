# Transcription for script-less episodes (ASR)

An episode that arrives as video only cannot be adapted and only gets the
footage-signal clip path. The 转写字幕 button on Materials (decision
2026-09-15) reads the episode's audio into timed subtitles: the transcript's
word stream becomes subtitle-shaped cues (broken on silence gaps, sentence
ends and a 42-character width cap), the cues are written to storage as a
real WebVTT with a machine NOTE, the episode's `script_format` becomes
`'asr'`, and the lines attach through the normal ingest path
(`attachIngestToEpisode`, both backends) — scenes, draft version and the
cost-0 parse job exactly as an uploaded SRT would make them. The clip
engine is then re-run so `find_clips` can rank from the script where AI is
enabled.

Never silent (the V1 rule stands): only the button starts it, it refuses an
episode that already has lines, and every line is machine-written and
unreviewed — the studio is where a human checks text and timing, with the
timing desk and auto-sync available for repairs.

## Providers (`lib/asr.ts`, pattern of `lib/align.ts`)

```
# .env.local
STUDIO_ASR_PROVIDER=local-whisper   # or: openai
STUDIO_ASR_PYTHON=C:\path\to\python.exe   # local-whisper; needs faster-whisper
STUDIO_ASR_MODEL=small              # large-v3 = better, much slower on CPU
```

- **local-whisper** — `scripts/transcribe_episode.py`, faster-whisper on
  CPU with word timestamps and VAD, language auto-detected. Spends nothing,
  so it may run in fixture/demo mode the way the ffmpeg burns do.
- **openai** — `whisper-1` with `verbose_json` word/segment timestamps.
  A REAL model call: needs `OPENAI_API_KEY`, demo replay refuses it in the
  engine as well as the route (`DEMO_REPLAY=0` is the explicit override),
  and the job records the audio-minute cost ($0.006/min, rounded up to
  integer cents) — including when a later step fails after the paid call
  succeeded. The audio track is extracted first (ffmpeg, 16 kHz mono AAC):
  the endpoint caps uploads at 25 MB, which an episode master exceeds.

Every run is a `studio.jobs` row of the reserved kind `transcribe_episode`
(migration 0011 adds the SQL enum values `transcribe_episode` and `asr`),
recorded through the system actor like the clip engine — producers never
gain read access to `studio.jobs` — with `usage.audio_minutes`, provider
and model, heartbeats through the run, and provider output validated with
zod before anything downstream reads it. If a clip-cutting run is mid-flight
when the lines land, the response's warnings say to press 重新切片 after it
finishes; otherwise the re-rank is scheduled automatically. Speaker
attribution is a follow-up: ASR hears what was said, not who said it, so
lines are restored to the exact machine cues with `speaker: null`
(`restoreMachineLines` — the generic parser's speaker heuristic never eats
machine text), and the planned LLM pass from the character notes remains
open.

## Smoke run

```
npx tsx scripts/asr-smoke.ts                              # Mandarin demo minute, scored vs its reference SRT
npx tsx scripts/asr-smoke.ts docs/demo/idiots-in-cars/ep2.mp4   # any video
```
