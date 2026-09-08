// The trope taxonomy: the controlled vocabulary every market title and every
// producer title is tagged with (decision 2026-09-06, "Studio becomes the
// market desk"). Genre is too coarse for mini-drama ("romance" is most of
// the market); a title is bought on its premise mechanics, so the tags are
// premise mechanics. A title carries several.
//
// Two ways a title gets a trope: (1) a platform's own tag maps to one
// (ReelShort theme tags, DramaBox tags/genres), which is `observed`;
// (2) a keyword in the title or blurb fires a rule, which is `inferred`.
// The mapping tables are the whole method, on purpose: a producer can read
// why a title got a tag, and a wrong tag is a one-line fix here.

/** Bump when a mapping or keyword changes: a share computed under another version is not comparable. */
export const TAXONOMY_VERSION = "2026-09-07.1";

export type TropeId =
  | "ceo_billionaire"
  | "revenge"
  | "secret_identity"
  | "rebirth"
  | "second_chance"
  | "contract_marriage"
  | "pregnancy_babies"
  | "war_god"
  | "son_in_law"
  | "underdog_rise"
  | "strong_heroine"
  | "family_drama"
  | "werewolf"
  | "mafia"
  | "fantasy_paranormal"
  | "time_travel"
  | "sweet_romance"
  | "dark_toxic"
  | "love_triangle_betrayal"
  | "enemies_to_lovers"
  | "forbidden_love"
  | "young_love"
  | "suspense"
  | "comedy"
  | "palace_period"
  | "survival_apocalypse"
  | "chosen_one"
  | "lgbtq";

export type Trope = {
  id: TropeId;
  zh: string;
  en: string;
  /** Platform tag names (exact, case-insensitive) that map to this trope. */
  platform_tags: string[];
  /** Lower-case substrings of an English title/blurb that imply this trope. */
  keywords: string[];
  /** Substrings of a Chinese title/synopsis that imply this trope (producer catalogs). */
  keywords_zh: string[];
};

export const TROPES: Trope[] = [
  {
    id: "ceo_billionaire",
    zh: "霸总 / 豪门",
    en: "CEO & billionaire",
    platform_tags: ["CEO", "Billionaire", "Heiress/Socialite", "Business Owner", "Wealthy", "Divine Tycoon", "Rich", "Secret Billionaire", "CEO / Boss", "Royalty/Nobility", "High Society"],
    keywords: ["billionaire", "ceo", "tycoon", "heiress", "heir ", "mogul", "president", "chairman", "wealthy"],
    keywords_zh: ["霸总", "总裁", "豪门", "富豪", "千金", "财阀", "董事长"],
  },
  {
    id: "revenge",
    zh: "复仇 / 打脸",
    en: "Revenge",
    platform_tags: ["Revenge", "Comeback Story", "Avenge", "Counterattack", "Comeback", "Getting Back at Ex", "Regret", "Upgrade from Ex", "Hatred", "Cathartic"],
    keywords: ["revenge", "payback", "strikes back", "turned the tables", "vengeance", "regret", "avenge"],
    keywords_zh: ["复仇", "报复", "打脸", "反击", "逆袭复仇", "雪耻"],
  },
  {
    id: "secret_identity",
    zh: "隐藏身份 / 扮猪吃虎",
    en: "Secret identity",
    platform_tags: ["Hidden Identity", "Secret", "Playing Dumb", "Secret Identity", "Concealed Identity", "Disguise", "Mistaken Identity", "Identity Reveal", "Multiple Identities", "True and Fake Heiress", "Secret Agent"],
    keywords: ["secret", "hidden", "disguise", "undercover", "in disguise", "real heiress", "true identity", "pretend", "fake"],
    keywords_zh: ["隐藏身份", "马甲", "扮猪", "真千金", "假千金", "身份", "隐瞒", "伪装"],
  },
  {
    id: "rebirth",
    zh: "重生",
    en: "Rebirth",
    platform_tags: ["Rebirth", "Reborn"],
    keywords: ["reborn", "rebirth", "second life", "wakes up", "woke up", "start over", "time loop", "back to the"],
    keywords_zh: ["重生", "重来一次", "回到过去", "再活一次"],
  },
  {
    id: "second_chance",
    zh: "破镜重圆",
    en: "Second-chance love",
    platform_tags: ["Second Chance", "Second-chance Love", "Second-Chance Love", "Reunion Years Later", "Reunion"],
    keywords: ["second chance", "ex-husband", "ex-wife", "ex husband", "ex wife", "divorce", "love again", "after we broke"],
    keywords_zh: ["破镜重圆", "前夫", "前妻", "离婚", "复合", "追妻"],
  },
  {
    id: "contract_marriage",
    zh: "契约婚姻 / 闪婚",
    en: "Contract & flash marriage",
    platform_tags: ["Contract Marriage", "Contract Lover", "Contract Lovers", "Marriage Before Love", "Marriage", "Love After Marriage", "Wedding", "Marriage of Convenience", "Fake Marriage", "Fake Relationship", "Surrogate Bride", "Protective Husband"],
    keywords: ["contract marriage", "flash marriage", "fake marriage", "marriage of convenience", "married to", "waking up married", "my husband", "my wife", "wife", "husband", "bride", "groom"],
    keywords_zh: ["契约", "闪婚", "替嫁", "假结婚", "协议结婚", "联姻", "先婚后爱", "老公", "妻子", "夫人"],
  },
  {
    id: "pregnancy_babies",
    zh: "带球跑 / 萌宝",
    en: "Pregnancy & babies",
    platform_tags: ["Pregnancy", "Single Mom", "Single Dad", "Pregnancy & Babies", "Secret Baby", "Secret Child", "Genius Baby", "Lost Child"],
    keywords: ["pregnant", "pregnancy", "baby", "babies", "twins", "triplets", "mommy", "daddy", "my son", "my daughter", "little "],
    keywords_zh: ["怀孕", "萌宝", "宝宝", "孩子", "带球", "双胞胎", "亲子"],
  },
  {
    id: "war_god",
    zh: "战神 / 兵王",
    en: "War god",
    platform_tags: ["War God", "Super Warrior", "Marshal/General", "Soldier", "Tough Guy", "Bodyguard", "Super Hero"],
    keywords: ["war god", "dragon king", "warlord", "general", "commander", "sovereign", "warrior", "soldier", "king returns", "god of war"],
    keywords_zh: ["战神", "兵王", "龙王", "将军", "归来", "战王", "上将"],
  },
  {
    id: "son_in_law",
    zh: "赘婿",
    en: "Son-in-law",
    platform_tags: ["Son-in-Law"],
    keywords: ["son-in-law", "son in law"],
    keywords_zh: ["赘婿", "上门女婿", "女婿"],
  },
  {
    id: "underdog_rise",
    zh: "逆袭 / 小人物",
    en: "Underdog rise",
    platform_tags: ["Underdog Rise", "Underdog", "Small Potato", "A Nobody", "Sudden Wealth", "Uplifting Series", "Rags to Riches", "Server", "Assistant", "Beggar", "Servant", "Intern", "Fool", "Wallflower", "Cinderella", "Self-growth"],
    keywords: ["nobody", "deliveryman", "delivery", "janitor", "underdog", "from zero", "loser", "rise", "looked down", "dismissed", "poor"],
    keywords_zh: ["逆袭", "小人物", "外卖", "保安", "穷小子", "废柴", "草根"],
  },
  {
    id: "strong_heroine",
    zh: "大女主",
    en: "Strong heroine",
    platform_tags: ["Strong Heroine", "Independent Woman", "Strong-Willed", "Strong Female Lead", "Housewife", "Girl Power", "Female Empowerment"],
    keywords: ["queen", "she's the boss", "boss lady", "her empire", "girl boss"],
    keywords_zh: ["大女主", "女强", "女王", "独立女性"],
  },
  {
    id: "family_drama",
    zh: "家庭伦理",
    en: "Family drama",
    platform_tags: ["Family Drama", "Family", "Family Bonds", "Dysfunctional-Family", "Family Intrigue", "Saintly Parent"],
    keywords: ["stepmother", "in-laws", "mother-in-law", "family", "parents", "sister", "brother", "mom rules"],
    keywords_zh: ["家庭", "婆婆", "婆媳", "伦理", "亲情", "母亲", "父亲"],
  },
  {
    id: "werewolf",
    zh: "狼人 / Alpha",
    en: "Werewolf & alpha",
    platform_tags: ["Werewolf", "Werewolves", "Alpha", "Luna", "Shifter"],
    keywords: ["alpha", "luna", "pack", "werewolf", "wolf", "mate", "mated"],
    keywords_zh: ["狼人", "狼王"],
  },
  {
    id: "mafia",
    zh: "黑帮",
    en: "Mafia",
    platform_tags: ["Mafia", "Crime Lord", "Underworld"],
    keywords: ["mafia", "syndicate", "gangster", "cartel", "mob ", "don ", "crime lord", "underworld"],
    keywords_zh: ["黑帮", "黑道", "教父"],
  },
  {
    id: "fantasy_paranormal",
    zh: "玄幻 / 灵异",
    en: "Fantasy & paranormal",
    platform_tags: ["Fantasy", "Vampire", "Horror", "Paranormal", "Super Power", "Alternative History", "Sci-Fi", "Supernatural", "Dragon", "Magic", "High Fantasy", "Mythology", "Immortal", "Gamified World"],
    keywords: ["vampire", "genie", "dragon", "ghost", "immortal", "magic", "curse", "super power", "x-ray", "demon", "devil", "witch"],
    keywords_zh: ["玄幻", "修仙", "仙", "妖", "鬼", "灵异", "异能", "神医", "系统"],
  },
  {
    id: "time_travel",
    zh: "穿越",
    en: "Time travel",
    platform_tags: ["Time Travel", "Back in Time", "Transmigration"],
    keywords: ["time travel", "back to the 80s", "transmigrat", "travel back", "sent back"],
    keywords_zh: ["穿越", "穿书", "回到八十年代", "回到80年代", "穿回"],
  },
  {
    id: "sweet_romance",
    zh: "甜宠",
    en: "Sweet romance",
    platform_tags: ["Sweet Romance", "Love at First Sight", "Sweet Love", "True Love", "Soulmate", "Destiny", "Romance", "Fated Lovers", "Destined Love", "Slow Burn", "Opposites Attract", "Childhood Sweetheart", "Hidden Feelings"],
    keywords: ["spoil", "sweetheart", "crush", "love at first sight", "adore", "cherish", "destiny"],
    keywords_zh: ["甜宠", "甜", "宠妻", "暗恋", "一见钟情", "心动"],
  },
  {
    id: "dark_toxic",
    zh: "虐恋 / 强制爱",
    en: "Dark & toxic romance",
    platform_tags: ["Toxic Romance", "Dark Romance", "Dark", "Toxic Love", "Toxic Relationship", "Bitter Love", "Turbulent Love", "Forced Love", "Twisted", "Badboy", "Possessive", "Playboy", "Gritty"],
    keywords: ["cruel", "obsessed", "obsession", "forced", "kidnap", "shackle", "captive", "possessive", "ruthless"],
    keywords_zh: ["虐恋", "虐", "强制", "囚禁", "偏执", "病娇"],
  },
  {
    id: "love_triangle_betrayal",
    zh: "三角恋 / 替身 / 背叛",
    en: "Love triangle & betrayal",
    platform_tags: ["Love Triangle", "Betrayal", "Misunderstanding", "Secret Lover", "Sabotaging"],
    keywords: ["replaced", "replacement", "stand-in", "mistress", "cheat", "betray", "stole", "affair", "first love", "wrong heir"],
    keywords_zh: ["替身", "白月光", "背叛", "出轨", "小三", "三角"],
  },
  {
    id: "enemies_to_lovers",
    zh: "欢喜冤家",
    en: "Enemies to lovers",
    platform_tags: ["Enemies to Lovers"],
    keywords: ["enemy", "enemies", "rival", "hate"],
    keywords_zh: ["冤家", "死对头", "欢喜"],
  },
  {
    id: "forbidden_love",
    zh: "禁忌之恋",
    en: "Forbidden love",
    platform_tags: ["Forbidden Love", "Erotica", "Adults Only", "Step-Siblings", "Stepbrother", "Taboo", "Age Gap", "BDSM", "Steamy"],
    keywords: ["brother-in-law", "stepbrother", "forbidden", "boss's", "professor", "in bed with", "best friend's"],
    keywords_zh: ["禁忌", "禁恋", "师生", "叔", "小叔"],
  },
  {
    id: "young_love",
    zh: "校园 / 青春",
    en: "Young love",
    platform_tags: ["Young Adult", "Student", "Young Love", "Jock", "Athlete", "Campus", "Campus Lovers", "Sports Romance"],
    keywords: ["campus", "college", "high school", "student", "teacher", "waterboy", "class"],
    keywords_zh: ["校园", "青春", "高中", "大学", "同学"],
  },
  {
    id: "suspense",
    zh: "悬疑",
    en: "Suspense & mystery",
    platform_tags: ["Suspense", "Mystery", "Crime", "Thriller", "Romantic Suspense", "Criminal", "Suspenseful"],
    keywords: ["murder", "detective", "killer", "mystery", "missing", "conspiracy"],
    keywords_zh: ["悬疑", "凶手", "谋杀", "侦探", "刑侦"],
  },
  {
    id: "comedy",
    zh: "喜剧",
    en: "Comedy",
    platform_tags: ["Comedy", "Humor"],
    keywords: ["comedy", "hilarious", "funny"],
    keywords_zh: ["喜剧", "搞笑", "沙雕", "爆笑"],
  },
  {
    id: "palace_period",
    zh: "古装 / 宫斗",
    en: "Palace & period",
    platform_tags: ["Palace Intrigue", "Historical", "Period Drama", "Royalty"],
    keywords: ["palace", "emperor", "empress", "concubine", "prince", "princess", "dynasty", "throne", "kingdom"],
    keywords_zh: ["古装", "宫斗", "皇", "王爷", "公主", "太子", "宫廷"],
  },
  {
    id: "survival_apocalypse",
    zh: "末世 / 求生",
    en: "Survival & apocalypse",
    platform_tags: ["Survival", "Post-Apocalyptic"],
    keywords: ["apocalypse", "zombie", "wasteland", "survive", "survival", "lost in space"],
    keywords_zh: ["末世", "丧尸", "求生", "末日"],
  },
  {
    id: "chosen_one",
    zh: "天选之子",
    en: "The chosen one",
    platform_tags: ["The Chosen One"],
    keywords: ["chosen one", "prophecy", "destined"],
    keywords_zh: ["天选", "天命", "预言"],
  },
  {
    id: "lgbtq",
    zh: "LGBTQ",
    en: "LGBTQ",
    platform_tags: ["LGBTQ", "Lesbian", "Gay", "Gay & Lesbian"],
    keywords: [],
    keywords_zh: ["百合", "耽美"],
  },
];

export const TROPE_BY_ID: Record<TropeId, Trope> = Object.fromEntries(TROPES.map((t) => [t.id, t])) as Record<TropeId, Trope>;

const TAG_INDEX: Map<string, TropeId> = new Map();
for (const trope of TROPES) for (const tag of trope.platform_tags) TAG_INDEX.set(tag.toLowerCase(), trope.id);

/**
 * Platform tags that describe audience positioning (女频 / 男频), not the
 * premise. This is how the platform shelves the title; it is neither the
 * protagonist's gender nor a measured viewer demographic.
 */
const AUDIENCE_TAGS: Record<string, "female" | "male"> = {
  female: "female",
  "f-drama": "female",
  male: "male",
  "m-drama": "male",
};

export function audienceFromTags(tags: string[]): "female" | "male" | null {
  for (const tag of tags) {
    const audience = AUDIENCE_TAGS[tag.toLowerCase()];
    if (audience) return audience;
  }
  return null;
}

export function isTropeId(value: string): value is TropeId {
  return value in TROPE_BY_ID;
}

export type TropeAssignment = { id: TropeId; evidence: "observed" | "inferred"; via: string };

/**
 * Tag a title. Platform tags first (observed), then keyword rules on the
 * title and blurb (inferred). Deterministic and order-stable so a snapshot
 * rebuilt from the same raw data is byte-identical.
 */
export function assignTropes(input: { platform_tags: string[]; title: string; blurb: string }): TropeAssignment[] {
  const out = new Map<TropeId, TropeAssignment>();
  for (const tag of input.platform_tags) {
    const id = TAG_INDEX.get(tag.trim().toLowerCase());
    if (id && !out.has(id)) out.set(id, { id, evidence: "observed", via: tag });
  }
  const text = ` ${input.title} ${input.blurb} `.toLowerCase().replace(/[’‘]/g, "'");
  for (const trope of TROPES) {
    if (out.has(trope.id)) continue;
    const hit = trope.keywords.find((kw) => text.includes(kw)) ?? trope.keywords_zh.find((kw) => text.includes(kw));
    if (hit) out.set(trope.id, { id: trope.id, evidence: "inferred", via: hit.trim() });
  }
  return TROPES.filter((t) => out.has(t.id)).map((t) => out.get(t.id)!);
}

export function tropeLabel(id: TropeId, locale: "zh" | "en"): string {
  const t = TROPE_BY_ID[id];
  return t ? (locale === "zh" ? t.zh : t.en) : id;
}
