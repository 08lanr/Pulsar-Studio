# Pulsar Studio — Product

*Adapts finished Chinese mini dramas for American viewers and produces the
paid-social creative brief for them. The producer keeps the IP and approves
every version in its own portal.*

> **Status (2026-09-04):** the V2 pivot — *subtitles, not dubbing* — reshaped
> the producer flow after much of this file was written. Where this file
> describes per-scene approvals, request-alternative decisions, dubbing, or a
> producer-facing creative pack, the newest entries in
> [docs/decisions.md](docs/decisions.md) override it: the producer edits
> everything themselves on one continuous script sheet and finalizes in one
> click; deliverables are the clean English script and the subtitled video.

Business context for anyone touching this repo. Engineering conventions and
invariants are in [CLAUDE.md](CLAUDE.md); the week-by-week plan in
[docs/build-plan.md](docs/build-plan.md); the schema in
[docs/data-model.md](docs/data-model.md); the deck, slide by slide, in
[docs/deck-notes.md](docs/deck-notes.md). Slide numbers below refer to it.
Decisions that override any of these files, newest first, are in
[docs/decisions.md](docs/decisions.md).

## V1 (decided 2026-09-03, later the same day): two portals, three screens, one export

**Pulsar Studio V1: upload a Chinese short drama (video optional) or its
script and receive an approved U.S. script plus a paid-social creative
brief, exported — with a partner portal where the mini-drama company (the
producer, 制片方) reviews and approves.** Nothing is linked to Reach or
Stage in V1. Studio only. The decision and the lead engineer's three
amendments (freeze on approve, mint ids and record cost now, ASR as
fallback not front door) are the top entry of
[docs/decisions.md](docs/decisions.md); it overrides every other doc.

Two portals, one Next.js app, one Supabase project. Nothing else ships as a
route.

### Admin portal — Pulsar staff, English chrome by default, `app/(admin)`

1. **Projects** `/titles` — title, producer, episode count, % adapted,
   status, API cost to date; open. `/titles/new`: name, producer, optional
   synopsis and character notes — nothing is uploaded here. `/titles/[id]`:
   episodes with ingest state and status, upload per-episode subtitle files
   (video optional) — the one place upload happens, after the title exists
   (`POST /api/titles`, then `POST /api/titles/[id]/ingest`) — cost to
   date, Export. `/producers`: the partner companies a title belongs to.
2. **Adaptation** `/titles/[id]/episodes/[n]` — the hero screen. Video
   (when present) │ Chinese script (timecoded lines; click a line and the
   player jumps) │ U.S. adaptation for the selected line and scene: adapted
   English, *why this version* (zh + en), tone shift, 2–3 alternatives,
   regenerate, shorten, edit by hand, approve scene, approve episode. A
   Chinese back-translation of each rewrite is stored for the partner. Not
   translation: 「你再这样下去，我以后不会再管你了。」→ literal "If you
   continue like this, I won't care about you anymore." → Studio "Do this
   again and I'm done covering for you." with 为什么这样改编:
   更直接，也更符合美式剧集中争吵场景的表达方式。
3. **Creative pack** `/titles/[id]/pack` — per title: 5 U.S. title options,
   10 hooks (opening lines / ad hooks), 3 short descriptions, 3–5 thumbnail
   concepts as text, ad angles (betrayal, revenge, secret identity, romance,
   cliffhanger…). **Clip finder** on the same page: best scenes to
   advertise, each with a timestamp range, hook, why it could work,
   suggested opening text and a recommended cut length; shortlist or
   dismiss. Picking a title or hook marks it as the platform choice.
4. **Export** — one action on the title page: adapted script (.srt / .vtt
   and .csv now; .docx later), creative brief (top ad scenes, hook copy,
   timestamps, angle), title package (titles, descriptions, thumbnail
   concepts), and the bilingual diff document for the partner. Exports are
   taken from the approved snapshot when one exists, else the in-review
   one, else the current draft.

### Partner portal — the producer, Chinese chrome by default, `app/(producer)`, URLs under `/producer`

- `/producer` — their own titles and the episodes awaiting review;
  `/producer/titles/[id]` — the title's episodes with review state;
  `/producer/titles/[id]/episodes/[n]` — the bilingual review.
- Per scene, from the frozen snapshot: the Chinese source lines, the
  Chinese back-translation of the rewrite, the English, the rationale in
  Chinese, major changes first. Nothing internal: no alternatives, no
  jobs, no cost, no staff notes, no creative pack (the diff header shows
  the title's own name, not the selected U.S. title or hook).
- Three actions: **approve scene** (批准场景), **request alternative**
  (要求备选) with a one-line reason, **approve episode** (批准本集).
- Own titles only (RLS on `producer_id`). Login through Supabase auth
  (magic link or password); one partner account per producer is enough
  for the pilot. Staff may open the portal to preview it.

### Approval, kept simple

- A scene's status is the staff working status: `draft` or `approved`.
- Staff **approve episode** requires every scene approved; it writes one
  frozen snapshot with a sha256 on the version, moves it `draft →
  in_review`, and makes it visible to the partner.
- The partner decides per scene per version: `approved` or
  `needs_alternative` with a note. These decisions are the only partner
  writes, and they go through functions.
- Partner **approve episode** requires every scene decided `approved`;
  the version becomes `approved`. In the pilot a staff admin may record
  the approval on the producer's behalf with an evidence note.
- After a `needs_alternative`, staff fork the version → a new draft,
  edit, re-submit. `in_review` and `approved` versions are frozen.
- No comment threads, no three-stage rail, no assignment, no
  version-history UI. One version row per submission so an export is
  reproducible; submit, approve and fork insert audit rows (no UI).

### The creative pack is the ad brief

The pack plus the shortlisted clip suggestions is what a human editor
receives to cut ads: which scene, from when to when, with what hook and
opening text, at what length, for which angle. Titles, hooks, descriptions
and thumbnail concepts are text; no image or video is generated. Hooks,
clip suggestions, rewrites and alternatives carry stable external ids in
every export (`ttl_`, `ep_`, `sc_`, `ln_`, `ad_`, `ver_`, `rw_`, `alt_`,
`var_`, `clip_`); uuids never leave the repo. Every LLM call is a jobs row
with usage and cost; the title page shows API cost to date.

### Not linked to Reach or Stage in V1

No Reach manifest, no export to Reach, no shared creative table, no Reach
ids shown (ids are still minted). No release to Stage. Not in V1: dubbing,
lip sync, automatic video editing, thumbnail image generation, originals /
incubation, the feedback loop from Reach or Stage, any Reach handoff,
comments, roles beyond staff vs partner, asset library, native app,
publishing to Stage, Voice A/B, the marketing-boundaries record, beats UI.

### Success test

Three real titles: a usable first-pass adaptation; a native
English-speaking editor saves meaningful time; 10–20 usable TikTok / Meta
ad concepts per title; those concepts become ads the Reach workflow can
launch.

## Earlier scope note (superseded by V1)

The morning's "script first" MVP entry — hook and title text handed to
Reach through a shared table, producer approval recorded on their behalf
over WeChat, no producer login — is superseded by V1 above where it
differs: the partner portal replaces the WeChat handoff, the creative pack
replaces the hook / title lists, and nothing is linked to Reach. The full
entry, the assumptions A1–A3 and the review-decision table remain in
[docs/decisions.md](docs/decisions.md); a decision there overrides anything below.

Sections below are the whole product. Where a paragraph or row is beyond
V1 it is tagged **Later** rather than removed.

## What Pulsar is

Pulsar takes finished Chinese mini dramas (vertical, 1 to 2 minute
episodes, 50 to 100 episodes per title), adapts them for American viewers,
buys traffic on TikTok and Meta, and monetizes them on its own U.S. web
platform. Three products, one loop (slides 1, 5):

- **Pulsar Studio** — adapts the title and produces the ad brief. This
  repo.
- **Pulsar Reach** — runs the ads on TikTok and Meta. Consumes Studio's
  creatives; reports back which ones brought viewers and paying users.
  Not linked in V1.
- **Pulsar Stage** — where viewers watch and pay (first episodes free, then
  per-episode unlock or subscription). Web first, native app later. Reports
  back which titles, scenes and hooks led to payment. Not linked in V1.

The loop: Select (pick titles likely to work in the U.S.) -> Studio (adapt,
make creatives) -> Reach (buy traffic) -> Stage (watch, pay) -> Learn (data
back into selection and adaptation). Studio sits at step two, is fed by
step five, and also serves step one: slide 18's third selection test cuts
hooks from a candidate title and runs them small before the title is
adapted, so Studio must be able to make creatives from a title it has not
adapted. In V1 the creative pack can be generated from an ingested script
before any episode is adapted; running the concepts is Reach's job, done
by hand from the exported brief.

Commercial model (slides 10, 13): the producer (制片方) keeps the IP and
takes a royalty (Pulsar assumes 30% of receipts net of payment fees).
Pulsar funds adaptation and media spend and holds a U.S. distribution and
marketing licence for a fixed term. The producer reviews and approves every
adapted version before it goes live, sets marketing boundaries, and
confirms titles one by one. Studio the product must make that review step
real, not a checkbox: in V1 that is the partner portal.

Track record (slide 6): 1,390 creatives tested over five months for a U.S.
rewards app at $2.50 per registration. The buying discipline is proven; the
drama adaptation is new.

## What Studio does — four stages (slide 7)

1. **Understand the original** (理解原作). Script, episode structure,
   characters, core emotional beats. In the product: the title's synopsis
   and character notes, entered at creation and used by every pass. **V1.**
   The per-scene context paragraph, the editable character list and the
   localization-effort note that feeds selection: **Later.**
2. **American adaptation** (美国本土化). Dialogue, pacing, dubbing,
   subtitles, titles, thumbnails, on-screen text. Rewritten for an American
   viewer, not translated. The thesis: translated catalogues (DramaBox,
   DramaWave; slide 11) lose viewers at specific beats and a rewrite fixes
   those beats. **V1:** the rewritten dialogue with rationale (zh + en),
   tone note, tags, 2–3 alternatives, regenerate / shorten, back-
   translation; title options as text. **Later:** dubbing, subtitle
   rendering, on-screen text, thumbnail images.
3. **Producer review** (制片方审核). The producer reviews and approves the
   adapted version before launch, scene by scene, episode version by
   episode version. **V1**, in the partner portal (on-behalf with an
   evidence note remains possible in the pilot).
4. **More selling points for the same title** (为现有剧集开发更多卖点). From
   U.S. click and viewing data, new hooks, trailers, thumbnails, titles and
   alternative openings for a title already live. **V1:** the creative pack
   and the clip finder, generated from the script without performance
   data. **Later:** trailers, thumbnail images, alternative openings cut
   from footage, and the data feed that motivates new ones.

Outputs, in order of importance:

- **V1:** the approved rewritten script per episode, frozen per version,
  with the rationale per line; exported as .srt / .vtt / .csv and as a
  bilingual diff; the creative brief (top ad scenes with timestamps, hook
  copy, angle) and the title package (titles, descriptions, thumbnail
  concepts), with one title and one hook marked as the platform choice.
- **Later:** subtitled or dubbed video per version; dozens of media
  creatives per title (trailers, openings, thumbnails, clips) for Reach to
  test. Reach expects many variants per title; Studio's value is making
  variants cheap. That holds for text variants in V1.

## Producer control (slide 10)

What the producer decides, and how the product carries each:

| Producer decides | In the product | Scope |
|---|---|---|
| The adapted version is reviewed before launch | The partner portal: approve scene / request alternative / approve episode per frozen version; the approved snapshot carries a hash and every export comes from it | V1 |
| Dubbing and visual materials are reviewed before launch | The render (subtitle or dub track) attaches to the version before release; the title's launch package is approved once per title | **Later.** In V1 the creative pack is text, internal to staff, and leaves the app only as the exported brief; the partner reviews the script |
| Marketing boundaries: positioning, actor likeness, what cannot be promoted, what counts as a major change | A structured, versioned record per title, confirmed by the producer, immutable once confirmed; every creative export records the boundary version it was cleared against | **Later**, with media creatives. In V1 `is_major` on an adapted line is the only boundary mechanism: the partner sees major changes first |
| Which titles go live, one by one | Title status moves to live only by a founder action after the producer's confirmation is recorded | **Later** (needs a Stage release). In V1 a title tops out at `approved` |

Pulsar keeps producing and testing ad versions **within the agreed
boundaries** (slide 10). That sentence is the escape hatch from
per-creative approval: after the first creative set per title is approved
in full, only creatives flagged as a major change (a new claim on screen,
an actor's face in a thumbnail, a cloned voice) block on the producer; the
rest are visible to the producer and exportable immediately. In V1 the
creative set is text for a human editor, is not shown to the partner and
has no per-item approval; the boundary record that will carry the rest is
Later.

Every submit, approve and fork is an attributed, append-only audit event.
In the pilot a producer may still confirm over WeChat; a staff admin then
records the approval on the producer's behalf with an evidence note, and
the portal shows it to the producer as such the next time they log in.

## Who uses Studio

- **Pulsar editors** — the founders now, U.S. editors from month 4-5
  (slide 15). Work in English in the admin portal. Read the Chinese source,
  write the English adaptation, approve scenes, submit episodes.
- **The producer's reviewer** — in mainland China, on a phone as often as
  not, reads Chinese. Logs into the partner portal (V1). Sees only their
  own titles, only versions in review or approved, only the Chinese
  original, a Chinese back-translation of the rewrite, and the rationale
  in Chinese. Approves scenes, asks for an alternative with a one-line
  reason, approves the episode. Forwards the exported diff to a
  screenwriter, a boss or a lawyer.
- **Operators** — the founders, running ingest (subtitle files per
  episode, optional video), generating the creative pack, exporting the
  brief for the editor who cuts ads.

Three readers, two portals, one screen whose core content is Chinese
beside English by design. The chrome is one language per portal (a cookie
may override): `app/(admin)/layout.tsx` defaults to `en` and
`app/(producer)/layout.tsx` to `zh` when no `pulsar_studio_locale` cookie
is set (`lib/i18n.ts` `DEFAULT_LOCALE` covers only routes outside a group,
such as `/login`); the content columns never change language.

## Product principles (hypotheses we are building toward)

Each carries its source. Principles absent from the deck are the founders'
and are marked so.

- **The unit of output is a diff**: the original line or beat, why an
  American viewer drops here, the replacement. A Chinese producer executive
  cannot judge an English script, but can read a diff and forward it. Every
  rewrite Studio produces is presentable that way, with the rationale and a
  back-translation stored in Chinese as data, never translated at view time.
  (Slide 7's 为什么这样改编 block; product-strategy synthesis 2026-09.)
- **Rationale is a labelled hypothesis** until Reach and Stage grade it. It
  references the line it changes, uses only facts in the source and the
  title's notes, and carries a change type. A model asserting a plot fact
  that is not in the source is a defect. (Founders; mirrors the sibling's
  never-invent rule.)
- **Verifiability over generation.** Studio starts from a finished title;
  there is no "type an idea, get a script" path. Proposing new title
  directions from paid data (slide 19) is a later feature built on the same
  library, not script generation.
- **No AI video generation.** Allowed: dub audio, subtitles, on-screen text
  overlays, cuts and re-edits of delivered footage, thumbnails from frame
  grabs plus typography. Forbidden: lip-sync or face re-animation,
  inpainting or removal of burned-in text, generated imagery in thumbnails
  or posters, synthetic footage of any kind. "Newly produced" creatives
  (slide 8) means human-shot or human-edited. (Slide 7; boundary of slide
  10.) The allowed list is Later; the forbidden list applies from day one.
  In V1 the clip finder only points at footage; a human cuts it.
- **Stock voices by default.** Cloning an actor's voice is a likeness use
  the producer controls (slide 10); it is a per-title flag allowed only when
  the confirmed boundary records consent, and every dubbed track shows its
  voice provenance in review. Later, with dubbing.
- **Review is real, not a checkbox.** Approval binds to a frozen version
  with a hash; editing after approval opens a new version; nothing reaches
  Stage or Reach without it. (Slide 10.) V1: the partner approves in its
  own portal.
- **Audience-first entry point survives.** A title can be adapted toward a
  specific American audience pocket; the schema allows more than one
  adaptation per title. V1 shows one adaptation per title and no pocket;
  pocket variation lives in creatives, which Reach targets. Later.
  (Founders, not in the deck; slide 8's hook x audience testing is Reach's.)
- **Adaptation data compounds.** Which hooks and rewrites paid, per pocket,
  becomes a reusable library. Every exported hook, clip suggestion, rewrite
  and version carries a stable id so results can come back; a grade is only
  ever a computed view over measured events, and the finest grain Stage can
  attribute is a scene. (Slides 5, 12, 17.) The ids ship in V1; the
  ingestion of results is Later.
- **Voice A/B is deferred entirely.** The idea was one scene, literal
  translation versus rewrite, side by side, ninety seconds, as a
  pre-rendered demo fixture. It is not built and not fixtured in V1: it
  depends on dubbing, which is out, and the script diff (slide 7) already
  makes the literal-vs-rewrite argument in a form the producer can read
  and forward. Revisit with dubbing. (Founders, not in the deck;
  docs/decisions.md 2026-09-03, item 12.)
- **Mostly automated with human review, not a manual editing job.** The
  $2K per title (slide 13) is editorial hours plus roughly $20-45 of API
  calls in V1 (`docs/build-plan.md` cost table; the title page shows the
  actual figure); $85-300 with dubbing, Later.

## Numbers the product has to fit (slides 13-16)

- Pilot: 3 to 5 titles, then 8 to 12 titles live by month 6. Two to three
  partner producers by month 3.
- Adaptation cost: about $2K per title, all in, spread over the first 5,000
  acquired users ($0.40 per user in the unit economics). Unchanged by the
  V1 scope; in V1 it is mostly editorial hours, with the LLM passes a
  small share, recorded per job.
- Platform cost at pilot scale: $1.5-2.5K a month total, of which AI,
  dubbing and creative APIs $500-1,000 across all three products, video
  delivery $500-1,000 at $1 per 1,000 minutes viewed. Cloudflare Stream: $5
  per 1,000 minutes stored, $1 per 1,000 delivered. Supabase Pro from $25.
- Pilot targets: CAC <= $0.50; first-payment rate >= 5%; >= 5,000 acquired
  users per title; at least two of the first titles at 90-day gross ROAS >=
  2.5x. Per-creative results Reach reports: spend, cost per viewer,
  first-payment rate (slide 8).
- Timeline (slide 15): Week 4, Stage MVP live and Studio and Reach
  workflows usable, first title adapted. Week 6, first 3-5 titles adapted
  and live. Week 10, pilot complete. Month 3, second slate. Month 4-5,
  first U.S. editors and media buyers. Month 6, 8-12 titles live.
- Two founders are the only engineers for six months; one of them also runs
  product and producer relationships (slide 16). Stage and Reach share the
  Week-4 window. Scope accordingly.

## The target UI — three screens and the partner review

The deck has two Studio mockups. **Slide 1's is primary**: it is the one
that draws the workbench. **Slide 7's supplies the diff card and the
pickers.** Both are layout references only; colour, type and components
come from the sibling design system (blue accent, borders not shadows,
nothing above weight 600, one SVG icon set, self-hosted Outfit for Latin
and the system CJK stack for Chinese). The deck's palettes (cream/gold on
slide 1, violet on slide 7) are for the deck; violet is reserved for Pulsar
Discover. The creative pack has no mockup and is described in the design
system's terms below.

**What V1 builds:** the Projects list and title page; the Adaptation
workbench from slide 1 with slide 7's diff card on the adapted line; the
Creative pack page; and the partner review screen, which is slide 7's
rendering of the same data in Chinese. The slide-1 tabs **Dubbing,
Subtitles, On-screen Text, Title & Thumbnail** are Later and do not render.

**Projects** (`/titles`, `/titles/new`, `/titles/[id]`): a table of
titles — name, producer, episodes, % adapted, status, cost to date. The
title page lists episodes with ingest state (subtitles / video / lines),
status chip (draft, in review, approved), progress, and per-episode
upload; the Export action with its format picker; the pack link.

**Adaptation** (`/titles/[id]/episodes/[n]`), from slide 1, English chrome:

- Title row: title, episode picker, "All changes saved", cost of this
  episode's jobs.
- Two columns per scene: **Source — Chinese** and **Adapted — U.S.
  English**. Timecoded lines; clicking a source line seeks the player; the
  adapted line carries a chip (AI first pass / edited) and opens the diff
  card.
- The diff card, from slide 7: adapted English, **why this change**
  (为什么这样改编, zh + en), the tags (更精炼 tighter, 更情感化 more
  emotional), the tone note (语气调整), the 2–3 alternatives with a
  "choose" on each, and Regenerate / Shorten / edit by hand.
- Right rail: player with timeline (only when the episode has a video;
  otherwise the rail starts at the scene list); the scene list with each
  scene's status; **Approve scene**; **Approve episode** (submit), enabled
  when every scene is approved; after a partner's request for an
  alternative, the note and a **Fork** action.
- Not from slide 1: Add line / Split / Merge (Later), the three-stage
  legend and Workflow Status rail, Notes & Comments, the assignee, the
  comment icon. None of these exist in V1.

**Creative pack** (`/titles/[id]/pack`), new, English chrome: a page whose
hero is the list of top ad scenes from the clip finder — one card per
suggestion with the episode and timestamp range, the hook, why it could
work, the suggested opening text, the recommended cut length, and
Shortlist / Dismiss; the shortlisted cards are the ad brief. Below it, the
pickers from slide 7's Hook 选项 / 标题选项: **title options** and **hook
options** as short lists with one selected as the platform choice, then
descriptions, thumbnail concepts and ad angles as plain lists. One
Generate action per title and one Find clips action per episode; with no
API key each renders an "unavailable" state, and fixture content fills the
page.

**Partner review** (`/producer/titles/[id]/episodes/[n]`), from slide 7,
Chinese chrome: the title header (back to titles, title, episode, status
chip 审核中 / 已批准); per scene, the Chinese original lines, the Chinese
back-translation, the rationale in Chinese, tags and tone note, the
English underneath, major changes first; per scene **批准场景** and
**要求备选** with a one-line reason; **批准本集** once every scene is
approved. Nothing internal: no alternatives, no comments, no jobs, no cost.
The same rendering is the exported bilingual diff.

**Do not build from the mockups**: the coin balance and "+" (a Stage
concept, slide 9), "Upgrade to Premium", "Product Three", the avatar
menu, the search box until there is something to search, the Team nav and
assignee picker until editors exist (month 4-5), the Reviews nav item, the
Notes & Comments panel, the three-stage Workflow Status rail. No currency,
no tiers, no seats: nothing the pipeline cannot back. Nor slide 7's 缩略图
Thumbnail, 本地化 Localization and 版本 Versions tabs: nothing behind them
in V1.

V1 routes. Admin, `app/(admin)`: `/titles`, `/titles/new`, `/titles/[id]`,
`/titles/[id]/episodes/[n]`, `/titles/[id]/pack`, `/producers`. Partner,
`app/(producer)`: `/producer`, `/producer/titles/[id]`,
`/producer/titles/[id]/episodes/[n]`. Plus `/login`. Subtitle-file and
video ingest is a staff action on the title page, not a route; export is
a download from the title page, not a page; there is no versions route
and no diff route (the diff is an export and the partner screen). No route
ships as an empty shell; no Dubbing, Subtitles, On-screen Text or
Thumbnail route exists until there is a job behind it.

## Vocabulary

English term, Chinese label (the deck's), code name, i18n prefix. The deck
is the source of truth for zh strings; both dictionaries are written by a
founder, never machine-translated from each other. Terms marked Later name
schema shapes without UI in V1.

| English | Chinese | Code | Prefix |
|---|---|---|---|
| producer (the partner; never "studio") | 制片方 | Producer | producer.* |
| Studio (the product; untranslated) | Pulsar Studio | — | — |
| admin portal (staff) | 管理后台 | app/(admin) | admin.* |
| partner portal (the producer's) | 合作方门户 | app/(producer) | portal.* |
| title | 剧集 | Title | title.* |
| episode (第 {n} 集; en "Ep {n}") | 集 | Episode | episode.* |
| scene | 场景 | Scene | scene.* |
| line | 台词 | Line | line.* |
| original line / adapted line | 原始台词 / 改编后台词 | Line.text_zh / AdaptedLine.text_en | adapt.* |
| adaptation (the rewrite) | 改编 (本土化改编 in prose) | Adaptation | adapt.* |
| alternative rewrite (2–3 on demand; "ideas to adapt the dialogue") | 备选改写 | Alternative (alt_) | adapt.alternatives |
| script file (subtitle file SRT / VTT / ASS, or a script document) | 剧本文件 / 字幕文件 | ScriptFile (ingest source) | ingest.* |
| localization (dubbing, subtitles, on-screen text) — Later | 本地化 | — | localize.* |
| version | 版本 | Version (ver_) | version.* |
| why this change (rationale) | 为什么这样改编 | AdaptedLine.rationale_zh/en | adapt.why |
| back-translation | 回译 | AdaptedLine.back_translation_zh | adapt.backTranslation |
| tone adjustment | 语气调整 | tone_note | adapt.tone |
| change type: tighter / more emotional | 更精炼 / 更情感化 | tags | tag.* |
| AI first pass (the per-line chip) | AI 初稿 | first_pass job | adapt.aiFirstPass |
| U.S. editorial review — Later (no stage rail in V1; no `stage.*` keys in the dictionaries) | 美方编辑审校 | editorial_review | — |
| producer approval — Later (no stage rail in V1) | 制片方审批 | producer_approval | — |
| producer review (the activity) | 制片方审核 | — | review.* |
| approve scene (staff working status, and the partner decision) | 批准场景 | Scene.status = approved / SceneDecision.approved | review.approveScene |
| request alternative (partner, with a one-line reason) | 要求备选 | SceneDecision.needs_alternative | review.requestAlternative |
| approve episode (staff: submit; partner: approve) | 批准本集 | submit_version / approve_version | review.approveEpisode |
| in review (version status chip; en label "In partner review") | 审核中 | Version.status = in_review | version.inReview |
| approved version | 已批准版本 | Version.status = approved | version.approved |
| status label: draft (scene, version) | 草稿 | status = draft | status.draft |
| status label: approved (scene status, partner decision, version chip) | 已批准 | status = approved / SceneDecision.approved | status.approved |
| status label: needs alternative (partner decision state; the action is 要求备选 above) | 需要备选 | SceneDecision.needs_alternative | status.needsAlternative |
| major change | 重大改动 | is_major | review.major |
| marketing boundaries — Later | 营销边界 | MarketingBoundaries | boundaries.* |
| release / go live — Later | 上线 | Release | release.* |
| creative pack | 创意包 | Variant set per title (var_) | pack.* |
| hook | 开场 Hook | Variant(kind=hook) | hook.* |
| title option | 标题选项 | Variant(kind=title) | pack.title |
| description | 简介 | Variant(kind=description) | pack.description |
| thumbnail concept (text) | 缩略图概念 | Variant(kind=thumbnail_concept) | pack.thumbnail |
| ad angle | 广告切入点 | Variant(kind=angle) | pack.angle |
| ad scene / clip suggestion | 广告片段 | Clip (clip_) | clip.* |
| creative | 素材 | Variant | creative.* |
| trailer / thumbnail image — Later | 预告 / 缩略图 | Variant kinds | creative.* |
| dubbing / subtitles — Later | 配音 / 字幕 | Render kinds | localize.* |
| burned-in / sidecar subtitles — Later | 内嵌字幕 / 外挂字幕 | render_kind | localize.* |
| audience pocket — Later | 人群 | AudiencePocket | pocket.* |
| U.S. English | 美式英语 | target_locale en-US | — |
| acquired user (economics) | 获客用户 | — | PRODUCT.md only |
| viewer (Stage-side) | 观众 | — | PRODUCT.md only |
| paying user / first-payment rate | 付费用户 / 首充率 | — | PRODUCT.md only |
| media spend / scale spend | 投流 / 放量 | — | Reach vocabulary |
| Stage (the platform) | 自有平台 | — | — |
| closed loop | 闭环 | — | — |

Product names (Pulsar Studio / Reach / Stage), "Hook", TikTok and Meta stay
Latin in Chinese copy.

## Not in scope

Never, or not this product: script generation from scratch; AI video,
lip-sync, inpainting or generated imagery; a marketplace for brands; a
native app; anything a producer would use before a deal exists; a browser
uploader for multi-gigabyte deliveries (an episode file of pilot size
uploads to Supabase Storage; Cloudflare Stream when a title needs
delivery); per-creative producer approval beyond the first set and major
changes; Team, assignment and editor roles until month 4-5; pinyin on
lines; coins, tiers, seats; a Reach UI inside Studio.

Not in V1 (see the V1 section above and the Later list below): any link
to Reach or Stage (manifest, shared table, ids shown, release); dubbing
and TTS; Voice A/B; lip sync; automatic video editing; subtitle burn-in
and renders; Cloudflare Stream pushes; thumbnail image generation,
trailers and other media creatives; the marketing boundaries record;
comments and notes; roles beyond staff vs partner; assignment; asset
library; originals / incubation; beats UI; feedback ingestion from Reach
and Stage; in-app speech recognition (the producer delivers SRT / VTT /
ASS; ASR is the v1.1 fallback job).

## Later (planned, don't build early, don't block)

Post-V1 pieces of the product, in rough order:

- **The Reach and Stage contract.** Stable ids plus a shared table in the
  same Supabase project; a creative-set manifest keyed by the ids V1
  already exports; an exported status marking what Reach may test; the
  releases view for Stage. No Reach UI inside Studio.
- **Video → script extraction (ASR)** — v1.1. A job that produces the
  timecoded Chinese script from a delivered video when no subtitle file
  exists, with LLM speaker attribution from the character notes, flagged
  for a human check; feeds the same ingest as SRT / VTT / ASS. The job
  kind exists; the implementation returns "unavailable".
- **Comments and notes** on a scene or line, between staff and partner;
  the Notes & Comments panel from slide 1. V1 carries only the partner's
  one-line reason on a request for an alternative.
- **Marketing boundaries** (slide 10): the structured, versioned record
  per title, confirmed by the producer; every creative export records the
  boundary version it was cleared against; the major-change criteria list.
- **Audience pockets**: one nullable pocket per adaptation, more than one
  adaptation per title, per-line pocket tags once a grading loop consumes
  them.
- **Media creatives** (slide 8): thumbnails from frame grabs plus
  typography, trailers, alternative openings, clips cut from the title by
  the app rather than by hand from the brief; the launch package arrives
  with them, with the partner's approval of it.
- **Dubbing and TTS** (slide 7, stage 2): stock voices by default, cloned
  voices only with recorded consent; provider chosen after a measured
  trial. Voice A/B comes back with it.
- **Subtitle burn-in and renders**, and the Cloudflare Stream push of a
  rendered version; one Stream asset per adaptation is the default.
- **Feedback ingestion** from Reach and Stage (slides 5, 12, 17): results
  keyed by the ids V1 already exports.
- **Producer-facing results** (slides 5, 10, 17): per title, per creative,
  monthly report, on the same partner login as approvals.
- **Understanding pass**: per-scene context paragraph, editable character
  list, beats, localization-effort note for selection.
- **New-title incubation** (slide 19): concept, audience insight and
  creative direction proposed from the library of pocket-tagged, result-
  graded hooks and rewrites; the producer writes and approves.
- **Editor role and assignment**: the `assigned_to` column exists; the UI
  arrives with the first U.S. editors. Roles beyond staff vs partner.
- **Grade rollups and attribution shares** across variants and versions:
  after pilot data, as an explicit product decision.
- **Selection tests at scale** (slide 18 (03)): the candidate state and
  selection-test variants exist; the pilot slate is chosen by judgment.
- **.docx export** of the adapted script; a version-history UI.
- Native app; brand marketplace; asset library.

## Open decisions

- Dubbing / TTS provider, final: Later; no trial in the plan until V1 is
  real, then a measured-cost trial.
- Whether Reach moves from file persistence to the shared Supabase project:
  after V1, not before Week 10; the creative-set manifest keyed by ids
  works either way.
- Studio's own accent colour: stay all-blue through the pilot.
- One Stream asset per adaptation vs one asset with multiple audio tracks:
  Later, with renders; check Stream's audio-track API before then; one per
  adaptation is the default.
- The major-change criteria list and whether minor changes are pre-
  delegated to Pulsar's editorial review: settled with the first producer,
  recorded on the boundaries once that record exists; until then, on the
  title.
- Video playback reachability from mainland China for the producer's
  review (Supabase Storage in V1, Stream later): matters only for titles
  with a video; verify with the first producer that has one; keep a
  downloadable clip fallback in scope.
- A1 (subtitle files primary; script documents degrade) is confirmed by
  V1. A2 (staff ingest) stands; its second half (no producer login) is
  superseded by the partner portal, with on-behalf approval kept for the
  pilot.
