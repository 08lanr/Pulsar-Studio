// DramaBox public web catalog -> data/research/runs/<RUN_ID>/dramabox.json
//
// Sources (public, unauthenticated, en locale):
//   /                 home rails (Top Hits big cards, Must-sees, Trending, Hidden Gems)
//   /more/<position>  a rail (trending, must-sees, hidden-gems); pagination is client-side
//   /browse           the genre list (56 "typeTwo" tags) + newest titles, 12 visible
//   /film/<bookId>    title detail: real viewCount / followCount, shelfTime,
//                     tags, genre list, episode count, per-episode duration and price
//
// Detail fetch policy (review P1): every listing discovered on any list is a
// detail candidate. Priority order: home rails, trending, must-sees, hidden
// gems, newest. The cap (--details N) is recorded with the number actually
// fetched, so a coverage gap is a known number, not a silent hole.
//
// Caveat (docs/research-feasibility.md): the viewCount on rail cards is a
// small display number that does not match the film page. Only film-page
// numbers become metrics; the card number is kept as card_view_count for
// the record and never displayed.
//
// Usage: node scripts/research/scrape-dramabox.mjs [--browse-pages N] [--details N]

import { fetchPageProps, log, nowIso, writeArtifact, writeFailure } from "./lib.mjs";

const BASE = "https://www.dramaboxapp.com";
const args = process.argv.slice(2);
const browsePages = Number(args[args.indexOf("--browse-pages") + 1] || 10);
const maxDetails = Number(args[args.indexOf("--details") + 1] || 120);

function trimCard(b) {
  return {
    book_id: String(b.bookId ?? b.action ?? ""),
    title: b.bookName ?? b.name ?? "",
    blurb: b.introduction ?? "",
    cover: b.cover ?? b._originalCover ?? null,
    author: b.author || null,
    tags: Array.from(new Set([...(b.tags ?? []), ...(b.labels ?? [])])),
    genres: (b.typeTwoList ?? []).map((t) => t.name).filter(Boolean),
    audience: b.typeOneName ?? (b.typeOneNames ?? [])[0] ?? null,
    episode_count: b.chapterCount ?? null,
    rating: b.ratings ?? null,
    card_view_count: b.viewCount ?? null,
    follow_count: b.followCount ?? null,
    shelf_time: b.shelfTime ?? b.firstShelfTime ?? null,
    status: b.lastUpdateTimeDisplay ?? b.status ?? null,
    free: b.free ?? null,
    language: b.language ?? null,
  };
}

async function rail(position, name) {
  const books = [];
  const fetched_at = nowIso();
  for (let p = 1; p <= 10; p++) {
    const pp = await fetchPageProps(p === 1 ? `${BASE}/more/${position}` : `${BASE}/more/${position}?pageNo=${p}`);
    const items = pp?.moreData?.items ?? [];
    if (!items.length) break;
    if (p > 1 && items.every((b, i) => books[i]?.book_id === String(b.bookId))) {
      log(`rail ${position} page ${p}: repeats page 1, stopping`);
      break;
    }
    for (const b of items) books.push({ rank: books.length + 1, ...trimCard(b) });
    log(`rail ${position} page ${p}/${pp.pages ?? "?"}: ${items.length}`);
    if (!pp.pages || p >= pp.pages) break;
  }
  return { list: position, name, chart: position !== "hidden-gems", fetched_at, books };
}

async function main() {
  const started_at = nowIso();
  const home = await fetchPageProps(`${BASE}/`);
  if (!home) throw new Error("home page: no payload");
  const homeFetched = nowIso();
  const homeRails = [
    { list: "home-top", name: "Top Hits", chart: true, fetched_at: homeFetched, books: (home.bigList ?? []).map((b, i) => ({ rank: i + 1, ...trimCard(b) })) },
    ...(home.smallData ?? []).map((r) => ({
      list: `home-${r.id}`,
      name: r.name,
      chart: false,
      fetched_at: homeFetched,
      books: (r.items ?? []).map((b, i) => ({ rank: i + 1, ...trimCard(b) })),
    })),
  ];
  log(`home: ${homeRails.length} rails`);
  const rails = [await rail("trending", "Trending"), await rail("must-sees", "Must-sees"), await rail("hidden-gems", "Hidden Gems")];
  const browseFirst = await fetchPageProps(`${BASE}/browse`);
  const browseFetched = nowIso();
  const genres = (browseFirst?.types ?? []).map((t) => ({ id: t.id, name: t.name }));
  const newest = [];
  for (let p = 1; p <= browsePages; p++) {
    const pp = p === 1 ? browseFirst : await fetchPageProps(`${BASE}/browse?pageNo=${p}`);
    const items = pp?.bookList ?? [];
    if (!items.length) break;
    if (p > 1 && items[0] && newest.some((n) => n.book_id === String(items[0].bookId))) {
      log(`browse page ${p}: repeats page 1, pagination is client-side; stopping`);
      break;
    }
    for (const b of items) newest.push({ rank: newest.length + 1, ...trimCard(b) });
    log(`browse page ${p}/${pp.pages ?? "?"}: ${items.length}`);
  }
  const lists = [...homeRails, ...rails, { list: "newest", name: "New on DramaBox", chart: false, fetched_at: browseFetched, books: newest }];

  // Every discovered listing is a candidate, in list priority order.
  const candidates = new Map();
  for (const l of lists) for (const b of l.books) if (b.book_id && !candidates.has(b.book_id)) candidates.set(b.book_id, b);
  const requested = candidates.size;
  const details = [];
  const failures = [];
  for (const id of Array.from(candidates.keys()).slice(0, maxDetails)) {
    try {
      const pp = await fetchPageProps(`${BASE}/film/${id}`);
      const info = pp?.bookInfo;
      if (!info) {
        failures.push({ book_id: id, error: "no bookInfo" });
        log(`film ${id}: no bookInfo`);
        continue;
      }
      const chapters = pp.chapterList ?? [];
      const firstPaid = chapters.findIndex((c) => (c.chapterPrice ?? 0) > 0 || c.unlock === false);
      details.push({
        ...trimCard(info),
        author: candidates.get(id)?.author ?? null,
        fetched_at: nowIso(),
        view_count: info.viewCount ?? null,
        follow_count: info.followCount ?? null,
        chapters_listed: chapters.length,
        avg_episode_s: chapters.length ? Math.round(chapters.reduce((a, c) => a + (c.duration ?? 0), 0) / chapters.length / 1000) : null,
        paid_start: firstPaid >= 0 ? firstPaid + 1 : null,
        languages: (pp.languages ?? []).map((l) => (typeof l === "string" ? l : l.name ?? l.language ?? "")).filter(Boolean),
      });
      log(`film ${id}: ${info.bookName} views=${info.viewCount} follows=${info.followCount}`);
    } catch (err) {
      failures.push({ book_id: id, error: String(err.message ?? err) });
      log(`film ${id}: ${err.message}`);
    }
  }
  const file = writeArtifact("dramabox", {
    platform: "dramabox",
    collector_version: "0.2",
    started_at,
    fetched_at: nowIso(),
    source_urls: [`${BASE}/`, `${BASE}/more/trending`, `${BASE}/more/must-sees`, `${BASE}/more/hidden-gems`, `${BASE}/browse`],
    genres,
    lists,
    detail_coverage: { requested, cap: maxDetails, fetched: details.length, failed: failures.length },
    detail_failures: failures,
    details,
  });
  log(`wrote ${file}: lists=${lists.length} candidates=${requested} details=${details.length} failed=${failures.length}`);
}

main().catch((err) => {
  log("failed:", err.message);
  writeFailure("dramabox", err);
  process.exit(1);
});
