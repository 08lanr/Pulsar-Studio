// Step 3 of the native-Chinese pass: check DeepSeek's rewrites and write the
// ones that pass into locales/_keys/*.json (zh only). Then run
// `node scripts/merge-locales.mjs`.
//
//   npx tsx scripts/zh-native/apply.ts            # report only
//   npx tsx scripts/zh-native/apply.ts --write    # report and write
//
// A rewrite is rejected (current Chinese kept) when it
//   - changes the set of {placeholders},
//   - drops a brand or unit that the English carries (TikTok, ReelShort, …),
//   - loses a required qualifier (TikTok before 收入/观众, 广告 before 花费/点击率/结果, 美国),
//   - is empty, contains half-width ASCII punctuation the rules forbid, or
//   - grows past 1.6× the current length (UI columns are fixed).
// Everything is written to tmp/zh-native/report.md for review, including
// DeepSeek's per-batch analysis.

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const work = path.join(root, "tmp", "zh-native");
const outDir = path.join(work, "out");
const keyDir = path.join(root, "locales", "_keys");
const write = process.argv.includes("--write");

type Entry = { key: string; en: string; zh: string; file: string; refs: string[] };
type Item = { key: string; zh: string; changed: boolean; note: string };
type BatchOut = { file: string; analysis: string; items: Item[] };

const entries = new Map<string, Entry>((JSON.parse(fs.readFileSync(path.join(work, "keys.json"), "utf8")) as Entry[]).map((e) => [e.key, e]));

const BRANDS = ["TikTok", "ReelShort", "DramaBox", "YouTube", "Meta", "Pulsar", "Grow", "CSV", "USD", "UTC", "LTV", "ROAS", "CPM", "CPC", "CPA", "SRT", "VTT", "URL"];
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

function problems(e: Entry, zh: string): string[] {
  const out: string[] = [];
  const t = zh.trim();
  if (!t) out.push("empty");
  if (placeholders(t) !== placeholders(e.en)) out.push(`placeholders ${placeholders(e.en) || "-"} → ${placeholders(t) || "-"}`);
  for (const b of BRANDS) if (e.en.includes(b) && !t.includes(b) && !(b === "USD" && /美元/.test(t))) out.push(`dropped ${b}`);
  // Qualifier rules from docs/terminology.md.
  if (/\b(earnings|revenue)\b/i.test(e.en) && /收入/.test(t) && !/TikTok/.test(t) && /TikTok/.test(e.en)) out.push("收入 without TikTok");
  if (/\bviewers?\b/i.test(e.en) && /观众/.test(t) && /TikTok/.test(e.en) && !/TikTok/.test(t)) out.push("观众 without TikTok");
  if (/\bad (spend|ctr|results)\b/i.test(e.en) && /(花费|点击率|结果)/.test(t) && !/广告/.test(t)) out.push("花费/点击率/结果 without 广告");
  if (/\bUS\b/.test(e.en) && /美国/.test(e.zh) && !/美国/.test(t)) out.push("dropped 美国");
  if (/[一-鿿][,;:?!()]|[,;:?!()][一-鿿]/.test(t)) out.push("half-width punctuation next to CJK");
  if (t.length > Math.max(6, e.zh.length * 1.6)) out.push(`too long (${t.length} vs ${e.zh.length})`);
  if (/您/.test(t)) out.push("uses 您");
  return out;
}

const batches: BatchOut[] = fs
  .readdirSync(outDir)
  .filter((n) => n.endsWith(".json"))
  .sort()
  .map((n) => JSON.parse(fs.readFileSync(path.join(outDir, n), "utf8")) as BatchOut);

// The human review: keys to keep as they are, and final wordings that win
// over both DeepSeek and the automatic checks.
const review = JSON.parse(fs.readFileSync(path.join(root, "scripts", "zh-native", "review.json"), "utf8")) as { reject: string[]; set: Record<string, string> };
const rejectSet = new Set(review.reject);

const accepted = new Map<string, Item>();
const rejected: { key: string; zh: string; why: string[]; note: string }[] = [];
let unchanged = 0;
for (const b of batches) {
  for (const it of b.items) {
    const e = entries.get(it.key);
    if (!e) continue;
    if (review.set[it.key] !== undefined) continue;
    const zh = it.zh.trim();
    if (!it.changed || zh === e.zh) {
      unchanged += 1;
      continue;
    }
    if (rejectSet.has(it.key)) {
      rejected.push({ key: it.key, zh, why: ["human review: kept current wording"], note: it.note });
      continue;
    }
    const why = problems(e, zh);
    if (why.length) rejected.push({ key: it.key, zh, why, note: it.note });
    else accepted.set(it.key, { ...it, zh });
  }
}
for (const [key, zh] of Object.entries(review.set)) {
  const e = entries.get(key);
  if (!e) continue;
  if (placeholders(zh) !== placeholders(e.en)) throw new Error(`review.set ${key}: placeholders differ`);
  if (zh !== e.zh) accepted.set(key, { key, zh, changed: true, note: "human review: final wording" });
}

const covered = new Set(batches.flatMap((b) => b.items.map((i) => i.key)));
const missing = [...entries.keys()].filter((k) => !covered.has(k));

const lines: string[] = [];
lines.push(`# Native-Chinese pass — DeepSeek review (${new Date().toISOString().slice(0, 10)})`, "");
lines.push(`Scope ${entries.size} keys · batches ${batches.length} · rewritten ${accepted.size} · kept as is ${unchanged} · rejected by checks ${rejected.length} · not covered ${missing.length}`, "");
lines.push("## DeepSeek's analysis per batch", "");
for (const b of batches) lines.push(`- **${b.file}** — ${b.analysis.replace(/\s+/g, " ")}`);
lines.push("", "## Rejected by the checks (current Chinese kept)", "");
for (const r of rejected) lines.push(`- \`${r.key}\` → ${r.zh}  \n  ${r.why.join("; ")} · ${r.note}`);
if (missing.length) lines.push("", "## Not covered", "", ...missing.map((k) => `- \`${k}\``));
lines.push("", "## Accepted rewrites", "");
for (const [k, it] of accepted) lines.push(`- \`${k}\`  \n  was: ${entries.get(k)!.zh}  \n  now: ${it.zh}  \n  ${it.note}`);
fs.writeFileSync(path.join(work, "report.md"), lines.join("\n"));
console.log(lines[2]);
console.log(`report: tmp/zh-native/report.md`);

if (write) {
  const byFile = new Map<string, Map<string, string>>();
  for (const [k, it] of accepted) {
    const f = entries.get(k)!.file;
    if (!byFile.has(f)) byFile.set(f, new Map());
    byFile.get(f)!.set(k, it.zh);
  }
  for (const [file, map] of byFile) {
    const p = path.join(keyDir, file);
    const json = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, { en: string; zh: string }>;
    for (const [k, zh] of map) if (json[k]) json[k].zh = zh;
    // Keep the one-entry-per-line shape the key files use.
    const body = Object.entries(json)
      .map(([k, v]) => `  ${JSON.stringify(k)}: { "en": ${JSON.stringify(v.en)}, "zh": ${JSON.stringify(v.zh)} }`)
      .join(",\n");
    fs.writeFileSync(p, `{\n${body}\n}\n`);
    console.log(`wrote ${map.size} → ${file}`);
  }
}
