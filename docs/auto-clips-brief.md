# Brief for Claude Code: ad clips cut automatically after an episode upload

Repository: Pulsar-Studio. Read `CLAUDE.md` and the top of `docs/decisions.md` first; every rule there still applies. This brief was written from a read of the current code on 2026-09-14, so file and function names below are the real ones.

## What we are building and why

Today "Generate ads" in a campaign does not look at the drama. `generatePromoDrafts` (in both `lib/data/fixture.ts` around line 1895 and `lib/data/supabase.ts` around line 1126) creates five creatives from fixed strings and arithmetic: creative N starts at N x 4 seconds and runs 18 or 24 seconds, the hook is one of two literal sentences, the caption is a template. `lib/promote/render.ts` then cuts that range, crops to 9:16 and burns the hook. The one real selection tool, `runFindClips` in `lib/jobs.ts` (prompt in `lib/prompts/find-clips.ts`), ranks moments from the subtitle text but is only reachable from the staff creative pack and is never used by the producer flow.

The founders want this: when an episode is uploaded, Studio cuts a set of short vertical ad clips from it automatically, in the background, and shows them on the title's Materials page with a download link, ready to use in a Meta or TikTok ad. When a campaign later presses Generate ads, the five creatives come from these clips instead of the arithmetic.

Decisions already made by the founders (do not re-open them):

1. Inputs: video plus subtitles when an SRT exists (script-based ranking with the existing `find_clips` model), footage-only signals as the fallback when there is no subtitle file.
2. Output: several single-cut clips per episode, 9:16, 1080x1920, 9 to 25 seconds each. No montage in this version.
3. Trigger: automatically after an episode upload completes. A manual "Cut clips again" button also exists.
4. The producer downloads the files for Meta. Studio does not launch on Meta; the TikTok launch path is unchanged.

## Where the code goes

### 1. Data model: renders live on the existing `studio.clips` rows

Reuse the `Clip` type in `lib/types.ts` (rank, start_ms, end_ms, hook_en, why_en, why_zh, opening_text_en, cut_length_s, angle, status, job_id). Add these fields to `Clip` and to the table:

- `source: "script" | "footage"` (how the moment was chosen)
- `render_path: string | null` (storage path, same convention as `PromoCreative.render_path`)
- `render_sha256: string | null`
- `render_status: "pending" | "rendered" | "failed"`
- `render_note: string | null` (the failure reason, shown to the producer)
- `duration_ms: number | null`, `width`, `height`

Migration `supabase/migrations/0010_clip_renders.sql`: `alter table studio.clips add column ...` with defaults (`render_status` default `pending`, `source` default `script`), idempotent (`add column if not exists`), plus grants matching `0009_grants.sql`. Fixture side: extend the fixture store rows and the demo seed with the same fields (existing seed clips get `source: "script"`, `render_status: "pending"`).

Clips must become readable by producers for their own titles. Today `listClips` is used from the staff pack. Add to the data interface in `lib/data/index.ts`:

- `listEpisodeClips(session, titleId, episodeNumber): Promise<Clip[]>` (producer or staff; producer scoped by `requireTitleEditor` / the RLS policy; foreign titles are not found, never forbidden)
- `setClipRender(session, clipId, { render_path, render_sha256, duration_ms, width, height, render_status, render_note })`
- `replaceEpisodeClips(session, episodeId, rows)` if `upsertClips` does not already replace the suggested set for an episode (check its semantics: the comment on `FindClipsResult` says suggested rows are replaced, shortlisted and dismissed kept; keep that)

Both backends must behave the same, including authorization failures.

### 2. Selection: `lib/clips/select.ts`

One entry point: `selectClipRanges(session, titleId, episodeNumber): Promise<{ source: "script" | "footage"; rows: NewClip[] }>`.

Script path (episode `has_timecodes` and `lines_total > 0`, and `isLlmAvailable()` is true and model calls are allowed): call the existing `runFindClips`. It already writes ranked `Clip` rows with real cue timecodes and a hook. Use its output as is. Keep its idempotency key; pass `force` through from the manual button.

Footage path (no timecodes, no lines, no provider key, or fixture replay mode refusing model calls): compute signals with ffmpeg and pick windows. Put the pure scoring in `lib/clips/footage.ts` so it is unit-testable without ffmpeg:

- Scene cuts: `ffmpeg -i src -vf "select='gt(scene,0.30)',showinfo" -an -f null -` and parse `pts_time` from stderr.
- Loudness: `ffmpeg -i src -af "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level" -f null -` parsed per second (or `ebur128` momentary loudness; either is fine, pick one and document it).
- `scoreWindows(cuts: number[], loudness: {t: number; db: number}[], durationMs: number, opts)`: slide a window of 15 seconds in 1 second steps; score = normalized loudness peak in the window plus normalized count of scene cuts in the window; snap the window start to the nearest scene cut within 1.5 seconds before it when one exists. Return the top 6 non-overlapping windows, strongest first, minimum gap 3 seconds. Windows never extend past `durationMs`.
- Rows from this path carry `hook_en: ""`, `why_en: "Chosen from footage signals (scene cuts and loudness); no script was available"`, `why_zh: "根据画面切换和音量选出，没有台词可参考"`, `opening_text_en: null`, `angle: null`, `source: "footage"`. Never invent a hook or a plot claim on this path; the evidence rules in `CLAUDE.md` apply to copy as much as to numbers.

When both exist, the script path wins; optionally snap each script range's start to the nearest scene cut within 1.5 seconds (nice to have, behind a flag, not required).

### 3. Render: `lib/clips/cut.ts`

Generalize `renderAd` from `lib/promote/render.ts` into a shared function and have both callers use it:

`cutClip({ sourcePath, startMs, endMs, hook, captionsSrt, storedName }): Promise<RenderedAd>`

Behavior, same as today's `renderAd` plus captions:

- `-ss start -to end`, scale to cover 1080x1920 then center crop, libx264 veryfast crf 23, yuv420p, faststart, aac 128k. Output MP4 H.264 + AAC, which is what Meta and TikTok accept.
- Hook: first 3 seconds, top third, bold, outlined, via the `subtitles=` filter with `force_style`, exactly as now. Keep the hook inside Meta's Reels safe zone: leave the top 14 percent and the bottom 35 percent of the frame clear of text. Today's `MarginV=140` with `Alignment=8` is inside the top band; move it to about `MarginV=300` (the top 14 percent of 1920 is 269 px). Empty hook means no hook layer.
- Captions (new): when `captionsSrt` is given, burn it as a second `subtitles=` filter, bottom-center, `MarginV` about 700 so it sits above the bottom 35 percent band. The SRT passed in must already be offset to the clip (cue times minus `startMs`, cues outside the range dropped, partial cues clipped). Write the offset helper as a pure function `offsetSrt(cues, startMs, endMs)` in `lib/clips/captions.ts` and unit-test it.
- Which captions: only English. If the episode has an approved snapshot, use `styledSrt(scenes, "en")` from `lib/subtitle-video.ts` (adapted English). If there is an in-review or draft version with English lines, use that and say so in `render_note` ("captions from draft English"). If there is no English at all, render without captions. Never burn the Chinese source into an ad.
- Store at `<title_id>/<episode_id>/clip-<clip external_id>.mp4` through `putStoredBytes`, hash with sha256, and record `duration_ms`, width, height. Output for `renderAd` (campaign creatives) keeps its current path convention.
- Windows path escaping (`ffPath`) stays. Temp dir cleanup stays. The 5 minute timeout stays.

### 4. The job: `lib/clips/run.ts`

`cutEpisodeClips(episodeId, { force }): Promise<{ selected: number; rendered: number; failed: string[] }>`, run with `systemSession()` in the background like `renderCampaign` in `lib/promote/generate.ts` (fire and forget, errors logged, safe to re-run).

Steps: check `ffmpegAvailable()` (from `lib/promote/render.ts`; reuse, do not duplicate) and fail the whole run with `render_note = "ffmpeg is not installed on this machine"` on every row if absent; select; write rows with `render_status: "pending"`; render each in rank order; `setClipRender` after each; never leave a row without a terminal status.

Record the run as a `studio.jobs` row of kind `cut_clips` (input: episode id, source path, selection source; `cost_cents` 0 for the footage path; the script path's cost is already on the `find_clips` job). Idempotency key `cut_clips:<episode_id>:<video_path>:<clip_prompt_version>`; `force` appends a random suffix like `runFindClips` does. One run per episode at a time: if a `cut_clips` job for the episode is `running`, return without starting another.

Fixture mode: this runs real ffmpeg on the local file under `.uploads/`, which is fine and needs no key. It must not call a model unless `DEMO_REPLAY=0` and a key are set (`assertModelCallsAllowed` already enforces this; catch its error and take the footage path). `PROMO_RENDER=off` disables rendering for tests, same as today.

### 5. Triggers

Call `void cutEpisodeClips(episode.id).catch(log)` after the episode is saved in these three places, all of which already exist:

- `app/api/titles/[id]/ingest/route.ts` when a video was part of the upload (both the video-only branch and the subtitles-plus-video branch)
- `app/api/titles/[id]/episodes/[n]/video/route.ts` (attach or replace a video) with `force: true`, because the footage changed
- the producer-side upload route under `app/api/producer/titles/[id]/episodes/[n]/` if it stores video separately from the two above (check `components/producer/UploadEpisodes.tsx` to see which route the producer uploader posts to; add the trigger where the video is actually stored, once, not twice)

New producer routes, following the shared handler and API guard pattern (same-origin guard, role check, zod, data layer, JSON):

- `GET /api/producer/titles/[id]/episodes/[n]/clips` returns the clips with `download_url: mediaUrl(render_path)` and the run state
- `POST /api/producer/titles/[id]/episodes/[n]/clips` with body `{ force?: boolean }` starts a run (reviewer role or above); returns 202 with the job id; 409 if a run is already going

Run state for the UI, derived, no new column on episodes: `none` (no clips, no job), `cutting` (latest `cut_clips` job running or any row pending), `ready` (at least one rendered), `failed` (latest job failed or every row failed, with the note).

### 6. Campaign generation uses the clips

In both `generatePromoDrafts` implementations: before the arithmetic, load the title's rendered clips (`render_status = "rendered"`, ordered by episode number then rank). If there are at least one, build the five creatives from the top five (fewer if fewer exist, minimum one): `kind: "direct_clip"`, `hypothesis: clip.why_en`, `source_episode_id`, `source_start_ms`, `source_end_ms` from the clip, `hook: clip.hook_en`, caption and ad_description as today (templated from the title name; do not invent plot), and copy `render_path`, `render_sha256`, `duration_ms`, width, height from the clip with `render_settings: { schema: 3, format: "9:16", source: "auto_clip", clip_id }` so `renderCampaign` skips them (it already skips creatives with a `render_path`). Fall back to the current arithmetic only when no rendered clips exist, and set the campaign `status_note` to say the ads were cut at fixed offsets because no clips were available. The manifest, approval and launch invariants are untouched: the approved creative still freezes an exact file hash.

### 7. Materials page

`app/(producer)/producer/titles/[id]/materials/page.tsx`: under each episode row add an "Ad clips" block: state pill (cutting / n ready / failed with the note), then one row per clip: rank, time range (mm:ss to mm:ss), the hook (or "no hook, add one in the campaign" when empty), the angle when present, a "why" line marked 推断 / inferred, and two actions: Download (link to `download_url`, `download` attribute) and Preview (opens the media URL). A "Cut clips again" button posts `force: true`. The page polls every 5 seconds while the state is `cutting` (a small client component, same approach as the campaign page polling while `generating`).

Copy rules: Chinese chrome per `docs/terminology.md` (你 not 您, 剧集 for the title, 分集 for the episode, half-width space between CJK and Latin). Add keys under `locales/_keys/` and run `node scripts/merge-locales.mjs`. Proposed keys: `clips.title` "广告切片" / "Ad clips", `clips.state.cutting` "正在切片" / "Cutting clips", `clips.state.ready` "{n} 条可用" / "{n} ready", `clips.state.failed` "切片失败" / "Cutting failed", `clips.state.none` "还没有切片" / "No clips yet", `clips.again` "重新切片" / "Cut clips again", `clips.download` "下载" / "Download", `clips.noHook` "没有开场文字，可在广告活动中添加" / "No hook text; add one in the campaign", `clips.whyFootage` for the footage-path explanation. Fixed-width action column, buttons never wrap (decision 2026-09-08 "final UI/UX pass").

### 8. Fixture seed and demo

The demo journey must keep passing unchanged. Do not run the cutter on `POST /api/demo/reset`. The seed's demo titles can carry a few pre-made `Clip` rows with `render_status: "rendered"` pointing at the existing demo file (the fixture store already hard-links `docs/demo/xiangyuan-ep1.mp4` under `.uploads/`), so the Materials page shows the block in the rehearsal without ffmpeg having to run. Mark those rows `source: "script"` with hooks from `data/fixture/canned.ts` style copy. The e2e (`tests/e2e/demo-journey.spec.ts`) may gain one assertion that the Materials page shows the Ad clips block; nothing else in the journey changes.

## Tests

- `tests/clips-footage.test.ts`: `scoreWindows` picks the loudest, most cut-dense windows, returns non-overlapping ranges strongest first, snaps to a scene cut within 1.5 seconds, never exceeds the duration, returns fewer than 6 when the episode is short.
- `tests/clips-captions.test.ts`: `offsetSrt` drops cues outside the range, clips partial cues, re-numbers, and offsets times by the start.
- `tests/clips-run.test.ts` with `PROMO_RENDER=off`: a run on an episode without ffmpeg ends with every row `failed` and a note; a run on a timed episode in replay mode takes the footage path (no model call); a second run while one is running is refused.
- `tests/promote-from-clips.test.ts`: `generatePromoDrafts` builds creatives from rendered clips with the clip's hash and skips re-rendering; falls back to the arithmetic with a status note when there are none.
- Existing suites unchanged.

## Checks before reporting done

`npm test`, `npm run typecheck`, `npx next lint`, `npm run build`, `npm run test:e2e` (both viewports), and one real walk in fixture mode with ffmpeg on PATH:

1. New title, upload `docs/demo/xiangyuan-ep1.mp4` with `docs/demo/xiangyuan-ep1.srt`. Within a few minutes the Materials page shows clips, each file is 1080x1920 H.264/AAC, 9 to 25 seconds, hook burned in the top area below the 14 percent line, and (with `DEMO_REPLAY=0` and a key) the hooks come from `find_clips`; in replay mode the footage path runs and the rows say so.
2. New title, upload the video alone. Six clips appear, no hook text, why line says footage signals.
3. New campaign on that title, Generate ads: the five creatives carry the clip ranges and hooks, no re-render, the approve and launch steps behave as before on the fake TikTok.
4. Download one clip and open it in a media player; check the crop and the text position.

## Documentation

Add an entry at the top of `docs/decisions.md` (dated, "Decided by the founders (Ruobin)") describing: automatic clip cutting after upload, script-first selection with a footage fallback, single 9:16 cuts of 9 to 25 seconds, campaigns built from the clips, Meta safe zones, and what is deliberately not done (montage, 4:5 feed variant, voiceover, Meta launch from Studio). Update the "Current product boundary" section of `CLAUDE.md` with two sentences: clips are cut by `lib/clips/*` after upload; `generatePromoDrafts` prefers rendered clips and falls back to fixed offsets with a note. This feature displays no numbers, so `lib/research/registry.ts` is untouched.

## Out of scope for this brief

Montage assembly, a 4:5 feed variant, voiceover or music, AI-written captions on the footage path, launching on Meta from Studio, moving renders off the web server into a worker (note it as the next step once more than one producer uploads at once).
