// Step 2 of the native-Chinese pass: ask DeepSeek to rewrite the producer
// portal's Chinese as a native product writer would, and to explain what was
// wrong with the current wording.
//
//   npx tsx scripts/zh-native/run.ts glossary    # one call: the canonical term list
//   npx tsx scripts/zh-native/run.ts translate   # one call per batch, resumable
//
// Reads DEEPSEEK_API_KEY (and optional DEEPSEEK_BASE_URL / ZH_NATIVE_MODEL)
// from .env.local. This is developer tooling, not an app path: nothing here
// writes to locales/ or studio.jobs. Outputs land under tmp/zh-native/.

import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

const root = process.cwd();
const work = path.join(root, "tmp", "zh-native");
const outDir = path.join(work, "out");

function loadEnv(): void {
  const p = path.join(root, ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#") && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();
if (!process.env.DEEPSEEK_API_KEY) {
  console.error("DEEPSEEK_API_KEY is not set (put it in .env.local)");
  process.exit(1);
}
const client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com", maxRetries: 3, timeout: 5 * 60 * 1000 });
const MODEL = process.env.ZH_NATIVE_MODEL || "deepseek-chat";

type Entry = { key: string; en: string; zh: string; file: string; refs: string[] };
const entries: Entry[] = JSON.parse(fs.readFileSync(path.join(work, "keys.json"), "utf8"));

const PRODUCT_BRIEF = `产品背景：Pulsar Studio 是一个面向中国短剧（微短剧）制片公司的「美国发行工作台」。制片方登录后可以：
- 「我的剧库」：管理自己的剧集（作品），看每部剧在 TikTok 上的状态、广告状态、美国发行优先级评分；
- 「广告活动」：为一部剧发起一轮美国投放测试（六步：准备 → 选择广告 → 批准广告 → 批准预算 → 提交投放 → 查看广告结果），投放由 Pulsar 团队通过 Grow 系统执行；目前是演示环境，提交只是模拟交接，不会真的花钱；
- 「TikTok 表现」：各剧在 TikTok 上的收入、观众、付费转化、留存、广告归因；
- 「美国市场」：公开平台（ReelShort、DramaBox）榜单研究、题材分析、下一部拍什么、数据来源与定义；
- 「素材」：分集视频、字幕上传与英文字幕改编（对白改写为美式表达，制片方逐行审阅并定稿）；
- 「公司与账户」：公司资料、账户记录、报表导入、模拟推演。
数据严谨性是产品的核心：每个数字都带有证据标签（实测 / 推断 / 估算 / 合作方上报），未观测的值显示为「暂无」而不是 0，演示数据必须标明是演示。评分是「优先级」，不是成功概率。`;

const STYLE_RULES = `写作要求（必须遵守）：
1. 简体中文，读者是国内短剧制片公司的发行/运营负责人。语气像成熟的国内 SaaS 后台（巨量引擎、抖音精选联盟、快手磁力、飞书）：专业、简洁、自然，用「你」不用「您」，不卑不亢，不堆砌客套。
2. 不要英文直译的句式（例如「打开其下一步操作」「没有什么在等你」）。先理解英文的意思，再用中国产品经理会写的说法重写。能删的字删掉。
3. 控件类型决定形式：按钮 = 动宾短语（新建广告活动 / 查看结果 / 提交），表头与标签 = 名词短语（不加句号），提示与空状态 = 完整短句（可用句号），标题 = 短名词短语。
4. 占位符 {name} 必须原样保留，个数与名称不能变，也不能新增。品牌与专有名词保留英文：TikTok、ReelShort、DramaBox、YouTube、Meta、Pulsar、Studio、Grow、CSV、USD、UTC、LTV、ROAS、CPM、CPC、CPA、D7、D30、URL、SRT、VTT、ASS。CTR 可写成「点击率」。
5. 中文与英文、数字之间加半角空格（如「TikTok 收入」「近 30 天」「第 {n} 轮」）；中文标点用全角（，。：；？！（）「」）；数字、百分号、货币符号用半角。
6. 产品规则不能丢：「收入」「观众」前面一定带 TikTok；「花费」「点击率」「结果」前面一定带「广告」；涉及美国市场/授权/发行时保留「美国」；四种证据标签必须是四个可区分的固定译法，全程一致；「演示」「模拟」的提示不能弱化；「不代表成功概率」「未观测不等于 0」这类严谨性表述必须保留。
7. UI 空间有限：译文长度不要超过当前中文的 1.3 倍；表头、按钮、导航尽量不超过 8 个字；不要为了礼貌加字。
8. 术语全程一致：同一概念只能用一种说法（见术语表）。英文里同一个词在不同 key 里出现时，中文也要一致。
9. 只重写中文，不要改变含义、不要增删信息、不要臆测产品没有的功能。当前中文已经准确时可以保留（changed=false）。`;

function terminology(): string {
  const md = fs.readFileSync(path.join(root, "docs", "terminology.md"), "utf8");
  return md.split("## Where things live")[0];
}

async function json<T>(system: string, user: string): Promise<T> {
  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    temperature: 0.3,
    max_tokens: 8192,
  });
  const choice = res.choices[0];
  if (choice?.finish_reason === "length") throw new Error("response truncated at max_tokens; make the batch smaller");
  const text = choice?.message.content ?? "";
  try {
    return JSON.parse(text) as T;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`no JSON in response: ${text.slice(0, 200)}`);
    return JSON.parse(m[0]) as T;
  }
}

type Glossary = { terms: { concept_en: string; zh: string; why: string; avoid: string[] }[]; register_notes: string; problems_seen: string[] };

async function glossary(): Promise<void> {
  // Short labels are where terminology shows: every key whose English is at most five words.
  const seen = new Set<string>();
  const short = entries
    .filter((e) => e.en.split(/\s+/).length <= 4 && !seen.has(e.en.toLowerCase()) && seen.add(e.en.toLowerCase()))
    .map((e) => `${e.key}\t${e.en}\t${e.zh}`);
  const system = `你是一位有多年经验的中国互联网产品文案负责人，负责把一个面向中国短剧制片公司的 B2B 后台的中文界面改写成地道、专业的中文，让人感觉这个产品就是国内团队做的。\n\n${PRODUCT_BRIEF}\n\n${STYLE_RULES}`;
  const user = `第一步：先定术语表。下面是产品现有的术语对照（英文含义、当前中文、禁用词、说明），以及界面里所有较短的标签（key、英文、当前中文，制表符分隔）。请：
1. 给出一份规范术语表：产品核心概念的英文含义 → 唯一中文译法（成熟国内平台会用的说法），并说明为什么、以及应避免的写法。至少覆盖：作品/剧集/剧库、广告活动、投放轮次、六个步骤名、预算、花费、点击率、开场留存（hook hold）、基准/达标、TikTok 收入/观众/付费转化/留存/归因、美国发行优先级、评估构成、准备清单、素材、分集、字幕、定稿、审核/批准、四种证据标签（observed / inferred / estimated / partner_reported）、数据状态（available / collecting history / requires connection / manual / unavailable / stale / failed）、演示数据/演示结果、榜单、显著度（prominence）、题材（trope/story type）、新上架、增长、数据来源与定义。
2. 用 3–6 句话点评当前中文整体的问题（哪些地方一看就是翻译腔、哪些术语不统一、哪些说法国内平台不会这么说）。
3. 列出你在标签里看到的最典型的具体问题，最多 25 条，每条不超过 40 字。

篇幅控制：terms 不超过 60 条，每条 why 不超过 30 字、avoid 不超过 3 个；总输出控制在 4000 字以内。

只输出 JSON：{"terms":[{"concept_en":"","zh":"","why":"","avoid":[""]}],"register_notes":"","problems_seen":[""]}

=== 现有术语对照 ===
${terminology()}

=== 短标签 ===
${short.join("\n")}`;
  const g = await json<Glossary>(system, user);
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, "glossary.json"), JSON.stringify(g, null, 2));
  console.log(`glossary: ${g.terms.length} terms, ${g.problems_seen.length} problems noted`);
}

type Batch = { id: string; file: string; items: Entry[] };
type BatchOut = { analysis: string; items: { key: string; zh: string; changed: boolean; note: string }[] };

function batches(): Batch[] {
  const out: Batch[] = [];
  const byFile = new Map<string, Entry[]>();
  for (const e of entries) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
  for (const [file, list] of byFile) {
    const size = 30;
    for (let i = 0; i < list.length; i += size) out.push({ id: `${file.replace(/\.json$/, "")}-${String(i / size + 1).padStart(2, "0")}`, file, items: list.slice(i, i + size) });
  }
  return out;
}

async function translate(): Promise<void> {
  const g: Glossary = JSON.parse(fs.readFileSync(path.join(work, "glossary.json"), "utf8"));
  const terms = g.terms.map((t) => `- ${t.concept_en} → ${t.zh}${t.avoid.length ? `（不用：${t.avoid.join("、")}）` : ""}`).join("\n");
  const system = `你是一位有多年经验的中国互联网产品文案负责人，负责把一个面向中国短剧制片公司的 B2B 后台的中文界面改写成地道、专业的中文，让人感觉这个产品就是国内团队做的。\n\n${PRODUCT_BRIEF}\n\n${STYLE_RULES}\n\n规范术语表（必须遵守）：\n${terms}\n\n文风备注：${g.register_notes}`;
  fs.mkdirSync(outDir, { recursive: true });
  const all = batches();
  const todo = all.filter((b) => !fs.existsSync(path.join(outDir, `${b.id}.json`)));
  console.log(`${all.length} batches, ${todo.length} to run`);
  let done = 0;
  const workers = Array.from({ length: 4 }, async () => {
    for (;;) {
      const b = todo.shift();
      if (!b) return;
      const rows = b.items.map((e) => ({ key: e.key, en: e.en, zh_current: e.zh, where: e.refs.slice(0, 3).map((r) => r.replace(/^app\/\(producer\)\/producer\//, "").replace(/^components\/producer\//, "")).join(", ") }));
      const user = `请逐条重写下面这些界面文案的中文（key 说明它在哪个页面/控件上，where 是引用它的代码文件，en 是英文原意，zh_current 是当前中文）。每条给出最终中文 zh；如果当前中文已经地道且符合规范，changed=false 并原样返回。对每条改动用一句话说明 note（改了什么、为什么）。另外用 2–4 句话写 analysis：这一批文案在措辞上的主要问题。

只输出 JSON：{"analysis":"","items":[{"key":"","zh":"","changed":true,"note":""}]}

=== 文案 ===
${JSON.stringify(rows, null, 1)}`;
      try {
        const res = await json<BatchOut>(system, user);
        const got = new Map(res.items.map((i) => [i.key, i]));
        const missing = b.items.filter((e) => !got.has(e.key)).map((e) => e.key);
        if (missing.length) throw new Error(`batch ${b.id} missing ${missing.length} keys: ${missing.slice(0, 5).join(", ")}`);
        fs.writeFileSync(path.join(outDir, `${b.id}.json`), JSON.stringify({ file: b.file, analysis: res.analysis, items: b.items.map((e) => got.get(e.key)!) }, null, 2));
        done += 1;
        console.log(`✓ ${b.id} (${b.items.length}) · ${done} done`);
      } catch (e) {
        console.error(`✗ ${b.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
  });
  await Promise.all(workers);
}

const phase = process.argv[2];
if (phase === "glossary") glossary();
else if (phase === "translate") translate();
else {
  console.error("usage: tsx scripts/zh-native/run.ts glossary|translate");
  process.exit(1);
}
