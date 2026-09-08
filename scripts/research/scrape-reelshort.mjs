// ReelShort public catalog -> data/research/runs/<RUN_ID>/reelshort.json
//
// Sources (all public, unauthenticated, en locale):
//   /                       home: named shelves (TOP, New Release, Hidden
//                           Identity, ...) with 10 books each
//   /shelf/<slug>-<id>      a shelf; every page returns the whole list
//                           (client-side pagination, observed 2026-09-06)
//
// Per book we keep: ids, title, blurb, episode count, ReelShort's own theme
// tags, read_count (their "views" counter), collect_count (their saves
// counter), paid_start (the first paid episode), is_new, trailer flag,
// episode-1 duration. Nothing else. Each list records when it was read.
//
// Usage: node scripts/research/scrape-reelshort.mjs [--top-pages N]

import { fetchPageProps, log, nowIso, writeArtifact, writeFailure } from "./lib.mjs";

const BASE = "https://www.reelshort.com";
const TOP_SHELF = "top-short-movies-dramas-51002370";
const NEW_SHELF = "new-release-short-movies-dramas-51002369";
const args = process.argv.slice(2);
const topPages = Number(args[args.indexOf("--top-pages") + 1] || 17);

function trim(book) {
  return {
    book_id: book.book_id,
    t_book_id: book.t_book_id ?? null,
    title: book.book_title,
    blurb: book.special_desc ?? "",
    cover: book.book_pic ?? book.default_pic ?? null,
    episode_count: book.chapter_count ?? null,
    themes: (book.theme_list ?? []).map((t) => t.tag_name).filter(Boolean),
    primary_theme: Array.isArray(book.theme) ? book.theme[0] ?? null : null,
    read_count: book.read_count ?? null,
    collect_count: book.collect_count ?? null,
    paid_start: book.paid_start ?? null,
    is_new: book.is_new === 1,
    has_trailer: Boolean(book.have_trailer),
    ep1_duration_s: book.start_play?.duration ?? null,
    screen_mode: book.screen_mode ?? null,
  };
}

async function shelfPages(slug, pages) {
  const out = [];
  const seen = new Set();
  const fetched_at = nowIso();
  for (let p = 1; p <= pages; p++) {
    const url = p === 1 ? `${BASE}/shelf/${slug}` : `${BASE}/shelf/${slug}/${p}`;
    const pp = await fetchPageProps(url);
    if (!pp?.list) {
      log(`shelf ${slug} page ${p}: no list, stopping`);
      break;
    }
    const before = out.length;
    for (const book of pp.list) {
      if (seen.has(book.book_id)) continue;
      seen.add(book.book_id);
      out.push({ rank: out.length + 1, ...trim(book) });
    }
    log(`shelf ${slug} page ${p}/${pp.totalPage ?? "?"}: ${pp.list.length} books, ${out.length - before} new`);
    if (out.length === before) break;
    if (pp.totalPage && p >= pp.totalPage) break;
  }
  return { books: out, fetched_at };
}

async function main() {
  const started_at = nowIso();
  const home = await fetchPageProps(`${BASE}/`);
  const info = home?.fallback?.["/api/ms/hall/webInfo"];
  if (!info) throw new Error("home page: no webInfo payload");
  const homeFetched = nowIso();
  const shelves = (info.bookShelfList ?? [])
    .filter((s) => s.bookshelf_name && Array.isArray(s.books))
    .map((s) => ({
      shelf_id: String(s.bs_id),
      name: s.bookshelf_name.replace(/[^\p{L}\p{N}&' ]+$/u, "").trim(),
      fetched_at: homeFetched,
      books: s.books.map((b, i) => ({ rank: i + 1, ...trim(b) })),
    }));
  log(`home: ${shelves.length} shelves`);
  const top = await shelfPages(TOP_SHELF, topPages);
  const fresh = await shelfPages(NEW_SHELF, 3);
  const file = writeArtifact("reelshort", {
    platform: "reelshort",
    collector_version: "0.2",
    started_at,
    fetched_at: nowIso(),
    source_urls: [`${BASE}/`, `${BASE}/shelf/${TOP_SHELF}`, `${BASE}/shelf/${NEW_SHELF}`],
    shelves,
    lists: [
      { list: "top", name: "TOP", chart: true, fetched_at: top.fetched_at, books: top.books },
      { list: "new", name: "New Release", chart: false, fetched_at: fresh.fetched_at, books: fresh.books },
    ],
  });
  log(`wrote ${file}: top=${top.books.length} new=${fresh.books.length}`);
}

main().catch((err) => {
  log("failed:", err.message);
  writeFailure("reelshort", err);
  process.exit(1);
});
