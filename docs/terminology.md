# Terminology and destination map (2026-09-09)

Three domains, kept apart in every label: **preparation** (is the title ready and worth a US test), **TikTok monetization** (what the published title earns and who watches it), **advertising** (what Pulsar campaigns spend and return). Bare words that blur them ("Performance", "Results", "Launch", "Evidence", "Analytics") are qualified wherever the control's meaning is not fixed by its context.

## Terminology map

| Use | 中文 | Do not use | Meaning / source |
| --- | --- | --- | --- |
| TikTok status | TikTok 状态 | Launched, Live, Published | From the linked listing's analytics state. *On TikTok · reporting / data stale / sync failed* = data has been delivered (the title is live on the platform). *Linked · awaiting data* = mapped, first report pending. *Not linked to TikTok* = publication unknown, never "unpublished". |
| Ad status | 广告状态 | Status, Launched | From the latest campaign record and its results: *No ad campaign · preparing · awaiting approval · ready to launch · submitted · running · results in · launch failed*. Submitted is a demo handoff until a provider exists; only a `live` record is running. |
| TikTok earnings | TikTok 收入 | Revenue, Performance | Publisher earnings in USD over the visible range; a row whose source reports only gross purchase sales is tagged **gross sales** and is not comparable. |
| TikTok viewers | TikTok 观众 | Viewers, Users | Period-unique viewers of the listing. |
| Revenue & LTV | 收入与 LTV | Monetization | The TikTok section's revenue mix, payers, recharge vs redemption, waterfall, platform LTV and observed cohort value. |
| Episode retention | 分集留存 | Episodes, Performance | Continuation, completion, paywall and unlock per episode. |
| Ad attribution | 广告归因 | Acquisition, Analytics | Attributed users, payers, revenue, CPA and cohort ROAS per campaign, inside the TikTok section. |
| Ad spend | 广告花费 | Spend, Budget | Reported spend across every round; a budget is shown as "budget" until spend is reported. |
| Ad CTR | 广告点击率 | Performance | Clicks ÷ impressions across every reported row, beside the Studio-wide benchmark (≥ 1.2 %). |
| Ad results | 广告结果 | Results | Per-ad hook hold, CTR, spend, landing actions read against the benchmarks. |
| Review ad results | 查看广告结果 | Review results | The sixth campaign step, outside a campaign page. Inside the campaign strip the six steps keep their short names. |
| Campaign status / step | 广告活动阶段 | Stage | Prepare → Choose ads → Approve ads → Approve budget → Launch → Review ad results. |
| US potential assessment | 美国潜力评估 | Readiness score, Score & story evidence | The explained composite (story match, market signal, launch readiness, own evidence, company fit). Lives in Preparation; not a portfolio headline. |
| Assessment breakdown | 评估构成 | Evidence | The five components with facts, evidence labels and points. |
| Preparation checklist | 准备清单 | Next steps | The ordered actions that would raise the assessment or unblock a campaign. |
| View assessment | 查看评估 | Score & story evidence | The link from the preparation checklist view into a title's Preparation. |
| Market comparisons | 市场对比 | Evidence | Comparable US listings sharing story types. |
| Materials | 素材 | Localize, Adapt | Episodes, video, scripts, subtitles, exports (the frozen Adapt pipeline). |
| Data sources & definitions | 数据来源与定义 | Data & Sources | The registry page and the metric dictionary. |
| Demo dataset / Demo results (simulated) / Demo analytics | 演示数据集 / 演示结果（模拟）/ 演示数据 | Mock, Test data | Fixture-mode provenance labels; shown wherever a simulated number informs a decision. |

Chinese follows the same rule: 收入/观众 always carry TikTok, 花费/点击率/结果 always carry 广告.

## Where things live now (old → new)

| Was | Now |
| --- | --- |
| My catalog › Launch readiness (default) with score dial, bands, rights/subs/video, campaign step | My catalog › **Portfolio** (default): TikTok status, ad status, TikTok earnings, ad spend, ad CTR, open. The readiness table is **Preparation checklist** (`?view=preparation`, old `?view=launch` still resolves). |
| My catalog › Performance | My catalog › **TikTok comparison** (`?view=tiktok`, old `?view=performance` still resolves). |
| "Score & story evidence" link | "View assessment" → the title's Preparation section. |
| `/producer/titles/[id]` (episode console) | `/producer/titles/[id]` is the **title overview**; the episode console is `/producer/titles/[id]/materials`. Episode routes are unchanged. |
| `/producer/titles/[id]/potential` | `/producer/titles/[id]/preparation` (the old URL redirects). |
| `/producer/titles/[id]/analytics/*` | Unchanged routes, now framed as the **TikTok revenue & audience** section (Summary · Revenue & LTV · Episode retention · Ad attribution · Listing link). |
| Campaign detail `/producer/promote/[id]` | Unchanged; breadcrumb is My catalog › title › Ad campaigns › campaign, "Back to …" returns where you came from. The title's rounds are listed at `/producer/titles/[id]/campaigns`. |
| Ad campaigns (global list) | Unchanged at `/producer/promote`. |
| Overview › "View title evidence" | "Open" → the title overview. |
| Score components, comparables, reports, checklist | Preparation section, in full. |
| Rights, subtitles, video facts | Overview cards (summary), Materials (episodes), Preparation checklist view (comparison). |
| TikTok metrics, revenue, LTV, cohorts, episodes, funnel | TikTok revenue & audience, unchanged content. |
| Campaign spend, results, approvals, next rounds | Campaign detail (unchanged) and the title's Ad campaigns section (summary per round). |
| Source definitions, freshness, demo provenance | Data sources & definitions; freshness line and demo chips stay on every analytics view; demo notes on results. |
