# Investor deck — English notes (Pulsar_Investor_Send.pdf, 19 slides, Chinese)

Transcribed 2026-09-03 from the Chinese deck so engineering docs can cite slide
numbers. Numbers are the deck's; "illustrative" means the deck itself labels the
visual 设计示意 / 示意 (design illustration, not real data).

## 1 · Cover

**Pulsar: the go-abroad platform focused on the U.S. short-drama track.** From
content adaptation and paid acquisition to a monetization closed loop — the full
chain. Three products:

- **Pulsar Studio** — 剧集本土化改编与广告素材生产: title localization/adaptation
  and ad-creative production.
- **Pulsar Reach** — TikTok / Meta 投流获客: paid acquisition.
- **Pulsar Stage** — 自有美国短剧平台: Pulsar's own U.S. short-drama platform,
  receiving viewing and payment.

Visual (illustrative): three mockups side by side in a cream / navy / gold
palette. Reach dashboard ("Love on the Line — Hook Test #3", hook performance
cards, performance over time, channel mix TikTok / Meta / YouTube Shorts). Stage
on a phone ("Love on the Line", S1 E6 "The Truth Between Us", episode list,
"Unlock Episode 7" for 120 coins, balance 2,840). Studio desktop — **this is the
second Studio mockup and the closer one to the product principles**:

- Header: Pulsar Studio · Product Three · search · coin balance · avatar.
- Tabs: **Dialogue · Dubbing · Subtitles · On-screen Text · Title & Thumbnail**.
- Title row: "Love on the Line" · S1 · Ep 6 picker · "All changes saved".
- Two columns: **Source — Chinese (Scene 12)** and **Adapted — U.S. English
  (Scene 12)**. Each column opens with a *Context* block (the scene in one or
  two sentences, "Show more"). Then timecoded lines: `00:12:04 · 李薇 · 你从来只在乎并购，从来不在乎我。 · pinyin` beside `00:12:04 · LI · "You only care about
  the merger. You've never cared about me." · chip "AI first pass" ▾ · comment
  icon`. Three lines shown (Li, Yiran, Li).
- Line toolbar: Add line · Split · Merge · Shorten · AI rewrite · "35 / 1,200
  lines".
- Status legend: **AI first pass · U.S. editorial review · Studio approval**.
- Right rail: video player with timeline (00:12:04 / 00:45:12); **Workflow
  Status — Scene 12 of 42**: AI first pass (completed 2m ago) → U.S. editorial
  review (in progress · assigned to Alex M.) → Studio approval (pending);
  **Notes & Comments (3)** with a comment "Adjusted for a more conversational
  tone and shorter line."; buttons **Approve Scene 12** (gold) and **Request
  Changes** (outline).

## 2 · U.S. market

U.S. short-drama platform revenue: **$0.8B (2024) → ~$1.5B (2026) → ~$3.7B
(2031)**, ~20% CAGR 2026–31. SAM $3.5–4B annual revenue in 2031 ≈ 6–7M monthly
paying users at FlexTV's disclosed U.S.+Canada monthly ARPPU ≈ $46. Near-term
reachable scale $25–50M ≈ 45–90K monthly paying users. Callout: the track is
highly dependent on paid acquisition — ReelShort's 2025 sales expense ≈ 55% of
revenue. Sources: Media Partners Asia; FlexTV SEC filing (nine months to
2025-09-30).

## 3 · Why now

Already a $1.5B market, penetration still early. (01) Demand validated: U.S.
users of top short-drama apps average 35.7 min/day on mobile, above Netflix,
Prime Video and Disney+ mobile; 65% of current viewers started in the last
year. (02) Supply ready: Chinese producers hold thousands of finished titles
U.S. audiences have never seen; a title shoots in two weeks at far below U.S.
cost; China's 2025 short-drama market > $9B (Omdia: $11B global, ~83% China).
(03) Distribution not locked: top 3 apps ≈ 60% of ex-China revenue, but only
~30% of U.S. Gen Z / millennials have heard of the format. Sources: Omdia, MPA,
Holywater audience survey.

## 4 · Pain points — three links between a finished title and U.S. dollars

(01) **Content localization** — the title has to be reprocessed so U.S. viewers
feel it was shot for them: dialogue, pacing, titles, thumbnails, dubbing and the
opening hook. (02) **Precise paid acquisition** — users come mainly from paid;
creative that scales is found only by mass testing; each title needs many hook ×
audience combinations tested. (03) **Monetization closed loop** — playback,
per-episode unlock, payment, user data and producer reporting need a U.S.-local
operating system.

## 5 · How Pulsar works — one closed loop

Input: partner library → **SELECT** (pick the titles most likely to break out in
the U.S.) → **STUDIO** (adapt the title, make ad creatives) → **REACH** (run
TikTok / Meta, bring U.S. users to Pulsar) → **STAGE** (users watch on Pulsar,
pay to unlock) → **LEARN** (which ads, scenes and titles brought users and
payment). Data feeds back into the next batch's selection and adaptation.
Producers see each title's real performance; Pulsar funds and operates the
platform, localization and spend; producers supply titles and production
materials; every round tells both sides what U.S. audiences respond to and pay
for.

## 6 · Track record — Freecash on TikTok

Short drama is new to Pulsar; scaled TikTok / Meta buying is not. Freecash is a
U.S. consumer rewards app, strictly performance-settled; Pulsar ran its TikTok.
**1,390 ad creatives** produced and tested over **5 months**; **$200K** spend;
**~80K** registrations; **~$2.50** per registration. Everflow screenshot
(2026-02-01 → 2026-05-01): 241,389 clicks · 40,541 conversions · 16.8% CVR ·
$368,073 revenue. Same discipline for short drama: mass creatives, find winners
fast, move budget before decay.

## 7 · Pulsar Studio · 本土化改编

"We adapt titles for American audiences and produce the ad creatives at the same
time." Four steps:

1. **理解原作 — Understand the original.** Script, episode structure, characters,
   core emotional beats.
2. **美国本土化 — American localization.** Dialogue, pacing, dubbing, subtitles,
   titles, thumbnails, on-screen text.
3. **制片方审核 — Producer review.** The partner reviews and confirms the adapted
   version before it goes live.
4. **为现有剧集开发更多卖点 — More selling points for the same title.** From U.S.
   clicks and viewing, make new hooks, trailers, thumbnails, titles and
   alternative openings.

Mockup (illustrative, violet palette, Chinese UI — differs from slide 1's):

- Brand row: "Pulsar Studio · 创意制作 (creative production)"; header: search,
  coin balance 2,840 (+), avatar "AM".
- Left nav: 首页 Home · 项目 Projects (active) · 剧集 Titles · 素材库 Asset
  library · AI 工具 AI tools │ 评价 Reviews · 审批 Approvals · 团队 Team · 合作伙伴
  Partners. Bottom: an "Upgrade to Premium" upsell card (template leftover).
- Top tabs inside a title: 概览 Overview · **改编 Adaptation** (active) · Hook 与标题
  Hook & title · 缩略图 Thumbnail · 版本 Versions · 本地化 Localization · 内容与审核
  Content & review.
- Title header: ← 返回剧集 (back to titles) · **爱在旅途** (Love on the Road) ·
  episode-range picker "第 1–6 集" · status chip "已进入改编阶段" (in adaptation
  stage) · meta "爱情 · 微短剧 · 12 集 · 美国英语" · logline "两个陌生人，一场公路之旅，真相改变了一切。" · Share · ⋯
- Left: video player with scrubber (00:01:18 / 00:12:45), CC, settings,
  fullscreen.
- Middle column **原始台词（中文）** — original lines with timecode and a play
  button per line: 00:01:05 你到底……看什么？ · 00:01:11 我没有骗你，只是有些事，现在还不能说。 ·
  **00:01:18 如果你再不告诉我实话，我们就到此为止。** (selected, arrow →) · 00:01:23 我更是被逼才知道……
  · 00:01:31 真相是什么？
- Right column **改编后台词（美式英语）** — adapted line "If you don't tell me the
  truth right now, we're done." with play; **为什么这样改编 (why this change)**:
  natural American phrasing, keeps emotional intensity and tonal emphasis, fits
  overseas viewers' expectations; **这一版本 (this version)** tags 更精炼 (tighter)
  · 更情感化 (more emotional); **语气调整 (tone adjustment)**: more direct and
  decisive, stronger tension, matches how American speech handles conflict and
  boundaries.
- Below: **Hook 选项 (hook options)** — three candidates, one selected; **标题选项
  (title options)** — 爱在旅途 (selected) · 在两条路之间 · 破碎的心; each with
  "查看全部 (view all)".

## 8 · Pulsar Reach

Pulsar runs TikTok and Meta to bring U.S. users in. We make the ads (dozens of
hook / trailer / opening / creative versions per title, some cut from the title,
some newly produced); we run the spend (through Pulsar's U.S. ad infrastructure);
we find the audience (test demographics, interests, creative angles, title
positioning); we give budget to winners (track which ads brought viewers and
paying users, then scale). Mockup (illustrative): Creative Performance cards with
Spend / Cost per Viewer / First Payment Rate — $2,311 / $0.096 / 3.21%; $6,432 /
$0.061 / 5.21% (Top Performer); $1,112 / $0.112 / 2.71%. This is the buying
method Pulsar already ran at scale (slide 6).

## 9 · Pulsar Stage

Pulsar's own U.S. short-drama platform. Users arriving from TikTok / Meta ads
watch, unlock and pay on Pulsar. **Web first, native app later.** Watch (vertical
titles play on Pulsar) · Unlock (first episodes free, then per-episode unlock or
subscription) · Pay (U.S.-local collection, settled to producers per title) ·
Data (every title tracked ad click → episode view → payment). Status: web player
· pilot; payments · pilot; native app · planned. Mockup: stage.pulsar.com, "Love
on the Line" S1 E6, 36 episodes, coins 2,840, "Unlock Episode 6 · 120". Reach
drives traffic, Stage receives viewing — so Pulsar can match each ad to what the
user watched and whether they paid.

## 10 · Producer control

**The producer keeps the IP and has the final say over its content.** Producer
decides: the title and the reviewed localized version always belong to the
producer; the adapted version is reviewed before launch; dubbing and visual
materials are reviewed before launch; **marketing boundaries** — how the title
is positioned, how actors and likeness are used, what cannot be promoted, what
counts as a major change; which titles go live, confirmed one by one. Pulsar is
responsible for: U.S. platform distribution; U.S. payments and settlement;
TikTok / Meta spend, continuously producing and testing ad versions **within the
agreed boundaries**; App Store and ad-platform compliance; user data and monthly
reports. Pulsar's license covers only U.S. distribution and marketing for the
agreed term; it ends when the term ends.

## 11 · Competition — the top three

| | ReelShort | DramaBox | DramaWave |
|---|---|---|---|
| 2026 ex-China share | 29%; ~$1.05B revenue | 21%; implied ~$760M | 13%; implied ~$470M |
| Owner | Crazy Maple Studio (CA), controlled by COL (Beijing) | StoryMatrix (Singapore), under Dianzhong (Beijing) | Skywork AI, under Kunlun (Beijing) |
| Content source | Mainly U.S.-produced English originals, many adapted from Chinese web-novel IP | Mainly licensed, translated Chinese dramas; U.S. originals growing | Mainly licensed Chinese dramas, AI localization |
| Genres | Romance, werewolf / dark romance, billionaire | Romance, fantasy romance, crime, family | Flash marriage, CEO romance |
| Audience | ~75% female | ~57% F / 43% M | 84%+ female |
| Monetization | Per-episode coin unlock; VIP $19.99/week | Subscription-led $5.99/week; ads added 2026 | Per-episode coin unlock |
| Acquisition | 2025 sales expense ≈ 55% of revenue | Paid social + programmatic; intensity undisclosed | 80%+ of downloads from paid |

## 12 · Why Pulsar — deeper adaptation, per-title spend, data-driven originals

(01) **Deeper adaptation**: Studio rewrites dialogue, pacing and hooks for U.S.
viewers — not catalogue translation. (02) **Stronger ads and spend**: dozens of
creative versions per title on TikTok / Meta, per-title budget, validated at
scale (slide 6). (03) **Originals later, after data**: Stage data shows which
stories and hooks pay; originals follow. DramaBox vs Pulsar: large licensed
catalogue vs small slate chosen by testing · catalogue-level translation vs deep
adaptation of selected titles · unified buying for the whole catalogue vs
per-title independent TikTok / Meta tests · platform-level creative testing vs
dozens of versions tested before scaling · data for platform optimization vs
per-title tracking ad → view → pay · continuously expanding originals vs
originals launched after data validates demand.

## 13 · Unit economics

Spend **$0.50** to acquire a user; base case **$2.00** revenue and **$0.43**
contribution per user; optimistic contribution **$1.57**. Revenue per user
(base): paying-user LTV $40 × first-payment rate 5% = $2.00. Cost per user:
acquisition $0.50 · payment fees $0.10 · producer share $0.57 · **adaptation
$0.40** · total variable $1.57. Optimistic: LTV $74 → $3.68 revenue/user, $1.57
contribution. Footnotes: CAC = TikTok / Meta spend ÷ acquired users. LTV =
first-payment revenue × paying months; base $25 × 1.6 months ($25 ≈ RevenueCat
short-drama category median $23.85; 1.6 months from RevenueCat 31% first renewal
and 2% six-month retention); optimistic FlexTV ARPPU $46.44 × 1.6 = $74. Payment
fees: Stripe 2.9% + $0.30, ~3 payments per paying user, spread over 20 users.
Producer share: 30% of revenue net of payment fees (Pulsar's assumption).
**Adaptation cost: $2K per title spread over the first 5,000 users.** CAC and
first-payment rate are pilot targets.

## 14 · Platform cost

Stage is cheap to build and run; spend is the main cash outlay. Initial build
$3–5K cash (excluding founder labor): production environment and hosting, video
infrastructure, database and accounts, payment integration, analytics and
monitoring, initial AI / API credits. Pilot monthly platform cost $1.5–2.5K:
database / accounts / hosting / monitoring ~$500; **AI, dubbing and creative
APIs $500–1,000**; video delivery $500–1,000 (at $1 per 1,000 minutes viewed; a
25K-user pilot ≈ $750). Payback target ≤ 90 days: CAC $0.50; first-payment rate
5%; CAC per paying user $10; paying-user 90-day revenue target $25; $25 × 5% =
$1.25 per user → 90-day gross ROAS 2.5× (below slide 13's $40 base LTV).
Cloudflare Stream: $5 per 1,000 minutes stored, $1 per 1,000 minutes delivered,
encoding and bandwidth included. Supabase Pro from $25/month. All internal
estimates.

## 15 · Roadmap — six months from build to a repeatable per-title model

- **Week 4 — Stage MVP live.** Web player, first title, payment test
  environment; **Studio and Reach workflows usable.**
- **Week 6 — Stage official launch.** Payments and attribution live; **first 3–5
  titles adapted.**
- **Week 10 — Pilot complete.** 3–5 titles through TikTok / Meta tests; viewing
  and payment data in.
- **Month 3 — Second slate.** 2–3 partner producers; next titles chosen from
  pilot data; scale spend on titles tracking to 90-day gross ROAS 2.5×.
- **Month 4–5 — Scale.** Spend concentrated on proven titles; first U.S. editors
  and media buyers hired; originals development started from Stage data.
- **Month 6 — 8–12 titles live.** ≥ 2 titles at 90-day gross ROAS ≥ 2.5×; decide
  the native app from Stage web data.

## 16 · Team and pilot targets

Andrew — cofounder, growth and operations: TikTok / Meta spend, creative
production and optimization; ex-Mastercard product manager. Ruobin — cofounder,
product and partnerships: product, technology, producer relationships; ex-Bain
private-equity team. Both UC Berkeley, CS and business. Pilot targets: of the
first 3–5 titles, ≥ 2 reach 90-day gross ROAS ≥ 2.5×; CAC ≤ $0.50; first-payment
rate ≥ 5%; payment cycle measured in pilot; ≥ 5,000 acquired users per title;
pilot spend ≈ $20–25K (5 titles × 5,000 × $0.50 ≈ $12.5K for first tests, rest
reserved to scale winners). 5% target vs RevenueCat: 5.5% of short-drama app
installs pay within 35 days.

## 17 · Existing paths vs Pulsar

Licensing to an existing platform / traditional distributor / Pulsar: U.S.
distribution ✓ ✓ ✓ · includes localization ✓ ✓ ✓ · per-title TikTok / Meta spend
partial · partial · ✓ · creative-level ad results synced to the producer ✗ ·
partial · ✓ · per-title viewing and payment data synced partial · partial · ✓ ·
both sides jointly choose the next slate from data ✗ · ✗ · ✓. Only Pulsar does
all of it in one partnership.

## 18 · Selection mechanism — how we decide which titles to test

(01) Validated in China? — views, per-episode retention, payment performance.
(02) Will U.S. audiences buy it? — genre, setting, characters, and how much
localization it needs. (03) Can U.S. users be acquired at reasonable cost? —
make the first batch of creatives, run small on TikTok / Meta, measure the cost
of a sustained viewer.

## 19 · Studio · new-title incubation (later)

As Pulsar accumulates U.S. click / view / pay data, Studio can propose entirely
new title directions (setting, characters) for producers to shoot. Step 1
audience: U.S. college-age viewers. Step 2 themes worth testing: sports, class
conflict, hometown rivalry, public revenge. Step 3 concept: "Second String" — a
backup QB, the groundskeeper's son, framed by the coach's son and cut from the
team, joins the rival team; the season builds to the two teams' showdown.
Concept posters: "He lost her. To his biggest rival." / "Broken heart. One last
shot." / "Same field. No mercy." Pulsar provides concept, audience insight and
U.S. creative direction; the producer writes, casts, produces and gives final
approval.

## Visual language of the deck (for the design system)

Serif display (navy `≈#1a2340`) over Latin sans body; section labels in violet
`≈#5b4a9e`; numbers and accents in gold `≈#b8902f`; dark-navy callout bands;
cream `≈#f6f1e6` highlight columns. Slide 1's product mockups use the same
cream / navy / gold; slide 7's Studio mockup is the odd one out in violet.
