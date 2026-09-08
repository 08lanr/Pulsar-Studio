# Market research: what the first two crawls showed (2026-09-06)

> **Historical note.** The numbers in the body of this file describe the
> first crawl on the evening of 2026-09-06 (a first pass that also caught
> ReelTalk podcast rows). The section right below is regenerated from the
> published data and is the current truth; the Data & Sources page in the
> portal shows the same numbers live.

## Current status (generated)

Published run `2026-09-07T04-38-53Z`, schema v2, taxonomy `2026-09-07.1`:
507 platform listings (not distinct dramas), 506 with at least one trope.

| platform | status | listings | with views | fetched |
|---|---|---|---|---|
| reelshort | ok | 442 | 442 | 2026-09-07T04:39:46.308Z |
| dramabox | ok | 65 | 53 | 2026-09-07T04:38:53.436Z |

Audience geography for both sources is **unknown**; collection locale is
`en`. Runs live under `data/research/runs/<run_id>/`; the builder never
overwrites a run and publishes only after validation
(`docs/market-desk-plan.md`).

Source corrections from the review, now recorded in the registry
(`lib/research/registry.ts`) and shown on Data & Sources:

- **Meta Ad Library** is not a guaranteed US commercial-ad feed; its
  documented broad commercial scope is UK/EU. Treated as a research task or
  reviewed import, never a promised connector.
- **YouTube** public counters carry no viewer geography and differ from
  owner-authorized analytics; Shorts view semantics changed in March 2025.
- **Google Trends** is a normalized index, one series per export.
- **TikTok Top Ads** is a selected sample.
- **No free Apple top-grossing RSS feed is assumed**; a storefront or
  licensed source must be validated first.


Written the evening the market-desk pivot landed (top of `docs/decisions.md`).
Two platforms were crawled to learn what is actually observable before
designing the product around it. Everything below was verified against
live pages on 2026-09-06 with `scripts/research/*`.

## Summary

| | ReelShort | DramaBox |
|---|---|---|
| Public surface | `reelshort.com` (Next.js, `__NEXT_DATA__` JSON in the HTML) | `dramaboxapp.com` (same) |
| Auth needed | none | none |
| Lists observed | home shelves (TOP, New Release, Reel Original, Hidden Identity, Love at First Sight, Second Chance, Pregnancy & Babies, Interactives, Young Love, More Recommended), TOP shelf = 200 titles, New Release = 200 | home rails (Top Hits, Must-sees, Trending, Hidden Gems), `/more/<rail>` (18 each), `/browse` (newest 12 + 56 genre ids), `/film/<id>` detail |
| Per-title metrics | `read_count` (views), `collect_count` (saves), `paid_start` (first paid episode), `chapter_count`, ep1 duration, `is_new`, trailer flag | `viewCount` and `followCount` on the film page, `ratings`, `chapterCount`, `shelfTime` (release date), per-episode duration and price, publisher (`author`, e.g. Webfic) |
| Tags | theme tags (Female/Male, Modern, Romance, Revenge, Playing Dumb, Strong Heroine, Werewolf, Mafia…) | `tags`/`labels` (Family Bonds, Strong Female Lead, Revenge, War God…) + `typeTwo` genres (56: Werewolves, Avenge, Divine Tycoon, Son-in-Law, Secret Identity…) + F-Drama/M-Drama |
| Studio attribution | none (only "Reel Original" marks first-party) | `author` on rail cards (mostly Webfic, DramaBox's own publisher) |
| Titles in the first snapshot | 397 | 110 (53 with film-page metrics) |

Both crawls run in about two minutes with a 700 ms pause between requests.
Total: 507 titles, 506 tagged with at least one trope by the taxonomy.

## Caveats found while crawling (all handled in the scripts)

- **Pagination is client-side on both sites.** Every page of a ReelShort
  shelf returns the whole 200-title list; DramaBox `/more/<rail>?pageNo=2`
  and `/browse?pageNo=2` return page 1. The scripts dedupe and stop when a
  page repeats. Deeper lists need the sites' XHR endpoints, which we have not
  used (they may need signed params); 200 + 200 + rails is enough for charts.
- **DramaBox shows two different "view counts".** Rail cards carry a small
  display number (10–20K) that does not match the film page (tens of
  millions, e.g. Queen Mom Rules 51.7M views / 1.3M follows). Only film-page
  numbers become metrics; card numbers are dropped. Titles without a film
  fetch have `views: null` and rank by chart placement only.
- **ReelShort's `read_count` and DramaBox's `viewCount` count different
  things.** Never compare them. The engine ranks within a platform (heat =
  view percentile lifted by chart rank) and only compares shares.
- **Non-drama rows share the shelves.** ReelTalk podcast episodes and
  reality clips carry `Podcast` / `Reality Show` tags; the snapshot builder
  drops them.
- **Studio attribution is thin.** DramaBox's `author` is almost always its
  own publisher label (Webfic). ReelShort names nobody. "Which studio made
  this" will need a second source (YouTube channel credits, press, the
  Chinese title match) and will be labeled `inferred` when it comes from
  matching rather than the platform.
- **Terms of service.** Both sites' terms restrict automated access. This is
  research use of public catalog pages at low volume, with a named
  user-agent, no login, no video, no per-user data. The founders should make
  that posture a conscious call before a daily job runs; the crawlers keep
  the volume and cadence trivial to adjust (`RESEARCH_PAUSE_MS`, page caps).

## What this makes possible, and what it does not

Observable now (`observed`): what each platform is charting, saves and
views per title within a platform, the paywall position (ReelShort median
around episode 10–11), episode counts and lengths, release dates
(DramaBox), the platforms' own tags, and DramaBox's publisher.

Derivable now (`inferred`): tropes for every title (the taxonomy), the
audience split (女频/男频), similar titles across platforms, trope shares of
the charts, and change over time once a second snapshot exists.

**Not observable from these sources**: competitor CTR, payer conversion,
ad spend, revenue per title. The product does not show these as facts.
Estimates (`estimated`) can come later from Sensor Tower / AppMagic at the
app level, and never per title.

## Next sources, in order

1. **Meta Ad Library** (public API): which titles ReelShort/DramaBox/
   ShortMax are spending on right now, creative counts per title, hook copy.
   The strongest free competitor signal.
2. **YouTube Data API**: mini-drama channels, views and velocity per title,
   comment volume; studio attribution through channel ownership.
3. **TikTok Creative Center**: trending hashtags and top ads (web, no API).
4. **US app charts**: only after a storefront source or licensed report is validated (no free RSS feed is assumed).
5. **A second crawl** of the same two sites turns on the change columns.

## Runbook

```bash
npm run research:crawl
```

Runs both collectors under one run id (`data/research/runs/<run_id>/`),
then builds and publishes the snapshot (`data/research/snapshots/<run_id>.json`
and the `data/research/published.json` pointer) only after validation. A
run is never overwritten; `npm run research:build` with
`RESEARCH_RUN_ID=<id> --force` re-applies the taxonomy to an existing run's
artifacts. In Supabase mode the app still reads the committed files;
`research.title_observations` (migration 0004) is the landing table for a
scheduled job to write history into once the founders enable collection.
