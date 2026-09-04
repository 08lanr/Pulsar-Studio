// The knowledge layer (lib/memory): IDF-weighted matching, the house exemplar
// bank, the register guide, CC-CEDICT glosses, and how they assemble into
// prompt blocks after the cached system blocks.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { BigramIndex } from "@/lib/memory/rank";
import { houseExemplarBlock, houseExemplarCount, rankHouseExemplars } from "@/lib/memory/house-style";
import { IDIOMS, idiomBlock, matchIdioms } from "@/lib/memory/idioms";
import { findGlosses, glossBlock, glossCount } from "@/lib/memory/glosses";
import { gatherKnowledge } from "@/lib/memory";
import { parseCedict } from "@/scripts/import-cedict";
import { buildFirstPass } from "@/lib/prompts/first-pass";
import { buildAlternatives } from "@/lib/prompts/alternatives";
import { ingestEpisodeFile } from "@/lib/ingest";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { producer, seedMinute } from "./seed-minute";

afterEach(() => resetFixtureStore());

const demoLines = () => {
  const srt = readFileSync(path.join(process.cwd(), "docs", "demo", "xiangyuan-ep1.srt"));
  return ingestEpisodeFile(new Uint8Array(srt), "xiangyuan-ep1.srt").lines.map((l) => ({
    text_zh: l.text_zh,
    speaker: l.speaker ?? null,
  }));
};

test("IDF weighting stops function characters from making a match", () => {
  const docs = ["我们准备刷墙。", "我去上大学。", "他在路上。", "咱们准备开始汇报吧。", "我也没办法。"];
  const index = new BigramIndex(docs, (d) => d);
  const paint = index.queryOne("咱们准备开始汇报", 5, 0)[0];
  assert.equal(paint.item, "咱们准备开始汇报吧。");
  assert.ok(paint.score > 0.8, `near-exact scores high (${paint.score})`);
  const wall = index.queryOne("咱们准备开始汇报", 5, 0).find((h) => h.item === "我们准备刷墙。");
  assert.ok(!wall || wall.score < 0.3, `shared 准备 alone scores low (${wall?.score})`);
  assert.equal(index.queryOne("我去上海开过会", 5, 0.5).length, 0, "'I go to university' does not clear a real threshold");
  assert.equal(index.queryOne("我也没办法呀", 1, 0.5)[0]?.item, "我也没办法。");
});

test("the house bank is a real exemplar corpus and retrieval shows the move, not just the line", () => {
  assert.ok(houseExemplarCount() >= 30, `bank has ${houseExemplarCount()} adapted lines`);
  const hits = rankHouseExemplars([{ text_zh: "路上有点堵车" }]);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].text_zh, "路上有点堵车");
  const block = houseExemplarBlock(hits) ?? "";
  assert.match(block, /HOUSE EXEMPLARS/);
  assert.match(block, /studio:/);
  assert.match(block, /never import a name/i);
  assert.deepEqual(rankHouseExemplars([{ text_zh: "量子力学的基本原理" }]), [], "no match, no noise");
});

test("the register guide matches set phrases by containment and never inside other words", () => {
  const hits = matchIdioms(["不好意思 杨总", "久仰 杨总", "咱们准备开始汇报", "谁让我们是祖孙呢"]);
  const heads = hits.map((e) => e.zh[0]);
  assert.ok(heads.includes("不好意思"));
  assert.ok(heads.includes("久仰"));
  assert.ok(heads.includes("汇报"));
  assert.ok(heads.includes("谁让"));
  assert.ok(heads.includes("总"), "X总 forms of address are covered");
  // Single-character forms only fire as a whole line: 是 inside 是吗 must not.
  const yes = matchIdioms(["是"]).map((e) => e.zh[0]);
  assert.ok(yes.includes("是"));
  const isIt = matchIdioms(["是吗"]).map((e) => e.zh[0]);
  assert.ok(!isIt.includes("是") && isIt.includes("是吗"));
  const block = idiomBlock(hits.slice(0, 2)) ?? "";
  assert.match(block, /SET PHRASES/);
  assert.match(block, /most common first/);
  // Every entry is well-formed.
  for (const e of IDIOMS) {
    assert.ok(e.zh.length && e.en.length && e.en.length <= 4 && e.note.length > 10, e.zh[0]);
  }
});

test("CC-CEDICT slice keeps idioms, marked usages and set phrases, drops proper nouns and jargon", async () => {
  const sample = [
    "# comment",
    "久仰 久仰 [jiu3 yang3] /honorific: I've long looked forward to meeting you./It's an honor to meet you at last./",
    "年輕有為 年轻有为 [nian2 qing1 you3 wei2] /young and promising/",
    "無能為力 无能为力 [wu2 neng2 wei2 li4] /(idiom) powerless to do anything about it/",
    "遙控器 遥控器 [yao2 kong4 qi4] /a remote control/",
    "生長率 生长率 [sheng1 zhang3 lu:4] /growth rate/",
    "北京 北京 [Bei3 jing1] /Beijing, capital of People's Republic of China/",
    "王 王 [Wang2] /surname Wang/",
    "演繹法 演绎法 [yan3 yi4 fa3] /deductive reasoning/",
    "沒轍 没辄 [mei2 zhe2] /(coll.) at one's wit's end/",
  ].join("\n");
  const rows = parseCedict(sample);
  const zh = rows.map((r) => r.zh);
  assert.deepEqual(zh.sort(), ["久仰", "年轻有为", "无能为力", "没辄"].sort());
  assert.ok(rows.find((r) => r.zh === "久仰")!.en[0].startsWith("honorific"));

  assert.ok((await glossCount()) >= 8_000, "bundled slice is substantial");
  const glosses = await findGlosses(["久仰 杨总", "我们向部长年轻有为", "我也没办法呀"]);
  const heads = glosses.map((g) => g.zh);
  assert.ok(heads.includes("久仰"));
  assert.ok(heads.includes("年轻有为"));
  const skipped = await findGlosses(["久仰 杨总"], { skip: new Set(["久仰"]) });
  assert.ok(!skipped.some((g) => g.zh === "久仰"), "the register guide's phrases are not glossed twice");
  assert.match(glossBlock(glosses) ?? "", /meaning only/i);
});

test("gatherKnowledge assembles blocks in authority order and reports counts", async () => {
  const t = await seedMinute();
  const approved = await fixtureData.listApprovedTranslationMemory(producer(), t.id);
  const k = await gatherKnowledge(demoLines(), { approvedMemory: approved, titleId: t.id });
  assert.equal(k.counts.approved, 0, "fresh seed has no approvals yet");
  assert.ok(k.counts.house >= 1, "the founder's minute IS in the house bank");
  assert.ok(k.counts.idioms >= 5);
  assert.ok(k.counts.glosses >= 2);
  assert.ok(k.counts.reference <= 3);
  const order = k.blocks.map((b) => b.text.split("\n")[0]);
  const expected = ["HOUSE EXEMPLARS", "SET PHRASES", "DICTIONARY GLOSSES", "REFERENCE PAIRS"];
  let cursor = 0;
  for (const head of order) {
    const idx = expected.findIndex((e, i) => i >= cursor && head.startsWith(e));
    assert.ok(idx >= 0, `unexpected or out-of-order block: ${head}`);
    cursor = idx;
  }
  assert.ok(k.blocks.every((b) => !b.cache), "knowledge blocks are never cache breakpoints");
  assert.ok(k.fingerprint.length > 10);
});

test("knowledge sits after the cached system blocks in every writing prompt", async () => {
  const k = await gatherKnowledge([{ text_zh: "久仰 杨总", speaker: "向园" }], { reference: false });
  const bible = { text: "BIBLE", cache: true };
  const fp = buildFirstPass({
    bible,
    episode_number: 1,
    scene: { number: 1, start_ms: 0, end_ms: 1000, context_zh: null, context_en: null },
    lines: [{ seq: 1, speaker: "向园", text_zh: "久仰 杨总", start_ms: 0, end_ms: 1000 }],
    previous_tail: [],
    has_timecodes: true,
    knowledge: k.blocks,
  });
  const cached = fp.system.map((b, i) => (b.cache ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(cached, [0, 1], "bible and rules are the only cache breakpoints");
  assert.ok(fp.system.length > 2 && fp.system.slice(2).every((b) => !b.cache));
  assert.ok(fp.system.slice(2).some((b) => /^SET PHRASES/.test(b.text)), "the register guide rides along");

  const alt = buildAlternatives({
    bible,
    episode_number: 1,
    scene: { number: 1, context_zh: null, context_en: null },
    line: { seq: 1, speaker: "向园", text_zh: "久仰 杨总", text_en: "Heard a lot about you, Mr. Yang.", start_ms: 0, end_ms: 1000, literal_en: null, current_rationale_en: null },
    around: [],
    existing_en: [],
    producer_note: null,
    knowledge: k.blocks,
  });
  assert.equal(alt.system.length, 2 + k.blocks.length);
});
