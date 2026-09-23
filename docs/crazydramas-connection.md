# The crazydramas connection (read-only)

Decision 2026-09-23 (top of `docs/decisions.md`), plan `connection-segment-plan.md` part A (A0–A5, A8). Studio reads the public crazydramas.com API and tells, for each title, where its series stands there. It writes nothing on crazydramas, holds no credential of any kind, and never claims more than a public read can prove.

## What it answers, and what it never claims

For each Studio title, four things:

1. Is this series on crazydramas?
2. How many episodes are there, and are they numbered 1..N?
3. Which episodes match Studio's files, and which are missing, another length, or still processing?
4. What are the free/paid split, the price, whether an IAP product is set, and is the poster still the placeholder?

A duration match proves only **"same length"**. It never proves "same file". A true "identical" needs a record of what Studio itself uploaded — the ledger of plan A6, the write path, which is **not built** and waits on a decision about access. The three series live today (Mafia King, Reclaiming Her World, He Hated All Women) were uploaded by hand through the crazydramas CMS, so for them the answer stays at "same length". The `identical` and `local_newer` values exist in the types and are never produced in v1.

## Where the data comes from

Two public endpoints, read by `lib/crazydramas/transport.ts` and nothing else:

| Read | What it gives | Notes |
| --- | --- | --- |
| `GET /api/dramas` | the published catalog | `Cookie: pulsar_mock=0` is sent **and** every `mock-*` slug is dropped after the parse, because the edge cache ignores the cookie and production mixes in 18 mock series. `cache: 'no-store'` (Next 14 caches server fetches otherwise). Up to 60 s of lag after a publish (public `max-age=60`). |
| `GET /api/dramas/<slug>` | the drama (id, status, freeEpisodeCount, seriesPriceCents, iapProductId, posterUrl, posterBlurhash) and its **published** episodes (episodeNumber, durationSeconds, status, isPublished) | **404 means "not live".** It does not mean "not uploaded": a draft and an archived series answer 404 too, and the public API cannot tell them apart. |

`playbackId`, `previewPlaybackId` and `thumbnailUrl` are **never stored or shown**: the thumbnail URL carries the Mux playback id of paid episodes (a paywall leak on crazydramas). The zod schemas in `lib/crazydramas/types.ts` are whitelists — nothing outside the fields named there survives a parse, and a hand-built row that carries one of those keys is refused. The saved bodies under `tests/fixtures/crazydramas/` are stripped the same way.

`CRAZYDRAMAS_BASE_URL` (default `https://crazydramas.com`) is the site's origin, not a secret. Fixture mode never fetches: `lib/crazydramas/fake.ts` answers with a deterministic catalog that mirrors `tests/fixtures/workspace` (`fixture-film` complete, its three episodes 120, 150 and 180 frames at 30 fps as `ffprobe -count_packets` measures the checked-in files; `-partial`, `-differs`, `-processing`, `-draft` (404), `-broken` (a failed read); plus the three real unmatched series), and its posters are two SVGs the app serves itself (`public/crazydramas-fake/poster.svg`, `poster-placeholder.svg`), so the browser never asks crazydramas.com for a poster either — the e2e spec aborts and fails on any request to another host. `CRAZYDRAMAS_LIVE_READ=1` is the engineer's override that allows the public reads from fixture mode. Under node:test the live transport refuses before any request, whatever the environment says. `lib/crazydramas/pick.ts` is where the transport is chosen; `index.ts` re-exports it, and no module inside the folder imports `./index`. (What broke `next build` under the default heap was not that cycle but output tracing following `path.join(process.cwd(), ".uploads")` in `lib/data/storage.ts` and `lib/data/launch.ts` into the runtime folder — 33 GB, some ten thousand entries; `next.config.js` now keeps `.uploads`, `.uploads-e2e` and `tmp` out of the trace with `outputFileTracingIgnores` / `outputFileTracingExcludes`.)

## What is kept (migration `0017_crazydramas_link.sql`)

- **`core.platform_links`** — which drama on crazydramas the title *is*: `title_id`, `platform 'crazydramas'`, `slug` (the slug the drama is read under now; a followed CMS rename moves it), `title_slug` (the title's own `crazydramas_slug` when the link was made or last re-pointed in Studio; a followed rename keeps it, or records the title's current slug when that is one the link already accepted — film-meta brought up to date with an earlier rename), `cd_drama_id`, `linked_at`, `linked_by`. Made on the first 200 read of `core.titles.crazydramas_slug` with the drama id the platform returned; from then on the title is matched by that id, because a slug can be edited in the crazydramas CMS. One link per title × platform, one title per drama id.
- **`core.platform_snapshots`** — append-only, one row per public read of one slug: `http_status`, the whitelisted `drama`, the `episodes` list, `read_at`, `error`; `title_id` the title the check ran for, null for a series that matches no title. The sweep keeps the last twenty per slug. These are public facts: producers of a title read its rows (`can_read_title`); a row with no title is staff's to see. A title's reading is built from **its own** rows of the slug ("one film is one title per company", so two companies' titles can carry one slug and each records its own reads); another title's rows are never this title's reading, whoever looks. Future stats (revenue, funnels) do **not** go here.

No job kind: a public GET costs no model money, `studio.jobs.target_id` is NOT NULL, and producers cannot read jobs. The snapshot row is the record. Both backends implement the rows through `getData()` (`getPlatformLink`, `listPlatformLinks`, `upsertPlatformLink`, `recordPlatformSnapshot`, `listPlatformSnapshots`, `listLatestPlatformSnapshots`, `prunePlatformSnapshots`, `listTitlesWithPlatformSlug`, `listTitleEpisodes`) with the same refusals: a foreign title is not found, a producer write is forbidden, a bad slug or body is invalid, a drama id already linked to another title is a conflict.

## The states

`lib/crazydramas/match.ts` derives the reading from what the data layer holds (the title, its episode rows, the slug's snapshots newest first, the link); it is never stored. The screens call one pure function, `crazydramasStatusFor(title, episodes, snapshots, link)`, and the loaders `loadCrazydramasStatus` / `loadCrazydramasStatuses` in `lib/crazydramas/sweep.ts` gather the inputs.

**Series state**, first rule that applies:

| State | When |
| --- | --- |
| `not_linked` | no slug in film-meta / on the title |
| `not_checked` | a slug, and no read yet (the sweep runs on the first tick after boot; an import checks at once) |
| `read_failed` | the newest read failed; the newest good read is shown, marked stale, with its own read time |
| `not_live` | 404 — "not uploaded, or draft". Also a 200 for **another** drama under the linked slug (`note: slug_reassigned`, a CMS edit) |
| `live_partial` | a Studio episode number is absent on crazydramas, or an episode there is still uploading, processing or failed |
| `live_differs` | an episode is another length, crazydramas has an episode Studio does not, or its numbers are not 1..N |
| `local_newer` | only with a ledger (plan A6): Studio's file is not the one it uploaded — never in v1 |
| `live_unverified` | every episode is there and ready, but Studio has no frame count for one of them (an uploaded, non-imported title) |
| `live_complete` | counts equal, numbers 1..N, every episode ready and "same length" — or "close", an older render; when any episode reads close the chip says so in words ("complete · some older renders", `chipReading().older`), never as a count |

`not_checked` and `live_unverified` are the two states plan A3 left implicit; both are honest answers rather than a claim. Keeping "close" inside `live_complete` is deliberate: Mafia King's 21 re-rendered episodes are one frame short of the zip's files and are not re-rendered (build amendment 2), and a series that reads "lengths differ" would also be swept every 15 minutes for good.

**Per-episode verdict**, pairing by episode number: `missing` (Studio has it, crazydramas does not), `extra` (crazydramas has it, Studio does not), `not_ready` (status uploading, processing or failed, or no length yet), then the frame rule below: `same_length`, `close`, `different_length`, `unknown` (Studio has no frame count), and `identical` (ledger only).

**Free/paid and extras:** free is episodes 1..freeEpisodeCount, paid the rest; the price is `seriesPriceCents` ($9.99 today); "IAP set" is whether `iapProductId` is present; the poster is the placeholder when its URL contains `-placeholder` (three live series today: he-mocked-…, he-treated-…, ever-since-…).

## The frame rule and its calibration caveat

```
d = round(durationSeconds × fps) − video_frames
```

with `durationSeconds` from crazydramas (what Mux reports), `fps` from the file (inferred from the import's own `video_frames` / `duration_ms`, snapped to a standard rate; a caller may pass the film's fps) and `video_frames` from Studio's own ffprobe count on the imported link (`lib/film-import/import.ts`).

| d | Verdict | Why |
| --- | --- | --- |
| **+2** | `same_length` | the measured Mux offset: all 52 Mafia King files from `cut/eps.zip` give exactly +2 |
| +1, +3, +4 | `close` | the current re-renders show +3 and +4 against live: "probably an older render" |
| anything else | `different_length` | for example He Hated All Women's episodes 3, 4, 29, 30, 56 and 57 after their three boundary fixes were rendered |

**Never ±0.1 s**: it misfires on 69 of 169 live episodes (a file 0.000 s apart that is not the Mux offset is *not* the same length). The offset lives in one named constant, `MUX_FRAME_OFFSET = 2` (`lib/crazydramas/match.ts`, with `FRAME_RULE.calibrated_on`, `calibrated_files` and `confirmed: false`). **It is calibrated on one film.** It must be confirmed on the first Studio-made upload before it may block anything; until then the reading informs and never gates.

## Refresh

- **The sweep** — step 5 of the scheduler's tick (`lib/tiktok/scheduler.ts` → `tickCrazydramas()` in `lib/crazydramas/sweep.ts`): once an hour, or every 15 minutes while any title is `live_partial` or `live_differs` (an episode not ready reads partial) or the last sweep hit an error. One catalog GET plus one GET per linked or catalog slug, in sequence; the catalog's series that match no title are read and recorded with no title (the staff mirror's "Unmatched on crazydramas" list); then the prune to twenty rows per slug. Skipped under `SCHEDULER_DISABLED=1` and under node:test.
- **Check now** — `POST /api/titles/[id]/crazydramas/check`: same-origin guard, staff or a producer reviewer / approver (a viewer stays read-only and gets 403 from the route and from `checkCrazydramasTitle` alike, the rule the page's button follows), zod, the same check function, JSON. Refused with 429 (`code: too_soon`, `retry_after_s`, `Retry-After`) while a snapshot of that slug is younger than 30 seconds — before any request is made, and judged on every read of the slug whoever made it — and with 409 (`code: not_linked`) when the title has no slug. A foreign title is 404. The status in the answer is the caller's own reading (their session's rows of the title).
- **After an import** — `lib/film-import/import.ts` runs one check once a successful import set a slug, failure-soft (a failed check is a log line, never a failed import).
- **The staff mirror** — `GET /api/admin/crazydramas/unmatched` (and the Import films desk): the series live on crazydramas that match no Studio title, from the newest title-less snapshot per slug; `series` is null until a sweep has read the catalog at all.

Following a rename (`resolveReadSlug`): a check reads the link's slug; when the catalog lists the linked drama id under another slug (a CMS rename), that slug is read and the link's `slug` follows while its `title_slug` stays; when the title's own slug is none of the link's `title_slug`, its `slug` or the platform's (the person re-pointed the title in Studio), that slug is read and the link moves to the drama it answers with, `title_slug` becoming that slug — refused, in the snapshot's error and without naming the other title (it may be another company's: "…is a series linked to a different title, so the link was not moved; staff can resolve it"), when another title holds that drama. `title_slug` is what keeps the third check after a rename reading the platform's slug: film-meta still carries the pre-rename slug, and without the record of what the title's slug was at link time that read as a re-point (the phase 3a review). On a followed rename the link records the title's current slug as `title_slug` when it is already the link's `title_slug` or `slug` (film-meta was brought up to date with the first rename), so a second rename does not turn that slug into a re-point (round two). The screens read the same way (`loadCrazydramasStatus` takes `resolveReadSlug` without a catalog): after a re-point the reading is the title's own slug with no link — "not checked yet" until the new slug is read, "not live" when it answers 404 — never the old drama with a frozen checked time; and a check's answer carries the link only when the slug it read is the link's.

## What credentials would add later

Nothing in this phase reads a credential. When one is added, it is always prefixed `CRAZYDRAMAS_`, never `NEXT_PUBLIC_` (crazydramas's own `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` collide with Studio's), kept in `.env.local`, read only in `lib/crazydramas/transport.ts`, and never written to a row, a log, a fixture or a response — routes say "configured: yes/no" only (the `lib/tiktok/tokens.ts` rule).

Preferred: a narrow crazydramas route `GET /api/studio/series/<id>` with a `CRAZYDRAMAS_STUDIO_TOKEN` read scope over giving Studio the service role. Either way Studio would gain: drafts and archived series (so `not_live` splits into `not_uploaded` and `draft`); new episodes not yet published, uploading or failed; `mux_upload_id` / `asset_id`, created and updated times; and the stats views (`funnel_by_drama`, `funnel_by_creative`) — into a staff-only table, not the snapshots. A Mux **Read** token (`CRAZYDRAMAS_MUX_TOKEN_ID` / `_SECRET`) adds `GET /video/v1/assets/{id}/input-info`, the uploaded file's own track durations and dimensions: the only retroactive identity check for the three live series.

The write path (publish a series, upload missing episodes, replace an episode; plan A6) is deferred to a decision on access with Jayden, and the paywall leak (paid episodes' `thumbnailUrl` exposing the playback id) is a prerequisite to fix before Studio pushes more paid content.
