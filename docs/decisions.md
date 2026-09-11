# Decisions log

Integration note (2026-09-07): the Promote desk migration is `0006_promote_desk.sql`, after the market desk migrations `0004_research.sql` and `0005_watchlist_reports.sql`, to keep migration versions unique. Its column addition remains idempotent.

Newest first. A decision here overrides anything older in `PRODUCT.md`,
`docs/build-plan.md`, `docs/data-model.md` or `docs/build-context-review.md`
until those files are brought in line.

## 2026-09-10 (latest) · Market signal counts what the platforms are launching now

Decided by the founders (Ruobin) while rehearsing the demo: the What to make next board said a title's story types were launching at twice their usual share while its US launch priority showed "Market signal 5 / 10 · moved 0 pts", so the two pages disagreed. Assessment v1.1 (`lib/research/assessment.ts`):

- **Market signal 0–10 = launch lift 0–6 + chart movement 0–4.** Lift is the largest `fresh_share / share` among the title's tropes, read from the same `whatToMakeNext` board (v1.0) the producer sees: ≥ 1.5× → 6, ≥ 1.2× → 4, ≥ 1.0× → 2, else 0; labelled inferred, with the count of tropes at or above 1.2× and the largest lift shown. Below 10 recent listings the fact says so and scores 0. Chart movement keeps the day-over-day cohort-share delta (observed), now mapped to 0–4 around 2.
- **The movement was always 0 before.** `loadWorkspace` never passed the previous day's snapshot to `tropeStats`, so `delta_pts` was null for every trope; it now passes the previous day scored, and the fact reports the real mean.
- Bands and every other component are unchanged; the composite stays "our evidence summarized, never a probability".
- **Same day, for the demo walk:** My catalog accepts `?trope=<id>` and the "N of your titles carry it" link on What to make next carries it, so the board's story type filters the catalog (a status line names the story type, and each row shows its own story types while the filter is on; the plain board is unchanged otherwise). Company & accounts leads with the goal and shows the profile as chips. **Rights are no longer scored** (v1.2): the license window stays recorded on the title but contributes no points, no band override and no next-step; launch readiness is subtitles 0–10, video 0–8, destination 0–4, ad account 0–3. **Pulsar's 15% service fee is shown** under every proposed budget (`lib/promote/fee.ts`: ad spend + fee = total billed) on the new-campaign form and the brief panel; the approved budget stays the ad spend and is what TikTok receives. The new-campaign form proposes $500 and a tiktok.com destination by default. **Lifts are displayed as signed percentages** (`lib/research/lift.ts`: 2.18× → "+118%") on What to make next, Explore › story types and the assessment facts; the column reads "Share increase · vs its usual share". The ratio stays in the data and the registry.
- **TikTok revenue & audience, same day:** (1) a from/to date form beside the presets (`?range=custom&from&to`, `parseWindow`, clamped to the delivered data, previous period of the same length); (2) the data bar is labelled cells (Period · Data through · Last sync · Source) with source notes as chips; (3) the overview opens with **How this title is doing** (`lib/analytics/health.ts`): revenue and viewers vs the previous period, payer conversion and revenue per viewer vs the catalog median of the producer's other titles with data, and **blended ROAS** = all title revenue in the period ÷ ad spend whose reporting window overlaps it, labelled blended and never attributed; an overall rules-based label (Doing well / Mixed / Needs attention / Not enough data). Nothing here predicts. The demo seed's campaign 4 (Rise of the Son-in-Law) is a finished round with demo results and one open change request, so the title has a result to read before the next round is drafted from Prepare.

Checks: `npm test`, `npm run typecheck`, `npm run build`.

## 2026-09-09 · TikTok launch inside Studio: connect, launch, read back

Decided by the founders (Ruobin): "all I really want you to port over is the ability to connect to TikTok, launch ads, and feed the metrics back … keep the entire Studio workflow as is … the only thing we need from the admin side is the ability to make sure everything is going well." The Pulsar Grow bridge (2026-09-04 "Grow owns launch") is retired: Studio launches ads itself. What was ported from the sibling `pulsar` repository is its TikTok transport, OAuth connect, identity preflight, the idempotent launch engine, the review verdict logic and the ad-level metrics sync; what was left behind is its merchant model, category blocklist, concierge queue, spark/mass launch, warm-ups and the operator approval gate.

- **The producer flow is unchanged and now real.** Brief → generate → choose → approve ads → approve budget → **Launch on TikTok** → results. The launch button replaces the demo handoff; no staff step sits between the producer's approval and TikTok. The destination URL is required (ads send viewers to a link, decision: "we'll have a platform ready for it"); objective TRAFFIC to that link, CTA WATCH_NOW.
- **One launch per approval manifest, resumable.** `promote.launches` (migration 0008) holds one row per manifest hash (unique idempotency key); each step's TikTok id is recorded before the next runs, so a retry or the scheduler's adoption resumes at the first unfinished step and can never create a second campaign (`lib/tiktok/launch.ts`, Pulsar's invariants over `getData()`). The ad group's lifetime budget is exactly the approved experiment budget; nothing sends more than the approver signed. A budget change is a new experiment version, which clears approval as before.
- **Statuses from `launching` on are TikTok's** (`launching` engine running → `submitted` created, in TikTok's review → `live` | `paused` | `ended` | `failed` with TikTok's reason in `status_note`). A five-minute in-process scheduler (`lib/tiktok/scheduler.ts`, started by the first request of the process; `SCHEDULER_DISABLED=1` off) adopts stale launches, polls review (`/ad/get/` + `/ad/review_info/`, neither sufficient alone) and reads ad-level daily metrics back hourly into `promote.results` with `source: "tiktok"`, upserted on (creative, window, source). Staff `Sync now` runs a tick on demand.
- **Hook hold is the 2-second watch rate.** TikTok reports `video_watched_2s` and `video_watched_6s`, never 3 s; `hook_hold_rate = video_watched_2s / video_play_actions` (`docs/analytics/metric-dictionary.md`). Landing actions stay null: no source observes them for a TRAFFIC campaign. The 30 % benchmark stands.
- **Accounts are Pulsar's Business Centers, assigned manually — a BC per vendor, not an ad account** (Ruobin, later the same day: "the way we have it in overlord and pulsar is the ability to connect multiple BCs … we can assign a BC, not an ad account, to a specific vendor"). The operator connection is Pulsar Grow's: many authorizations accumulate in `.tokens.json` on the server through the admin **Connect TikTok** flow (`/tiktok`, staff admin, the approved production developer app; each Business Center is its own authorization), sandbox tokens from `.env.local`. `/tiktok` lists the Business Centers every authorization reaches (one `/bc/get/` per token, cached) and loads one BC's accounts with their health on demand (`/bc/asset/get/` + `/advertiser/info/`, `lib/tiktok/business-centers.ts`, `lib/tiktok/account-health.ts` deny-by-default). Staff assign a **Business Center** to a producer company (`core.company_accounts` row of kind `business_center`, `assigned_by` set); at launch `pickLaunchAccount` walks that BC and takes the first account TikTok reports as READY that has a linked TikTok handle, and the data layer refuses any pick outside the vendor's assignment. Assigning one ad account (with its identity) remains as an explicit override. Only staff-assigned rows count — a producer-recorded "connected" row never routes Pulsar's token anywhere. Producers see the assignment on Company & accounts and can **request one from Pulsar** (`core.account_requests`) with a mock payment opt-in (brand, holder, last four; never a card number; Studio charges nothing). The exact Business Center process stays manual by decision. Not ported from Pulsar: warm-ups, the account fingerprint scan and the multi-account fan-out; a suspended account is handled by re-assigning.
- **Finished ads.** Generation now renders each concept to the file the producer approves (`lib/promote/render.ts`: ffmpeg cut, 9:16, hook burned in via libass; `render_sha256` frozen by the manifest and checked at upload). Without ffmpeg the concepts open with the source-footage preview and the live launch gate asks for renders; fixture mode's fake launch accepts the source file so the demo walks the pipeline.
- **Demo data stays demo.** Fixture mode always launches into a fake TikTok inside the process (`lib/tiktok/fake.ts`, deterministic 17-digit ids, review settles on the second poll, `TIKTOK_FAKE_REVIEW=reject` for the failure path); its read-back is labelled `demo`. Real objects require `DATA_SOURCE=supabase`, because an in-memory store that forgets a launch on restart is a duplicate launch waiting to happen (`TIKTOK_LIVE=1` reaches the sandbox from fixture mode for engineers; production is refused there).
- **Staff monitor and intervene, never approve.** The Promote desk lists launched campaigns with TikTok's note; a campaign's page shows the launch record and offers Sync now, Pause/Resume on TikTok (read back after the flip: a suspended account answers 0 and ignores the change) and Retry; the old mark-launching/live buttons survive only as an audited override behind a disclosure.
- **Not done, on purpose.** Automatic regeneration on a producer's change request (staff still revise); app-install objectives and native drama destinations; a production launch has not been exercised — Pulsar's briefing notes sandbox cannot prove `/ad/create/` end to end, so the first real proof needs a production token, an assigned account with a linked identity and a small budget.

Checks: `npm test` (182), `npm run typecheck`, `npx next lint`, `npm run build`, `npm run test:e2e` (the journey now presses Launch on TikTok and lands in TikTok's review on the fake).

## 2026-09-08 (night) · Native Chinese pass on the producer portal, written with DeepSeek

Decided by the founders (Ruobin): "it might be a good literal translation, but it likely doesn't look like a native Chinese app". DeepSeek (`deepseek-chat`) rewrote every Chinese string the producer portal can render, then a human review settled the result. Scope: the 1,508 keys referenced from `app/(producer)`, `components/producer`, the shared components and `lib/` (`scripts/zh-native/collect.ts`); staff chrome (285 admin-only keys) and 558 unreferenced keys were left alone. Register, chosen for this pass: neutral 你, lighter than a formal B2B tone, the voice of a domestic SaaS console.

- **How.** `scripts/zh-native/run.ts glossary` asked for one canonical term list plus a critique of the current wording (`docs/reviews/zh-native-2026-09-08-glossary.json`); `run.ts translate` then rewrote the keys in 63 batches of 30 with the product brief, the style rules, the terminology map and that glossary in the system prompt, returning per-key notes and a per-batch analysis. `apply.ts` rejects a rewrite that changes the `{placeholders}`, drops a brand or unit, loses a TikTok/广告/美国 qualifier, uses 您 or half-width punctuation next to CJK, or grows past 1.6×; `review.json` records the human decisions (21 rewrites kept as they were, 38 final wordings). Result: 353 strings rewritten, 1,134 kept. The full record, with DeepSeek's analysis of every batch and each accepted change, is `docs/reviews/zh-native-2026-09-08-report.md`.
- **What changed in the vocabulary.** 作品 → 剧集 for a title and 分集 for an episode (作品 no longer appears in producer copy or the metric registry); the evidence labels are 实测 / 推断 / 估算 / 合作方上报; 花费 always reads 广告花费 and 3 秒留存 reads 开场留存; 版权窗口 → 授权窗口; 映射 → 关联; "Explore listings" is 浏览上架剧集, "Story ideas to explore" is 选题参考; 打开 → 查看 on buttons; "第 {n}/{total} 步" reads 第 {n} 步，共 {total} 步. The terminology map (`docs/terminology.md`) carries the new rows and the register rules.
- **What was refused.** Rewrites that changed meaning (n/a → 暂无, 下载英文剧本 → 分集, 占展示 → 的展示, 英文为空 → 英文行为空, comparative rewrite tags losing 更), that blurred product distinctions (平台条目关联 → 平台链接, 采集日 → 昨日), that were inconsistent with each other (人群 / 入组 / 同期群, 审批角色 / 批准角色), and the four admin keys outside scope.
- **Invariants.** No English string changed; placeholders, brand names and the evidence-label rules were checked mechanically; `docs/demo` and the e2e (English) are unaffected. The DeepSeek calls were developer tooling against `DEEPSEEK_API_KEY` in `.env.local`, not app jobs.

Checks: `npm test` (173), `npm run typecheck`, `npx next lint`, `npm run build`, `npm run test:e2e`, and a walk through every producer page in Chinese at 1440.

## 2026-09-08 (night, later) · DeepSeek as a third LLM provider

Decided by the founders (Ruobin): "put a DeepSeek API key". `LLM_PROVIDER=deepseek` with `DEEPSEEK_API_KEY` selects it (`lib/llm.ts`); defaults are `deepseek-chat` for the fast tier and `deepseek-reasoner` for the strong tier, overridable with `LLM_MODEL_FAST` / `LLM_MODEL_STRONG`. DeepSeek is reached through the OpenAI SDK at `https://api.deepseek.com` (`DEEPSEEK_BASE_URL` to change) using chat completions in JSON mode: the caller's zod schema is stated in the system prompt as JSON Schema, the answer is validated by the same zod schema and semantic check on our side, and a failure gets the same single repair turn as the other providers. Every invariant holds: one `studio.jobs` row per call with integer `cost_cents` (DeepSeek's cache-hit tokens are counted as cache reads; list prices in `PRICES`, unknown models still charge at the top tier), `isLlmAvailable()` reads only the chosen provider's key, and fixture replay stays provider-free. The key goes in `.env.local`, never in the repo.

## 2026-09-08 (night) · Final UI/UX pass: nothing hangs, one shape per row, one range control

Decided by the founders (Ruobin) after the redesign: "small things have fallen through the cracks" — the Ad campaigns table and its buttons, the date-range chips, and words or arrows hanging alone on a new line. Presentation only; no number, rule or route changed.

- `app/polish.css` loads last. Producer-portal text uses `text-wrap-style: pretty` (paragraphs, cells, captions) and `balance` (headings) so a last line is never one word; the longhand is deliberate, the `text-wrap` shorthand would undo every intentional `white-space: nowrap`. Every "label →" link carries a non-breaking space before the arrow; the freshness lag "(1 d lag)" and the comparison note "(% change)" carry non-breaking spaces in the locale strings.
- Repeating rows share one shape: the action column is a fixed width in Ad campaigns (170px), TikTok performance (112px), My catalog and the title's campaigns table, and its button never wraps; the "Step n of 6" badge always sits above its step name; column names share the top line of the header with units and bases beneath; the Spend and Ad results sub-labels (`USD · this round to date`, `Hook hold ≥ 30% · CTR ≥ 1.2%`) break only at their separator. TikTok performance headers are single-line and the state chip stays on one line.
- The date range is one segmented control (`RangeControl`, `.seg.an-range`) everywhere, sitting at the right of the analytics view tabs under a shared hairline and beside the TikTok performance filters; the "Range" label is now the control's accessible name only.
- What to make next: the story-type board's lift and growth columns are wide enough for "vs all listings" and "median of {n} listings"; "See all →" is its own line under the platform split, which breaks only between platforms.
- Sidebar: the US market item reads **Data sources** (`ws.nav.sources`); the page and the What-to-make-next button keep "Data sources & definitions". The section tab rows (`.tw-nav`, `.pf-views`) no longer summon a vertical scrollbar from the active tab's 1px overhang.

Checks: `npm test` (173), `npm run typecheck`, `npx next lint`, `npm run build`, `npm run test:e2e` (both viewports), walked in both locales at 1440 and 1920.

## 2026-09-08 (evening) · Status-board catalog; TikTok performance is its own area; Overview retired

Decided by the founders (Ruobin) after walking the pulled build: the Overview was "kind of useless" (its task queue duplicated Ad campaigns and its market board duplicated What to make next) and the catalog was unintuitive — three views competing on one screen, buttons whose destination changed per row, and a "TikTok comparison" label that meant nothing on its own. The fix separates ad performance from TikTok performance completely and makes the catalog a plain status page.

- **My catalog is the landing page and a status board.** One row per title: title, TikTok status, ad status, US potential (score dial and band). Each cell links into the section that owns it — TikTok → the title's TikTok section (or the listing-link flow when not linked), Ads → the title's campaigns (or a new campaign when none), US potential → Preparation — plus Open. Search, sort (launch priority or name) and the recommendation-band chips are the only controls. No numbers on this page.
- **TikTok performance (`/producer/tiktok`)** is a sidebar area of its own: the former catalog "TikTok comparison" table unchanged (revenue, viewers, payer conversion, D30 cohort value, state), with range, search and sort. The per-title TikTok section breadcrumbs back here. `/producer/titles?view=performance|tiktok` redirects here with its query.
- **Ad campaigns** keeps every ad number: the task queue, all rounds, results and the next-round decision. The queue rows read "Step n of 6" and the budget stays visible at every width; the demo-handoff note appears only at the launch step.
- **Overview is retired.** `/producer` redirects to the catalog (`?view=opportunities` to What to make next). The company goal and monthly budget remain on Company & accounts.
- **Two sidebar groups** (later the same day): *My titles* — My catalog · Ad campaigns · TikTok performance; *US market* — US overview · What to make next · Explore listings · Data sources; then Company & accounts. The market pages drop their in-page area tabs (the sidebar is the area navigation); Explore keeps its own sub-tabs. Ad campaigns is a table in the TikTok performance framing (one row per round: step, budget, spend, results, action). What to make next is trimmed to read top-down: story types in five columns (pair and "of yours" fold into the story-type cell), three make-now briefs, a four-tile summary (new listings, leading story type, fastest riser, own exposure), six newest listings per platform beside each other with the five fastest movers folded into the same panel.
- Preparation is unchanged as a title section; the catalog's "preparation checklist" view folds into the band filter. `homeFor("producer")` is `/producer/titles`.

## 2026-09-09 (later) · One title workspace; the catalog is the portfolio home

Decided by the founders (Ruobin): "reframe the items; the information is good, it is missing presentation." A title had four unrelated homes (episode console, assessment, analytics, campaign) and the catalog mixed preparation with operating results. The reorganization moves presentation only; every calculation, permission and provenance rule stays where it was.

- **My catalog is the portfolio.** One row per title: TikTok status, ad status, TikTok earnings (publisher earnings, USD, one visible range; a gross-sales basis is tagged, never substituted), ad spend to date, ad CTR to date against the benchmark, open. Quick filters *All · On TikTok · Ads active · Preparing* are defined in the UI and may overlap. The US potential score is no longer a headline; the readiness comparison survives as the **Preparation checklist** view and the analytics comparison as the **TikTok comparison** view (old `?view=` values resolve).
- **Two statuses, two sources** (`lib/research/title-status.ts`). Platform status comes from the linked listing's analytics state: data delivered = on TikTok; a link alone = awaiting data; no link = unknown, never "unpublished". Ad status comes from the latest campaign record and its results: submitted is a demo handoff, only a `live` record is running. Neither proves the other.
- **One title workspace** (`components/producer/TitleShell.tsx`, `lib/research/title-workspace.ts`): Overview · TikTok revenue & audience · Ad campaigns · Preparation · Materials, with the shared identity, both statuses, section nav and the route back to the catalog. `/producer/titles/[id]` is the overview; the episode console moved to `/materials`; `/potential` redirects to `/preparation`; analytics routes are unchanged and framed by the shell; campaign detail stays at `/producer/promote/[id]` with a title breadcrumb and a return route.
- **Vocabulary** (`docs/terminology.md`, applied through `locales/_keys/zz-terminology.json`, which merges last): revenue and viewers always carry "TikTok", spend/CTR/results always carry "ad"; "Review ad results" outside the campaign strip; "View assessment" instead of "Score & story evidence"; "Data sources & definitions". The composite keeps its name, US potential assessment, inside Preparation.
- **Less text.** Results cells show the benchmark once in the header and ✓/✗ in the cell; the demo note appears once; findings are one line per ad; next-round options are one line each.

Checks: `npm test`, typecheck, lint, build, `npm run test:e2e` (updated for the workspace: catalog → overview → preparation → campaigns → campaign → back, quick filters, old deep links).

## 2026-09-09 · MVP pass: one demo journey, results that explain the next decision, what to make next as a decision table

Decided by the founders (Ruobin): "get this to an MVP state" overnight. Four things changed; none of them touches approvals, spend controls or the evidence rules.

- **One demo journey, reset on demand.** The fixture seed is one coherent path: the market board's launch signal (CEO / rebirth / revenge) → title 1, which carries it and scores highest → campaign 1 on title 1 with chosen ads, an immutable manifest, an approved budget, a demo handoff and two demo-labelled results → the next round. One campaign per title, distinct names, every video episode hard linked to `docs/demo/xiangyuan-ep1.mp4` under `.uploads/` by the fixture store so previews play. `POST /api/demo/reset` (fixture only; 404 in Supabase), the top-bar "Demo dataset · Reset demo" chip and `npm run demo:reset` rebuild the store. `docs/demo/DEMO.md` is the script.
- **An end-to-end smoke test.** Playwright (`npm run test:e2e`, `tests/e2e/demo-journey.spec.ts`) exercises the journey on 1440×900 and 1920×1080 against the running dev server: overview → what to make next → filtered Explore with reload persistence → catalog search/band/zero-result recovery → title potential → campaign 2 through choose, change request, approve, budget, launch, demo results, reload and the next round → API error feedback and form validation → a check that no request leaves localhost. Screenshots under `docs/demo/e2e/`. `npm test` stays the unit suite; the e2e is a separate command because it needs the server.
- **Results explain the next decision.** `lib/research/results.ts` (`readResults`) is the one benchmark reading: per ad, hook hold and CTR beside the benchmark they are judged against with a met/missed mark, CPM / CPC / cost per action under their counters, rates unknown (never 0 %) when the denominator is 0, and provenance (source, window, read time, demo note) ahead of the table. "What the results say" lists which benchmark each ad met or missed with its numbers, then offers the next round as three explained options; every option creates round N as a new campaign (`nextRoundName`, counted per title) that must be approved and submitted again. No demo action reaches a model or a provider (e2e asserts it; `lib/jobs.ts` still refuses in replay mode).
- **What to make next is a decision table.** The Overview's market view reads left to right: story type and its share of new listings → views added to that story type's listings since the last collection, per platform and never pooled (`RisingTrope.views_added`, registry metric `trope_views_added`, observed; listings without a comparable counter are a stated gap, not a zero) → the owned titles that carry it → "View listings", which opens Explore already filtered. Top new listings expand in place with their own counters and growth. Explore now sits under the US market insights area tabs so the flow never drops the producer into an unrelated page.
- **Title Analytics (demo provenance, typed contract).** One canonical destination per title, `/producer/titles/[id]/analytics` with four views (Overview, Revenue & LTV, Episodes, Acquisition) plus the fixture-only listing link, reachable from My catalog (`?view=performance`, one basis / one window / one currency per ranking column), the title page and campaign results. Values and provenance are separate fields (`lib/analytics/types.ts`): every metric carries availability, source, evidence and a definition key; unobserved values are unavailable, never zero; percentage change and percentage-point change are distinct types. Ten demo scenarios are keyed to the demo titles (`data/fixture/demo-analytics.ts`, deterministic, clock fixed at 2026-09-08). Distinctions kept on every page: gross → refunds → fees → publisher earnings → settled → paid out; recharge ≠ redemption; platform-reported LTV ≠ observed D7/D30 cohort revenue per user (explicit formula, entry window, elapsed days, immature cohorts null); the funnel is event counts unless a cohort is linked; attributed revenue is a subset of title revenue and unattributed traffic is never called organic; ROAS is not profit. Acquisition reuses `promote.results` and the same benchmarks as the campaign page. Supabase mode stores links (migration 0007) and returns `requires_connection` for every metric: production never falls back to demo numbers. TikTok's public documentation defines metrics at app level only; per-listing, per-episode, refund, fee, settlement and attribution granularity is **proposed and unverified** (`docs/analytics/tiktok-source-mapping.md`, `docs/analytics/metric-dictionary.md`).

Checks: `npm test` (168), `npm run typecheck`, `npx next lint`, `npm run build`, `npm run test:e2e` (both specs, both viewports) and axe-core on the redesigned and new pages (0 violations).

## 2026-09-08 (evening) · The market collection runs daily

Decided by the founders (Ruobin): "schedule a daily crawl". The
terms-of-service posture that was left open on 2026-09-06 is now settled
in favour of one collection a day of the same public catalog pages a
browser loads, at a fixed hour, from one runner.

- `.github/workflows/research-crawl.yml` runs `npm run research:crawl` at
  04:30 UTC daily (12:30 Beijing) and on manual dispatch, then commits
  `data/research/runs/<id>/`, the snapshot and `published.json` to `main`.
  Same command, same immutability and atomic-publication rules as a local
  run; a failed platform is carried forward as stale by the builder.
- The repo is the data store for now: each day adds roughly 0.5–1 MB of
  run artifacts plus a snapshot. Move the artifacts to object storage when
  that becomes a burden, keeping the snapshot and pointer in the repo.
- Watch the first runs: if the platforms refuse GitHub's datacenter
  addresses, the fallback is the same command on a Windows scheduled task
  on a founder's machine, committing the same paths.
- A local `npm run research:crawl` still works and publishes a second run
  for the day; the loader follows the newest validated run per day.

## 2026-09-08 (later) · What to make next: launches, not just prominence

Decided by the founders (Ruobin): the workspace judged the catalog a studio
already has, but did not say what to shoot next. Mini-drama studios clone a
premise within days of seeing it work, so US market insights now has two
views: **US overview** (what is prominent) and **What to make next** (what
the platforms are launching now). A small version sits on the Overview.

- **Fresh is observed, with every reason kept:** the platform's own new
  flag, its New/Newest list (with rank), a release date within 30 days
  (DramaBox exposes one; ReelShort does not), and first seen by Studio on
  the latest published day (needs history). `lib/research/next.ts`
  (`whatToMakeNext`, v1.0). Nothing is called new because we guessed.
- **Growth needs two published days** and stays within a platform: listings
  are grouped per platform and ranked by views added per day (same counter,
  actual elapsed days; a decrease is an anomaly and never a mover). A
  listing first seen today has no baseline and shows "no baseline", never 0.
  Until the second day the board says "collecting history".
- **Story types being launched now:** share of the fresh cohort carrying
  each trope (multi-label, denominator shown, split by platform), lift
  against the trope's share of every listing (≥ 10 fresh listings), median
  growth of the fresh listings carrying it, the trope most often launched
  with it, the producer's own titles with it, and two new examples.
  Registry metrics `fresh_share` (inferred) and `fresh_growth` (observed).
- **Make-now briefs** are templated from the top three story types: keep the
  structure (trope + partner), swap the setting, the platform's median
  episode count and paywall, one premise example (a synopsis opening, not a
  tested hook) and the count of the studio's own titles. Labelled inferred.
  They are a starting point for a clone brief, never a demand claim.
- Verified against two real collections (2026-09-07 and 2026-09-08). The
  ReelShort New shelf returned 27 rows on the second day where it had
  returned 200; the collector stops when a page adds nothing, so the
  snapshot carries what the platform served. Tests: `tests/research-next.test.ts`.

## 2026-09-08 · The US launch workspace: a number, a demo catalog, five areas

Decided by the founders (Ruobin): "show a number", "generate a test / demo
for everything so we can stress-test it", "make everything usable". The
product is a US launch workspace for Chinese mini-drama catalogs, with the
market desk as supporting evidence. Central journey: choose a title →
understand its US potential → generate campaign concepts → approve
variations and budget → launch (mock until a provider is connected) → learn
what deserves more investment.

- **Navigation is five areas** plus "Add title" as an action: 总览 Overview
  (recommended titles, decisions waiting, results, setup gaps), 我的剧库 My
  catalog (every title scored, readiness, tests, next action), 美国市场洞察
  US market insights (the market brief, explorer, title detail, sources),
  发行与实验 Launch & experiments, 公司与账户 Company & accounts (goals &
  profile, owned accounts, permissions & billing, reports).
- **US potential is a number** (`lib/research/assessment.ts`, v1.0): 0–100,
  a composite of what Studio actually holds — story match 0–35, market
  signal 0–10 (needs history; 0 and says so until then), readiness 0–25,
  own evidence 0–25 (demo results count at half), fit 0–5 — with every
  fact, its evidence label, its points and "what would raise it" shown next
  to the number, plus a band (test first / prepare / not now / not enough).
  It is our evidence summarized, never a probability of success or an
  audience measurement, and the page says so.
- **Experiments are structured records.** `promote.campaigns.experiment`
  holds budget, hypothesis, audience, first batch, signal, and the
  approver's budget sign-off, versioned; a save clears approval. Results
  (`promote.results`) are per creative and window with an explicit source;
  in fixture mode "simulate demo results" produces demo-labelled rows so
  the results → next-spend loop can be exercised. The next-spend decision
  creates a new round. Submission stays a mock handoff.
- **Customer ownership is recorded, not fabricated.**
  `core.company_accounts` holds the accounts the customer owns and the
  state they reported (unconnected / invited / connected / revoked) and
  what access Studio has. No account creation, no credentials. Billing is
  "not configured" until a provider is connected.
- **The demo catalog** (`data/fixture/demo-catalog.ts`) seeds fixture mode
  by default: 14 titles in different states of readiness, profile,
  watchlist, imported reports, four experiments at different stages (one
  with demo results), and the account inventory. `FIXTURE_SEED=empty`
  restores the bare seed; the test runner uses it.
- Migration 0006 carries the Supabase side; no project is provisioned.
  Tests: `tests/workspace.test.ts`.

## 2026-09-08 · A focused producer market brief

This supersedes the four-summary-card homepage and the expanded dashboard layout. The existing research collection, evidence rules, and tenant boundaries stay in place.

- Overview has three sections: up to six concrete drama examples; six story-share bars; and up to three owned titles with a comparable, recorded materials and an action. Company relevance is visible and optional. The story bars describe the selected market, with company interests highlighted, rather than measuring only the company's preferred tropes.
- My titles has one catalog, with Company profile and Reports as permanent sibling tabs. Company identity is loaded through a minimal tenant-scoped data method. Profiles reuse the existing research record; saving returns to Overview with refreshed recommendations and confirmation. Distribution informs next actions; annual volume remains descriptive. Target markets express intent, not viewer geography.
- Filters apply immediately, search covers existing Chinese/English taxonomy and publisher names, and scope travels into detail return links. Raw views/saves sorts require a single platform. Mobile navigation uses a modal menu with focus containment and Escape support.
- Ordinary views prioritize readable titles, named charts and platform-specific counters. An information dialog gives exact values and read dates without leaving the results; full methodology remains in Sources. Available data and planned connections are separated. Missing covers have a local visual fallback.
- Market detail uses Summary, Trends and Sources; legacy Story/Creative/Comparables tab URLs resolve to the summary. Saved titles have a dedicated navigation link.
- No US rights or whole-title readiness is inferred from generic dates or partial approvals. Existing company reports and recorded license/episode facts remain in catalog disclosures. Promote remains review/approval; Grow owns execution.

## 2026-09-07 · Trust in the numbers: run artifacts, provenance, registry, Data & Sources

Decided by the founders (Ruobin) via the market-intelligence review
(`docs/market-intelligence-review.md`) and its prompt. The desk is rebuilt
as a market-intelligence and launch-decision tool; the ledger is
`docs/market-desk-plan.md`. What changed in the contracts:

- **Snapshot schema v2.** Every counter is an `Observation` with the
  platform's field name, unit (views / collects / follows / rating), read
  time and evidence. Collection context (English public web, locale en) is
  recorded separately from audience geography, which is `unknown` for these
  sources: an English page does not establish a US audience. Runtime basis
  (`episode_1` vs `listed_average`) travels with the value.
- **Immutable runs, atomic publication.** Collectors write
  `data/research/runs/<run_id>/` and refuse to overwrite; the builder
  validates with zod and only then moves `data/research/published.json`.
  The latest validated run of a day represents that day; earlier same-day
  runs stay on disk. A failed platform is carried forward as `stale` from
  the last published run, never dropped; a run with no fresh platform
  publishes nothing and is recorded as `last_failure`.
- **Scores are within-platform and null when unobserved.** `view_percentile`
  and `chart_visibility` stay separate; their max is called *prominence*
  and is documented as not momentum. Ties go to the charted listing. Whole
  snapshots are scored before filtering, current and previous alike, so an
  unchanged snapshot shows zero movement under every filter.
- **Movement only with comparable history** (`lib/research/history.ts`):
  counter velocity over the actual interval, growth % only on a positive
  baseline, decreases as anomalies, rank movement within the same named
  list, entry/exit categorical. First-seen dates come from history.
- **Words.** Publisher ≠ studio (`companies[].role`); 女频/男频 is audience
  positioning, not protagonist gender or demographics; synopsis openings
  are *premise examples*, not hooks.
- **Registry.** `lib/research/registry.ts` lists every source and metric
  with grain, source field, unit, denominator, window, evidence, formula,
  version, limitations and a status computed from the published data
  (`available | collecting_history | requires_connection | manual |
  unavailable | stale | failed`). Rendered at `/producer/sources`; every
  metric label links to its entry. The review's source corrections (Meta
  Ad Library scope, YouTube public vs owned, Trends normalization, TikTok
  Top Ads sample, no assumed app-store RSS) are recorded there.
- **Navigation.** 市场概览 / 市场探索 (作品 · 题材 · 平台 · 公司) / 我的剧库 /
  素材与测试 / 数据与来源, with 新增作品 as an action. Title detail has
  Overview · Trends · Story & format · Creative examples · Comparables ·
  Sources.
- **Company-scoped records (migration 0005).** Watchlists; report imports
  with preview, validation, duplicate detection and reversible batches;
  an explained launch-test shortlist (`lib/research/shortlist.ts`, v1.0)
  whose reasons and missing inputs are visible. Nothing here is a
  probability of success.
- **Not enabled:** scheduled collection (terms-of-service posture is the
  founders' call), every external connector (listed with real states).

Current coverage at this decision (recounted from the published run
`2026-09-07T04-38-53Z`, 507 listings, 506 tagged):

| platform | status | listings | with views | fetched |
|---|---|---|---|---|
| reelshort | ok | 442 | 442 | 2026-09-07T04:39:46.308Z |
| dramabox | ok | 65 | 53 | 2026-09-07T04:38:53.436Z |

## 2026-09-06 · Studio becomes the market desk

Decided by the founders (Ruobin) after the first conversation with a Chinese
mini-drama studio: Studio angles away from being a creation/production space
and toward helping studios decide **what to produce, where to release, and
how they are doing.** Two products under one roof, in this order of
importance, and the platform (the money pit) feeds the second one later.

- **Market research is the front door.** `/producer` is now the market
  overview: public charts from ReelShort and DramaBox (first two platforms;
  Meta Ad Library, TikTok Creative Center and YouTube are next), run through
  one **trope taxonomy** (`lib/research/taxonomy.ts`, ~28 premise mechanics
  such as 霸总, 复仇, 隐藏身份, 契约婚姻, 战神, 狼人) so titles, tropes,
  studios and the producer's own catalog are comparable. Filters by
  platform, audience (女频/男频) and trope. Nothing raw is shown: a crawl is
  normalized into a dated snapshot (`data/research/snapshots/YYYY-MM-DD.json`,
  `npm run research:crawl`) and the engine (`lib/research/engine.ts`) computes
  what the page shows. Snapshots append; a second crawl turns on change
  columns.
- **Every number carries an evidence label**: `observed` (read from the
  platform's page), `inferred` (our rules, e.g. a keyword trope or a studio
  guessed from a shelf), `estimated` (a model or third-party estimate),
  `partner_reported` (the producer told us). The UI shows the label beside
  the number. Competitor CTR, payer conversion and spend are NOT shown
  because no public source exposes them; rank, chart share, saves and view
  velocity are what is observable. Raw views are never compared across
  platforms (ReelShort read_count and DramaBox viewCount count different
  things); titles get a within-platform heat score (0-100).
- **Personalization comes from a short onboarding**, not from Adapt: a
  producer editor answers which tropes they produce, their audience, volume,
  distribution mode and markets (`core.producers.research_profile`,
  migration 0004). The market page then shows "you produce it and the charts
  want it / the charts want it and you do not list it / you produce it and it
  is thin on the charts". Viewer-role producers read the desk but cannot
  describe the company; staff previewing cannot act, as everywhere.
- **My titles is the second tab**: the catalog, each title tagged with the
  same taxonomy from its synopsis, scored against chart share, with
  comparable market titles. Performance-vs-market is an honest empty state
  until a platform report is connected or a CSV imported; the founder's
  China numbers on a title (`china_metrics`) show as partner-reported.
- **Hooks and promotion are the third**: Promote's home now opens with the
  opening sentence of the hottest blurbs for the producer's tropes ("hooks
  that are working"), then the existing campaign flow. Promote proposes the
  test; Grow runs it and reports back. No measurement is rebuilt in Studio.
- **Adapt is frozen, not retired.** It is the fulfillment step once a title
  is chosen ("you already have an English-ready version") and the catalog
  intake for producers who upload scripts. It moves off the home page under
  My titles; no new pipeline work.
- Feasibility of the first two crawls, the fields each platform exposes,
  and the caveats (client-side pagination, DramaBox's two view counts,
  terms-of-service posture) are in `docs/research-feasibility.md`.
- Data-layer contract: `getMarket` (any member; Studio-wide, no per-producer
  rows), `getResearchProfile` / `saveResearchProfile` (own company only).
  Both modes read the same committed snapshot; `research.title_observations`
  is the crawl's landing table for history and is not read yet.
## 2026-09-04 · Finalize readiness: an editor-authored line is its own explanation

Found testing the manual-draft path: the finalize gate required `rationale_zh`
and `back_translation_zh` on every non-keep line, but the producer editor
sends text only — an episode whose lines were hand-written could show a green
“可以定稿了” banner while `finalize_version` refused, in English. Decided:

- **The finalize rule** (`lib/data/views.ts` `adaptedLineIssue`; fixture
  `finalizeVersion`; SQL `studio.finalize_version`): every source line
  adapted, non-cut lines non-empty, and AI-authored changes carry
  `rationale_zh` (plus `back_translation_zh` unless cut). Rows with
  `authored_by = 'editor'` are exempt — finalize is the producer approving
  words a person wrote; nobody owes an explanation to themselves.
- **The staff path stays strict.** `submit_version` and `set_scene_status`
  still require the rationale on every changed line regardless of author:
  staff changes are explained TO the producer.
- **One rule, three readers.** The same predicate feeds the episode
  summaries and the studio's banner/finalize button, so the UI can never say
  ready while the server would refuse; when AI takes are missing their notes
  the banner counts them in portal words.
- **Portal words for unavailable states.** Producer-facing refusals map by
  error code (`llm_unavailable`) instead of printing server English; the
  burn failure and the auto-sync unavailable state are localized (the
  technical reason stays on hover); a blank manual-draft row reads
  “（英文待填写）”, no longer “（该句已删去）”.

## 2026-09-04 · Pulsar's Promote desk: the staff side of every producer action

Decided by the founders (Ruobin): "after a producer does anything — request
change, send for approval — the admin portal doesn't do anything, and that is
the important part we want from Grow." Also: five concepts per round, an
approve-all, and the producer information architecture.

- **Every producer action has a staff next step.** The admin portal gains a
  Promote desk (`/promote`): campaigns queued as *Needs Pulsar* (change
  requests to answer, launches to run), *Waiting on producer*, *Launched*.
- **A change request is answered with a revision, never an edit.** Staff
  `revisePromoCreative` writes a new `pc_` row (`parent_creative_id`,
  `version + 1`, status `ready`, a `revision_note` the producer sees) and marks
  the parent `superseded`. Only while the campaign is in `review`; approved
  rounds stay frozen (0003's guard). Producers cannot call it.
- **Launch is recorded by staff on the desk.** `advancePromoCampaign` moves
  `submitted → launching → live`, `submitted|launching → failed`,
  `failed → launching`, with the Grow campaign id and an audit note. Until
  Grow's read-back lands, this is the source of launch status inside Studio.
- **Five concepts per round, not six.** Copy says so explicitly: Pulsar keeps
  launching new rounds; it tests five concepts at a time.
- **Keep all.** Producers can approve every still-pending creative in one
  click; existing change requests are never swept up by it.
- **Producer IA.** Sidebar: a primary *New drama* action; *Studio* (Adapt, where
  localization happens); *Promote*; *Drama library* (placeholder for the title
  list that will connect to Stage — wording only, no Stage integration). The
  site title is *Pulsar Mini Dramas*. Promote's brief starts by picking a drama
  from cards; the chosen drama is locked into the brief.
- **Admin localization is oversight only.** Staff watch where a producer is;
  they do not upload scripts or adapt from the admin side. Removing the admin
  upload/adapt affordances is pending, not done.

## 2026-09-04 · Promote is a sibling product; Grow owns launch

Decided by the founders (Ruobin): Pulsar Studio now has two producer-facing
products over one drama library. **Adapt** localizes a title. **Promote** turns
the uploaded episode masters into paid-social creatives, asks the producer to
approve the exact outputs, and hands those outputs to Pulsar Grow. Grow remains
the system of record from launch onward, including TikTok review and metrics.

- `core.titles`, `core.episodes`, and their private source media are shared.
  Promote never requires an adaptation, approved subtitle version, or creative
  pack. A better script may improve future selection, but cannot be a gate.
- Promote owns campaign intent, concepts, immutable creative revisions,
  producer approval manifests, and append-only handoff attempts in a separate
  `promote` schema. It uses external `pb_` and `pc_` ids across the boundary.
- Only approved, rendered outputs cross to Grow. A producer-facing button says
  “Submit to Pulsar for launch”; “handoff to Grow” stays implementation detail.
- A producer approves exact versions. Approval hashes a frozen manifest. Any
  later media or copy change creates a new creative version and new approval;
  it never mutates the approved row.
- The producer navigation exposes Promote as a first-class product and keeps
  the title page as a shortcut, not another adaptation pipeline step.
- The initial vertical slice includes the campaign brief, six hypothesis-led
  direct/creator-style concepts, review, frozen approval, and an idempotent mock
  submission. Actual MP4 rendering, production UGC composition, Grow service
  authentication, launch status, and metrics readback replace the seams next.

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
