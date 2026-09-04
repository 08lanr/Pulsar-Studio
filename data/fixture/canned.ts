// The demo replay bank: pre-authored adaptations for every fixture line that
// ships without one (episodes 3 and 4), keyed by the NORMALIZED Chinese text
// so they survive a re-upload of the same script through the real ingest
// path (fresh uuids, same dialogue).
//
// Why this exists: in fixture mode the "生成美式改编" button must work with no
// API key, spend nothing, and produce the same good result every run — the
// founders' rule for the demo is "don't translate a new show; use the
// existing translations". lib/demo-replay.ts looks lines up here and writes
// them through the normal data-layer first-pass path, so everything
// downstream (readiness, finalize, exports) treats them exactly like model
// output. Lines not in the bank are left unadapted and reported, which in a
// demo simply means: use the bundled scripts.

import type { AdaptTag, ChangeType } from "@/lib/types";
import { USER_CONTEXTS, USER_LINES } from "./canned-user";

export const DEMO_MODEL = "demo-replay";
export const DEMO_PROMPT_VERSION = "canned-v1";

/** Whitespace/punctuation-insensitive key: the same dialogue matches after a round-trip through any subtitle format. */
export function cannedKey(zh: string): string {
  return zh.replace(/[\s，。！？；：…—·、“”‘’"'​]/g, "");
}

export type CannedLine = {
  literal_en: string | null;
  text_en: string;
  /** The substring of text_en the sheet highlights as the change's face. */
  key_phrase_en?: string | null;
  back_translation_zh: string | null;
  change_type: ChangeType;
  is_major: boolean;
  rationale_en: string | null;
  rationale_zh: string | null;
  tone_note_en?: string | null;
  tone_note_zh?: string | null;
  tags?: AdaptTag[];
  syllables_est?: number | null;
  alternatives?: {
    text_en: string;
    back_translation_zh: string;
    rationale_zh: string;
    rationale_en: string;
    tags?: AdaptTag[];
    syllables_est?: number | null;
  }[];
};

export type CannedContext = { context_zh: string; context_en: string };

/** Scene context, keyed by the scene's FIRST line (normalized). */
const CONTEXTS: Record<string, CannedContext> = {
  [cannedKey("沈总，您真的要在晚宴上宣布吗？")]: {
    context_zh: "晚宴前夜，助理周瑞劝沈亦辰谨慎行事；沈亦辰决意在董事会面前摊牌，并承诺先向林晚坦白撤单真相。",
    context_en:
      "The night before the gala. Zhou Rui, the assistant, urges caution; Shen Yichen is set on forcing the board's hand — but first he owes Lin Wan the truth about the killed deal.",
  },
  [cannedKey("妈，我没事，就是有点累。")]: {
    context_zh: "林晚和母亲通电话强装轻松，刚挂断，沈亦辰便出现在门口，只求五分钟。",
    context_en:
      "Lin Wan keeps up a brave front on the phone with her mother. The moment she hangs up, Shen Yichen is at her door asking for five minutes.",
  },
  [cannedKey("去年撤单的时候，我以为你的公司是我叔叔安插的。")]: {
    context_zh: "沈亦辰坦白当年撤单的原因——误以为她的公司是叔叔安插的棋子；林晚说出这一年的代价，他承诺晚宴必到。",
    context_en:
      "The confession: he killed the deal believing her company was his uncle's plant. She names what it cost her; he promises to show up at the gala — because he owes her.",
  },
  [cannedKey("沈总，董事们都到齐了。")]: {
    context_zh: "晚宴开场前，董事们已就位，沈亦辰却先去后台找林晚。",
    context_en: "Minutes before the gala begins, the board is seated — and Shen Yichen goes backstage to find Lin Wan first.",
  },
  [cannedKey("灯光倒数十秒。所有人就位。")]: {
    context_zh: "后台倒数，林晚在指挥全场；沈亦辰追到后台，她让他把要说的话搬到台上去说。",
    context_en:
      "Backstage countdown. Lin Wan is running the show; Shen Yichen catches her, and she dares him to say it from the stage instead.",
  },
};

/** The bank. Keys are normalized zh; content mirrors lib/prompts/first-pass output. */
const BANK: Record<string, CannedLine> = {
  // ---- Episode 2 · the slide-7 example line (already adapted in the fixture;
  // this entry exists so 查看备选说法 has three options for the demo's
  // headline moment) ---------------------------------------------------------
  [cannedKey("如果你再不告诉我实话，我们就到此为止。")]: {
    literal_en: "If you don't tell me the truth, we will stop here.",
    text_en: "If you don't tell me the truth right now, we're done.",
    key_phrase_en: "we're done",
    back_translation_zh: "如果你现在不告诉我实话，我们就完了。",
    change_type: "rewrite",
    is_major: false,
    rationale_zh: "“到此为止”直译生硬；we're done 是美式剧集中常见的决裂表达，加 right now 增强紧迫感。",
    rationale_en: "'We're done' is the standard U.S.-drama break line; 'right now' supplies the urgency the literal loses.",
    tags: ["more_direct", "more_emotional"],
    syllables_est: 13,
    alternatives: [
      {
        text_en: "Tell me the truth, or we're done here.",
        back_translation_zh: "告诉我实话，否则我们就到此为止。",
        rationale_zh: "命令式开场，最后通牒的味道最重，冲突推到顶。",
        rationale_en: "Opens on the imperative — a straight ultimatum; pushes the confrontation to its peak.",
        tags: ["more_direct", "tighter"],
        syllables_est: 9,
      },
      {
        text_en: "One more lie, and I'm walking away.",
        back_translation_zh: "再骗我一次，我就转身走人。",
        rationale_zh: "把“到此为止”落到“走人”的动作上，画面感强，适合切背影镜头。",
        rationale_en: "Lands the break-up on a physical action — walking away; strong image, cuts well to her turning.",
        tags: ["idiom", "more_emotional"],
        syllables_est: 9,
      },
      {
        text_en: "I need the truth. Right now. Or this is over.",
        back_translation_zh: "我要听实话。现在。否则就结束了。",
        rationale_zh: "三个短句层层加压，节奏感最强，适合近景逐字咬出来。",
        rationale_en: "Three hard stops stack the pressure — the most rhythmic read, made for a tight close-up.",
        tags: ["pacing", "more_emotional"],
        syllables_est: 11,
      },
    ],
  },
  // ---- Episode 3 · Scene 1 -------------------------------------------------
  [cannedKey("沈总，您真的要在晚宴上宣布吗？")]: {
    literal_en: "President Shen, are you really going to announce it at the banquet?",
    text_en: "Sir, you're really announcing it at the gala?",
    key_phrase_en: "gala",
    back_translation_zh: "先生，您真的要在晚宴上宣布吗？",
    change_type: "cultural",
    is_major: false,
    rationale_zh: "美式职场不会用“沈总”这类头衔直呼上级，改为 Sir 更自然；banquet 显得old-fashioned，公司活动在美语里就是 gala。",
    rationale_en: "U.S. workplaces don't address the boss by title-plus-surname; 'Sir' is the natural register, and 'gala' is what this event is called in American English.",
    tags: ["cultural_swap", "clarity"],
    syllables_est: 12,
  },
  [cannedKey("董事会想让我消失，我偏要站在灯下。")]: {
    literal_en: "The board wants me to disappear; I insist on standing under the lights.",
    text_en: "The board wants me gone. So I'll stand where the light is brightest.",
    key_phrase_en: "where the light is brightest",
    back_translation_zh: "董事会想让我消失。那我就站在灯最亮的地方。",
    change_type: "rewrite",
    is_major: false,
    rationale_zh: "保留“灯下”的比喻，但拆成两个短句制造宣战感，符合美剧强势主角的语气节奏。",
    rationale_en: "Keeps the light metaphor but breaks it into two short declaratives — the cadence of a U.S.-drama power move.",
    tone_note_zh: "更强硬、更有对抗性。",
    tone_note_en: "Harder, more confrontational.",
    tags: ["more_direct"],
    syllables_est: 16,
    alternatives: [
      {
        text_en: "They want me invisible. I'm about to be unmissable.",
        back_translation_zh: "他们想让我隐形。我偏要让所有人都看见我。",
        rationale_zh: "用 invisible/unmissable 的对仗替代比喻，更简洁，也保留挑衅感。",
        rationale_en: "Swaps the metaphor for an invisible/unmissable antithesis — tighter, same defiance.",
        tags: ["tighter", "more_direct"],
        syllables_est: 14,
      },
      {
        text_en: "The board wants me to disappear. I don't do disappearing.",
        back_translation_zh: "董事会想让我消失。我不干消失这种事。",
        rationale_zh: "口语化的否定句式，带一点冷幽默，弱化文绉绉的比喻。",
        rationale_en: "Colloquial refusal with dry humor; drops the literary image entirely.",
        tags: ["more_casual", "humor"],
        syllables_est: 14,
      },
    ],
  },
  [cannedKey("那林小姐呢？她还不知道您当初为什么撤单。")]: {
    literal_en: "What about Miss Lin? She still doesn't know why you withdrew the order back then.",
    text_en: "And Miss Lin? She still doesn't know why you killed the deal.",
    key_phrase_en: "killed the deal",
    back_translation_zh: "那林小姐呢？她还不知道您当初为什么终止了那笔交易。",
    change_type: "rewrite",
    is_major: false,
    rationale_zh: "“撤单”译作 killed the deal，是美式商战剧的惯用说法，比 withdrew the order 更口语、更有冲击力。",
    rationale_en: "'Killed the deal' is the standard U.S. business-drama idiom — punchier and more spoken than 'withdrew the order'.",
    tags: ["idiom"],
    syllables_est: 14,
  },
  [cannedKey("明天之前，我会告诉她。")]: {
    literal_en: "Before tomorrow, I will tell her.",
    text_en: "She'll hear it from me by tomorrow.",
    key_phrase_en: "hear it from me",
    back_translation_zh: "明天之前，她会亲耳听我说。",
    change_type: "tone",
    is_major: false,
    rationale_zh: "hear it from me 强调“由我亲口说”，为后面的道歉戏做情感铺垫，比直译更有分量。",
    rationale_en: "'Hear it from me' stresses that it comes from him personally — sets up the apology scene with more weight than the literal.",
    tags: ["more_emotional"],
    syllables_est: 9,
  },
  [cannedKey("您上次也是这么说的。")]: {
    literal_en: "You said that last time too.",
    text_en: "You said that last time, too.",
    back_translation_zh: "您上次也是这么说的。",
    change_type: "literal",
    is_major: false,
    rationale_zh: "直译已经自然，仅按美式书写习惯加逗号。",
    rationale_en: "The literal line already lands; only punctuation adjusted.",
    tags: [],
    syllables_est: 7,
  },
  [cannedKey("周瑞。")]: {
    literal_en: "Zhou Rui.",
    text_en: "Zhou Rui.",
    back_translation_zh: null,
    change_type: "keep",
    is_major: false,
    rationale_zh: null,
    rationale_en: null,
    tags: [],
    syllables_est: 2,
  },
  [cannedKey("我闭嘴。")]: {
    literal_en: "I'll shut up.",
    text_en: "Shutting up now, sir.",
    key_phrase_en: "Shutting up now",
    back_translation_zh: "我这就闭嘴，先生。",
    change_type: "tone",
    is_major: false,
    rationale_zh: "加一点自嘲，符合美剧里下属识趣打圆场的节奏，让紧张场景落在轻的一拍上。",
    rationale_en: "A touch of self-deprecation — the classic beat of an underling backing off in U.S. shows; ends the scene on a light note.",
    tags: ["humor", "more_casual"],
    syllables_est: 6,
  },

  // ---- Episode 3 · Scene 2 -------------------------------------------------
  [cannedKey("妈，我没事，就是有点累。")]: {
    literal_en: "Mom, I'm fine, just a bit tired.",
    text_en: "Mom, I'm fine. Just tired.",
    key_phrase_en: "Just tired.",
    back_translation_zh: "妈，我没事。就是累了。",
    change_type: "tighten",
    is_major: false,
    rationale_zh: "拆成两个短句更贴近美式口语的电话节奏，也放大了强装轻松的感觉。",
    rationale_en: "Two clipped sentences match American phone-call rhythm and sharpen the brave-front feeling.",
    tags: ["tighter"],
    syllables_est: 6,
  },
  [cannedKey("明天过了就好了。")]: {
    literal_en: "After tomorrow it will be fine.",
    text_en: "Once tomorrow's over, I'll be okay.",
    key_phrase_en: "I'll be okay",
    back_translation_zh: "等明天过去，我就没事了。",
    change_type: "rewrite",
    is_major: false,
    rationale_zh: "把“就好了”落到 I'll be okay，主语回到她自己，更符合英语的情感表达习惯。",
    rationale_en: "Anchors the reassurance on herself ('I'll be okay'), the way English carries this sentiment.",
    tags: ["clarity"],
    syllables_est: 9,
  },
  [cannedKey("不，我没有再想他……好吧，有一点。")]: {
    literal_en: "No, I'm not thinking about him again... okay, a little.",
    text_en: "No, I'm not still thinking about him... Okay. A little.",
    key_phrase_en: "Okay. A little.",
    back_translation_zh: "不，我没有还在想他……好吧。有一点。",
    change_type: "tone",
    is_major: false,
    rationale_zh: "用两个断句制造被妈妈戳穿后的停顿感，美式喜剧节奏里的经典“嘴硬三连”。",
    rationale_en: "The two hard stops play the caught-by-mom beat — a classic American denial-then-confession rhythm.",
    tone_note_zh: "口是心非，带笑意。",
    tone_note_en: "Denial with a smile in it.",
    tags: ["more_emotional", "humor"],
    syllables_est: 13,
    alternatives: [
      {
        text_en: "I'm over him, Mom. ...Mostly.",
        back_translation_zh: "我已经放下他了，妈。……差不多吧。",
        rationale_zh: "更短促、更俏皮，把转折压到最后一个词。",
        rationale_en: "Shorter and cheekier; lands the reversal on a single word.",
        tags: ["tighter", "humor"],
        syllables_est: 8,
      },
      {
        text_en: "No, I haven't been thinking about him— fine. A little.",
        back_translation_zh: "不，我没有一直想他——好吧。有一点。",
        rationale_zh: "破折号打断自己，更像被当场拆穿的真实口语。",
        rationale_en: "The self-interrupting dash reads like being caught mid-lie.",
        tags: ["more_emotional"],
        syllables_est: 13,
      },
    ],
  },
  [cannedKey("妈，先挂了，有人敲门。")]: {
    literal_en: "Mom, I'll hang up first, someone is knocking.",
    text_en: "Mom, I gotta go — someone's at the door.",
    key_phrase_en: "gotta go",
    back_translation_zh: "妈，我得挂了——有人在敲门。",
    change_type: "cultural",
    is_major: false,
    rationale_zh: "美式电话收尾惯用 gotta go；直译 hang up first 在英语里显得生硬。",
    rationale_en: "'Gotta go' is how American phone calls end; the literal 'hang up first' reads stilted.",
    tags: ["more_casual", "idiom"],
    syllables_est: 10,
  },
  [cannedKey("有时间吗？五分钟。")]: {
    literal_en: "Do you have time? Five minutes.",
    text_en: "Got a minute? Five, actually.",
    key_phrase_en: "Five, actually",
    back_translation_zh: "有一分钟吗？确切说，五分钟。",
    change_type: "rewrite",
    is_major: false,
    rationale_zh: "Got a minute 是标准美式开场；补 Five, actually 保留他惜字如金里的那点克制幽默。",
    rationale_en: "'Got a minute?' is the standard ask; 'Five, actually' keeps his clipped, dry humor.",
    tags: ["idiom", "humor"],
    syllables_est: 8,
  },
  [cannedKey("你是来解释的，还是来道歉的？")]: {
    literal_en: "Are you here to explain, or to apologize?",
    text_en: "Are you here to explain, or to apologize?",
    back_translation_zh: "你是来解释的，还是来道歉的？",
    change_type: "literal",
    is_major: false,
    rationale_zh: "原句的对仗在英语里同样成立，直译即是最优解。",
    rationale_en: "The parallelism survives translation intact; the literal is the best line.",
    tags: [],
    syllables_est: 12,
  },
  [cannedKey("都是。")]: {
    literal_en: "Both.",
    text_en: "Both.",
    back_translation_zh: null,
    change_type: "keep",
    is_major: false,
    rationale_zh: null,
    rationale_en: null,
    tags: [],
    syllables_est: 1,
  },

  // ---- Episode 3 · Scene 3 -------------------------------------------------
  [cannedKey("去年撤单的时候，我以为你的公司是我叔叔安插的。")]: {
    literal_en: "When I withdrew the order last year, I thought your company was placed there by my uncle.",
    text_en: "When I killed the deal last year, I thought your company was a plant. My uncle's.",
    key_phrase_en: "a plant",
    back_translation_zh: "去年我终止那笔交易时，我以为你的公司是安插进来的棋子——我叔叔的。",
    change_type: "rewrite",
    is_major: false,
    rationale_zh: "“安插”对应美式谍战/商战剧的 plant 一词；把 My uncle's 单独断句，模仿坦白时的迟疑。",
    rationale_en: "'Plant' is the exact U.S. thriller word for 安插; isolating 'My uncle's' plays the hesitation of a confession.",
    tags: ["idiom", "clarity"],
    syllables_est: 18,
  },
  [cannedKey("所以你连查都没查？")]: {
    literal_en: "So you didn't even investigate?",
    text_en: "So you didn't even check?",
    back_translation_zh: "所以你连查都没查？",
    change_type: "literal",
    is_major: false,
    rationale_zh: "check 比 investigate 口语，其余直译即可。",
    rationale_en: "'Check' over 'investigate' for register; otherwise literal.",
    tags: ["more_casual"],
    syllables_est: 7,
  },
  [cannedKey("我查了。查到的时候已经晚了。")]: {
    literal_en: "I checked. By the time I found out, it was already late.",
    text_en: "I did. By the time I knew, it was too late.",
    key_phrase_en: "I did.",
    back_translation_zh: "我查了。等我知道的时候，已经太迟了。",
    change_type: "tighten",
    is_major: false,
    rationale_zh: "用 I did 承接上一句问话，避免重复 check；节奏更像真实对话。",
    rationale_en: "'I did' answers the question without repeating 'check' — real dialogue economy.",
    tags: ["tighter", "pacing"],
    syllables_est: 11,
  },
  [cannedKey("你毁了我一年。")]: {
    literal_en: "You ruined a year for me.",
    text_en: "You cost me a year of my life.",
    key_phrase_en: "a year of my life",
    back_translation_zh: "你让我付出了一年的人生。",
    change_type: "rewrite",
    is_major: false,
    rationale_zh: "cost me a year of my life 是美式控诉的惯用表达，把抽象的“毁”落到具体的代价上，情感更重。",
    rationale_en: "'Cost me a year of my life' is the idiomatic accusation — it makes the damage concrete and heavier than 'ruined'.",
    tone_note_zh: "压着怒气的平静。",
    tone_note_en: "Quiet, with anger underneath.",
    tags: ["more_emotional", "idiom"],
    syllables_est: 8,
    alternatives: [
      {
        text_en: "You took a year from me.",
        back_translation_zh: "你从我这里夺走了一年。",
        rationale_zh: "更短，动词 took 带出被剥夺感。",
        rationale_en: "Shorter; 'took' foregrounds the theft.",
        tags: ["tighter"],
        syllables_est: 6,
      },
      {
        text_en: "I lost a year because of you.",
        back_translation_zh: "因为你，我失去了一年。",
        rationale_zh: "把主语换成她自己，控诉变成陈述，更冷。",
        rationale_en: "First-person subject turns the accusation into a colder statement of fact.",
        tags: ["more_direct"],
        syllables_est: 8,
      },
    ],
  },
  [cannedKey("我知道。所以这场晚宴，我一定会到。")]: {
    literal_en: "I know. So this gala, I will definitely attend.",
    text_en: "I know. That's why I'll be at that gala — no matter what.",
    key_phrase_en: "no matter what",
    back_translation_zh: "我知道。所以那场晚宴我一定到——无论如何。",
    change_type: "tone",
    is_major: false,
    rationale_zh: "no matter what 补足“一定”的承诺重量；英语里单说 definitely 不够郑重。",
    rationale_en: "'No matter what' carries the vow; a bare 'definitely' is too light for the promise.",
    tags: ["more_emotional"],
    syllables_est: 14,
  },
  [cannedKey("为什么？")]: {
    literal_en: "Why?",
    text_en: "Why?",
    back_translation_zh: null,
    change_type: "keep",
    is_major: false,
    rationale_zh: null,
    rationale_en: null,
    tags: [],
    syllables_est: 1,
  },
  [cannedKey("因为这是我欠你的。")]: {
    literal_en: "Because this is what I owe you.",
    text_en: "Because I owe you that much.",
    key_phrase_en: "that much",
    back_translation_zh: "因为这至少是我欠你的。",
    change_type: "rewrite",
    is_major: false,
    rationale_zh: "owe you that much 带“至少”的分寸感，是英语里认亏欠的地道说法。",
    rationale_en: "'Owe you that much' carries the 'at least this' nuance — the idiomatic register of admitted debt.",
    tags: ["idiom"],
    syllables_est: 7,
  },
  [cannedKey("沈亦辰，我不需要你欠我什么。")]: {
    literal_en: "Shen Yichen, I don't need you to owe me anything.",
    text_en: "Shen Yichen, I don't want your debt. I never did.",
    key_phrase_en: "I never did.",
    back_translation_zh: "沈亦辰，我不想要你的亏欠。从来都不想。",
    change_type: "rewrite",
    is_major: true,
    rationale_zh: "补了一句原文没有的 I never did，强化她的骄傲与拒绝——属于加词的重大改动，请制片方确认是否保留。",
    rationale_en: "Adds 'I never did', which is not in the source — it sharpens her pride and refusal. Flagged as a major change for the producer to confirm.",
    tone_note_zh: "决绝，但不歇斯底里。",
    tone_note_en: "Final, but never hysterical.",
    tags: ["more_emotional"],
    syllables_est: 12,
    alternatives: [
      {
        text_en: "Shen Yichen, I don't need you to owe me anything.",
        back_translation_zh: "沈亦辰，我不需要你欠我什么。",
        rationale_zh: "完全忠实原文、不加词的版本——如果“重大改动”走得太远，选这一版。",
        rationale_en: "The fully faithful version with nothing added; the one to pick if the flagged change goes too far.",
        tags: ["clarity"],
        syllables_est: 12,
      },
      {
        text_en: "I'm not a debt for you to settle.",
        back_translation_zh: "我不是一笔等你来还的债。",
        rationale_zh: "把“欠”具象成“还债”，隐喻更锋利，姿态更高。",
        rationale_en: "Sharpens the owing into a settle-a-debt image; colder, and she keeps the high ground.",
        tags: ["more_direct", "idiom"],
        syllables_est: 9,
      },
      {
        text_en: "Keep your debt, Shen Yichen. I never asked for it.",
        back_translation_zh: "你的亏欠自己留着，沈亦辰。我从没要过。",
        rationale_zh: "拒绝前置、名字后置像最后通牒，气场最强的一版。",
        rationale_en: "Front-loads the refusal and lands his name like an ultimatum; the most forceful read.",
        tags: ["more_direct", "more_emotional"],
        syllables_est: 13,
      },
    ],
  },

  // ---- Episode 4 · Scene 1 -------------------------------------------------
  [cannedKey("沈总，董事们都到齐了。")]: {
    literal_en: "President Shen, the directors have all arrived.",
    text_en: "Sir, the board's all here.",
    key_phrase_en: "the board's all here",
    back_translation_zh: "先生，董事会成员都到了。",
    change_type: "cultural",
    is_major: false,
    rationale_zh: "同前：头衔改 Sir；the board's all here 是美式会议场景的自然说法。",
    rationale_en: "Title becomes 'Sir'; 'the board's all here' is the natural boardroom phrasing.",
    tags: ["cultural_swap", "tighter"],
    syllables_est: 6,
  },
  [cannedKey("让他们等。我先去找林晚。")]: {
    literal_en: "Let them wait. I'll go find Lin Wan first.",
    text_en: "Let them wait. Lin Wan comes first.",
    key_phrase_en: "Lin Wan comes first",
    back_translation_zh: "让他们等。林晚优先。",
    change_type: "rewrite",
    is_major: false,
    rationale_zh: "comes first 直接把“先去找”升格为优先级宣言，一句话立住人物的选择。",
    rationale_en: "'Comes first' upgrades the errand into a statement of priorities — the whole choice in four words.",
    tone_note_zh: "不容置疑。",
    tone_note_en: "Not up for discussion.",
    tags: ["more_direct", "tighter"],
    syllables_est: 8,
    alternatives: [
      {
        text_en: "They can wait. She can't.",
        back_translation_zh: "他们可以等。她不能等。",
        rationale_zh: "对仗压缩到六个词，悬念感更强。",
        rationale_en: "Compressed antithesis in six words; more tension.",
        tags: ["tighter", "more_direct"],
        syllables_est: 6,
      },
    ],
  },
  [cannedKey("她在后台，说今晚不想见您。")]: {
    literal_en: "She is backstage; she said she doesn't want to see you tonight.",
    text_en: "She's backstage. She said she doesn't want to see you tonight.",
    back_translation_zh: "她在后台。她说今晚不想见您。",
    change_type: "literal",
    is_major: false,
    rationale_zh: "信息句，直译分成两短句即可。",
    rationale_en: "Information line; literal, split for rhythm.",
    tags: [],
    syllables_est: 14,
  },
  [cannedKey("那就更要去了。")]: {
    literal_en: "Then I have even more reason to go.",
    text_en: "Then that's exactly where I'm going.",
    key_phrase_en: "exactly",
    back_translation_zh: "那我就偏要去那儿。",
    change_type: "rewrite",
    is_major: false,
    rationale_zh: "英语里“更要去”的逻辑用 exactly 落地，语气比直译的 even more reason 干脆。",
    rationale_en: "'Exactly' lands the defiance; 'even more reason to go' explains where this asserts.",
    tags: ["more_direct", "idiom"],
    syllables_est: 9,
  },

  // ---- Episode 4 · Scene 2 -------------------------------------------------
  [cannedKey("灯光倒数十秒。所有人就位。")]: {
    literal_en: "Lights count down ten seconds. Everyone in place.",
    text_en: "Lights in ten. Everyone in position.",
    key_phrase_en: "Lights in ten",
    back_translation_zh: "灯光十秒后。全员就位。",
    change_type: "cultural",
    is_major: false,
    rationale_zh: "Lights in ten 是美国后台口令的真实说法，瞬间建立她掌控全场的专业感。",
    rationale_en: "'Lights in ten' is the real backstage call — instantly reads as a professional running the show.",
    tags: ["idiom", "clarity"],
    syllables_est: 9,
  },
  [cannedKey("林晚。")]: {
    literal_en: "Lin Wan.",
    text_en: "Lin Wan.",
    back_translation_zh: null,
    change_type: "keep",
    is_major: false,
    rationale_zh: null,
    rationale_en: null,
    tags: [],
    syllables_est: 2,
  },
  [cannedKey("沈总，现在不是时候。")]: {
    literal_en: "President Shen, now is not the time.",
    text_en: "Mr. Shen, this is not the time.",
    key_phrase_en: "Mr. Shen",
    back_translation_zh: "沈先生，现在不是时候。",
    change_type: "cultural",
    is_major: false,
    rationale_zh: "她刻意用 Mr. Shen 保持距离（而不是叫名字），对应原文里“沈总”的疏离感。",
    rationale_en: "She keeps him at 'Mr. Shen' — the distance the title carries in the source.",
    tags: ["cultural_swap", "softened"],
    syllables_est: 8,
  },
  [cannedKey("等我上台，就来不及说了。")]: {
    literal_en: "Once I go on stage, it will be too late to say it.",
    text_en: "Once I'm on that stage, it'll be too late to say this.",
    key_phrase_en: "too late to say this",
    back_translation_zh: "等我站上那个台，再说这些就来不及了。",
    change_type: "tone",
    is_major: false,
    rationale_zh: "this/that 的指代让台词更具体：那座台、这句话，紧迫感更强。",
    rationale_en: "'That stage / say this' makes both concrete; the urgency lands harder.",
    tags: ["clarity", "more_emotional"],
    syllables_est: 13,
  },
  [cannedKey("那你就上台说。")]: {
    literal_en: "Then you go on stage and say it.",
    text_en: "Then say it from the stage.",
    key_phrase_en: "from the stage",
    back_translation_zh: "那你就在台上说。",
    change_type: "tighten",
    is_major: false,
    rationale_zh: "六个词保留她将军式的反击；from the stage 是英语里对“当众说”的标准指涉。",
    rationale_en: "Six words keep her checkmate; 'from the stage' is the idiom for saying it in public.",
    tone_note_zh: "反将一军，带一点挑衅的笑。",
    tone_note_en: "A dare, with the ghost of a smile.",
    tags: ["tighter", "more_direct"],
    syllables_est: 6,
    alternatives: [
      {
        text_en: "Then say it to everyone.",
        back_translation_zh: "那就当着所有人说。",
        rationale_zh: "把“台上”翻成“当众”，赌注感更明确。",
        rationale_en: "Trades the stage for everyone; makes going public the explicit stake.",
        tags: ["clarity", "more_direct"],
        syllables_est: 6,
      },
      {
        text_en: "You have a stage. Use it.",
        back_translation_zh: "台就在那儿，用它。",
        rationale_zh: "两个短句像下命令，她全程掌控节奏。",
        rationale_en: "Two clipped imperatives; she is running this exchange.",
        tags: ["tighter", "pacing"],
        syllables_est: 6,
      },
      {
        text_en: "Then go up there and say it in front of everyone.",
        back_translation_zh: "那就上台，当着所有人的面说。",
        rationale_zh: "最完整直白的一版，节奏放慢，适合配慢镜头。",
        rationale_en: "The fullest, plainest read; slower rhythm, plays well over a lingering shot.",
        tags: ["clarity", "more_emotional"],
        syllables_est: 12,
      },
    ],
  },
  [cannedKey("……好。")]: {
    literal_en: "...Okay.",
    text_en: "...Okay.",
    back_translation_zh: null,
    change_type: "keep",
    is_major: false,
    rationale_zh: null,
    rationale_en: null,
    tags: [],
    syllables_est: 2,
  },
};

/** The founder's-footage entries (canned-user.ts), normalized once. */
const USER_BANK: Record<string, CannedLine> = Object.fromEntries(
  USER_LINES.map((u) => [cannedKey(u.zh), u.line])
);
const USER_CTX: Record<string, CannedContext> = Object.fromEntries(
  USER_CONTEXTS.map((u) => [cannedKey(u.firstLineZh), { context_zh: u.context_zh, context_en: u.context_en }])
);

export function cannedLine(zh: string): CannedLine | null {
  const key = cannedKey(zh);
  return BANK[key] ?? USER_BANK[key] ?? null;
}

/** The bank's own alternatives for a line (the supplement in ./canned-extra
 * is merged by lib/demo-replay.ts, which also appends the literal fallback). */
export function cannedAlternatives(zh: string): NonNullable<CannedLine["alternatives"]> {
  const key = cannedKey(zh);
  return (BANK[key] ?? USER_BANK[key])?.alternatives ?? [];
}

export function cannedContext(firstLineZh: string): CannedContext | null {
  const key = cannedKey(firstLineZh);
  return CONTEXTS[key] ?? USER_CTX[key] ?? null;
}
