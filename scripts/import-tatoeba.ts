import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ReferenceTranslationMemoryExample } from "../lib/types";

type TatoebaSentence = {
  id: number;
  text: string;
  lang: string;
  script: string | null;
  license: string;
  owner: string | null;
  is_unapproved: boolean;
  translations: Array<{
    id: number;
    text: string;
    lang: string;
    license: string;
    owner: string | null;
    is_unapproved: boolean;
    is_direct: boolean;
  }>;
};

type TatoebaPage = {
  data: TatoebaSentence[];
  paging: { has_next: boolean; next: string | null; total?: number };
};

const licenses = new Set(["CC BY 2.0 FR", "CC0 1.0"]);
const endpoint = new URL("https://api.tatoeba.org/v1/sentences");
for (const [key, value] of Object.entries({
  lang: "cmn",
  is_native: "yes",
  is_unapproved: "no",
  is_orphan: "no",
  "trans:lang": "eng",
  "trans:is_direct": "yes",
  "trans:is_native": "yes",
  "trans:is_unapproved": "no",
  "trans:is_orphan": "no",
  sort: "words",
  limit: "500",
})) endpoint.searchParams.set(key, value);

function isDialogueSized(textZh: string, textEn: string): boolean {
  const zh = textZh.trim();
  const en = textEn.trim();
  const englishWords = en.split(/\s+/u).filter(Boolean).length;
  return (
    zh.length >= 2 &&
    zh.length <= 60 &&
    en.length >= 1 &&
    en.length <= 180 &&
    englishWords <= 28 &&
    /\p{Script=Han}/u.test(zh) &&
    /[A-Za-z]/u.test(en) &&
    !/[\r\n\t]/u.test(zh + en) &&
    !/https?:\/\/|www\.|@\w+\.\w+/iu.test(zh + en)
  );
}

async function fetchPage(url: string): Promise<TatoebaPage> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "Pulsar-Studio translation-memory importer" },
      });
      if (!response.ok) throw new Error(`Tatoeba returned ${response.status}: ${await response.text()}`);
      return (await response.json()) as TatoebaPage;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1_000));
    }
  }
  throw lastError;
}

async function main() {
  const rows: ReferenceTranslationMemoryExample[] = [];
  const seen = new Set<string>();
  let next: string | null = endpoint.toString();
  let pages = 0;
  let available = 0;
  let fetched = 0;

  while (next) {
    const page: TatoebaPage = await fetchPage(next);
    pages++;
    fetched += page.data.length;
    if (typeof page.paging.total === "number") available = page.paging.total;
    for (const source of page.data) {
      if (source.lang !== "cmn" || source.script !== "Hans" || !source.owner || !licenses.has(source.license)) continue;
      const translations = source.translations
        .filter(
          (translation) =>
            translation.lang === "eng" &&
            translation.is_direct &&
            !translation.is_unapproved &&
            !!translation.owner &&
            licenses.has(translation.license) &&
            isDialogueSized(source.text, translation.text)
        )
        .sort((a, b) => a.id - b.id);

      for (const translation of translations.slice(0, 2)) {
        const key = `${source.text.trim()}\u0000${translation.text.trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          source: "tatoeba",
          source_sentence_id: source.id,
          translation_sentence_id: translation.id,
          source_owner: source.owner,
          translation_owner: translation.owner!,
          source_license: source.license as ReferenceTranslationMemoryExample["source_license"],
          translation_license: translation.license as ReferenceTranslationMemoryExample["translation_license"],
          text_zh: source.text.trim(),
          text_en: translation.text.trim(),
        });
      }
    }
    next = page.paging.has_next ? page.paging.next : null;
    process.stdout.write(`\rFetched ${fetched}/${available || "?"}; kept ${rows.length}`);
  }

  rows.sort(
    (a, b) =>
      a.source_sentence_id - b.source_sentence_id || a.translation_sentence_id - b.translation_sentence_id
  );
  const output = {
    metadata: {
      source: "Tatoeba",
      generated_at: new Date().toISOString(),
      api_query: endpoint.toString(),
      license: "CC BY 2.0 FR or CC0 1.0 per sentence",
    },
    rows,
  };
  const outputPath = resolve(process.cwd(), "data/reference/tatoeba-cmn-eng.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output), "utf8");
  process.stdout.write(`\nWrote ${rows.length} attributed pairs to ${outputPath}\n`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
