# Auto-sync from audio (forced alignment)

The subtitle studio's 从音频自动对轴 action estimates each cue's true
start/end from the episode's own audio while keeping the written Chinese
text untouched. It is provider-based (`lib/align.ts`) and **no provider is
implemented yet**: the button renders in a disabled state with this
document as the pointer, and the API returns `{ available: false }`.
Alignments are never fabricated.

## Contract

`AlignmentProvider.alignCues({ videoPath, cues }) → AlignmentProposal[]`
— one proposal per cue: `{ line_id, old_start_ms, old_end_ms,
new_start_ms, new_end_ms, confidence }`, confidence in 0..1. The studio
shows the proposals as a diff; accepted rows persist through
`POST /api/titles/[id]/episodes/[n]/timing/cues` (never applied silently).

## Configuration (when a provider lands)

Set in `.env.local`:

```
# which provider to use; the only planned first implementation:
STUDIO_ALIGN_PROVIDER=whisperx

# whisperx (local): a python with whisperx installed, plus ffmpeg on PATH
STUDIO_ALIGN_PYTHON=C:\path\to\python.exe
STUDIO_WHISPER_MODEL=large-v3        # or medium for speed
```

A hosted alternative (e.g. an ASR API with word timestamps) would instead
need its API key here; the provider decides. Costs must flow through
`studio.jobs` like every model call (kind `transcribe_episode` is already
reserved by `lib/asr.ts` / migration 0002).

## Why forced alignment, not plain ASR

We already trust the text (the producer wrote or reviewed it); only the
clock is wrong. Forced alignment fits the known text to the audio, which
is more accurate and cheaper than transcribing and re-matching.
