// Dictionary glosses from CC-CEDICT for the set phrases, chengyu and
// multi-character terms that appear in a scene. Meaning only — the register
// guide (./idioms) and house exemplars carry HOW to say it. Loaded lazily so
// routes that never write a line do not pay for the file. Refresh with
// `npm run memory:import:cedict`; provenance in data/reference/README.md.

import type { CedictRow } from "@/scripts/import-cedict";

export type Gloss = CedictRow;

type Table = { byFirst: Map<string, Gloss[]>; size: number };
let table: Promise<Table> | null = null;

async function load(): Promise<Table> {
  if (table) return table;
  table = import("@/data/reference/cedict-phrases.json").then((mod) => {
    const rows = ((mod as { default?: { rows: Gloss[] } }).default ?? (mod as unknown as { rows: Gloss[] })).rows;
    const byFirst = new Map<string, Gloss[]>();
    for (const row of rows) {
      const list = byFirst.get(row.zh[0]);
      if (list) list.push(row);
      else byFirst.set(row.zh[0], [row]);
    }
    // Longest headword first so 久仰大名 wins over 久仰 at the same position.
    for (const list of byFirst.values()) list.sort((a, b) => b.zh.length - a.zh.length);
    return { byFirst, size: rows.length };
  });
  return table;
}

export async function glossCount(): Promise<number> {
  return (await load()).size;
}

/**
 * Every dictionary headword contained in the lines, longest match per
 * position, each headword once, at most `perLine` per line and `limit` in
 * total. `skip` lets the caller drop phrases the register guide already covers.
 */
export async function findGlosses(
  lines: string[],
  opts: { limit?: number; perLine?: number; skip?: Set<string> } = {}
): Promise<Gloss[]> {
  const { byFirst } = await load();
  const limit = opts.limit ?? 10;
  const perLine = opts.perLine ?? 3;
  const seen = new Set<string>();
  const out: Gloss[] = [];
  for (const line of lines) {
    let taken = 0;
    for (let i = 0; i < line.length && taken < perLine; i++) {
      const candidates = byFirst.get(line[i]);
      if (!candidates) continue;
      const hit = candidates.find((row) => line.startsWith(row.zh, i));
      if (!hit || seen.has(hit.zh) || opts.skip?.has(hit.zh)) continue;
      seen.add(hit.zh);
      out.push(hit);
      taken++;
      i += hit.zh.length - 1;
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function glossBlock(glosses: Gloss[]): string | null {
  if (!glosses.length) return null;
  const rows = glosses.map((g) => `- ${g.zh} (${g.py}): ${g.en.join("; ")}`);
  return `DICTIONARY GLOSSES (CC-CEDICT, meaning only)
Reference meanings for phrases in this scene. They tell you what the Chinese means, not how an American says it — write the line in the register the rules and exemplars describe.

${rows.join("\n")}`;
}
