# Licensed reference data for the writing passes

Generated, server-only corpora that `lib/memory` retrieves from during the
first pass, alternatives and rewrites. Both are deliberately LOWER authority
than producer-approved Pulsar translation memory and the Pulsar-authored
register guide (`lib/memory/idioms.ts`) and house exemplars
(`lib/memory/house-style.ts`); see `docs/decisions.md` (2026-09-04, "Training
the translator") for the authority order and what each source is allowed to
teach the model.

## `cedict-phrases.json` — CC-CEDICT glosses

Refresh with `npm run memory:import:cedict`. Source: MDBG's CC-CEDICT export,
licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
The importer (`scripts/import-cedict.ts`) keeps only the slice a dialogue
adapter needs:

- entries marked as idioms, colloquialisms, slang, honorifics, polite or humble
  forms, interjections, proverbs and sayings, at any length;
- unmarked entries of four or more characters (set phrases and chengyu);
- and drops proper nouns, species names and technical fields.

Each row keeps the simplified headword, pinyin and up to three glosses. The
prompt block presents them as **meaning only**: they say what the Chinese
means, never how an American series says it. If the corpus is copied or
redistributed, the CC BY-SA attribution and share-alike terms travel with it.

## `tatoeba-cmn-eng.json` — Tatoeba sentence pairs

Refresh with `npm run memory:import:tatoeba` from the official public Tatoeba
API. The importer keeps only Simplified Chinese sources with direct English
translations, approved and non-orphaned on both sides, owned by self-identified
native speakers on both sides, and dialogue-sized.

Each row retains both sentence IDs, both contributor usernames and both
licenses ([CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/deed.en)
or [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)). Attribution
pages: `https://tatoeba.org/en/sentences/show/{id}`.

Retrieval uses this corpus only for **near-identical** source lines (IDF-weighted
bigram cosine ≥ 0.55, at most three per scene): its English is learner-textbook
register, which is the wrong model for an American rewrite, so a loose match is
noise rather than help. It is a retrieval aid for checking meaning, not an
approved translation, style guide or source of story facts.
