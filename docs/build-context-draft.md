# Pulsar Studio: build context (DRAFT, as received 2026-09-03)

> Verbatim draft from the founders. Under review; see docs/build-context-review.md
> for the critique and CLAUDE.md / PRODUCT.md for the revised, adopted versions.

Drop this in the repo as CLAUDE.md (or reference it from one). It is what Claude Code needs to know about the business before touching code. Product decisions here are settled as of September 2026; anything marked "open" is not.

## What Pulsar is

Pulsar takes finished Chinese mini dramas (vertical, 1 to 2 minute episodes, 50 to 100 episodes per title), adapts them for American viewers, buys traffic on TikTok and Meta, and monetizes them on its own U.S. web platform. Three products, one loop:

* Pulsar Studio: adapts the title and produces the ad creatives. This repo.
* Pulsar Reach: runs the ads on TikTok and Meta. Consumes Studio's creatives; reports back which ones brought viewers and paying users.
* Pulsar Stage: the platform where viewers watch and pay (first episodes free, then per-episode unlock or subscription). Web first, native app later. Reports back which titles, scenes and hooks led to payment.

The loop on the deck: Select (pick titles likely to work in the U.S.) → Studio (adapt, make creatives) → Reach (buy traffic) → Stage (watch, pay) → Learn (data back to selection and adaptation). Studio sits at step two and is fed by step five.

Commercial model: the Chinese studio keeps the IP and gets a royalty (Pulsar assumes 30% of net receipts). Pulsar funds adaptation and media spend and holds a U.S. distribution and marketing license for a fixed term. The studio reviews and approves every adapted version before it goes live, sets marketing boundaries (positioning, actor likeness, what cannot be advertised, what counts as a major change), and confirms titles one by one. Studio the product must make that review step real, not a checkbox.

## What Pulsar Studio does

The deck's four steps, which are the product's four stages:

1. Understand the original. Script, episode structure, characters, and the core emotional beats.
2. American localization. Dialogue, pacing, dubbing, subtitles, titles, thumbnails, on-screen text. Rewritten for an American viewer, not translated. The thesis is that translated catalogues (DramaBox, DramaWave) lose viewers at specific beats and a rewrite fixes those beats.
3. Studio review. The partner studio reviews and approves the adapted version before launch.
4. More sell points for the same title. From U.S. click and viewing data, produce new hooks, trailers, thumbnails, titles and alternative openings for a title already live.

Studio's outputs, in order of importance to the business: the approved adapted episodes (dubbed or subtitled video plus rewritten script), and dozens of ad creatives per title (hooks, trailers, openings, thumbnails, titles) for Reach to test. Reach expects many variants per title; Studio's value is making variants cheap.

## Product principles (settled)

* The unit of output is a diff: original beat, why an American viewer drops here, the replacement. A Chinese studio executive cannot judge an English script, but can read a diff and forward it. Every rewrite Studio produces should be presentable that way.
* Verifiability over generation. Do not build a "type an idea, get a script" tool; Chinese tools already do that faster and in-language. Studio starts from a finished title.
* Voice A/B is the demo: one scene, literal translation versus rewrite, side by side, ninety seconds. Build the thing that makes this comparison one click.
* No AI video generation. Adaptation works on existing footage: audio (dubbing), subtitles, cuts, on-screen text, thumbnails, and new edits of existing footage for creatives.
* Audience-first entry point survives: a title can be adapted toward a specific American audience pocket, and the same title can get more than one adaptation or creative set per pocket.
* Adaptation data compounds. Which hooks and rewrites paid, per audience, becomes a reusable library. Design the data model so a diff can be tagged with a pocket and later graded by Reach and Stage results.

## The design preview (what the deck shows)

Slide 7's mockup is the reference UI. Left nav: Overview, Projects, Assets, AI tools, Reviews, Team, Partners. Top tabs inside a title: Overview, Adaptation, Hook and title, Thumbnail, Script, Localization, Content review. The Adaptation view: video player with timeline on the left; on the right a two-column script where each original Chinese line sits beside its rewritten English line, with a "why this change" note under the rewrite; a hook picker and a title picker below the player, each a short list of options with one selected. Status chips such as "adapted, U.S. English" and a review state. Treat this as the target, not a spec; Reach and Stage screens from the same design system exist for reference.

## Numbers the product has to fit

* Pilot: 3 to 5 titles, then 8 to 12 titles live by month 6. Two to three partner studios by month 3.
* Adaptation cost target: about $2K per title, all in, spread over the first 5,000 acquired viewers. That is the budget for dubbing, subtitles, editing and creative production per title, so the pipeline has to be mostly automated with human review, not a manual editing job.
* Monthly platform cost at pilot scale: AI, dubbing and creative APIs $500 to $1,000 a month across all three products. Model and dubbing calls need to be cheap per episode.
* Timeline: Week 4, Studio and Reach workflows available and the first title adapted. Week 6, first 3 to 5 titles adapted and live on Stage. Week 10, pilot complete.
* Founders are the only engineers for the first six months. Two people, one of them also running product and studio relationships. Scope accordingly.

## Stack decisions from the deck

Supabase (Postgres, auth, storage) from the Pro plan. Cloudflare Stream for video ($5 per 1,000 minutes stored, $1 per 1,000 minutes delivered; encoding and bandwidth included). Stripe on Stage. External AI, dubbing and creative APIs rather than self-hosted models. Web app. Nothing else is decided; Claude Code can choose the framework, but it should share auth, storage and the data model with Reach and Stage, which live in the same Supabase project.

## Suggested MVP scope

Build in this order, each step usable on its own:

1. Title ingest. Upload episodes (or pull from Cloudflare Stream), attach the Chinese script or subtitle file, align lines to timecodes. Entities: Studio partner, Title, Episode, Line (timecoded, original text), Character.
2. Understanding pass. Per episode: beat list, characters, emotional turns, the hook of episode one, the cliffhanger of each episode. Stored, editable.
3. Adaptation pass. Per line or beat: rewritten English, rationale, tags (pocket, change type). Output is the diff view. Support more than one adaptation per title.
4. Voice A/B. Generate literal and rewritten English audio for one scene, play side by side.
5. Dubbing and subtitle export. Per episode: dubbed audio track, subtitle file, burned-in or sidecar. Push to Cloudflare Stream for Stage.
6. Studio review. Partner logs in, sees the diff and the video, approves or comments per episode. Marketing boundaries recorded per title. Nothing goes to Stage without approval.
7. Creative generation. From approved footage: hook clips, trailers, alternative openings, thumbnails, title options. Export sets to Reach with IDs so results can come back.
8. Feedback. Ingest Reach and Stage results per creative and per adaptation; surface which hooks and rewrites paid.

Not in scope now: script generation from scratch, AI video, a marketplace for brands, a native app, anything a partner studio would use before a deal exists.

## Vocabulary (English / Chinese as used on the decks)

title 剧 / 剧集 · episode 单集 · adaptation 本土化改编 · hook 开场 Hook · creative 素材 · trailer 预告 · thumbnail 缩略图 · dubbing 配音 · subtitles 字幕 · studio (partner) 制片方 · studio review 制片方审核 · acquired viewer 用户 · paying user 付费用户 · first-payment rate 首充率 · media spend 投流 · scale spend 放量 · Stage 自有平台 · closed loop 闭环.

## Where the rest lives

Project docs in the Claude project "Chinese Businesss": pulsar/investor-deck-brief-v1.md (full deck copy), pulsar/product-strategy-synthesis.md (why the diff is the product), pulsar/deck-review-decisions-2026-09.md (decision log), pulsar/investor-deck-chinese-text.md (Chinese copy and term list). Deck exports: "investors vS English.pdf".
