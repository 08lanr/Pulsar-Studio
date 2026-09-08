// The metric and source registry (docs/market-desk-plan.md, phase 1).
//
// Every feature bundle in docs/market-intelligence-review.md has an entry
// here whether or not it is implemented, with its real availability. The
// Data & Sources page renders this file; a metric label in the UI links to
// its entry. Statuses are computed from the published data at request time
// (freshness, history), never hard-coded.
//
// Nothing here is a credential or an operational log. Producer raw reports
// are tenant-scoped and described, not exposed.

import { ENGINE_VERSION } from "./engine";
import type { MarketView } from "./snapshot";
import { TAXONOMY_VERSION } from "./taxonomy";

export type SourceGroup = "catalogs_charts" | "social_search" | "ads_creatives" | "platforms_pricing" | "my_reports" | "derived";

export type RegistryStatus = "available" | "collecting_history" | "requires_connection" | "manual" | "unavailable" | "stale" | "failed";

export type EvidenceKind = "observed" | "inferred" | "estimated" | "partner_reported";

export type SourceEntry = {
  key: string;
  group: SourceGroup;
  name: string;
  /** How Studio reads it. */
  access: "public_web" | "public_api" | "authorized_api" | "import" | "producer_input" | "derived" | "licensed";
  /** Where the source itself is. */
  surface: string;
  /** Locale the data is collected in. */
  collection_locale: string;
  /** What audience the numbers measure; `unknown` unless the source says. */
  audience_geography: "unknown" | "US" | "global" | "per_report";
  refresh_target: string;
  limitations: string[];
  /** The review's correction for this source, when there is one (S1–S5). */
  review_note?: string;
  status_rule: "catalog" | "history" | "connection" | "manual" | "unavailable" | "producer";
};

export type MetricEntry = {
  key: string;
  group: SourceGroup;
  name_en: string;
  name_zh: string;
  /** The producer's question this answers. */
  question_en: string;
  question_zh: string;
  grain: "listing" | "trope" | "platform" | "company" | "own_title" | "cohort";
  source_key: string;
  source_field: string | null;
  unit: string;
  denominator: string | null;
  window: string;
  evidence: EvidenceKind;
  formula: string;
  version: string;
  limitations_en: string[];
  limitations_zh: string[];
  status_rule: SourceEntry["status_rule"];
};

const CATALOG_LIMITS = [
  "English public web catalog; audience geography is unknown. An English page does not establish a US audience.",
  "Pagination is client-side: ReelShort shelves expose 200 listings, DramaBox rails 18 each. Not the whole catalog.",
  "Listings, not underlying dramas: the same work can appear on several platforms under different titles.",
];

export const SOURCES: SourceEntry[] = [
  {
    key: "reelshort_web",
    group: "catalogs_charts",
    name: "ReelShort public catalog (reelshort.com)",
    access: "public_web",
    surface: "Home shelves, TOP shelf, New Release shelf",
    collection_locale: "en",
    audience_geography: "unknown",
    refresh_target: "daily, once the founders settle the terms-of-service posture",
    limitations: [...CATALOG_LIMITS, "read_count and collect_count are the platform's own counters; their definitions are not documented.", "No publisher field; only the Reel Original shelf marks first-party titles."],
    status_rule: "catalog",
  },
  {
    key: "dramabox_web",
    group: "catalogs_charts",
    name: "DramaBox public catalog (dramaboxapp.com)",
    access: "public_web",
    surface: "Home rails, Trending, Must-sees, Hidden Gems, Browse (newest), film pages",
    collection_locale: "en",
    audience_geography: "unknown",
    refresh_target: "daily, once the founders settle the terms-of-service posture",
    limitations: [...CATALOG_LIMITS, "viewCount / followCount come from film pages only; rail cards show a different small number that is discarded.", "The author field is a publisher label (mostly Webfic), not the production studio."],
    status_rule: "catalog",
  },
  {
    key: "youtube_public",
    group: "social_search",
    name: "YouTube public video counters",
    access: "public_api",
    surface: "YouTube Data API v3, videos.list (statistics)",
    collection_locale: "n/a",
    audience_geography: "unknown",
    refresh_target: "daily after connection",
    limitations: ["Public counters carry no viewer geography.", "Shorts view-count semantics changed in March 2025; keep video type with every observation."],
    review_note: "S2: public counters differ from owner-authorized analytics; preserve video type and metric definition.",
    status_rule: "connection",
  },
  {
    key: "youtube_owned",
    group: "social_search",
    name: "YouTube owned-channel analytics",
    access: "authorized_api",
    surface: "YouTube Analytics channel reports (producer-authorized)",
    collection_locale: "n/a",
    audience_geography: "per_report",
    refresh_target: "daily after the producer connects a channel",
    limitations: ["Geography and retention only for channels the producer owns and authorizes."],
    review_note: "S3: a connected-producer feature, subject to report compatibility and ownership.",
    status_rule: "connection",
  },
  {
    key: "google_trends",
    group: "social_search",
    name: "Google Trends (US search interest)",
    access: "import",
    surface: "Trends export with fixed region, query, category, property and window",
    collection_locale: "en-US",
    audience_geography: "US",
    refresh_target: "weekly import",
    limitations: ["Normalized relative interest (0–100), not search volume.", "Separately normalized exports cannot be spliced together."],
    review_note: "S4: keep region, query/topic, category, search property and time window with every series.",
    status_rule: "manual",
  },
  {
    key: "meta_ad_library",
    group: "ads_creatives",
    name: "Meta Ad Library",
    access: "public_api",
    surface: "Ad Library API / web library",
    collection_locale: "n/a",
    audience_geography: "unknown",
    refresh_target: "to be validated",
    limitations: ["The API's documented broad commercial scope is UK/EU; worldwide coverage is political/issue ads. US commercial monitoring needs access validation or reviewed imports.", "Ad presence and longevity do not establish spend, ROAS or creative effectiveness."],
    review_note: "S1: not a guaranteed US commercial-ad feed. Treated as a research task, not a promised connector.",
    status_rule: "unavailable",
  },
  {
    key: "tiktok_top_ads",
    group: "ads_creatives",
    name: "TikTok Creative Center Top Ads",
    access: "public_web",
    surface: "Creative Center, Top Ads",
    collection_locale: "en",
    audience_geography: "unknown",
    refresh_target: "weekly reviewed capture",
    limitations: ["A selected, advertiser-authorized sample with indexed metrics; not the competitive universe."],
    review_note: "S5: keep exact metric labels and selection scope.",
    status_rule: "manual",
  },
  {
    key: "grow_results",
    group: "ads_creatives",
    name: "Pulsar Grow test results",
    access: "authorized_api",
    surface: "Grow experiment read model (control, allocation, conversion window preserved)",
    collection_locale: "n/a",
    audience_geography: "per_report",
    refresh_target: "on campaign completion",
    limitations: ["Only the producer's own campaigns; Grow owns execution and measurement."],
    status_rule: "connection",
  },
  {
    key: "app_store_charts",
    group: "platforms_pricing",
    name: "US app store charts and ratings",
    access: "licensed",
    surface: "To be validated: storefront source or licensed report",
    collection_locale: "en-US",
    audience_geography: "US",
    refresh_target: "to be validated",
    limitations: ["Chart type and access must be confirmed before implementation; do not assume a free RSS feed exists.", "App-level only; nothing per title."],
    status_rule: "unavailable",
  },
  {
    key: "storefront_pricing",
    group: "platforms_pricing",
    name: "Subscription and coin pricing captures",
    access: "import",
    surface: "Dated storefront offer captures by region, device and currency",
    collection_locale: "en-US",
    audience_geography: "US",
    refresh_target: "monthly reviewed capture",
    limitations: ["Cost-to-finish needs an explicit purchase scenario; no universal dollar figure."],
    status_rule: "manual",
  },
  {
    key: "producer_reports",
    group: "my_reports",
    name: "Your distribution and platform reports (CSV)",
    access: "import",
    surface: "CSV import with preview, validation and reversible batches",
    collection_locale: "per_report",
    audience_geography: "per_report",
    refresh_target: "whenever you import",
    limitations: ["Only your own company's reports; never visible to another producer.", "Period, currency and metric definitions are mapped at import and kept with every row."],
    status_rule: "producer",
  },
  {
    key: "producer_input",
    group: "my_reports",
    name: "What you told us (profile, rights, readiness)",
    access: "producer_input",
    surface: "Studio profile, catalog synopses, rights and readiness fields",
    collection_locale: "zh/en",
    audience_geography: "per_report",
    refresh_target: "whenever you edit",
    limitations: ["Reported status, not legal certification."],
    status_rule: "producer",
  },
  {
    key: "engine",
    group: "derived",
    name: "Studio derivations (taxonomy, prominence, shares, matches)",
    access: "derived",
    surface: `lib/research/engine.ts v${ENGINE_VERSION}, taxonomy ${TAXONOMY_VERSION}`,
    collection_locale: "n/a",
    audience_geography: "unknown",
    refresh_target: "recomputed on every request from published snapshots",
    limitations: ["Reproducible from committed snapshots; a taxonomy or engine version change is a method change, not a market change."],
    status_rule: "catalog",
  },
];

export const METRICS: MetricEntry[] = [
  {
    key: "views_counter",
    group: "catalogs_charts",
    name_en: "Views counter",
    name_zh: "观看计数",
    question_en: "How many times does the platform say this listing has been viewed?",
    question_zh: "平台显示这部作品被观看了多少次？",
    grain: "listing",
    source_key: "reelshort_web",
    source_field: "read_count (ReelShort) / viewCount (DramaBox film page)",
    unit: "platform views (lifetime)",
    denominator: null,
    window: "lifetime, as of the observation timestamp",
    evidence: "observed",
    formula: "value as displayed",
    version: "1",
    limitations_en: ["Lifetime, not momentum.", "Each platform counts something different; never compared across platforms.", "Not unique viewers."],
    limitations_zh: ["累计值，不代表当前势头。", "各平台口径不同，不做跨平台比较。", "不是独立观众数。"],
    status_rule: "catalog",
  },
  {
    key: "saves_counter",
    group: "catalogs_charts",
    name_en: "Saves / follows counter",
    name_zh: "收藏 / 追剧计数",
    question_en: "How many viewers saved (ReelShort) or followed (DramaBox) it?",
    question_zh: "有多少观众收藏（ReelShort）或追剧（DramaBox）？",
    grain: "listing",
    source_key: "dramabox_web",
    source_field: "collect_count (ReelShort) / followCount (DramaBox)",
    unit: "collects or follows (lifetime), kept distinct",
    denominator: null,
    window: "lifetime",
    evidence: "observed",
    formula: "value as displayed",
    version: "1",
    limitations_en: ["A collect and a follow are different actions; the unit is kept with every observation."],
    limitations_zh: ["收藏与追剧是不同动作，每个观测都保留单位。"],
    status_rule: "catalog",
  },
  {
    key: "chart_visibility",
    group: "derived",
    name_en: "Chart visibility",
    name_zh: "榜单可见度",
    question_en: "Where does the platform itself place this listing right now?",
    question_zh: "平台当前把这部作品放在榜单的什么位置？",
    grain: "listing",
    source_key: "engine",
    source_field: "placements[].rank on chart lists (TOP, Trending, Must-sees, Top Hits)",
    unit: "0–100",
    denominator: null,
    window: "the observation day",
    evidence: "observed",
    formula: "100 − 0.9 × best chart rank (floor 1); null when on no chart",
    version: ENGINE_VERSION,
    limitations_en: ["Editorial placement, not audience demand.", "Themed shelves (Hidden Identity, …) are membership, not rank."],
    limitations_zh: ["是平台编辑位置，不是观众需求。", "主题货架只算入选，不算名次。"],
    status_rule: "catalog",
  },
  {
    key: "view_percentile",
    group: "derived",
    name_en: "Views percentile (within platform)",
    name_zh: "观看分位（平台内）",
    question_en: "Among this platform's tracked listings with a counter, where does it sit?",
    question_zh: "在同平台有计数的作品中，它处在什么位置？",
    grain: "listing",
    source_key: "engine",
    source_field: "views_counter",
    unit: "0–100",
    denominator: "same-platform listings with a views counter in this snapshot",
    window: "the observation day",
    evidence: "observed",
    formula: "rank of the counter among same-platform counters, as a percentile",
    version: ENGINE_VERSION,
    limitations_en: ["Lifetime counter, so older hits rank high.", "null when the platform shows no counter (not zero)."],
    limitations_zh: ["累计计数，老剧会排得高。", "平台未公开计数时为空，不是零。"],
    status_rule: "catalog",
  },
  {
    key: "prominence",
    group: "derived",
    name_en: "Prominence",
    name_zh: "显著度",
    question_en: "Which listings are most visible on the platform today?",
    question_zh: "今天哪些作品在平台上最显眼？",
    grain: "listing",
    source_key: "engine",
    source_field: "view_percentile, chart_visibility",
    unit: "0–100",
    denominator: null,
    window: "the observation day",
    evidence: "inferred",
    formula: "max(view percentile, chart visibility); null when both are missing",
    version: ENGINE_VERSION,
    limitations_en: ["Not momentum: an old hit and an editorially promoted title both score high.", "Ties: a charted listing outranks an uncharted one."],
    limitations_zh: ["不是势头：老爆款和编辑推荐都会得高分。", "并列时，上榜作品排在未上榜之前。"],
    status_rule: "catalog",
  },
  {
    key: "trope_cohort_share",
    group: "derived",
    name_en: "Trope share of prominent listings",
    name_zh: "显著作品中的题材占比",
    question_en: "What story types make up the most visible listings?",
    question_zh: "最显眼的作品由哪些题材构成？",
    grain: "trope",
    source_key: "engine",
    source_field: "tropes[] (taxonomy)",
    unit: "share (0–100%)",
    denominator: "the prominence cohort: up to 50 scored listings in the current filter, platform split shown",
    window: "the observation day",
    evidence: "inferred",
    formula: "listings in cohort carrying the trope ÷ cohort size; multi-label, so shares sum above 100%",
    version: `${ENGINE_VERSION} / taxonomy ${TAXONOMY_VERSION}`,
    limitations_en: ["Chart composition, not demand.", "Changes are only computed under the same taxonomy version and the same reference population."],
    limitations_zh: ["是榜单构成，不是需求。", "只有同一题材体系版本、同一参照人群下才计算变化。"],
    status_rule: "catalog",
  },
  {
    key: "trope_lift",
    group: "derived",
    name_en: "Trope lift",
    name_zh: "题材超额比",
    question_en: "Is a story type over-represented among prominent listings versus the tracked sample?",
    question_zh: "某题材在显著作品中的占比是否高于整体样本？",
    grain: "trope",
    source_key: "engine",
    source_field: "trope_cohort_share, sample share",
    unit: "ratio",
    denominator: "sample share (listings with the trope ÷ all listings in the filter)",
    window: "the observation day",
    evidence: "inferred",
    formula: "cohort share ÷ sample share; only with a cohort of at least 10",
    version: ENGINE_VERSION,
    limitations_en: ["Exploratory signal within a sampled catalog; not validated demand."],
    limitations_zh: ["样本内的探索性信号，不是已验证的需求。"],
    status_rule: "catalog",
  },
  {
    key: "trope_share_change",
    group: "derived",
    name_en: "Trope share change",
    name_zh: "题材占比变化",
    question_en: "Which story types are gaining chart visibility?",
    question_zh: "哪些题材的榜单可见度在上升？",
    grain: "trope",
    source_key: "engine",
    source_field: "trope_cohort_share on two published days",
    unit: "percentage points",
    denominator: "cohort on each day",
    window: "latest day vs the previous published day (actual interval shown)",
    evidence: "inferred",
    formula: "share(today) − share(previous day), both scored on their whole snapshot before filtering",
    version: ENGINE_VERSION,
    limitations_en: ["Needs two published days under the same taxonomy version."],
    limitations_zh: ["需要同一题材体系版本下的两个采集日。"],
    status_rule: "history",
  },
  {
    key: "rank_movement",
    group: "derived",
    name_en: "Chart rank movement",
    name_zh: "榜单名次变化",
    question_en: "Is this listing climbing or falling on a named chart?",
    question_zh: "这部作品在某个榜单上是上升还是下降？",
    grain: "listing",
    source_key: "engine",
    source_field: "placements[].rank on the same named list",
    unit: "positions",
    denominator: null,
    window: "latest day vs previous published day",
    evidence: "observed",
    formula: "prior rank − current rank; entry and exit are categorical",
    version: ENGINE_VERSION,
    limitations_en: ["Same named list only; a shelf reshuffle is not a market movement."],
    limitations_zh: ["仅限同一榜单；货架调整不算市场变化。"],
    status_rule: "history",
  },
  {
    key: "counter_velocity",
    group: "derived",
    name_en: "Views / saves added per day",
    name_zh: "日均新增观看 / 收藏",
    question_en: "How fast is the counter growing?",
    question_zh: "计数增长有多快？",
    grain: "listing",
    source_key: "engine",
    source_field: "views_counter or saves_counter on two days",
    unit: "counter units per day",
    denominator: "actual elapsed days between the two observations",
    window: "between the two most recent published days",
    evidence: "observed",
    formula: "(end − start) ÷ elapsed days; growth % only with start > 0; a decrease is an anomaly",
    version: ENGINE_VERSION,
    limitations_en: ["Same platform counter only.", "First-seen listings have no baseline (no invented zero)."],
    limitations_zh: ["仅限同一平台同一计数。", "首次发现的作品没有基线（不虚构零值）。"],
    status_rule: "history",
  },
  {
    key: "paywall_episode",
    group: "platforms_pricing",
    name_en: "First paid episode",
    name_zh: "首个付费集",
    question_en: "Where does each platform put the paywall?",
    question_zh: "各平台把付费点放在第几集？",
    grain: "listing",
    source_key: "reelshort_web",
    source_field: "paid_start (ReelShort) / first chapter with price or locked (DramaBox film page)",
    unit: "episode number",
    denominator: null,
    window: "as observed",
    evidence: "observed",
    formula: "value as displayed; medians per platform with n shown",
    version: "1",
    limitations_en: ["DramaBox chapter prices were all zero on the web reader for sampled titles; the web value may not match the app."],
    limitations_zh: ["DramaBox 网页端抽样章节价格均为 0，网页值未必等于 App 内价格。"],
    status_rule: "catalog",
  },
  {
    key: "episode_length",
    group: "platforms_pricing",
    name_en: "Episode length",
    name_zh: "单集时长",
    question_en: "How long is an episode on each platform?",
    question_zh: "各平台单集多长？",
    grain: "listing",
    source_key: "dramabox_web",
    source_field: "start_play.duration (ReelShort, episode 1) / mean chapter duration (DramaBox, listed)",
    unit: "seconds",
    denominator: null,
    window: "as observed",
    evidence: "observed",
    formula: "value as displayed; basis kept per listing (episode_1 vs listed_average)",
    version: "1",
    limitations_en: ["Two different bases; medians are reported per platform with the basis named, never pooled."],
    limitations_zh: ["两种口径不同；中位数按平台分别报告并注明口径，不合并。"],
    status_rule: "catalog",
  },
  {
    key: "audience_positioning",
    group: "catalogs_charts",
    name_en: "Audience positioning (女频 / 男频)",
    name_zh: "受众定位（女频 / 男频）",
    question_en: "How does the platform shelve the title?",
    question_zh: "平台把这部作品归到哪类受众？",
    grain: "listing",
    source_key: "reelshort_web",
    source_field: "theme tag Female/Male (ReelShort) / typeOneName F-Drama/M-Drama (DramaBox)",
    unit: "category",
    denominator: null,
    window: "as observed",
    evidence: "observed",
    formula: "value as tagged",
    version: "1",
    limitations_en: ["Platform positioning, not the protagonist's gender and not a measured viewer demographic."],
    limitations_zh: ["是平台定位，不是主角性别，也不是观众人口统计。"],
    status_rule: "catalog",
  },
  {
    key: "company_role",
    group: "catalogs_charts",
    name_en: "Company relationship",
    name_zh: "公司关系",
    question_en: "Which company is attached to the listing, and in what role?",
    question_zh: "这部作品关联哪家公司，是什么角色？",
    grain: "company",
    source_key: "dramabox_web",
    source_field: "author (DramaBox: publisher) / Reel Original shelf (ReelShort: platform original, inferred)",
    unit: "relationship",
    denominator: null,
    window: "as observed",
    evidence: "observed",
    formula: "role kept with every link; publisher ≠ production studio ≠ rights holder",
    version: "1",
    limitations_en: ["The production studio is not exposed by either platform; it needs a second source and review."],
    limitations_zh: ["两家平台都不公开制作方；需要第二来源并人工复核。"],
    status_rule: "catalog",
  },
  {
    key: "catalog_match",
    group: "derived",
    name_en: "Catalog match",
    name_zh: "剧库匹配度",
    question_en: "Which of my titles resemble what is prominent right now?",
    question_zh: "我的哪些作品与当前显著作品相似？",
    grain: "own_title",
    source_key: "engine",
    source_field: "your synopsis (taxonomy) × trope_cohort_share",
    unit: "0–100",
    denominator: "the title's tropes",
    window: "the observation day",
    evidence: "inferred",
    formula: "mean cohort share of the title's tropes; comparables by trope overlap",
    version: `${ENGINE_VERSION} / taxonomy ${TAXONOMY_VERSION}`,
    limitations_en: ["Similarity to prominent listings, not a probability of success.", "Tags come from your synopsis; a thin synopsis matches nothing."],
    limitations_zh: ["是与显著作品的相似度，不是成功概率。", "标签来自你的简介，简介太短就匹配不到。"],
    status_rule: "producer",
  },
  {
    key: "premise_examples",
    group: "ads_creatives",
    name_en: "Premise examples from prominent listings",
    name_zh: "显著作品的开场设定示例",
    question_en: "How do prominent titles state their premise?",
    question_zh: "显著作品如何表述开场设定？",
    grain: "listing",
    source_key: "engine",
    source_field: "first sentence of the platform blurb",
    unit: "text",
    denominator: null,
    window: "the observation day",
    evidence: "observed",
    formula: "first sentence (20–220 chars) of the blurb of prominence-ranked listings",
    version: ENGINE_VERSION,
    limitations_en: ["Synopsis copy, not tested ad hooks. No creative-outcome evidence exists here."],
    limitations_zh: ["是简介文案，不是经过测试的广告钩子；这里没有创意效果证据。"],
    status_rule: "catalog",
  },
  {
    key: "own_performance",
    group: "my_reports",
    name_en: "Your US performance",
    name_zh: "你的美国表现",
    question_en: "How did our own launches perform?",
    question_zh: "我们的海外上线表现如何？",
    grain: "own_title",
    source_key: "producer_reports",
    source_field: "per imported report",
    unit: "per report (mapped at import)",
    denominator: "per report",
    window: "the report period",
    evidence: "partner_reported",
    formula: "as imported; period, currency and definitions kept with rows",
    version: "1",
    limitations_en: ["Only your company's reports.", "Never compared with raw platform counters."],
    limitations_zh: ["仅限你公司的报表。", "不与平台原始计数比较。"],
    status_rule: "producer",
  },
  {
    key: "ad_observations",
    group: "ads_creatives",
    name_en: "Observed active creatives",
    name_zh: "观测到的在投素材",
    question_en: "Which titles are competitors advertising, and with what?",
    question_zh: "竞品在为哪些作品投放广告，用什么素材？",
    grain: "listing",
    source_key: "meta_ad_library",
    source_field: "n/a until access is validated",
    unit: "creatives observed",
    denominator: null,
    window: "n/a",
    evidence: "observed",
    formula: "count of distinct ad ids per title / advertiser, first and last seen",
    version: "0",
    limitations_en: ["Observed count, not the complete ad universe; never spend or ROAS."],
    limitations_zh: ["是观测到的数量，不是全部广告；不代表投放金额或回报。"],
    status_rule: "unavailable",
  },
  {
    key: "search_interest",
    group: "social_search",
    name_en: "US search interest",
    name_zh: "美国搜索兴趣",
    question_en: "Is US search interest for a title or trope rising?",
    question_zh: "某作品或题材在美国的搜索兴趣是否上升？",
    grain: "trope",
    source_key: "google_trends",
    source_field: "Trends export value",
    unit: "relative index 0–100",
    denominator: "peak of the exported series",
    window: "per export",
    evidence: "observed",
    formula: "as exported; one series per export, never spliced",
    version: "0",
    limitations_en: ["Normalized index, not search counts."],
    limitations_zh: ["是归一化指数，不是搜索次数。"],
    status_rule: "manual",
  },
  {
    key: "youtube_velocity",
    group: "social_search",
    name_en: "YouTube views and velocity",
    name_zh: "YouTube 播放与增速",
    question_en: "Which titles' YouTube uploads are gaining views?",
    question_zh: "哪些作品的 YouTube 视频播放在增长？",
    grain: "listing",
    source_key: "youtube_public",
    source_field: "statistics.viewCount",
    unit: "views per day",
    denominator: "actual elapsed days",
    window: "between observations after connection",
    evidence: "observed",
    formula: "(end − start) ÷ elapsed days, per video, video type kept",
    version: "0",
    limitations_en: ["Public views are not US-only."],
    limitations_zh: ["公开播放量不限于美国。"],
    status_rule: "connection",
  },
  {
    key: "grow_experiment",
    group: "ads_creatives",
    name_en: "Test results (Grow)",
    name_zh: "测试结果（Grow）",
    question_en: "Which hook or cut won our test, and with what confidence?",
    question_zh: "我们的测试中哪个钩子或剪辑胜出，置信度如何？",
    grain: "own_title",
    source_key: "grow_results",
    source_field: "Grow experiment read model",
    unit: "per experiment",
    denominator: "per experiment",
    window: "the experiment window",
    evidence: "observed",
    formula: "as measured by Grow; control, allocation and conversion window preserved",
    version: "0",
    limitations_en: ["Grow owns measurement; Studio reads back."],
    limitations_zh: ["由 Grow 负责测量；Studio 只读取。"],
    status_rule: "connection",
  },
];

export const GROUP_LABELS: Record<SourceGroup, { en: string; zh: string }> = {
  catalogs_charts: { en: "Catalogs & Charts", zh: "目录与榜单" },
  social_search: { en: "Social & Search", zh: "社媒与搜索" },
  ads_creatives: { en: "Ads & Creatives", zh: "广告与素材" },
  platforms_pricing: { en: "Platforms & Pricing", zh: "平台与定价" },
  my_reports: { en: "My Reports", zh: "我的报表" },
  derived: { en: "Derived Metrics", zh: "推导指标" },
};

export const STATUS_LABELS: Record<RegistryStatus, { en: string; zh: string }> = {
  available: { en: "Available", zh: "可用" },
  collecting_history: { en: "Collecting history", zh: "积累历史中" },
  requires_connection: { en: "Requires connection", zh: "需要接入" },
  manual: { en: "Manual import", zh: "人工导入" },
  unavailable: { en: "Unavailable", zh: "暂不可用" },
  stale: { en: "Stale", zh: "已过期" },
  failed: { en: "Failed", zh: "采集失败" },
};

/** Days after which a published snapshot counts as stale. */
export const STALE_AFTER_DAYS = 3;

export type RegistryContext = {
  view: MarketView;
  /** Does the caller's company have any imported report? */
  hasReports: boolean;
  hasProfile: boolean;
  now?: Date;
};

export function snapshotAgeDays(view: MarketView, now = new Date()): number | null {
  if (!view.latest) return null;
  const latest = Math.max(...view.latest.platforms.map((p) => Date.parse(p.fetched_at)));
  return Math.floor((now.getTime() - latest) / 86_400_000);
}

export function statusFor(rule: SourceEntry["status_rule"], ctx: RegistryContext): RegistryStatus {
  const { view } = ctx;
  switch (rule) {
    case "catalog": {
      if (!view.latest) return view.publication.last_failure ? "failed" : "unavailable";
      if (view.latest.platforms.every((p) => p.status === "failed")) return "failed";
      if (view.latest.platforms.some((p) => p.status === "stale") || (snapshotAgeDays(view, ctx.now) ?? 0) > STALE_AFTER_DAYS) return "stale";
      return "available";
    }
    case "history": {
      if (!view.latest) return "unavailable";
      const days = new Set(view.days.map(([d]) => d)).size;
      return days >= 2 && view.previous ? "available" : "collecting_history";
    }
    case "connection":
      return "requires_connection";
    case "manual":
      return "manual";
    case "unavailable":
      return "unavailable";
    case "producer":
      return ctx.hasReports || ctx.hasProfile ? "available" : "requires_connection";
  }
}

/** Per-platform status for the coverage strip. */
export function platformStatuses(view: MarketView): { id: string; status: RegistryStatus; title_count: number; with_views: number; fetched_at: string | null; error: string | null }[] {
  if (!view.latest) return [];
  return view.latest.platforms.map((p) => ({
    id: p.id,
    status: p.status === "failed" ? "failed" : p.status === "stale" ? "stale" : "available",
    title_count: p.title_count,
    with_views: p.with_views,
    fetched_at: p.fetched_at,
    error: p.error,
  }));
}

export function metricByKey(key: string): MetricEntry | null {
  return METRICS.find((m) => m.key === key) ?? null;
}

export function sourceByKey(key: string): SourceEntry | null {
  return SOURCES.find((s) => s.key === key) ?? null;
}
