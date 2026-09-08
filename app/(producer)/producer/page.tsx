import { portalSession, producerLocale } from "@/components/producer/server";
import { EvidenceTag, MetricLabel, Prominence, StateBadge, TropeChip, exploreHref, fmtPct, fmtUtc, marketHref, platformName } from "@/components/producer/research/ui";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import {
  catalogMatches,
  cohortOf,
  filterTitles,
  formatStats,
  insights,
  profileOpportunities,
  rankTitles,
  scoreSnapshot,
  tagCatalogTitle,
  tropeStats,
  type Insight,
  type MarketFilter,
} from "@/lib/research/engine";
import { hasHistory, rankMovement } from "@/lib/research/history";
import { platformStatuses, snapshotAgeDays, statusFor } from "@/lib/research/registry";
import { isTropeId, tropeLabel } from "@/lib/research/taxonomy";
import { PLATFORMS, type Audience, type Platform } from "@/lib/research/types";

// /producer — the market overview (docs/market-desk-plan.md, phase 2).
// Answers a question before showing a table: what is prominent, what the
// charts are made of, what is new, and which of the producer's titles
// resemble that. With one observation day the change cards say
// "collecting history" instead of inventing a trend. Every card links to
// the filtered data that supports it; filters live in the URL.

export const dynamic = "force-dynamic";

type Search = { platform?: string; audience?: string; trope?: string };
const PLATFORM_IDS = new Set<string>(PLATFORMS.map((p) => p.id));

function parseFilter(sp: Search): MarketFilter {
  return {
    platform: sp.platform && PLATFORM_IDS.has(sp.platform) ? (sp.platform as Platform) : "all",
    audience: sp.audience === "female" || sp.audience === "male" ? (sp.audience as Audience) : "all",
    trope: sp.trope && isTropeId(sp.trope) ? sp.trope : null,
  };
}

function InsightLine({ i, locale }: { i: Insight; locale: "zh" | "en" }) {
  switch (i.kind) {
    case "trope_lift":
      return (
        <li>
          <span>{t(locale, "research.insight.tropeLift", { trope: tropeLabel(i.trope, locale), lift: i.lift, inCohort: i.in_cohort, cohort: i.cohort, titles: i.titles, sample: i.sample })}</span>
          <footer>
            <span className="ev ev-inferred">{t(locale, "research.insight.exploratory")}</span>
            <MetricLabel metric="trope_lift" locale={locale}>{t(locale, "research.col.lift")}</MetricLabel>
            {i.refs.map((k) => <a key={k} href={`/producer/market/${k}`}>{k}</a>)}
          </footer>
        </li>
      );
    case "paywall_gap":
      return (
        <li>
          <span>{t(locale, "research.insight.paywallGap", { a: platformName(i.a), aMedian: i.a_median, aN: i.a_n, b: platformName(i.b), bMedian: i.b_median, bN: i.b_n })}</span>
          <footer><EvidenceTag evidence="observed" locale={locale} /><MetricLabel metric="paywall_episode" locale={locale}>{t(locale, "research.col.paywall")}</MetricLabel><a href="/producer/explore/platforms">{t(locale, "research.explore.platforms")}</a></footer>
        </li>
      );
    case "new_listings":
      return (
        <li>
          <span>{t(locale, "research.insight.newListings", { platform: platformName(i.platform), count: i.count })}</span>
          <footer><EvidenceTag evidence="observed" locale={locale} />{i.refs.map((k) => <a key={k} href={`/producer/market/${k}`}>{k}</a>)}</footer>
        </li>
      );
    case "audience_split":
      return (
        <li>
          <span>{t(locale, "research.insight.audienceSplit", { platform: platformName(i.platform), share: fmtPct(i.female_share), n: i.n })}</span>
          <footer><EvidenceTag evidence="observed" locale={locale} /><MetricLabel metric="audience_positioning" locale={locale}>{t(locale, "research.col.audience")}</MetricLabel></footer>
        </li>
      );
  }
}

export default async function MarketOverview({ searchParams }: { searchParams: Search }) {
  const session = await portalSession();
  const locale = producerLocale();
  const data = getData();
  const [market, profile, catalog, watchlist] = await Promise.all([data.getMarket(session), data.getResearchProfile(session), data.listCatalogForMatching(session), data.listWatchlist(session)]);
  const filter = parseFilter(searchParams);
  const base = { platform: filter.platform, audience: filter.audience, trope: filter.trope ?? undefined };
  const canOnboard = session.kind === "producer";

  const head = (
    <div className="page-head">
      <div>
        <span className="page-kicker">{t(locale, "research.market.kicker")}</span>
        <h2>{t(locale, "research.market.title")}</h2>
        <p className="page-sub">{t(locale, "research.market.sub")}</p>
      </div>
      <form className="rs-search" action="/producer/explore/titles" method="get" role="search">
        <input className="input" type="search" name="q" placeholder={t(locale, "research.search.placeholder")} aria-label={t(locale, "research.search.placeholder")} />
        <button className="btn btn-outline" type="submit">{t(locale, "research.search.go")}</button>
      </form>
    </div>
  );

  if (!market.latest) {
    return (
      <>
        {head}
        <section className="rs-panel"><div className="rs-empty">{market.publication.state === "invalid" ? t(locale, "research.market.invalid") : t(locale, "research.market.noData")} <a href="/producer/sources">{t(locale, "research.nav.sources")}</a></div></section>
      </>
    );
  }

  const snapshot = market.latest;
  const scores = scoreSnapshot(snapshot);
  const titles = filterTitles(snapshot.titles, filter);
  const history = hasHistory(market.days);
  const previous = market.previous ? { titles: filterTitles(market.previous.titles, filter), scores: scoreSnapshot(market.previous), taxonomy_version: market.previous.taxonomy_version } : null;
  const stats = tropeStats(titles, scores, snapshot.taxonomy_version, previous);
  const hot = new Set(stats.slice(0, 10).map((s) => s.id));
  const mine = new Set(profile?.tropes ?? []);
  const prominent = rankTitles(titles, scores, 8);
  const cohort = cohortOf(titles, scores);
  const formats = formatStats(titles);
  const fresh = rankTitles(titles.filter((x) => x.platform_new), scores, 6);
  const obs = insights(titles, scores, stats, formats);
  const opportunities = profile ? profileOpportunities(profile.tropes, stats) : null;
  const tagged = catalog.rows.map((r) => ({ id: r.id, name_zh: r.name_zh, name_en: r.name_en, tropes: tagCatalogTitle(r) }));
  const matches = catalogMatches(tagged, stats, snapshot.titles, scores).filter((m) => m.market_score != null).slice(0, 4);
  const byId = new Map(tagged.map((x) => [x.id, x]));
  const marketById = new Map(snapshot.titles.map((x) => [x.key, x]));
  const catalogState = statusFor("catalog", { view: market, hasReports: false, hasProfile: Boolean(profile) });
  const historyState = statusFor("history", { view: market, hasReports: false, hasProfile: Boolean(profile) });
  const age = snapshotAgeDays(market);
  const latestFetch = snapshot.platforms.map((p) => p.fetched_at).sort().at(-1) ?? null;
  const risingTrope = stats.filter((s) => s.delta_pts != null).sort((a, b) => (b.delta_pts ?? 0) - (a.delta_pts ?? 0))[0] ?? null;
  const pstatus = platformStatuses(market);

  return (
    <>
      {head}

      <div className="rs-scope">
        <span><b>{t(locale, "research.scope")}</b> {t(locale, "research.scope.value")}</span>
        <span><b>{t(locale, "research.freshness")}</b> {fmtUtc(latestFetch)}{age != null && age > 0 ? ` · ${age}d` : ""} <StateBadge status={catalogState} locale={locale} /></span>
        {pstatus.filter((p) => p.status !== "available").map((p) => (
          <span key={p.id}>{platformName(p.id as Platform)}: <StateBadge status={p.status} locale={locale} /> {p.error}</span>
        ))}
        <span className="spacer" />
        <div className="filter-row">
          <span className="rs-toolbar-label">{t(locale, "research.filter.platform")}</span>
          <a className={`filter-chip${filter.platform === "all" ? " on" : ""}`} href={marketHref(base, { platform: "all" })}>{t(locale, "research.filter.all")}</a>
          {PLATFORMS.map((p) => (
            <a key={p.id} className={`filter-chip${filter.platform === p.id ? " on" : ""}`} href={marketHref(base, { platform: p.id })}>{p.name}</a>
          ))}
          <span className="rs-toolbar-label">{t(locale, "research.filter.audience")}</span>
          <a className={`filter-chip${filter.audience === "all" ? " on" : ""}`} href={marketHref(base, { audience: "all" })}>{t(locale, "research.filter.all")}</a>
          <a className={`filter-chip${filter.audience === "female" ? " on" : ""}`} href={marketHref(base, { audience: "female" })} title={t(locale, "research.audience.note")}>{t(locale, "research.audience.female")}</a>
          <a className={`filter-chip${filter.audience === "male" ? " on" : ""}`} href={marketHref(base, { audience: "male" })} title={t(locale, "research.audience.note")}>{t(locale, "research.audience.male")}</a>
          {filter.trope && (
            <>
              <span className="filter-chip on">{tropeLabel(filter.trope, locale)}</span>
              <a className="filter-chip clear" href={marketHref(base, { trope: undefined })}>{t(locale, "research.filter.clear")}</a>
            </>
          )}
        </div>
      </div>

      {!profile && canOnboard && (
        <div className="rs-banner">
          <span>{t(locale, "research.onboard.banner")}</span>
          <a className="btn btn-primary btn-sm" href="/producer/onboarding">{t(locale, "research.onboard.cta")}</a>
        </div>
      )}

      {/* Four summary cards. With one observation day, the change cards say so. */}
      <div className="rs-cards">
        <div className="rs-card">
          <span className="rs-card-label"><MetricLabel metric="prominence" locale={locale}>{t(locale, "research.card.prominent")}</MetricLabel></span>
          {prominent[0] ? (
            <>
              <a className="rs-card-value" lang="en" href={`/producer/market/${prominent[0].key}`}>{prominent[0].title}</a>
              <span className="rs-card-foot">{platformName(prominent[0].platform)} · <Prominence value={scores.get(prominent[0].key)?.prominence ?? null} locale={locale} /> · <a href={exploreHref(base, { sort: "prominence" })}>{t(locale, "research.card.open")} ›</a></span>
            </>
          ) : (
            <span className="rs-card-value">–</span>
          )}
        </div>
        <div className="rs-card">
          <span className="rs-card-label"><MetricLabel metric={history ? "trope_share_change" : "trope_cohort_share"} locale={locale}>{history ? t(locale, "research.card.risingTrope") : t(locale, "research.card.storyMix")}</MetricLabel></span>
          {history && risingTrope ? (
            <>
              <a className="rs-card-value" href={`/producer/explore/tropes`}>{tropeLabel(risingTrope.id, locale)}</a>
              <span className="rs-card-foot">{risingTrope.delta_pts! > 0 ? t(locale, "research.delta.up", { n: risingTrope.delta_pts! }) : t(locale, "research.delta.down", { n: Math.abs(risingTrope.delta_pts!) })} · {fmtPct(risingTrope.cohort_share)}</span>
            </>
          ) : stats[0] ? (
            <>
              <a className="rs-card-value" href="/producer/explore/tropes">{tropeLabel(stats[0].id, locale)}</a>
              <span className="rs-card-foot">{fmtPct(stats[0].cohort_share)} · {stats[0].in_cohort}/{stats[0].cohort} <StateBadge status={historyState} locale={locale} /></span>
            </>
          ) : (
            <span className="rs-card-value">–</span>
          )}
        </div>
        <div className="rs-card">
          <span className="rs-card-label">{history ? t(locale, "research.card.climber") : t(locale, "research.card.platformNew")}</span>
          {history ? (
            <span className="rs-card-value"><StateBadge status={historyState} locale={locale} /></span>
          ) : (
            <>
              <a className="rs-card-value" href={exploreHref(base, { sort: "released", newonly: "1" })}>{titles.filter((x) => x.platform_new).length}</a>
              <span className="rs-card-foot">{formats.map((f) => `${platformName(f.platform)} ${f.platform_new}`).join(" · ")} <EvidenceTag evidence="observed" locale={locale} /></span>
            </>
          )}
        </div>
        <div className="rs-card">
          <span className="rs-card-label"><MetricLabel metric="catalog_match" locale={locale}>{t(locale, "research.card.yourComparables")}</MetricLabel></span>
          {catalog.total === 0 ? (
            <a className="rs-card-value rs-card-state" href="/producer/titles/new">{t(locale, "research.state.noCatalog")}</a>
          ) : matches[0] ? (
            <>
              <a className="rs-card-value bilingual" lang="zh-CN" href={`/producer/titles/${matches[0].title_id}`}>{byId.get(matches[0].title_id)?.name_zh}</a>
              <span className="rs-card-foot">{t(locale, "research.mine.marketScore")} {matches[0].market_score} · {t(locale, "research.mine.marketScoreNote")}</span>
            </>
          ) : (
            <a className="rs-card-value rs-card-state" href="/producer/titles">{t(locale, "research.mine.untagged")}</a>
          )}
        </div>
      </div>

      <div className="rs-grid">
        <section className="rs-panel">
          <div className="rs-panel-head">
            <div>
              <h3>{t(locale, "research.section.prominent")}</h3>
              <p>{t(locale, "research.section.prominentSub")}</p>
            </div>
            <a className="rs-panel-aside" href={exploreHref(base, { sort: "prominence" })}>{t(locale, "research.card.open")} ›</a>
          </div>
          <ul className="rs-posters">
            {prominent.map((x) => (
              <li key={x.key}>
                <a href={`/producer/market/${x.key}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- third-party cover, not proxied */}
                  {x.cover ? <img className="rs-poster" src={x.cover} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="rs-poster" />}
                  <span className="rs-poster-title" lang="en">{x.title}</span>
                  <span className="rs-poster-meta">
                    <span className="rs-platform">{platformName(x.platform)}</span>
                    {scores.get(x.key)?.best_chart_rank != null && <span>#{scores.get(x.key)!.best_chart_rank}</span>}
                    <Prominence value={scores.get(x.key)?.prominence ?? null} locale={locale} />
                  </span>
                  <span className="rs-tropes clip">{x.tropes.slice(0, 2).map((tr) => <TropeChip key={tr.id} id={tr.id} locale={locale} hot={hot.has(tr.id)} mine={mine.has(tr.id)} />)}</span>
                </a>
              </li>
            ))}
          </ul>
          <div className="rs-panel-foot">{t(locale, "research.prominence.note")}</div>
        </section>

        <section className="rs-panel">
          <div className="rs-panel-head">
            <div>
              <h3>{t(locale, "research.section.insights")}</h3>
              <p>{t(locale, "research.section.insightsSub")}</p>
            </div>
          </div>
          <ul className="rs-insights">
            {obs.length === 0 && <li className="gt-muted">{t(locale, "research.personal.none")}</li>}
            {obs.map((i, n) => <InsightLine key={n} i={i} locale={locale} />)}
          </ul>
        </section>

        <section className="rs-panel">
          <div className="rs-panel-head">
            <div>
              <h3>{t(locale, "research.section.storyMix")}</h3>
              <p>{t(locale, "research.section.storyMixSub")} n={cohort.length}{Object.entries(stats[0]?.cohort_by_platform ?? {}).map(([p, n]) => ` · ${platformName(p as Platform)} ${n}`).join("")}</p>
            </div>
            <a className="rs-panel-aside" href="/producer/explore/tropes">{t(locale, "research.explore.tropes")} ›</a>
          </div>
          <div className="rs-panel-body">
            <div className="rs-bars" role="img" aria-label={t(locale, "research.chartSummary")}>
              {stats.slice(0, 12).map((s) => (
                <a key={s.id} className={`rs-bar${mine.has(s.id) ? " is-mine" : ""}`} href={marketHref(base, { trope: s.id })}>
                  <span className="rs-bar-label"><span>{tropeLabel(s.id, locale)}</span></span>
                  <span className="rs-bar-track"><span className="rs-bar-fill" style={{ width: `${Math.max(2, s.cohort_share * 100)}%` }} /></span>
                  <span className="rs-bar-value">{fmtPct(s.cohort_share)}</span>
                  <span className={`rs-bar-delta${s.delta_pts == null ? "" : s.delta_pts > 0 ? " up" : s.delta_pts < 0 ? " down" : ""}`}>
                    {s.delta_pts == null ? `${s.in_cohort}/${s.cohort}` : s.delta_pts > 0 ? `↑ ${t(locale, "research.delta.up", { n: s.delta_pts })}` : s.delta_pts < 0 ? `↓ ${t(locale, "research.delta.down", { n: Math.abs(s.delta_pts) })}` : t(locale, "research.delta.flat")}
                  </span>
                </a>
              ))}
            </div>
            <details className="rs-table-alt">
              <summary>{t(locale, "research.tableAlt")}</summary>
              <table>
                <thead><tr><th>{t(locale, "research.filter.trope")}</th><th>{t(locale, "research.col.inCohort")}</th><th>{t(locale, "research.col.cohortShare")}</th><th>{t(locale, "research.col.count")}</th><th>{t(locale, "research.col.sampleShare")}</th></tr></thead>
                <tbody>{stats.map((s) => <tr key={s.id}><td>{tropeLabel(s.id, locale)}</td><td>{s.in_cohort}/{s.cohort}</td><td>{fmtPct(s.cohort_share)}</td><td>{s.titles}/{s.sample}</td><td>{fmtPct(s.share)}</td></tr>)}</tbody>
              </table>
            </details>
          </div>
          <div className="rs-panel-foot">{!history && t(locale, "research.state.collectingHint")} <MetricLabel metric="trope_cohort_share" locale={locale}>{t(locale, "research.title.methodology")}</MetricLabel></div>
        </section>

        <section className="rs-panel">
          <div className="rs-panel-head">
            <div>
              <h3>{t(locale, "research.section.yourTitles")}</h3>
              <p>{t(locale, "research.section.yourTitlesSub")}</p>
            </div>
            <a className="rs-panel-aside" href="/producer/titles">{t(locale, "research.nav.titles")} ›</a>
          </div>
          {catalog.total === 0 ? (
            <div className="rs-empty">{t(locale, "research.state.noCatalog")} <a className="btn btn-outline btn-sm" href="/producer/titles/new">{t(locale, "research.nav.addTitle")}</a></div>
          ) : matches.length === 0 ? (
            <div className="rs-empty">{t(locale, "research.mine.untagged")}</div>
          ) : (
            <ul className="rs-list">
              {matches.map((m) => {
                const row = byId.get(m.title_id)!;
                const comps = m.comparable_keys.map((k) => marketById.get(k)).filter(Boolean).slice(0, 2);
                return (
                  <li key={m.title_id} style={{ flexWrap: "wrap" }}>
                    <a href={`/producer/titles/${m.title_id}`} className="rs-title-name bilingual" lang="zh-CN">{row.name_zh}</a>
                    <span className="rs-tropes clip">{m.hot_tropes.slice(0, 2).map((id) => <TropeChip key={id} id={id} locale={locale} hot evidence="inferred" />)}</span>
                    <span className="spacer" />
                    <b title={t(locale, "research.mine.marketScoreNote")}>{m.market_score}</b>
                    <span className="rs-title-sub" style={{ flexBasis: "100%" }}>
                      {t(locale, "research.mine.comparables")}: {comps.map((c, i) => <span key={c!.key}>{i ? " · " : ""}<a href={`/producer/market/${c!.key}`} lang="en">{c!.title}</a></span>)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {opportunities && (
            <div className="rs-personal" style={{ borderTop: "1px solid var(--border-light)" }}>
              {(["producing_hot", "hot_not_producing", "producing_cold"] as const).map((k) => (
                <div key={k}>
                  <h4>{t(locale, k === "producing_hot" ? "research.personal.producingHot" : k === "hot_not_producing" ? "research.personal.hotNotProducing" : "research.personal.producingCold")}</h4>
                  <div className="tags">
                    {opportunities[k].length === 0 ? <span className="gt-muted">{t(locale, "research.personal.none")}</span> : opportunities[k].map((s) => <TropeChip key={s.id} id={s.id} locale={locale} hot={hot.has(s.id)} mine={mine.has(s.id)} href={marketHref(base, { trope: s.id })} />)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rs-panel">
          <div className="rs-panel-head">
            <div>
              <h3>{t(locale, "research.section.newListings")}</h3>
              <p>{t(locale, "research.section.newListingsSub")}</p>
            </div>
            <a className="rs-panel-aside" href={exploreHref(base, { sort: "released", newonly: "1" })}>{t(locale, "research.card.open")} ›</a>
          </div>
          <ul className="rs-list">
            {fresh.length === 0 && <li className="gt-muted">{t(locale, "research.personal.none")}</li>}
            {fresh.map((x) => (
              <li key={x.key}>
                <a href={`/producer/market/${x.key}`} className="rs-title-name" lang="en">{x.title}</a>
                <span className="rs-platform">{platformName(x.platform)}</span>
                <span className="rs-tropes clip">{x.tropes.slice(0, 2).map((tr) => <TropeChip key={tr.id} id={tr.id} locale={locale} hot={hot.has(tr.id)} />)}</span>
                <span className="spacer" />
                {x.released_at && <span className="gt-muted">{x.released_at}</span>}
              </li>
            ))}
          </ul>
        </section>

        <section className="rs-panel">
          <div className="rs-panel-head">
            <div>
              <h3>{t(locale, "research.section.watchlist")}</h3>
            </div>
            <a className="rs-panel-aside" href="/producer/explore/titles?watched=1">{t(locale, "research.card.open")} ›</a>
          </div>
          {watchlist.length === 0 ? (
            <div className="rs-empty">{t(locale, "research.watch.empty")}</div>
          ) : (
            <ul className="rs-list">
              {watchlist.slice(0, 8).map((w) => {
                const x = marketById.get(w.listing_key);
                const prev = market.previous ? market.previous.titles.find((y) => y.key === w.listing_key) ?? null : null;
                const rm = x ? rankMovement(x.placements.find((p) => p.chart)?.list ?? "top", x, prev, history) : null;
                return (
                  <li key={w.listing_key}>
                    {x ? <a href={`/producer/market/${x.key}`} className="rs-title-name" lang="en">{x.title}</a> : <span className="rs-title-name gt-muted">{w.listing_key} · {t(locale, "research.watch.missing")}</span>}
                    {x && <span className="rs-platform">{platformName(x.platform)}</span>}
                    <span className="spacer" />
                    {x && <Prominence value={scores.get(x.key)?.prominence ?? null} locale={locale} />}
                    {rm && rm.state === "collecting_history" && <StateBadge status="collecting_history" locale={locale} />}
                    {rm && rm.state === "ok" && <span className={rm.movement > 0 ? "delta-up" : rm.movement < 0 ? "delta-down" : "gt-muted"}>{rm.movement > 0 ? `↑${rm.movement}` : rm.movement < 0 ? `↓${Math.abs(rm.movement)}` : "="}</span>}
                    {rm && rm.state === "entered" && <span className="delta-up">↑ #{rm.rank}</span>}
                    {rm && rm.state === "exited" && <span className="delta-down">↓</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <div className="rs-coverage">
        <span>{t(locale, "research.coverage", { listings: snapshot.titles.length, platforms: snapshot.platforms.filter((p) => p.status !== "failed").length })} · {t(locale, "research.coverage.note")}</span>
        {snapshot.platforms.map((p) => (
          <span key={p.id}>{platformName(p.id)} {p.title_count} ({t(locale, "research.col.withViews").toLowerCase()} {p.with_views}) · {fmtUtc(p.fetched_at)}</span>
        ))}
        <a href="/producer/sources">{t(locale, "research.nav.sources")} ›</a>
      </div>
    </>
  );
}
