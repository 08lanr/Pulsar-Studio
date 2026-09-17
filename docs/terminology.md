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
| Demo dataset / Demo results (simulated) / Demo analytics | 演示数据 / 演示结果（模拟）/ 演示数据 | Mock, Test data | Fixture-mode provenance labels; shown wherever a simulated number informs a decision. |
| Title (a series) / Episode | 剧集 / 分集 | 作品, 项目, 单集, 集 (alone) | A title is one drama series; an episode is one of its parts. 剧库 is the catalog. |
| Listing | 上架条目 / 条目 | 作品 | One platform's public page for a title (ReelShort, DramaBox, a TikTok listing). Explore listings = 浏览上架剧集. |
| Evidence labels: observed / inferred / estimated / partner_reported | 实测 / 推断 / 估算 / 合作方上报 | 观测, 推测, 估计, 合作方提供 | Four fixed, distinguishable translations; never blended. |
| Data state: available / collecting history / requires connection / manual / unavailable / stale / failed | 可用 / 积累历史中 / 需要接入 / 人工导入 / 不可用 / 过期 / 失败 | 有效, 需要连接, 手动 | Registry status chips. |
| Reviewer / approver roles | 审阅角色 / 审批角色 | 批准角色 | The role names; the action itself is 批准 (approve), never 审核通过. |
| Hook hold / benchmark met | 开场留存 / 达标 | 3 秒留存, 钩子留存, 达到 | The first benchmark of every ad result. |
| Clip posting state: not posted / publishing / posted / failed | 未发布 / 发布中 / 已发布 / 发布失败 | 未推送, 上传中, 已上传, 出错 | One clip on one platform, read from its `promote.clip_posts` row only — never inferred from Meta on the fly (2026-09-16, `docs/meta-organic-plan.md`). The cell is these words alone, never an id: *posted* carries the date and links to the permalink, *failed* carries the reason and a retry, *publishing* carries the step in small text. |
| Posting step: sending the file / waiting for the post / preparing the Reel / Instagram is processing the video / publishing / finished | 正在上传文件 / 等待帖子生成 / 正在准备 Reels / Instagram 正在处理视频 / 正在发布 / 已完成 | 处理中, 队列中 | The small line under *publishing*: the engine's persisted step, said in the words of the person watching rather than the API's. |
| Post to Facebook / Post to Instagram / Post again | 发布到 Facebook / 发布到 Instagram / 再发一条 | 推送, 上传, 重新发布 | Publishing a clip as a public organic post. *Post again* is the deliberate second post on a clip that already has one, never a side effect. |
| Choose content | 选择素材 | 选择内容, 添加素材 | The Meta launch's content step and its three tabs: Studio clips (Studio 切片) · From the Page (主页现有帖子) · Paste an id (粘贴帖子 ID). |
| Connections | 账户连接 | TikTok 设置, 账号设置 | The one staff entry that holds both providers' account connections — TikTok Business Centers and Meta accounts. |
| Launch state on the monitor: Not checked yet / Created paused on Meta · on TikTok / In review / Delivering / Paused / Ended / Rejected / Failed to launch / Account suspended | 尚未检查 / 已在 Meta（TikTok）创建，处于暂停状态 / 审核中 / 投放中 / 已暂停 / 已结束 / 已拒绝 / 投放失败 / 账户已停用 | Checking, Switch unknown, 检查中, 开关状态未知, Unknown | One campaign's state, from the sweep alone (2026-09-17, `docs/launch-ux-round-2.md` §1.7). *Not checked yet* means no sweep has read this campaign — the monitor starts one within ten seconds of the page opening and shows a spinner in the Last checked line, never a word that sounds like a verdict. *Created paused* means the objects exist but the campaign's own switch has not been read yet; the On/Off pill stays disabled until it is. The two placeholders that used to print here are deleted from the locale files. |
| Launch name | 投放名称 | Job, Run, 任务, 批次 | The name a person gives a launch, defaulting to "<company> · <date>". It is what the monitor, the card header and every campaign row lead with ("<launch name> · 1"); renaming it from the pencil never renames anything on Meta or TikTok. |
| Campid | Campid（投放编号） | Campaign ID, 活动 ID | The per-campaign attribution code stamped from the first campid (`rlapple01, rlapple02, …`), the Meta campaign's own name, and the `?campid=` on the tracking link. It lives in small text on an expanded row — never at the head of a cell or a card, and never confused with a provider's `act_…` / `lr_…` id. |
| What to do next (the hint above a provider refusal) | 下一步该做什么 | Error, Code, 错误码 | A failed launch reads as a next step: one plain-language sentence from `lib/launch/provider-errors.ts` above the provider's own words, then Retry. An unrecognised code shows the provider's sentence alone — a guessed next step is worse than no hint. |

Chinese follows the same rule: 收入/观众 always carry TikTok, 花费/点击率/结果 always carry 广告. Register (decision 2026-09-08, "native Chinese pass"): 简体, 你 not 您, the voice of a domestic SaaS console; buttons are verb–object phrases (新建广告活动, 查看结果), headers and labels are noun phrases without a full stop, hints are short full sentences; a half-width space separates CJK from Latin and digits (TikTok 收入, 近 30 天); full-width punctuation inside Chinese. The canonical term list DeepSeek produced is `docs/reviews/zh-native-2026-09-08-glossary.json`; the scripts under `scripts/zh-native/` regenerate the pass and `scripts/zh-native/review.json` records the human decisions.

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
