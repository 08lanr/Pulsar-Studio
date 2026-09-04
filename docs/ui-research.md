# UI research — what a mini-drama producer already knows

2026-09-03. Commissioned for the producer-first pivot (docs/decisions.md):
the partner portal must feel familiar to a Chinese mini-drama producer and
be smooth enough to demo. Sources at the bottom; where a console is behind a
login, the description comes from its public pages, onboarding guides and
help docs.

## The consoles producers actually live in

**短剧创作者中心 (shortdramas.com)** — the industry's home base since April
2026, the merger of 抖音集团短剧版权中心 and 红果短剧创作服务平台. One-stop:
IP 选取, 剧本投稿, 制作承接, 项目撮合, 签约结算, 成品经营, 数据复盘. Four
self-serve identities (编剧 / 导演 / 演员 / 版权方) plus 投资出品方; a 版权方
can upload finished works, manage distribution, and see per-work revenue and
viewing data. After login: a personal 创作后台 with the submission entry,
requirements, official notices, and submission-status tracking; identity
switching top-right; 账户信息 top-left. Workflow vocabulary: 提交审核 → 审核中
(1–3 工作日) → 审核通过 → 定时发布 → 已发布.

**爱奇艺号 / 抖音创作服务平台 / 快手创作者平台 / B站创作中心** — the general
creator consoles. Convergent anatomy: left rail (首页 · 内容管理/作品管理 ·
数据 · 收益 · 设置); the work list as poster-cover cards or a dense table with
状态 tags; upload as a stepper (上传 → 填写信息 → 提交审核 → 发布) with a big
blue primary button and a progress bar while the platform processes (转码中);
one action per row in an 操作 column.

**ReelShort / DramaBox partner intake** — pitch-based, not self-serve
(synopsis + episode outline + sample episodes; 1–4 week review). Nothing to
copy for UI except vocabulary; confirms that a real self-serve workspace is
a differentiator, not table stakes.

## What this dictates for the partner portal

1. **作品管理 is a poster grid.** Everything in this industry is a 2:3
   vertical cover. A table of external_ids reads as an engineering tool; a
   poster wall reads as "my works". → `.poster-grid`, cover placeholder from
   brand-tint gradients, one status tag, one progress line.
2. **The pipeline is a step strip.** Producers parse 步骤条 instantly:
   上传剧本 → AI 改编 → 逐场确认 → 定稿 mirrors 上传 → 审核 → 发布 they already
   know. → `.flowsteps` on the title console.
3. **One big primary action per screen.** The consoles never offer two
   competing CTAs. → 「一键生成美式改编」 alone on an untouched episode; the
   gold 「确认定稿」 alone at the end.
4. **Processing must be visible.** 转码中 taught producers that platforms
   show progress. An instant reveal reads as fake; a spinner with named
   stages reads as work. → the staged `.genprog` readout.
5. **Status vocabulary, not workflow jargon.** 待改编 / 改编中 / 待审核 /
   已定稿 — pill-tag words in the platforms' register. Never "version",
   "snapshot" or "RLS" in the producer's chrome; the frozen hash appears
   once, quietly, on the finalized banner (存档 + hash = 平台已留底).
6. **Phone-tolerant, desktop-first.** These consoles are desktop web with a
   phone companion app; the demo is desktop. Cards stack on narrow widths.
7. **Patterns, not paint.** The familiarity comes from the layout grammar
   above; colors, type and components stay on Pulsar's own design system
   (blue accent, borders not shadows, nothing above weight 600) so Studio
   still looks like Pulsar, not an Ant Design clone.

## What we deliberately did not copy

Revenue/data dashboards (nothing to show yet — the no-unbacked-numbers
rule), 项目撮合-style marketplace surfaces, identity switching, coin
balances and premium upsells (template noise the deck's own mockup carried),
and the platforms' review-queue framing (in Studio the producer IS the
approver; the platform-review mental model would put them on the wrong side
of the table).

Sources:
[红果短剧创作平台个人入驻全指南](https://www.sohu.com/a/967165483_121060424) ·
[“短剧创作者中心”平台上线](https://www.sohu.com/a/1016227650_120952561) ·
[带你了解「短剧创作者中心」](https://view.inews.qq.com/a/20260415A03IA600) ·
[短剧创作者中心（官网）](https://www.shortdramas.com/) ·
[红果短剧创作服务平台 · 百度百科](https://baike.baidu.com/item/%E7%BA%A2%E6%9E%9C%E7%9F%AD%E5%89%A7%E5%88%9B%E4%BD%9C%E6%9C%8D%E5%8A%A1%E5%B9%B3%E5%8F%B0/66913700) ·
[爱奇艺号创作者平台](https://creator.iqiyi.com/) ·
[爱奇艺帮助中心 · 如何发布视频](https://help.iqiyi.com/questionInfo/5113.html) ·
[Get accepted on ReelShort / DramaBox (Reelytics)](https://www.reelytics.io/blog/get-series-accepted-reelshort-dramabox-shorttv) ·
[Where to publish a vertical drama (Character App)](https://www.character.app/blog/where-to-publish-vertical-drama)
