# Review of the build-context draft

To: both founders. Re: `docs/build-context-draft.md` (2026-09-03), checked
against `docs/deck-notes.md` (19 slides), the sibling repo's `CLAUDE.md`,
`BRIEFING.md`, `DESIGN-BRIEF.md` and i18n code, and the scaffold in this
repo. Seven reviewers; each finding survived three independent checks.
The rewritten documents are `PRODUCT.md`, `docs/build-plan.md` and
`docs/data-model.md`; the lead writes `CLAUDE.md` from them.

## Update after the review (2026-09-03): scope narrowed to script-first

After reading this review the founders cut the MVP to the script
(`docs/decisions.md` § "MVP scope: the script first"; it overrides this file
where they differ). Ingest is subtitle files (SRT/VTT/ASS) or a script
document; video is optional and only gives the editor a player beside the
line; output is the adapted script (rationale, back-translation, 1-3
alternatives, change-type tags) plus text hook and title options, exported
as English VTT/SRT and a bilingual diff. Decisions 2, 6 and 12 below are
adjusted: 2 is script-only (no subtitled or dubbed launch format, no
Week-6 dubbing trial); 6 gates text variants only (`selected` = the Stage
pick, one per kind; exported status = what Reach may test via ids and a
shared table; media variants and boundary attestation arrive with them);
12 is deferred entirely, not fixtured. ASR from video is v1.1. Dubbing,
TTS, Voice A/B, burn-in, Stream pushes and feedback ingestion are out;
schema shapes may remain, tagged Later.

Findings now moot or deferred to Later: "Dubbing is open and on the Week-4
path"; "Partner deliverables" (the master / M&E-stem checklist and the
Dubbing-stage ingest gate; the SRT/VTT/ASS half stands); "No duration
budget on rewrites"; "'No AI video' needs a fence"; "Voice cloning is a
likeness use"; "No job story" shrinks to LLM passes (no dubbing calls, no
Stream encodes); "Cost" keeps only the subtitle-first column; "Slide 10
gates more than the diff" and "Boundaries recorded but never enforced"
defer with media creatives; "Feedback metrics unnamed" defers with feedback
ingestion (ids and join key stay); "Slide 18 needs creatives before
adaptation" defers (pilot slate by judgment).

Findings now more important: "'Align lines to timecodes' hides an ASR
project" (SRT-first ingest is the whole Week-4 path; A1); "The producer
cannot read the draft's diff" (back-translation and zh rationale are the
product, not a review aid); "No immutable approved version", "No audit
trail" and "Review is sixth in build order" (the review gate is the MVP's
only gate and the VTT/diff export is its output); the whole i18n section
(a text-only product is nothing but content-language rules); "Split the
draft" (`CLAUDE.md`, `PRODUCT.md` and `docs/` must say script-first or an
agent builds the pipeline).

The body below is left as reviewed. Sentences the decision supersedes are
tagged "(superseded — see update)" in place; nothing is rewritten.

## Second update (later on 2026-09-03): V1 definition

`docs/decisions.md` § "V1 definition" now overrides this file and the first
update. Decision 3 is reversed: the partner portal is in V1 (`app/(producer)`,
`/producer/*`, Chinese chrome, own titles under RLS), so "Auth and roles
absent" is built now, not Week 7-8; `on_behalf` survives only as a staff-admin
path with an evidence note. Nothing links to Reach or Stage: Decision 6 (the
exported status, the shared table), the `releases` gate and every feedback
finding defer with them; ids are still minted. New scope, all script-derived:
a creative pack per title (title, hook, description, thumbnail-concept and
ad-angle variants; `selected` = the platform pick) and a clip finder
(timestamp ranges with hook, reason and cut length — the ad brief for a human
editor). Approval is simpler than "Partner review" asks: `scenes.status` is
the staff working state; partner decisions are per scene per frozen version
(`approved` | `needs_alternative` + note); comments, the three-stage rail,
assignment and a version-history UI are shelved. Pockets (Decision 9) are
shelved. The admin route group is `app/(admin)`, not `app/(studio)` (Decision 8).

## Verdict

The draft reads the deck correctly on every number, date and commercial
term, and its principles (the diff as the unit of output, verifiability
over generation, no AI video, review that is real) are the right sentences
and must survive. It is the wrong document to drop in as `CLAUDE.md`: it is
business prose with no path, env var, command or invariant, and several
sentences would mislead an agent on day one ("Claude Code can choose the
framework", a "reference UI" the deck notes themselves call the wrong
mockup, pointers to a Claude project the agent cannot open). Its eight-step
MVP is a six-month plan labelled as an MVP: Stage and Reach share the
Week-4 window (slide 15), so Studio's real budget before Week 4 is two to
three engineer-weeks, and only ingest, the diff and a recorded approval are
load-bearing. Its largest gap is the review step: the draft promises it
will be real, then gives it one sentence with no version to freeze, no unit
of approval that matches either mockup, no audit trail, no Chinese
rationale for the producer to read, and no enforcement between "approved"
and what Stage plays. Fix those, cut the MVP to the Week-4 slice, and the
draft's own principles carry the rest.

## Keep

Carry into `PRODUCT.md` and `CLAUDE.md` nearly verbatim, with slide numbers
inline:

- The four stages ("What Pulsar Studio does", slide 7) and the loop ("What
  Pulsar is", slide 5).
- "The unit of output is a diff: original beat, why an American viewer
  drops here, the replacement. A Chinese studio executive cannot judge an
  English script, but can read a diff and forward it." (superseded — see
  update: the partner is the producer, Decision 7.) Every bilingual-
  content rule in the rewrite hangs off this sentence.
- "Verifiability over generation... Studio starts from a finished title."
- "No AI video generation. Adaptation works on existing footage."
- "Studio the product must make that review step real, not a checkbox"
  (slide 10) and "Nothing goes to Stage without approval" (step 6).
- "Rewritten for an American viewer, not translated" (step 2).
- "Export sets to Reach with IDs so results can come back" (step 7; slides
  5, 17). This is what makes the loop closable.
- The numbers and dates, which match slides 13, 14 and 15, and the reading
  that the pipeline must be "mostly automated with human review".
- "Founders are the only engineers... Scope accordingly." and the "Not in
  scope now" list.
- The vocabulary's framing: the deck's Chinese is the source of truth.

## Change

### Deck consistency

- **Two mockups, one product (high).** "The design preview" cites slide 7
  only. Slide 1's second Studio mockup, which deck-notes calls "the closer
  one to the product principles", is the only place the review step is
  drawn: per-line chip, the legend AI first pass -> U.S. editorial review ->
  Studio approval, a Workflow Status rail per scene, Notes & Comments,
  Approve Scene / Request Changes, and tabs that match step 2 one-to-one.
  Slide 7 supplies the diff card, the hook and title pickers and the
  Versions tab. Change: `PRODUCT.md` names slide 1 primary.
- **Mis-transcribed nav and tabs (medium).** "Script" where the deck has
  版本 Versions (the surface the draft's own multi-adaptation principle
  needs); 剧集 Titles and 审批 Approvals dropped, template item 评价 Reviews
  kept. The scaffold's `locales/*.json` inherited the error. Change: correct
  both lists; Reviews collapses into Approvals.
- **Template noise (high).** Coin balance, "Upgrade to Premium", "Product
  Three", avatar. Coins are a Stage concept (slide 9); a premium tier
  contradicts a model where Pulsar funds adaptation. Change: an explicit
  do-not-build list; no currency, tiers or seats.
- **"Same design system" is false (medium).** Slide 7 is violet, slide 1
  cream/gold, the sibling blue with violet reserved for Discover ("never mix
  them", `DESIGN-BRIEF.md` section 3). Change: mockups are layout references;
  tokens, blue, weight cap 600 and one SVG set come from the sibling.
- **Slide 10 gates more than the diff (high).** Dubbing and visual
  materials are reviewed before launch; boundaries are four typed things;
  ads are tested "within the agreed boundaries". Step 7 exports creatives
  with no gate; step 6 records boundaries as prose. Change: Decision 6.
- **Slide 18 needs creatives before adaptation (medium).** Test (03) cuts
  hooks from a candidate title; step 7 allows creatives only "from approved
  footage" and Title has no candidate state. Change: a title lifecycle from
  `candidate`, China-metrics fields, selection-test variants; the pilot
  slate is chosen by judgment.
- **Slide 19 and producer reporting omitted (medium).** Change: a Later
  section in the sibling's style (incubation, producer results on the
  approval login, editor roles from month 4-5), each with the one data
  property it needs.
- **Feedback metrics unnamed (medium).** Slides 8, 13, 16 name them: spend,
  cost per viewer, first-payment rate, CAC <= $0.50, 90-day ROAS >= 2.5x.
  Change: name the fields and the join key (`var_`/`cx_` ids plus adaptation
  and pocket); the finest grain Stage attributes is a scene, so per-line
  grades are inferred and labelled.

### Scope and the Week-4 slice

- **Week 4 is three products for two people (high).** The Timeline bullet
  quotes half of slide 15's Week-4 line; the other half is "Stage MVP live".
  Change: `build-plan.md` budgets Studio at two to three engineer-weeks and
  tags every step with its milestone.
- **Only three things are load-bearing (high).** Episodes registered by
  Stream uid with SRT-derived lines (superseded — see update: episodes are
  keyed on the subtitle file; the Stream uid is optional); one first pass per scene with zh/en
  rationale rendered as a two-column diff with human edits; a recorded
  approval per episode version plus a release gate. Steps 2 (structured
  beats), 4 (Voice A/B as pipeline), 5, 7 and 8 are Weeks 5-10. Change:
  three tiers in `build-plan.md`.
- **"Align lines to timecodes" hides an ASR project (high).** SRT means a
  parser; a script document or burned-in subtitles mean speech recognition
  plus forced alignment. Change: Decision 4.
- **Dubbing is open and on the Week-4 path (high).** `.env.example` calls
  the provider open and cites a `docs/build-plan.md` that did not exist; the
  draft's own output definition allows "subtitled". Change: Decision 2
  (superseded — see update).
- **Auth and roles absent (high).** "Partner logs in" implies roles, RLS,
  invitations and a Chinese surface; principle 1 (the executive forwards a
  diff) needs no login. Change: Decision 3.
- **No job story (high).** Hundreds of LLM calls, minutes-long dubbing
  calls, async Stream encodes; a crashed pass re-run double-pays. Change:
  `studio.jobs` with idempotency keys, one long-lived Node process on a VPS
  with ffmpeg (the sibling's `instrumentation.ts` heartbeat pattern), and the
  invariant "recorded output is never re-generated without an explicit
  regenerate action".
- **Video bytes bypass the app (medium).** Founders upload to Stream out of
  band; the app registers uids and never handles bytes; subtitles go up as
  Stream captions (superseded — see update: no Stream pushes in the MVP;
  the VTT is an export in storage).
- **Route scope (medium).** Week 4 routes are `/titles`, `/titles/[id]`,
  `/titles/[id]/episodes/[n]`; pickers are lists on the title page; no empty
  shells.
- **Fixture content (low).** A synthetic two-episode title, founders'
  Chinese, no partner footage ever, 30-40 real lines with zh/en rationale
  pairs, one scene per review state, a mixed-language comment thread, a
  producer persona. Every screen renders from it before it is done.

### Data model and the diff

Resolved in `docs/data-model.md`; the draft's text changes as follows.

- **Three grains (high).** Principle 1 says beat, both mockups line, slide 1
  approves per scene, step 3 hedges "per line or beat". Line is the storage
  grain, Scene the container and checkpoint, Version at (adaptation,
  episode) the gate, Beat an annotation over a range. Delete "or beat".
- **1:1 pairing is broken by the toolbar (high).** Add / Split / Merge /
  Shorten on slide 1, "tighter" on slide 7. An adapted line maps to a
  source-line range; a cut is a row with empty text; merged-away lines are
  kept, not deleted.
- **No immutable approved version (high).** Slide 1 autosaves the rows the
  producer approves; the draft dropped the Versions tab. Approval freezes a
  snapshot with a hash; edits fork; Stage plays released approved versions
  only; the second-round diff is approved vs new draft.
- **Pocket in two places (medium).** One nullable pocket per adaptation;
  lines inherit; variants carry their own; enumerated, never free text.
- **Canonical vs variant (medium).** The selected title is what Stage
  shows; the other options are ad copy. Canonical pointers on the
  adaptation, variants with a `kind`.
- **Shared-project ownership undecided (high).** Service-role key that
  bypasses RLS, `tsconfig` excluding `supabase/`, no schema owner. Change:
  Decision 5.
- **Provenance and rendered assets (medium).** `authored_by`, model, prompt
  version, retained AI text; renders tied to a version; `releases` as the
  only thing Stage reads.

### Partner review

- **The producer cannot read the draft's diff (high).** Chinese beside
  English, rationale in one unnamed language. Change: `back_translation_zh`
  and `rationale_zh` required, produced in the same LLM call; a version
  cannot be submitted without them; add 回译 to the glossary.
- **No audit trail; service-role approvals unattributable (high).** Change:
  append-only `core.audit_events` inside every review function; approvals
  under the producer's own session or as audited `on_behalf`; "producer
  routes never use the service-role key" as an invariant.
- **Review at scale is triage (high).** A producer executive will not read
  every line of 3-5 titles by Week 6. Change: `is_major` per line and per
  creative, the producer's review opens on the major list, batch approval
  records the delegation rule. Decision 11.
- **Boundaries recorded but never enforced (medium).** Change: structured,
  versioned, producer-confirmed, immutable once confirmed; exports store the
  boundary version and an attestation. Enforcement beyond that is post-pilot.
- **Review is sixth in build order (medium).** Change: a thin gate (frozen
  version, zh diff export, approve / request changes, audit row, release
  gate) lands in Week 3, before dubbing and before any Stream push Stage can
  see. Voice A/B becomes a fixture made by one script (Decision 12)
  (superseded — see update).

### Pipeline and cost

- **Partner deliverables (high).** Most finished dramas ship with burned-in
  subtitles and one mixed track; neither can be undone without generation.
  Change: a checklist (clean master, dialogue or M&E stem, script or SRT,
  music note) asked at deal time, recorded on the title, and an ingest gate
  that refuses the Dubbing stage without the stem.
- **No duration budget on rewrites (high).** English runs 20-40% longer.
  Change: `duration_ms` on lines, a syllable budget in the prompt, rendered
  TTS measured, "needs Shorten" above 10% overrun.
- **"No AI video" needs a fence (high).** Vendors sell lip-sync by default;
  subtitle removal is inpainting. Change: allow-list and deny-list in
  `PRODUCT.md`; "newly produced" means human-made; lip-sync off at the
  adapter.
- **Voice cloning is a likeness use (medium).** Stock by default; cloning
  only with recorded consent; provenance shown in review.
- **Cost (medium).** Per title, APIs are $50-120 subtitle-first and
  $150-400 with end-to-end dubbing (superseded — see update: $20-45 in
  V1, $85-300 with dubbing, per the `build-plan.md` cost table), so
  the $2K line holds. The $500-1,000
  monthly line (slide 14, shared across three products) holds only
  subtitle-first; fully dubbing 3-5 titles by Week 6 lands at $600-2,000.
  Change: the cost table in `build-plan.md`, estimates labelled, cost
  recorded per job so slide 13's $0.40 per user becomes measurable.
- **Call shape and gateways (medium).** Scene is the unit of LLM work,
  cached title bible, zod-validated structured output, interactive rewrites
  stream, full passes are jobs; all calls through `lib/llm.ts`,
  `lib/tts.ts`, `lib/media.ts`, each "unavailable" without a key.
  `@anthropic-ai/sdk` is not yet in `package.json`.

### i18n

- **No surface-to-locale map (high).** The sibling's split (customer zh,
  admin en-only) is inverted here. Change: Decision 8.
- **Content is language-fixed (high).** Source always zh-CN, adapted always
  en-US; rationale, tone note and context as `{zh, en}` pairs from one call;
  enums through `t()`; no render-time translation. The sibling's "no
  mixed-language screens" rule becomes "chrome is one language per screen;
  content carries its own language and a `lang` attribute", with `.txt-zh`
  / `.txt-en` classes.
- **"Studio" means two things (high).** The draft's partner entity is
  "Studio partner" in a product called Studio; the deck says 制片方. Change:
  Decision 7; rename the scaffold's `term.partnerStudio`,
  `term.studioReview`, `stage.studioApproval`.
- **Vocabulary drift and gaps (medium).** "acquired viewer 用户" vs the deck's
  acquired users; "episode 单集" vs 第 N 集; "localization" for both the
  rewrite and the mechanics; no words for approve, request changes, version,
  major change, boundaries, back-translation, release; no Chinese for the
  workflow states. Change: the glossary in `PRODUCT.md`.
- **Fonts (medium).** The scaffold copied Outfit 700/800 in a system capped
  at 600. Declare 400/500/600; never link an external host; drop pinyin from
  v1.

### Document shape

- **Split the draft (high).** `CLAUDE.md`: identity paragraph, Invariants
  (each naming its enforcing file), Conventions, Where things live, Later.
  `PRODUCT.md`: the business. `docs/`: deck-notes, archived draft,
  build-plan, data-model.
- **Delete "Claude Code can choose the framework" (high).** `package.json`,
  `tsconfig.json`, `.claude/launch.json` and `public/fonts` already fix the
  stack. The only open choice is the dubbing provider (superseded — see
  update; no open choice on the MVP path).
- **Replace "Where the rest lives" (high).** Repo-relative pointers only;
  copy the synthesis paragraphs that justify the diff into `PRODUCT.md` or
  drop the reference.
- **Principles are hypotheses (medium).** Nothing is marked open although
  the header promises it; Voice A/B and pockets appear on no slide; the 30%
  is an assumption on slide 13. `PRODUCT.md` tags each principle with its
  source and carries an Open decisions list.

## Decisions the founders must make now

1. **Unit of review.** Default: line stored, scene checkpoint, episode
   version gate. Wrong: the schema and the Approve / Request Changes UI are
   rebuilt after data exists.
2. **Week-4 launch format.** Default: subtitled (sidecar VTT); dub the free
   episodes of 1-2 titles by Week 6 through one end-to-end provider, stock
   voices; dubbing is a per-episode flag. Wrong: the monthly API line is
   blown or the first title slips. (superseded — see update: script only,
   English VTT + bilingual diff; no dubbing trial.)
3. **How the producer approves in the pilot.** Default: exported zh diff
   over WeChat, approval recorded `on_behalf` with screenshot and actor;
   producer login and share links Week 7-8. Wrong: a portal nobody uses by
   Week 4, or approvals with no evidence. (superseded — see second update:
   the partner portal is in V1; `on_behalf` survives as a staff-admin path
   with an evidence note.)
4. **What the partner delivers.** Default: SRT/VTT/ASS required; clean
   master and dialogue/M&E stem requested; checklist in the deal; no in-app
   alignment. Wrong: a three-week ASR project on the critical path.
5. **Schema ownership and deploy target.** Default: Studio owns `core` and
   `studio` and the only migrations directory; shared ids not shared tables
   with Reach; one long-lived Node process on a VPS with ffmpeg. Wrong:
   migration drift across three repos, or a serverless deploy that cannot
   run the pipeline.
6. **Producer gate on creatives.** Default: structured confirmed
   boundaries; first creative set per title approved in full; afterwards
   only `is_major` variants block. Wrong: Reach stalls, or slide 10 is
   broken. (superseded — see update: text variants only in the MVP.)
7. **Naming.** Default: `producer` for the partner, `Studio` for the
   product; stages `ai_first_pass` / `editorial_review` /
   `producer_approval`. Wrong: ambiguous tables and keys within weeks.
8. **Locale defaults.** Default: `app/(admin)/` en, `app/(producer)/` zh,
   cookie wins; content never follows the locale; rationale as zh/en pairs
   plus a zh back-translation. Wrong: a producer approving text they cannot
   read.
9. **Pockets and adaptations in the pilot.** Default: pocket on the
   adaptation; one adaptation per title in the UI; pilot titles by judgment
   (skip slide 18 (03)). Wrong: three dubs of one title on a $2K budget.
10. **Design target.** Default: slide 1 primary, sibling tokens and blue,
    do-not-build list, Outfit 400/500/600, no pinyin. Wrong: a violet
    template with a wallet as the first screen.
11. **Major-change criteria and delegation.** Default: bring a proposed list
    (plot beat removed, motivation changed, ending changed, cultural/
    religious/political reference added, likeness reused in creatives) to the
    first producer; record the answer on the boundary. Wrong: the producer is
    asked to read every line, and stops reading.
12. **Voice A/B.** Default: a fixture-backed script producing two committed
    renders in Week 1-2; the pipeline reproduces them later. Wrong: a week of
    dubbing infrastructure before the review gate exists. (superseded — see
    update: deferred entirely, not fixtured.)

## Decisions deferred

- Dubbing provider, final: after the Week-5 trial, with measured cost
  (superseded — see update; no trial in the MVP plan).
- Whether Reach moves to Supabase: not before Week 10.
- Studio accent colour: all-blue through the pilot; revisit month 3 only if
  needed.
- Grade attribution shares across variants and versions: after pilot data;
  no grade column until then.
- Editor role, assignment UI, Team nav: month 4-5 (slide 15).
- Producer-facing results and monthly report: month 3; keyed by title and
  producer from day one.
- New-title incubation (slide 19): month 4-5.
- Per-user preferred locale in the database: month 3.
- One Stream asset per adaptation vs multi-track: default one per
  adaptation; check the API before Week 5 (superseded — see update: Later,
  with renders; check before then).
- Per-line pocket tags, tag taxonomy table, gradeable registry: when a
  grading loop consumes them.

Footnote on a common misreading: slide 13's $2K per title and slide 14's
$500-1,000 monthly API line are different buckets (the first includes
editing and creative production, the second is platform APIs across three
products); they do not contradict, and the only engineering consequence is
Decision 2 (superseded — see update).
