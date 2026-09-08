import ExploreNav from "@/components/producer/research/ExploreNav";
import { portalSession, producerLocale } from "@/components/producer/server";
import { EvidenceTag, MetricLabel, ObservationCell, Prominence, TropeChip, exploreHref, platformName } from "@/components/producer/research/ui";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { filterTitles, rankTitles, scoreSnapshot, tropeStats, type MarketFilter } from "@/lib/research/engine";
import { TROPES, isTropeId, tropeLabel } from "@/lib/research/taxonomy";
import { PLATFORMS, type Audience, type MarketTitle, type Platform } from "@/lib/research/types";

// /producer/explore/titles — the title explorer: search (title/blurb),
// platform / positioning / trope filters, sort, pagination, all in the URL.
// Views columns are platform-specific counters and are never pooled into
// one leaderboard: a mixed list shows each listing's own counter with its
// field name, and the sort by views only makes sense within one platform
// (the page says so when the filter spans both).

export const dynamic = "force-dynamic";

type Search = { platform?: string; audience?: string; trope?: string; q?: string; sort?: string; page?: string; newonly?: string; watched?: string };
const PLATFORM_IDS = new Set<string>(PLATFORMS.map((p) => p.id));
const PAGE_SIZE = 25;
type Sort = "prominence" | "views" | "saves" | "episodes" | "title" | "released";
const SORTS: Sort[] = ["prominence", "views", "saves", "episodes", "title", "released"];

function parse(sp: Search): { filter: MarketFilter; sort: Sort; page: number; newonly: boolean } {
  return {
    filter: {
      platform: sp.platform && PLATFORM_IDS.has(sp.platform) ? (sp.platform as Platform) : "all",
      audience: sp.audience === "female" || sp.audience === "male" ? (sp.audience as Audience) : "all",
      trope: sp.trope && isTropeId(sp.trope) ? sp.trope : null,
      q: sp.q?.slice(0, 80) ?? null,
    },
    sort: SORTS.includes(sp.sort as Sort) ? (sp.sort as Sort) : "prominence",
    page: Math.max(1, Number(sp.page) || 1),
    newonly: sp.newonly === "1",
  };
}

function sortRows(rows: MarketTitle[], sort: Sort, scores: ReturnType<typeof scoreSnapshot>): MarketTitle[] {
  const num = (v: number | null | undefined) => (v == null ? -Infinity : v);
  switch (sort) {
    case "prominence":
      return rankTitles(rows, scores);
    case "views":
      return [...rows].sort((a, b) => num(b.metrics.views?.value) - num(a.metrics.views?.value) || a.title.localeCompare(b.title));
    case "saves":
      return [...rows].sort((a, b) => num(b.metrics.saves?.value) - num(a.metrics.saves?.value) || a.title.localeCompare(b.title));
    case "episodes":
      return [...rows].sort((a, b) => num(b.episode_count) - num(a.episode_count) || a.title.localeCompare(b.title));
    case "released":
      return [...rows].sort((a, b) => (b.released_at ?? "").localeCompare(a.released_at ?? "") || Number(b.platform_new) - Number(a.platform_new) || a.title.localeCompare(b.title));
    case "title":
      return [...rows].sort((a, b) => a.title.localeCompare(b.title));
  }
}

export default async function ExploreTitles({ searchParams }: { searchParams: Search }) {
  const session = await portalSession("/producer/explore/titles");
  const locale = producerLocale();
  const data = getData();
  const [market, profile, watchlist] = await Promise.all([data.getMarket(session), data.getResearchProfile(session), data.listWatchlist(session)]);
  const { filter, sort, page, newonly } = parse(searchParams);
  const watched = searchParams.watched === "1";
  const watchedKeys = new Set(watchlist.map((w) => w.listing_key));
  const base = { platform: filter.platform, audience: filter.audience, trope: filter.trope ?? undefined, q: filter.q ?? undefined, sort, newonly: newonly ? "1" : undefined, watched: watched ? "1" : undefined };

  if (!market.latest) {
    return (
      <>
        <ExploreNav active="titles" locale={locale} />
        <section className="rs-panel"><div className="rs-empty">{t(locale, "research.market.noData")}</div></section>
      </>
    );
  }
  const snapshot = market.latest;
  const scores = scoreSnapshot(snapshot);
  const stats = tropeStats(snapshot.titles, scores, snapshot.taxonomy_version);
  const hot = new Set(stats.slice(0, 10).map((s) => s.id));
  const mine = new Set(profile?.tropes ?? []);
  let rows = filterTitles(snapshot.titles, filter);
  if (newonly) rows = rows.filter((x) => x.platform_new);
  if (watched) rows = rows.filter((x) => watchedKeys.has(x.key));
  const sorted = sortRows(rows, sort, scores);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const slice = sorted.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const mixed = filter.platform === "all";
  const cols = mixed ? "28px minmax(0,2.4fr) 88px minmax(0,2fr) 90px 110px 90px 52px 60px" : "28px minmax(0,2.4fr) 88px minmax(0,2fr) 90px 110px 90px 52px 60px";

  return (
    <>
      <ExploreNav active="titles" locale={locale} />

      <form className="rs-toolbar" action="/producer/explore/titles" method="get">
        <input className="input" type="search" name="q" defaultValue={filter.q ?? ""} placeholder={t(locale, "research.search.placeholder")} aria-label={t(locale, "research.search.placeholder")} style={{ maxWidth: 320 }} />
        <select className="select" name="platform" defaultValue={filter.platform} aria-label={t(locale, "research.filter.platform")}>
          <option value="all">{t(locale, "research.filter.platform")}: {t(locale, "research.filter.all")}</option>
          {PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="select" name="audience" defaultValue={filter.audience} aria-label={t(locale, "research.filter.audience")} title={t(locale, "research.audience.note")}>
          <option value="all">{t(locale, "research.filter.audience")}: {t(locale, "research.filter.all")}</option>
          <option value="female">{t(locale, "research.audience.female")}</option>
          <option value="male">{t(locale, "research.audience.male")}</option>
        </select>
        <select className="select" name="trope" defaultValue={filter.trope ?? ""} aria-label={t(locale, "research.filter.trope")}>
          <option value="">{t(locale, "research.filter.trope")}: {t(locale, "research.filter.all")}</option>
          {TROPES.map((tr) => <option key={tr.id} value={tr.id}>{locale === "zh" ? tr.zh : tr.en}</option>)}
        </select>
        <select className="select" name="sort" defaultValue={sort} aria-label={t(locale, "research.explore.sort")}>
          {SORTS.map((s) => <option key={s} value={s}>{t(locale, "research.explore.sort")}: {t(locale, `research.sort.${s}`)}</option>)}
        </select>
        <label className="filter-chip" style={{ cursor: "pointer" }}><input type="checkbox" name="newonly" value="1" defaultChecked={newonly} /> {t(locale, "research.col.new")}</label>
        <label className="filter-chip" style={{ cursor: "pointer" }}><input type="checkbox" name="watched" value="1" defaultChecked={watched} /> {t(locale, "research.watch.watching")}</label>
        <button className="btn btn-primary btn-sm" type="submit">{t(locale, "research.search.go")}</button>
        <a className="filter-chip clear" href="/producer/explore/titles">{t(locale, "research.filter.reset")}</a>
      </form>

      <div className="rs-meta">
        <span>{t(locale, "research.results", { n: sorted.length })}</span>
        <span>{t(locale, "research.page", { page: current, pages })}</span>
        {mixed && (sort === "views" || sort === "saves") && <span className="ev ev-inferred">{t(locale, "research.viewsPooledNote")}</span>}
        <span>{t(locale, "research.market.observed", { date: snapshot.observed_at })}</span>
      </div>

      {slice.length === 0 ? (
        <section className="rs-panel"><div className="rs-empty">{t(locale, "research.noResults")}</div></section>
      ) : (
        <section className="rs-panel">
          <div className="gtable gtable-flush rs-table" style={{ ["--cols" as string]: cols }}>
            <div className="gt-head">
              <span>#</span>
              <span>{t(locale, "research.col.title")}</span>
              <span>{t(locale, "research.col.platform")}</span>
              <span>{t(locale, "research.col.tropes")}</span>
              <span><MetricLabel metric="prominence" locale={locale}>{t(locale, "research.col.prominence")}</MetricLabel></span>
              <span className="gt-num"><MetricLabel metric="views_counter" locale={locale}>{filter.platform === "reelshort" ? t(locale, "research.col.viewsRs") : filter.platform === "dramabox" ? t(locale, "research.col.viewsDb") : t(locale, "research.col.views")}</MetricLabel></span>
              <span className="gt-num"><MetricLabel metric="saves_counter" locale={locale}>{filter.platform === "reelshort" ? t(locale, "research.col.collects") : filter.platform === "dramabox" ? t(locale, "research.col.follows") : t(locale, "research.col.saves")}</MetricLabel></span>
              <span className="gt-num">{t(locale, "research.col.episodes")}</span>
              <span className="gt-num"><MetricLabel metric="paywall_episode" locale={locale}>{t(locale, "research.col.paywall")}</MetricLabel></span>
            </div>
            {slice.map((x, i) => {
              const sc = scores.get(x.key);
              return (
                <a className="gt-row" key={x.key} href={`/producer/market/${x.key}`}>
                  <span className="gt-muted">{(current - 1) * PAGE_SIZE + i + 1}</span>
                  <span className="rs-title">
                    {/* eslint-disable-next-line @next/next/no-img-element -- third-party cover, not proxied */}
                    {x.cover ? <img className="rs-cover" src={x.cover} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="rs-cover" />}
                    <span style={{ minWidth: 0 }}>
                      <span className="rs-title-name" lang="en">{x.title}</span>
                      <span className="rs-title-sub">
                        {x.companies[0]?.name ?? ""}{x.audience ? `${x.companies[0] ? " · " : ""}${t(locale, `research.audience.${x.audience}`)}` : ""}{x.platform_new ? ` · ${t(locale, "research.new")}` : ""}{sc?.best_chart_rank != null ? ` · #${sc.best_chart_rank}` : ""}
                      </span>
                    </span>
                  </span>
                  <span className="rs-platform">{platformName(x.platform)}</span>
                  <span className="rs-tropes clip">{x.tropes.slice(0, 3).map((tr) => <TropeChip key={tr.id} id={tr.id} locale={locale} hot={hot.has(tr.id)} mine={mine.has(tr.id)} />)}</span>
                  <span><Prominence value={sc?.prominence ?? null} locale={locale} /></span>
                  <span className="gt-num"><ObservationCell o={x.metrics.views} locale={locale} />{mixed && x.metrics.views && <small className="gt-muted"> {x.metrics.views.source_field}</small>}</span>
                  <span className="gt-num"><ObservationCell o={x.metrics.saves} locale={locale} />{mixed && x.metrics.saves && <small className="gt-muted"> {x.metrics.saves.unit}</small>}</span>
                  <span className="gt-num">{x.episode_count ?? "–"}</span>
                  <span className="gt-num">{x.paywall_episode ?? "–"}</span>
                </a>
              );
            })}
          </div>
          <div className="rs-panel-foot rs-pager">
            <span><EvidenceTag evidence="observed" locale={locale} /> {t(locale, "research.prominence.note")}</span>
            <span className="spacer" />
            {current > 1 && <a className="btn btn-outline btn-sm" href={exploreHref(base, { page: String(current - 1) })}>{t(locale, "research.prev")}</a>}
            {current < pages && <a className="btn btn-outline btn-sm" href={exploreHref(base, { page: String(current + 1) })}>{t(locale, "research.next")}</a>}
          </div>
        </section>
      )}

      <div className="rs-legend">
        <span>{t(locale, "research.filter.trope")}:</span>
        {stats.map((s) => <TropeChip key={s.id} id={s.id} locale={locale} hot={hot.has(s.id)} mine={mine.has(s.id)} href={exploreHref(base, { trope: s.id, page: undefined })} />)}
        {filter.trope && <span className="gt-muted">{tropeLabel(filter.trope, locale)}</span>}
      </div>
    </>
  );
}
