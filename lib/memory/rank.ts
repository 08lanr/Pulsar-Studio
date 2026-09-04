// One similarity measure for every retrieval corpus (approved memory, house
// exemplars, Tatoeba): IDF-weighted character-bigram cosine over the Chinese
// source. Plain bigram Dice matched on shared function characters (我 / 是 /
// 的 / 了) and returned "We're going to paint the wall" for 咱们准备开始汇报;
// weighting each bigram by how rare it is in the corpus makes a match mean
// something. Scores are in [0, 1]; 1 is an exact normalized match.

export function normalizeZh(text: string): string {
  return text.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
}

export function bigrams(normalized: string): Set<string> {
  const out = new Set<string>();
  if (normalized.length < 2) {
    if (normalized) out.add(normalized);
    return out;
  }
  for (let i = 0; i < normalized.length - 1; i++) out.add(normalized.slice(i, i + 2));
  return out;
}

type Indexed<T> = { item: T; normalized: string; grams: Set<string>; norm: number };

export type Hit<T> = { item: T; score: number };

/**
 * A corpus indexed once (inverted bigram index + IDF weights). Build per
 * corpus at module load; query per scene.
 */
export class BigramIndex<T> {
  private readonly docs: Indexed<T>[] = [];
  private readonly postings = new Map<string, number[]>();
  private readonly idf = new Map<string, number>();

  constructor(items: T[], text: (item: T) => string) {
    for (const item of items) {
      const normalized = normalizeZh(text(item));
      const grams = bigrams(normalized);
      this.docs.push({ item, normalized, grams, norm: 0 });
      for (const g of grams) {
        const list = this.postings.get(g);
        if (list) list.push(this.docs.length - 1);
        else this.postings.set(g, [this.docs.length - 1]);
      }
    }
    const n = this.docs.length;
    for (const [g, list] of this.postings) this.idf.set(g, Math.log((n + 1) / (list.length + 1)) + 1);
    for (const doc of this.docs) doc.norm = Math.sqrt([...doc.grams].reduce((s, g) => s + this.weight(g) ** 2, 0));
  }

  get size(): number {
    return this.docs.length;
  }

  private weight(gram: string): number {
    // Unseen grams (query-only) get the rarest possible weight.
    return this.idf.get(gram) ?? Math.log(this.docs.length + 1) + 1;
  }

  /** Best-scoring documents for ONE query string. */
  queryOne(text: string, limit: number, minScore: number): Hit<T>[] {
    const normalized = normalizeZh(text);
    const grams = bigrams(normalized);
    if (!grams.size) return [];
    const qNorm = Math.sqrt([...grams].reduce((s, g) => s + this.weight(g) ** 2, 0));
    const acc = new Map<number, number>();
    for (const g of grams) {
      const w = this.weight(g) ** 2;
      for (const idx of this.postings.get(g) ?? []) acc.set(idx, (acc.get(idx) ?? 0) + w);
    }
    const hits: Hit<T>[] = [];
    for (const [idx, dot] of acc) {
      const doc = this.docs[idx];
      const score = doc.normalized === normalized ? 1 : dot / (qNorm * doc.norm || 1);
      if (score >= minScore) hits.push({ item: doc.item, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /**
   * Best documents across MANY query strings (a scene): each document keeps
   * its best score over the queries; ties break on corpus order.
   */
  query(texts: string[], limit: number, minScore: number): Hit<T>[] {
    const best = new Map<T, number>();
    for (const text of texts) {
      for (const hit of this.queryOne(text, limit * 2, minScore)) {
        const prev = best.get(hit.item);
        if (prev === undefined || hit.score > prev) best.set(hit.item, hit.score);
      }
    }
    return [...best]
      .map(([item, score]) => ({ item, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
