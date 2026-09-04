// The one fixture title, its producer, the two login personas, the
// adaptation row and the cast. Everything else in data/fixture hangs off
// these ids. The synopsis and character notes are the "title bible" the LLM
// passes read (docs/data-model.md, core.titles.character_notes).

import type { Adaptation, Character, Producer, Profile, Title } from "@/lib/types";
import {
  ADAPTATION_ID,
  AT,
  PRODUCER_ID,
  PRODUCER_USER_ID,
  STAFF_USER_ID,
  TITLE_ID,
  characterId,
  ext,
} from "./ids";

export const producer: Producer = {
  id: PRODUCER_ID,
  external_id: ext("pr", "xinghai"),
  slug: "xinghai",
  name_zh: "星海影视",
  name_en: "Xinghai Pictures",
  contact_email: "chen@xinghai.example",
  contact_wechat: "xinghai_chen",
  deliverables: { clean_master: true, dialogue_stem: false, script_or_srt: true, music_note: "" },
  created_at: AT.producer,
};

export const profiles: Profile[] = [
  {
    id: STAFF_USER_ID,
    kind: "staff",
    staff_role: "admin",
    producer_id: null,
    producer_role: null,
    display_name: "Ruobin",
    locale: null,
    created_at: AT.producer,
  },
  {
    id: PRODUCER_USER_ID,
    kind: "producer",
    staff_role: null,
    producer_id: PRODUCER_ID,
    producer_role: "approver",
    display_name: "陈总",
    locale: null,
    created_at: AT.producer,
  },
];

export const title: Title = {
  id: TITLE_ID,
  external_id: ext("ttl", "love-on-the-road"),
  producer_id: PRODUCER_ID,
  name_zh: "爱在旅途",
  name_en: "Love on the Road",
  genre: "爱情 · 微短剧 · 美国英语",
  synopsis_zh:
    "活动策划师林晚在赶往职业生涯最重要的一场周年晚宴途中，车在山路上抛锚。雨夜里搭上一个自称司机的陌生人的车，两人一路斗嘴、试探，却越走越近。抵达云溪后她才发现，这个人正是她苦等半年、从不露面的沈氏集团总裁沈亦辰——也是一年前撤单、让她赔光积蓄的那个人。晚宴前夜，董事会的暗流、当年撤单的真相和两人之间的心动一起浮出水面。",
  synopsis_en:
    "Event planner Lin Wan is racing to the biggest gala of her career when her car dies on a mountain road. On a rainy night she accepts a ride from a stranger who says he is just a driver; the two spar, probe and slowly warm to each other. Only in Yunxi does she learn he is Shen Yichen, the never-seen CEO of Shen Group she has chased for six months, and the man whose cancelled contract wiped out her savings a year ago. On the eve of the gala, a hostile board, the truth behind that cancellation and what is growing between them all surface at once.",
  character_notes:
    "林晚（LIN Wan，28）：活动策划师，嘴硬心软，去年因大客户撤单赔光积蓄，把这场晚宴当作翻身仗。说话快、直接，不喜欢被同情。\n沈亦辰（SHEN Yichen，32）：沈氏集团总裁，为躲开董事会提前离京，隐瞒身份。话少，冷淡里带一点调侃；对林晚有愧疚。\n周瑞（ZHOU Rui，30）：沈亦辰的特助，忠心但受够了替他收拾烂摊子。对上级恭敬，私下会顶嘴。\n称呼：林晚叫他“沈总”时带讽刺；周瑞叫“沈总”是习惯。整体语气：都市爱情，快节奏，斗嘴多于抒情。",
  logline_zh: "两个陌生人，一场公路之旅，真相改变了一切。",
  logline_en: "Two strangers, one road trip, and a truth that changes everything.",
  episode_count: 4,
  source_locale: "zh-CN",
  status: "in_review",
  china_metrics: { views: 48000000, completion_rate: 0.61, paying_rate: 0.034 },
  localization_effort:
    "Low-to-medium: contemporary urban setting, no period vocabulary; the honorific 沈总 and the metric measurements are the recurring swaps.",
  deliverables: { clean_master: true, dialogue_stem: false, script_or_srt: true, music_note: "" },
  notes:
    "Major-change criteria agreed with 陈总 (2026-08-24): any line that drops or changes a character's name or title; any line that changes who is at fault in the contract story.",
  license_start: "2026-09-01",
  license_end: "2027-08-31",
  created_at: AT.title,
  updated_at: AT.updated,
};

export const adaptation: Adaptation = {
  id: ADAPTATION_ID,
  external_id: ext("ad", "love-on-the-road:en-US"),
  title_id: TITLE_ID,
  target_locale: "en-US",
  label: "U.S. general",
  display_title_en: "Love on the Road",
  created_by: STAFF_USER_ID,
  created_at: AT.title,
};

export const characters: Character[] = [
  {
    id: characterId(1),
    title_id: TITLE_ID,
    name_zh: "林晚",
    name_en: "Lin Wan",
    notes: "Event planner, 28. Fast, direct, allergic to pity. Calls him 'Mr. Shen' with an edge once she knows.",
    created_at: AT.understand,
  },
  {
    id: characterId(2),
    title_id: TITLE_ID,
    name_zh: "沈亦辰",
    name_en: "Shen Yichen",
    notes: "CEO of Shen Group, 32. Few words, dry, hiding from his own board. Guilty about her.",
    created_at: AT.understand,
  },
  {
    id: characterId(3),
    title_id: TITLE_ID,
    name_zh: "周瑞",
    name_en: "Zhou Rui",
    notes: "Shen's executive assistant, 30. Loyal, exhausted by covering for him; deferential in public, blunt in private.",
    created_at: AT.understand,
  },
];
