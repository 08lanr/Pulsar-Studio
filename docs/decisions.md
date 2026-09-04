# Decisions log

Newest first. A decision here overrides anything older in `PRODUCT.md`,
`docs/build-plan.md`, `docs/data-model.md` or `docs/build-context-review.md`
until those files are brought in line.

## 2026-09-04 · Demo readiness: five fixes before a producer sees it alone

Decided by the founders (Ruobin): "fix these things for the demo", from the
repo review's must-fix list.

- **Overlaps are fixable from the sheet.** QC still treats an overlap as an
  error, but the QC row now offers 修正时间 and 「AI 修复全部」 handles overlaps
  first: the previous cue's end is trimmed to a two-frame gap (never below a
  300 ms cue; if that is not enough the current cue's start moves too), in
  one batched `POST …/timing/cues`. No producer is blocked on a real SRT any
  more; the full timing desk still lives after finalize.
- **Pulsar's spend never reaches a producer.** First-pass, rewrite and
  alternatives return the job row (usage, cost, prompt input) to staff
  sessions only.
- **Demo replay cannot spend money.** `demoReplayActive()` moved to
  `lib/data-source.ts` and `runJob` — the single choke point for every model
  call — refuses while it is on, with a producer-readable message. Rewrite,
  pack and clips were previously unguarded; `tests/demo-guard.test.ts` pins it.
- **One word for finalize: 定稿 / Finalize.** The button, the confirm step,
  the title-page progress card, the version pill and the done banner all say
  it. The title-page step strip says 审阅修改, not 逐场确认; the sheet header
  says 双语剧本 and "click a timestamp to jump and edit", not "review or
  comment". Engineering copy (API keys, DEMO_REPLAY, "demo mode" as an
  excuse) is gone from producer strings. The producer home uses producer
  words for status (待确认, not 制片方审核中).
- **The header cannot contradict the QC card.** With every line adapted but
  errors remaining, the command strip reads 「还有 N 处必须修复」 in a warning
  tone; 「可以定稿了」 appears only when preflight is clean.

## 2026-09-04 · Training the translator: a knowledge layer in authority order

Decided by the founders (Ruobin): "improve translation right now, and improve
it over time as we translate more scripts, using online sources." The Tatoeba
seed (below) was the first attempt; a probe against the founder's own 24 lines
showed bigram-Dice retrieval returning unrelated textbook sentences ("We're
going to paint the wall" for 咱们准备开始汇报) in the wrong register, so the
approach was reshaped rather than removed.

- **One knowledge layer, `lib/memory`, gathered per scene (or per line) and
  rendered as prompt blocks in this authority order:**
  1. *Approved memory* — producer-approved lines from immutable snapshots
     (house truth). Lines the producer wrote or corrected by hand rank higher
     and are labelled `producer-edited`; they are the strongest signal of the
     voice the producer wants. This is the corpus that compounds.
  2. *House exemplars* — the Pulsar-authored demo bank (`data/fixture/canned*.ts`)
     is now also the house-style corpus: literal → studio line → key phrase →
     why, so the model sees the MOVE, not just a target sentence.
  3. *Register guide* — `lib/memory/idioms.ts`, an authored table of set
     phrases, forms of address and genre beats (久仰, 辛苦了, X总, 丫头, 撤单,
     白月光 …) with how American series say them and when. Exact containment,
     so it never misfires.
  4. *Glosses* — CC-CEDICT (CC BY-SA 4.0) filtered to idioms, marked usages
     and 4+ character set phrases (`npm run memory:import:cedict`). Meaning
     only; the prompt says so.
  5. *Reference pairs* — Tatoeba, now near-exact matches only (≥ 0.55) and at
     most three; lowest authority.
- **Retrieval is IDF-weighted bigram cosine** (`lib/memory/rank.ts`) for every
  corpus: shared function characters no longer make a match.
- **Knowledge blocks sit AFTER the cached system blocks** (bible, rules), so
  the two cache breakpoints have stable prefixes again. The Tatoeba and CEDICT
  files load lazily; routes that never write a line do not carry them.
- **Idempotency keys are stable** (`first_pass:version:scene:PROMPT_VERSION`);
  what was retrieved is recorded on the job as counts plus a fingerprint. A
  memory that grew since the last click must not silently regenerate a scene
  the producer already edited. `PROMPT_VERSION` is `v4`.
- **Alternatives and rewrites get the per-line knowledge too** (approved,
  house, register guide, glosses; no Tatoeba).
- **Approved-memory scope:** Studio-wide, as the seed-memory entry already
  decided; CLAUDE.md is aligned. A producer's rows never appear in another
  producer's route response — they only inform the prompt.
- Tests: `tests/memory.test.ts`, `tests/reference-memory.test.ts` (pins the
  probe lines to zero Tatoeba hits), `tests/translation-memory.test.ts`.

## 2026-09-04 · Tags become the dial: two takes, then "take it another direction"

Decided by the founders (Ruobin), in session, after a review noted the tone
tags (更精炼 / 更口语 / 更情感化 …) were the product's clearest evidence of
*how* it helps and yet rendered as passive grey chips nobody looked at.

- **Alternatives are TWO, not three**, and each leans into a different
  direction: the first tag on a take names it and is rendered filled at the
  top of the card, so the two read as "a more emotional one, a more direct
  one" rather than an anonymous list. The prompt (`lib/prompts/alternatives.ts`)
  enforces the count and the spread; the bank serves its first two.
- **The dial appears after alternatives, not before.** The default panel stays
  quiet (applied tags, edit box, one button). Once the producer opens
  备选说法 and neither take fits, a row 「都不合适？换个方向再写一版」 lists
  the tags nobody has tried on this line — not on the current take, not on any
  alternative — and tapping one requests **one more take that commits to that
  tag** (`POST …/alternatives` with `{ direction }`; new idempotency batch,
  suffixed with the tag; the `check` refuses a take missing it).
- **A tapped direction lands in the edit box like picking an alternative
  does** — it is written as an alternative row, auto-picked, and nothing
  commits until 保存本句. The confirm contract is unchanged.
- **Demo mode:** a direction pulls the first unused bank entry carrying that
  tag, else the first unused entry at all, else answers `available: false`
  and the UI says so. `tests/alternatives.test.ts` pins the prompt shapes
  and the replay behaviour.

## 2026-09-04 · Licensed seed memory

Translation retrieval no longer starts empty while the Studio approval corpus
is young.

- **Tatoeba seeds the corpus.** A refreshable, attributed Mandarin-English
  subset comes from Tatoeba's official API. Both sides must be approved,
  non-orphaned, directly linked, and owned by self-identified native speakers;
  only Simplified Chinese and subtitle-sized pairs are kept.
- **Authority is explicit.** Studio-approved memory remains house truth and
  ranks separately. Tatoeba examples are lower-trust vocabulary and idiom
  hints only; the prompt warns that community data can be wrong and forbids
  importing its names, story facts, relationships, or character voice.
- **License provenance stays attached.** Every pair retains both sentence IDs,
  contributor usernames, and per-sentence licenses. The corpus is generated
  with `npm run memory:import:tatoeba` and documented in `data/reference`.
- **No live production dependency.** Translation jobs retrieve locally from
  the bundled snapshot; they do not wait on Tatoeba or send studio scripts to
  Tatoeba.

## 2026-09-04 · Approved-script memory + provider-neutral LLM gateway

Translation quality now compounds from producer decisions instead of starting
from a generic prompt on every title.

- **Approved snapshots are the translation memory.** The first pass derives
  Chinese/English pairs from immutable `approved` version snapshots, ranks a
  small relevant set for each scene, and includes them as style and character-
  voice evidence. Retrieval spans Studio's approved corpus across producers;
  it remains server-only, same-title matches rank higher, and the prompt
  explicitly forbids importing old plot facts.
- **No duplicate memory table yet.** The approval snapshot remains the source
  of truth. A dedicated glossary/import surface can be added for historical
  scripts and exact terminology without copying current approved rows.
- **Provider-neutral calls.** `LLM_PROVIDER=anthropic|openai` selects one
  structured-output gateway. Both paths use the existing Zod contract,
  semantic validation, one repair attempt, retry taxonomy, usage accounting,
  and `studio.jobs.provider`. Fixture replay remains deterministic and never
  calls either API.
- **OpenAI path.** The OpenAI provider uses the Responses API with strict
  structured output; `OPENAI_API_KEY` is separate from a ChatGPT subscription.
  The default strong/fast models remain overrideable with
  `LLM_MODEL_STRONG` / `LLM_MODEL_FAST`.

## 2026-09-04 · The timing desk: offsets, per-cue trims, honest auto-sync

Built from a structured spec after the founder's footage ran ~500 ms late
(the burned-sub extraction sampled at 2 fps). Timing is now a first-class
control in the subtitle studio, not a re-ingest.

- **Pure math in `lib/subtitle-timing.ts`:** global offset (clamp starts at
  0, keep durations, push a clamp-pileup later — pre-existing overlaps pass
  through for QC), per-cue validation, the studio's warning list (overlap /
  reversed / <300 ms / past-video), `preciseTimecode`.
- **Explicit APIs, distinct from the stamp-repair `/retime`:**
  `POST …/timing/offset` (signed ms, ±1 min bound) and
  `POST …/timing/cues` (batched millisecond edits). Both live in the data
  layer for fixture AND Supabase (direct row updates; no schema change),
  mirror adapted rows and episode duration, and on an approved version run
  the shared fork→QC→refinalize tail (`app/api/titles/_lib/refinalize.ts`,
  which `/retime` now also uses). Offsets land in the rows exactly once —
  exports and burns never re-apply them.
- **The studio's timing desk:** ±100/±500 buttons plus an exact-ms field
  with the pending shift previewed live before applying; a per-cue editor
  (ms start/end, set-to-playhead, , / . nudges with Shift for 500 ms,
  undo per cue / all — edits stay client-side until saved in one batch);
  a playback desk (loop-current-cue, 0.5–1.5x, play-from-2s-before);
  inline warnings that click through to their cue.
- **Auto-sync from audio is an interface, not a fake:** `lib/align.ts`
  defines the forced-alignment provider contract and resolves from
  `STUDIO_ALIGN_PROVIDER`; none is implemented, so the button renders
  disabled with the reason and `docs/audio-alignment.md` documents the
  setup. The review-diff UI (per-cue accept/reject, confidence) is built
  and only ever shows real proposals.
- **Applied:** -500 ms to the founder's live episode (24 cues, none
  clamped, auto-refinalized). The bundled demo SRT was left alone — it
  already opens at 0:00.05 and a blanket shift would pile its head cues.
- ESLint was configured (eslint 8 + next/core-web-vitals) — `npm run lint`
  now actually runs; `.codex-tools/` and `video_output/` are gitignored.

## 2026-09-05 · Delivery stage two: the subtitle studio

Decided by the founders (Ruobin), in session: "first we finalize the
script, and then we finalize the subtitles (leaves room for fonts,
english + chinese, etc.)".

- **Subtitles are their own stage and page** — `/producer/titles/[id]/
  episodes/[n]/subtitles`, unlocked only once the script version is
  `approved` (a draft shows a pointer back to the episode studio, so the
  frozen script and the delivered video can never drift apart).
- **Live styled preview:** the studio's player renders the current cue as
  an overlay restyled instantly by the controls — content (English only /
  English + Chinese bilingual), font (sans / serif), size (S/M/L). The
  burn uses the SAME mapping (`lib/subtitle-video.ts`: Arial/Georgia for
  English, Microsoft YaHei/SimSun when bilingual so CJK glyphs render).
- **Deliverables live here:** the styled burned MP4 (route accepts the
  style options), SRT/VTT downloads, and the script report. The episode
  workspace's finalized card now points here instead of burning directly.
- **UI adopted:** the title-page flow is five steps (上传剧本 → AI 改编 →
  审阅修改 → 定稿 → 字幕交付); an approved episode's row action becomes
  制作字幕 and links straight into the studio.
- **Untimed episodes say so in words:** a plain-text script upload has no
  timecodes, so the studio explains that subtitles need SRT/VTT/ASS-timed
  lines (instead of a failing button), and still offers the script report.

## 2026-09-04 (late) · QC preflight + old-era consolidation

Prioritized by the founders from an outside product review ("which one do
you want to do / prioritize?"); built in session.

- **Subtitle QC preflight** (`lib/qc.ts`, pure functions): the checks a
  subtitle house runs before delivery — coverage (missing/empty lines),
  reading speed (error > 20 cps, warn > 17), line shape (≤ 42 chars/line,
  ≤ 2 lines), cue duration (700 ms – 7 s), overlaps (error) and hairline
  gaps (< 80 ms, warn), missing rationale, character-name spelling drift.
- **Errors block finalize; warnings ship visibly.** The finalize route runs
  `runQc` and returns 409 `qc_failed` with the report; the producer studio
  shows a live 交付预检 card in the right rail (issues click-through to
  their line) and disables the finalize button while errors remain.
- **Consolidation of pre-V2 remnants:** SQL `finalize_version` (migration
  0002) no longer requires scene confirms, matching the fixture;
  `dub_source_path` is gone everywhere (types, fixture, Supabase layer,
  SQL, subtitle-video source pick); the unused producer `ReviewScreen` is
  deleted; README / CLAUDE.md / PRODUCT.md now describe the subtitles-first
  flow (PRODUCT.md carries a status note rather than a rewrite).

## 2026-09-04 · The 审阅与修改 panel, final shape

Decided by the founders (Ruobin), in session, iterating on the live portal.

- **The panel sits level with the timestamps.** Viewer + timeline + scene
  strip run full width on top; below them the bilingual script sheet (left)
  and the 审阅与修改 panel (right, sticky) share one eye-line.
- **Panel order, top to bottom:** 为什么这样改编 + tone + tag chips → the
  English line in a clearly-labeled editable box (英文台词——可直接修改) →
  a 查看备选说法 button → **exactly 3 alternatives**, each an English line
  plus the vibe/why it could work → **确认修改**. Tapping an alternative
  fills the box; nothing commits until confirm; on confirm the script sheet
  on the left updates. Only the English ever changes — the Chinese column is
  untouchable.
- **No back-translation in the panel** (it stays in the bilingual diff
  export). No autosave — the confirm button is the contract.
- The alternatives prompt now asks for exactly 3; the demo bank carries 3
  per key line (including the slide-7 example line in episode 2).

## 2026-09-04 (night) · 向园 deleted; the seed is empty

The stale in-memory 向园 still pointed at a dubbed video from the retired
TTS experiments — "completely wrong". Removed at the founder's request:

- **The fixture seeds NOTHING** (producer + login personas only). The portal
  opens on the 新建剧集 card; the demo starts from the founder's own upload
  of `docs/demo/xiangyuan-ep1.srt` + `xiangyuan-ep1.mp4` (the clean,
  never-dubbed 720p cut). The replay bank still answers 生成 for that
  footage, so the flow works offline end to end.
- `.uploads/` purged (every dubbed/subtitled/test file), the seeded-title
  module deleted, tests rebuilt to construct their state through the real
  pipeline (tests/seed-minute.ts). A server restart clears any old in-memory
  titles.

## 2026-09-04 (night) · Subtitles, not dubbing — the V2 rework

Decided by the founders (Ruobin) after hearing the dub: localization ships
as SUBTITLES. "The intention of this application is to give producers the
ability to localize their scripts for America" — dubbing is out entirely.

- **Dubbing removed** (route, runner, script, button, job kind). The
  TTS demo is retired; edge-tts venv left on disk, unused.
- **The episode screen is built around reading the script.** No scenes: one
  continuous scrolling sheet; the right rail (compact player + 审阅与修改
  panel + media/export actions) stays on screen while the sheet scrolls.
  Finalize moved to the header and no longer requires scene confirms —
  content readiness (every line adapted, changed lines carrying their
  Chinese rationale) is the whole gate. Scene rows remain in the schema as
  segmentation bookkeeping only.
- **Columns are ORIGINAL vs ADAPTED.** Original = the Chinese line with its
  literal English underneath; Adapted = our American rewrite with the key
  phrase highlighted and WHY THIS CHANGE on the row beneath (the flagship;
  derived from the script alone for now — video ingestion for tone comes
  later).
- **Deliverables:** `format=script` — the clean report, JUST the English
  script (timecode · speaker · line) with a stats row (lines · words ·
  runtime); and `POST .../subtitle-video` — the episode's video with the
  adapted English burned in (ffmpeg, original audio untouched). Producer
  export surface is exactly those two.
- **Upload wording:** 添加单集 / "Add new episodes"; one row per episode
  (number + subtitle/script file + optional video), video field now in the
  new-title form too.
- **Fresh seed:** the fixture ships ONE title — minute one of the founder's
  footage (向园, `data/fixture/xiangyuan.ts`), ingested and untouched, so
  the demo opens on the 生成 moment. 爱在旅途 and the pack/clips/jobs seed
  data are retired (files deleted; their replay entries remain in canned.ts
  so the old demo SRTs still work if re-uploaded). Tests rebuilt around the
  new seed and the real pipeline (33 passing).

## 2026-09-04 · The founder's own footage in the demo

Minute one of the founder's 5-minute drama video (bilingual burned-in subs,
no subtitle stream) is a second demo title. Subs were extracted from tiled
frame crops read directly; the burned English became `literal_en`, our own
American rewrites became the adaptation (per the founder: "when you make the
English translation do your own, not from the video"), all authored into
`data/fixture/canned-user.ts` (24 lines, contexts, alternatives, key
phrases) and merged into the demo bank. New cast voices in lib/dub.ts
(董事长/向园/杨总/助理/随行). Assets: `docs/demo/xiangyuan-ep1.{srt,mp4}`
(720p re-encode of minute one). Episodes 2–5 deferred per the founder's
"just do one minute" fallback; extend by the same recipe or with a live key.

## 2026-09-04 · Demo dubbing is in (one-time, for the demo)

Requested by the founders: pass in a video + subtitles and hear an English
dub — a demo feature, explicitly not the deferred dubbing-provider decision.

- **How it works:** the producer uploads video + subtitle file at ingest
  (the uploader now has a video field), generates the adaptation, and a
  「生成英文配音（演示）」 button on the player's timeline row voices every
  adapted English line with Microsoft Edge neural TTS (free, no key) and
  mixes them over the video with ffmpeg — original audio ducked to 15%,
  each line delayed to its timecode and tempo-fitted to its slot (cap
  1.5x). The dubbed file replaces the episode's video (the original stays
  on disk). ~30s for a 22-line episode.
- **Voices:** per-character — the demo cast is pinned (林晚 Jenny · 沈亦辰
  Guy · 周瑞 Christopher), unknown speakers rotate through five Edge voices.
- **Pieces:** `scripts/dub.py` (edge-tts + ffmpeg), `lib/dub.ts` (gathers
  lines, assigns voices, spawns the repo venv `.venv-dub`'s python),
  `POST /api/titles/[id]/episodes/[n]/dub`, `setEpisodeVideo` on the data
  layer, JobKind `dub_episode` (fixture-only; NOT in the SQL enum).
- **Fixture-mode only** by guard: bytes and ffmpeg are local. Machine setup
  (done on this machine): `python -m venv .venv-dub && .venv-dub/Scripts/pip
  install edge-tts`; ffmpeg on PATH.
- Verified end to end: video+SRT upload → generate → dub → mixed, served by
  /api/media, plays with AAC audio.
- **Discoverability + demo clip (same day):** an 「上传视频/更换视频」 control
  sits beside the dub button on the timeline row (`POST .../episodes/[n]/video`
  attaches to an EXISTING episode), so the feature is reachable on the
  fixture title. A 15-second vertical demo clip ships at
  `docs/demo/demo-clip.mp4`; the dub drops lines beyond the video's end and
  clamps output to the video. `episodes.dub_source_path` remembers the
  undubbed original so re-dubs mix from the source, never from a dub
  (a manual attach resets it).

## 2026-09-04 · The cornerstone made visible: key phrase + why, in the sheet

Decided by the founders (Ruobin), in session.

- **"Why this change" is the cornerstone of the product and must be shown in
  the sheet itself, not only in the side panel.** Every adapted line now
  carries `key_phrase_en` — the exact substring of the English that carries
  the change — highlighted gold inside column 2 (e.g. "hear it from me"),
  with the explanation on a second row of the same sheet entry (gold-ruled
  WHY THIS CHANGE row). The field flows through the whole pipeline: types,
  fixture builder, canned bank (authored for all 24 bank lines), demo
  replay, first-pass/rewrite prompts, SQL (0001 adapted_lines + fork +
  snapshot). A hand edit clears the phrase (it may no longer exist in the
  text); choosing an alternative clears it too.
- **Finalize lives on the scene-strip row**, right-aligned beside the scene
  tabs (with its arm/confirm step); the panel keeps only the scene confirm.
- Note: the running fixture store predates the field — restart the dev
  server to reseed, then regenerate; fresh generations carry phrases
  immediately.

## 2026-09-03 (night) · No approval requests: producers change it themselves

Decided by the founders (Ruobin), in session, after running the portal.

- **The producer side has no request-changes flow.** They don't send changes
  for approval — they just make them. The 要求备选/needs_alternative UI is
  gone from the portal; the review screen is no longer routed to.
- **A Pulsar-submitted (in_review) episode** shows the same line list
  read-only with one decision bar: 确认定稿 (approve as submitted — per-scene
  sign-off rows are filled automatically) or 自己修改 (fork to an editable
  draft on the spot; the fork-while-undecided guard is removed, and the
  superseded version keeps any decisions for the audit trail).
- **The tag vocabulary is capped at exactly ten** so it reads as a system:
  tighter 更精炼 · more_emotional 更情感化 · more_direct 更直接 · softened 更缓和
  · more_casual 更口语 · cultural_swap 文化替换 · idiom 地道表达 · pacing 节奏调整
  · clarity 更清晰 · humor 增加幽默. (Dropped formal_to_casual/casual_to_formal
  → more_casual; subtext remapped.) An eleventh tag needs a decisions entry.
- **The screen stays the review-studio layout the founders liked** (viewer
  with the current line + timeline markers + scene strip + two-column
  bilingual script sheet). What changed is the right-hand panel: it is now
  审阅与修改 — click any timestamp and it shows 为什么这样改编 + tone, the tag
  chips, the EDITABLE English, the 回译, and 2–3 suggested alternatives
  (auto-fetched when the demo replay makes them free; behind a button when a
  live model would spend). A first rework replaced the whole layout with
  card rows and dropped the viewer — reverted the same night; keep the
  studio layout.
- The single 确认定稿 per episode stays: exports still come from a frozen,
  hashed snapshot.

## 2026-09-03 (evening) · Producer-first: the work moves to the partner portal

Decided by the founders (Ruobin), in session, over the V1 build.

- **Most of the workflow moves to the producer side.** A producer uploads a
  script → presses one button → the script is auto-adapted → they change
  what they want. The admin portal stays for Pulsar oversight; it is no
  longer where the work happens.
- **The UI must feel familiar to a mini-drama producer** and be smooth for a
  demo. Researched the consoles producers already use (短剧创作者中心, 爱奇艺号,
  抖音创作服务平台 …) — see `docs/ui-research.md`; the portal now follows
  their grammar: 作品管理 poster grid, 步骤条 pipeline strip, one primary
  action per screen, visible processing, platform status vocabulary.
- **Never translate new material for the demo; replay the existing
  translations.** In fixture mode the generate button replays the
  pre-authored bank (`data/fixture/canned.ts` via `lib/demo-replay.ts`) —
  deterministic, zero spend, no key needed. Real model calls run only in
  supabase mode (or `DEMO_REPLAY=0` with a key). `docs/demo/aizailvtu-demo-ep1.srt`
  is a bundled script whose upload replays end to end.
- **API key storage:** `.env.local` (gitignored) now exists with
  `ANTHROPIC_API_KEY=` — paste the key there.

What this changed in the build:

- Producers (reviewer/approver roles) may now: create titles under their own
  company, upload episodes, run the AI pass, edit lines, pick alternatives,
  confirm scenes — enforced per title by `requireTitleEditor`
  (lib/data/fixture.ts) and, in supabase mode, `core.can_edit_title()`
  (supabase/migrations/0002_producer_selfserve.sql). Viewers stay read-only.
  Producers now see their own drafts (they author them); Pulsar's API costs
  still never reach a producer session.
- **`finalizeVersion`** — the producer approver's one action: freezes the
  snapshot + sha256, writes per-scene sign-off rows, approves, supersedes
  the previous approved version. Staff are refused (they keep submit +
  approve-on-behalf), so an approval always records which side made it.
- New partner-portal screens: `/producer` (poster grid), `/producer/titles/new`
  (create + upload), `/producer/titles/[id]` (episode console + step strip),
  `/producer/titles/[id]/episodes/[n]` (the workspace: generate → edit →
  confirm → finalize → export). The staff-submitted `in_review` flow still
  routes to the review screen.
- Producer exports: srt / vtt / csv / diff of their own titles; brief and
  package stay Pulsar-internal.

## 2026-09-03 · V1 definition (supersedes the entries below where they differ)

Decided by the founders (Ruobin) after reviewing an outside proposal;
adopted with the lead engineer's three amendments (freeze on approve, mint
ids and record cost now, ASR as fallback not front door).

**Pulsar Studio V1: upload a Chinese short drama (video optional) or its
script and receive an approved U.S. script plus a paid-social creative
brief, exported — with a partner portal where the mini-drama company
reviews and approves.** Nothing is linked to Reach in V1. Studio only.

Two portals, one app, one Supabase project:

- **Admin portal** — Pulsar staff, English chrome by default. Projects →
  Adaptation workbench → Creative pack → Export.
- **Partner portal** — the producer (制片方, the mini-drama company), Chinese
  chrome by default. (Defaults are enforced by the route-group layouts:
  `app/(admin)/layout.tsx` passes `en` and `app/(producer)/layout.tsx`
  passes `zh` to `LocaleProvider` when no `pulsar_studio_locale` cookie is
  set; `lib/i18n.ts` `DEFAULT_LOCALE` only covers routes outside a group,
  such as `/login`.) Their own titles only (RLS); the bilingual diff per
  episode; approve scene / request alternative with a one-line reason /
  approve episode. Login through Supabase auth (magic link or password);
  one partner account per producer is enough for the pilot.

Screens (nothing else ships as a route):

1. **Projects** `/titles` — title, episode count, % adapted, status; open.
   New title (`/titles/new`): name, producer, optional synopsis and
   character notes. Per-episode subtitle files (video optional) are
   uploaded on the title page `/titles/[id]` after creation (`POST
   /api/titles`, then `POST /api/titles/[id]/ingest` per episode).
2. **Adaptation** `/titles/[id]/episodes/[n]` — the hero screen. Video (when
   present) │ Chinese script (timecoded lines; click a line and the player
   jumps) │ U.S. adaptation for the selected line and scene: adapted
   English, *why this version* (zh + en), tone shift, 2–3 alternatives,
   regenerate, edit by hand, approve scene. A Chinese back-translation of
   each rewrite is stored for the partner. Not translation: 「你再这样下去，我以后不会再管你了。」→ literal "If you continue like this, I won't care about
   you anymore." → Studio "Do this again and I'm done covering for you."
   with 为什么这样改编: 更直接，也更符合美式剧集中争吵场景的表达方式。
3. **Creative pack** `/titles/[id]/pack` — per title: 5 U.S. title options,
   10 hooks (opening lines / ad hooks), 3 short descriptions, 3–5 thumbnail
   concepts as text, ad angles (betrayal, revenge, secret identity, romance,
   cliffhanger…). **Clip finder**: best scenes to advertise, each with a
   timestamp range, hook, why it could work, suggested opening text and a
   recommended cut length; together they form the ad brief for a human
   editor. Picking a title or hook marks it as the platform choice. No Reach
   manifest, no export to Reach, no Reach ids shown (ids are still minted).
4. **Export** — one action on the title page: adapted script (.srt/.vtt and
   .csv now; .docx later), creative brief (top ad scenes, hook copy,
   timestamps, angle), title package (titles, descriptions, thumbnail
   ideas), and the bilingual diff document for the partner. Exports are
   taken from the approved snapshot when one exists, else the in-review
   one, else the current draft; the file header says which.

Approval, kept simple: a scene is `draft` or `approved` (a partner may mark
`needs_alternative` with a reason). Approving an episode — by staff in the
admin portal, by the partner in theirs — writes one frozen snapshot with a
hash; exports come from it. No comment threads, no three-stage rail, no
assignment, no version-history UI; the schema keeps one version row per
submission (a fork after `needs_alternative` is a new row) so an export is
reproducible, and the submit / approve / fork functions insert audit rows
(no UI). Version statuses are `draft`, `in_review`, `approved`, plus the
bookkeeping value `superseded` that only `fork_version` and
`approve_version` set (never shown, never visible to the partner).

Ingest: subtitle files (SRT/VTT/ASS) first. Video optional; in V1 an
episode file is stored in Supabase Storage and played from there
(Cloudflare Stream when a title needs delivery). When no subtitles exist:
an ASR job through an external API plus LLM speaker attribution from the
character notes, flagged for a human check — a fallback, not the front
door.

Costs and ids: every LLM/ASR call writes usage and cost on a jobs row and
the title page shows API cost to date; hooks, clip suggestions and rewrites
carry stable external ids in every export.

Not in V1: dubbing, lip sync, automatic video editing, thumbnail image
generation, originals / incubation, the feedback loop from Reach or Stage,
any Reach handoff, comments, roles beyond staff vs partner, asset library,
native app, publishing to Stage, Voice A/B, the marketing-boundaries
record, beats UI.

Success test (three real titles): a usable first-pass adaptation; a native
English-speaking editor saves meaningful time; 10–20 usable TikTok/Meta ad
concepts per title; those concepts become ads the Reach workflow can
launch.

## 2026-09-03 · MVP scope: the script first (superseded by V1 above where it differs)

Decided by the founders (Ruobin), in session, after reading the review.
Bullets 2–3 below (Stage pick, shared table to Reach, no producer login)
are superseded by V1: the partner portal replaces the WeChat handoff, the
creative pack replaces the hook / title lists, nothing is linked to Reach.

- The grand idea — upload a Chinese mini drama, get an American version
  (dub, subtitles, on-screen text, creatives) — is the product. It is too
  big for the MVP.
- **The MVP is the script.** Ingest a title's script: subtitle files per
  episode (SRT / VTT / ASS) or a script document; the video is optional and
  only gives the editor a player beside the line. Parse into episodes,
  scenes and timecoded lines. AI understanding pass (characters, per-scene
  context, beats). AI first-pass English adaptation per line with the
  rationale ("why this change"), 1–3 alternative rewrites on demand ("ideas
  to adapt the dialogue"), change-type tags, a Chinese back-translation.
  U.S. editorial edit. Producer approval per scene, version frozen on
  approval. Export the approved script: English VTT/SRT (the script in
  subtitle form) and a bilingual diff document the producer can forward.
- **Hook and title options are text and are in scope.** (superseded by V1
  above: the creative pack; `selected` is the platform pick and nothing is
  handed to Reach.) Studio produces
  them from the same pass; one is selected for the platform (Stage) and any
  number are handed to Pulsar Reach, the ad-launch engine. Assume Reach
  behaves like the `pulsar` / `overlord` repos: it drives TikTok (and Meta)
  traffic from creatives it is handed. The handoff is stable ids plus a
  shared table in the same Supabase project, not a Reach UI inside Studio.
- **Not in the MVP** (schema shapes may exist; no UI, no jobs): thumbnails,
  trailers, clips and other media creatives; dubbing and TTS; Voice A/B;
  subtitle burn-in and renders; Cloudflare Stream pushes; feedback
  ingestion from Reach and Stage.
- **Video → script extraction (ASR) is v1.1**, a job added after subtitle
  ingest works; it is not on the Week-4 path.

Assumptions taken by the lead engineer pending founder confirmation:

- **A1.** Subtitle files are the primary ingest. A script document without
  timecodes is accepted but degrades to a script-only view (no player, no
  VTT export until timecodes exist).
- **A2.** Producers review; they do not upload. Pulsar staff ingest. In the
  pilot a producer's approval may be recorded on their behalf with evidence
  (WeChat screenshot), as the review recommends. (Second half superseded by
  V1: the producer logs in to the partner portal; on-behalf survives as a
  staff-admin path with an evidence note.)
- **A3.** "From the same pass" for hook and title options means the same
  prompt family and cost rules, run as its own job (`propose_variants`)
  on the approved script and the title bible in Week 4 — not a side
  effect of the per-scene `first_pass` job.

## 2026-09-03 · Review decisions adopted for the scaffold

From `docs/build-context-review.md` § "Decisions the founders must make
now", adopted as defaults for the scaffold with these adjustments for the
script-first scope:

| # | Decision | Adopted default |
|---|---|---|
| 1 | Unit of review | Line stored · scene checkpoint · episode-version gate (unchanged) |
| 2 | Week-4 launch format | **Script only**: approved version exported as English VTT + bilingual diff. Subtitled playback is Stage's concern once a video exists on Stream; no dubbing trial in the plan until the script MVP is real |
| 3 | Producer approval in the pilot | (superseded by V1 above: the partner portal ships in V1; `on_behalf` remains a staff-admin path with an evidence note) ~~Exported zh diff over WeChat, recorded `on_behalf` with evidence; producer login later~~ |
| 4 | Partner deliverables | SRT/VTT/ASS required; video optional; no in-app alignment (unchanged; ASR is v1.1) |
| 5 | Schema ownership / deploy | Studio owns `core` + `studio` and the migrations; shared ids not tables; one long-lived Node process (unchanged). ffmpeg on the VPS is deferred: installed when ASR (v1.1) or the media track first needs it, not in Week 1 |
| 6 | Producer gate on creatives | (superseded by V1 above: the creative pack is text, internal to staff, no exported status, nothing to Reach) **Text variants only** (hook, title) in the MVP; `selected` marks the platform pick; ~~exported status marks what Reach may test~~; media variants and the boundary attestation flow arrive with them [Later] |
| 7 | Naming | `producer` for the partner, `Studio` for the product (unchanged); ~~stages `ai_first_pass` / `editorial_review` / `producer_approval`~~ (superseded by V1 above: no three-stage rail; `scenes.status` draft/approved + `scene_decisions`) |
| 8 | Locale defaults | `app/(admin)/` en, `app/(producer)/` zh, cookie wins; content columns never follow the locale (unchanged; route group renamed from `app/(studio)` by V1; enforced by the two route-group layouts, see V1 above) |
| 9 | Pockets | (superseded by V1 above: pockets are Later, no column in `0001`) ~~One nullable pocket per adaptation~~; one adaptation per title in the pilot UI |
| 10 | Design target | Slide 1 primary for the workbench, slide 7 for the diff card and pickers; sibling tokens and blue; Outfit 400/500/600; no pinyin (unchanged) |
| 11 | Major-change criteria | Proposed list taken to the first producer; recorded on the boundary (unchanged; boundaries table itself is post-MVP) |
| 12 | Voice A/B | **Deferred entirely** — not built, not fixtured, in the scaffold |

## 2026-09-03 · Stack

Next.js 14 App Router (matches `pulsar` and `overlord`), TypeScript strict,
`@/` alias, no CSS framework, hand-rolled zh/en i18n ported from `pulsar`,
dev port 3200, Supabase via `@supabase/ssr`, `DATA_SOURCE=fixture|supabase`
so the UI runs with no database, `@anthropic-ai/sdk` for the LLM passes,
Supabase Storage (bucket `studio-media`) for video in V1; Cloudflare Stream
only Later, when a title needs delivery.
