// Refresh data/reference/cedict-phrases.json from CC-CEDICT (MDBG's export,
// CC BY-SA 4.0). We keep the slice a dialogue adapter needs — set phrases,
// idioms/chengyu, colloquialisms, honorifics, interjections and multi-character
// terms — and drop proper nouns and technical vocabulary. Glosses are dictionary
// MEANING, never register: the prompt says so.
//
//   npm run memory:import:cedict

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export type CedictRow = { zh: string; py: string; en: string[] };

const SOURCE = "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz";

const LINE = /^(\S+) (\S+) \[([^\]]*)\] \/(.+)\/\s*$/;
// Register/usage markers CC-CEDICT writes either as "(idiom)" or as a bare
// "honorific:" / "polite:" prefix. Any of these earns an entry a place
// regardless of length.
const KEEP_MARKERS =
  /\((?:idiom|coll\.|slang|fig\.|polite|honorific|courteous|humble|derog\.|interj\.|onom\.|dialect|lit\. and fig\.|Internet slang|neologism|euphemism|proverb|saying|expression)|\b(?:honorific|polite|humble|courteous|derogatory|colloquial|euphemism|saying|proverb|expression|interjection|exclamation|greeting|formula)\b/i;
const DROP_MARKERS =
  /\((?:chemistry|computing|biology|medicine|math\.|physics|botany|zoology|geology|astronomy|linguistics|electricity|electronics|anatomy|pharmacology|mineralogy|statistics|engineering|military|Buddhism|Taoism|archaic|literary|bird species|plant species|fish species|insect species|mammal species|species of)|\b(?:Taiwan pr\.|variant of|old variant of|erhua variant|see \S+|abbr\. for)\b/i;
const PROPER_NOUN = /\b(?:surname|given name|\(name\)|county|city|province|prefecture|district|township|river|mountain|dynasty|kingdom|island|lake|company|corporation|university|brand)\b/i;

/** Pure filter so a test can pin the slice. */
export function parseCedict(text: string): CedictRow[] {
  const rows: CedictRow[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.startsWith("#")) continue;
    const m = LINE.exec(raw);
    if (!m) continue;
    const [, , simp, py, defsRaw] = m;
    if (!/^\p{Script=Han}+$/u.test(simp) || simp.length < 2 || simp.length > 8) continue;
    const defs = defsRaw.split("/").map((d) => d.trim()).filter(Boolean);
    if (!defs.length) continue;
    const joined = defs.join(" / ");
    if (PROPER_NOUN.test(joined)) continue;
    if (defs.every((d) => /^[A-Z]/.test(d) && !/^(?:I|I'm|I've|I'll|It's|It|We|You|Let|Don't|Do|Did|What|Why|How|Who|Where|When)\b/.test(d))) continue;
    const marked = KEEP_MARKERS.test(joined);
    if (DROP_MARKERS.test(joined) && !marked) continue;
    // Unmarked entries earn a place only when shaped like a set phrase
    // (four or more characters); shorter unmarked entries are ordinary
    // vocabulary the model already knows (遥控器, 生长率).
    if (!marked && simp.length < 4) continue;
    const kept = defs.filter((d) => !/^(?:CL:|see also|also written|also pr\.)/i.test(d)).slice(0, 3);
    if (!kept.length) continue;
    if (seen.has(simp)) continue;
    seen.add(simp);
    rows.push({ zh: simp, py, en: kept });
  }
  rows.sort((a, b) => a.zh.localeCompare(b.zh, "zh-Hans-CN"));
  return rows;
}

async function main() {
  const response = await fetch(SOURCE, { headers: { "user-agent": "Pulsar-Studio glossary importer" } });
  if (!response.ok) throw new Error(`MDBG returned ${response.status}`);
  const text = gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
  const rows = parseCedict(text);
  const output = {
    metadata: {
      source: "CC-CEDICT (MDBG export)",
      source_url: SOURCE,
      generated_at: new Date().toISOString(),
      license: "CC BY-SA 4.0",
      license_url: "https://creativecommons.org/licenses/by-sa/4.0/",
      note: "Filtered to set phrases, idioms, colloquialisms, honorifics and multi-character terms; proper nouns and technical fields dropped.",
    },
    rows,
  };
  const outputPath = resolve(process.cwd(), "data/reference/cedict-phrases.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output), "utf8");
  process.stdout.write(`Wrote ${rows.length} entries to ${outputPath}\n`);
}

if (process.argv[1] && /import-cedict/.test(process.argv[1])) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
