import { t, type Locale } from "@/lib/i18n";
import { whatToMakeNext, type FreshTitle, type RisingTrope } from "@/lib/research/next";
import type { MarketView } from "@/lib/research/snapshot";
import { snapshotHistory } from "@/lib/research/snapshot";
import type { WorkspaceTitle } from "@/lib/research/workspace";
import { tropeLabel } from "@/lib/research/taxonomy";
import { fmtCount, fmtPct, platformName } from "./ui";
import { GrowthCell, ReasonChips, titleHref } from "./NextParts";

// The Overview's "What to make next" view (decision 2026-09-09): one row per
// story type the platforms are launching, read left to right as a decision:
// what it is → whether its listings are being watched more since the last
// collection (per platform, never pooled) → which of my titles carry it →
// where to look closer. Drill-down stays on the page (top new listings
// expand in place); "View listings" opens the Explore tab already filtered.

const RETURN_TO = "/producer?view=opportunities";
const exploreFor = (trope: string) => `/producer/explore/titles?trope=${trope}&newonly=1&mode=all`;

function growthRank(x: FreshTitle): number {
  return x.growth.state === "ok" ? x.growth.per_day : -1;
}

function ViewsAdded({ s, locale, windowStart }: { s: RisingTrope; locale: Locale; windowStart: string | null }) {
  if (!windowStart || s.views_added.length === 0) return <small className="desk-collecting">{t(locale, "desk.viewsCollecting")}</small>;
  return (
    <ul className="desk-views-list">
      {s.views_added.map((v) => (
        <li key={v.platform}>
          <span className="desk-views-platform">{platformName(v.platform)}</span>
          {v.with_baseline > 0 ? (
            <>
              <strong className="desk-views-delta">+{fmtCount(v.delta)}</strong>
              <small>{v.growth_pct != null ? `+${v.growth_pct}%` : "–"} · {t(locale, "desk.withBaseline", { n: v.with_baseline, total: v.listings })}</small>
            </>
          ) : (
            <small className="desk-collecting">{t(locale, "desk.noBaseline", { n: v.listings })}</small>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function NextMini({ market, locale, catalog = [] }: { market: MarketView; locale: Locale; catalog?: WorkspaceTitle[] }) {
  const latest = market.latest;
  if (!latest) return <section className="rs-empty"><h2>{t(locale, "desk.signals")}</h2><p>{t(locale, "next.overview.noData")}</p><a href="/producer/sources">{t(locale, "next.nav.sources")}</a></section>;
  const board = whatToMakeNext({ latest, previous: market.previous, history: snapshotHistory(), days: market.days, catalog: catalog.map((x) => ({ id: x.summary.id, tropes: x.assessment.tropes })), limits: { tropes: 5, titles: 40, movers: 0 } });
  const windowStart = board.window.state === "ok" ? board.window.start : null;
  const freshByKey = new Map<string, FreshTitle>();
  for (const p of board.platforms) for (const x of p.titles) freshByKey.set(x.title.key, x);
  const nameOf = (x: WorkspaceTitle) => (locale === "zh" ? x.summary.name_zh : x.summary.name_en || x.summary.name_zh);

  return (
    <section className="desk-market" aria-labelledby="market-signals">
      <header className="desk-market-head">
        <div>
          <h2 id="market-signals">{t(locale, "desk.signals")}</h2>
          <p>{t(locale, "desk.signalSub")}</p>
        </div>
        <a className="desk-head-link" href="/producer/insights/next">{t(locale, "desk.fullBoard")} →</a>
      </header>
      <div className="desk-evidence">
        <span>{t(locale, "next.fresh", { fresh: board.fresh_sample, sample: board.sample })}</span>
        <span>{t(locale, "desk.collected", { date: latest.observed_at })}</span>
        <span>{windowStart ? t(locale, "next.window.ok", { start: board.window.state === "ok" ? board.window.start : "", end: board.window.state === "ok" ? board.window.end : "", days: board.window.state === "ok" ? board.window.days : 0 }) : t(locale, "next.window.collecting")}</span>
      </div>

      {!board.tropes.length ? (
        <p className="rs-empty">{t(locale, "desk.noSignals")}</p>
      ) : (
        <div className="desk-signals">
          <div className="desk-signal desk-signal-head" aria-hidden="true">
            <span>{t(locale, "next.col.trope")}</span>
            <span>{windowStart ? t(locale, "desk.viewsAdded", { start: windowStart }) : t(locale, "desk.viewsAddedNoWindow")}</span>
            <span>{t(locale, "next.col.mine")}</span>
            <span />
          </div>
          {board.tropes.map((s) => {
            const topNew = s.examples
              .map((k) => freshByKey.get(k))
              .filter((x): x is FreshTitle => Boolean(x))
              .sort((a, b) => growthRank(b) - growthRank(a) || (b.prominence ?? -1) - (a.prominence ?? -1))
              .slice(0, 3);
            const mine = s.catalog_ids.map((id) => catalog.find((x) => x.summary.id === id)).filter((x): x is WorkspaceTitle => Boolean(x));
            return (
              <article className="desk-signal" key={s.id}>
                <div className="desk-signal-title">
                  <h3><a href={exploreFor(s.id)}>{tropeLabel(s.id, locale)}</a></h3>
                  <span className="desk-signal-share"><b>{fmtPct(s.fresh_share)}</b> · {t(locale, "next.recipe.share", { n: s.fresh_titles, sample: s.fresh_sample })}</span>
                  <span className="desk-share-bar" aria-hidden="true"><span style={{ width: `${Math.round(s.fresh_share * 100)}%` }} /></span>
                  <span className="desk-signal-tag">{t(locale, "desk.inferred")}{s.lift != null ? ` · ${t(locale, "desk.vsAll", { pct: fmtPct(s.share) })}` : ""}</span>
                </div>
                <div className="desk-views">
                  <ViewsAdded s={s} locale={locale} windowStart={windowStart} />
                </div>
                <div className="desk-catalog-match">
                  {mine.length ? (
                    <>
                      <a className="desk-match-count" href={`/producer/titles?trope=${s.id}`}>{t(locale, mine.length === 1 ? "desk.oneTitle" : "next.mine.count", { n: mine.length })} →</a>
                      {mine.slice(0, 2).map((x) => <a key={x.summary.id} href={`/producer/titles/${x.summary.id}`}>{nameOf(x)}</a>)}
                    </>
                  ) : (
                    <small>{t(locale, "next.recipe.mineNone")}</small>
                  )}
                </div>
                <div className="desk-signal-actions">
                  <a className="btn btn-outline btn-sm" href={exploreFor(s.id)}>{t(locale, "desk.viewListings")}</a>
                </div>
                {topNew.length > 0 && (
                  <details className="desk-signal-more">
                    <summary>{t(locale, "desk.topNew", { n: topNew.length })}</summary>
                    <ul>
                      {topNew.map((x) => (
                        <li key={x.title.key}>
                          <span className="desk-more-title"><a href={titleHref(x, RETURN_TO)} lang="en">{x.title.title}</a><small>{platformName(x.title.platform)} · <ReasonChips reasons={x.reasons.slice(0, 1)} locale={locale} /></small></span>
                          <span className="desk-more-views">{x.views ? <><b>{fmtCount(x.views.value)}</b><small>{t(locale, "research.col.views")}</small></> : <small>{t(locale, "ux.unknown")}</small>}</span>
                          <GrowthCell x={x} locale={locale} />
                        </li>
                      ))}
                    </ul>
                    <a className="desk-more-link" href={exploreFor(s.id)}>{t(locale, "desk.moreInExplore")} →</a>
                  </details>
                )}
              </article>
            );
          })}
        </div>
      )}
      <p className="desk-method">{t(locale, "desk.method")} <a href="/producer/sources/trope_views_added">{t(locale, "desk.howComputed")}</a> · <a href="/producer/insights/next">{t(locale, "desk.definitions")}</a></p>

      <section className="desk-examples" aria-labelledby="listing-examples">
        <header>
          <div>
            <h2 id="listing-examples">{t(locale, "desk.examples")}</h2>
            <p>{t(locale, "desk.examplesSub")}</p>
          </div>
        </header>
        <div className="desk-platforms">
          {board.platforms.map((p) => (
            <section key={p.platform}>
              <h3>{platformName(p.platform)} <small>{t(locale, "desk.newOn", { n: p.fresh, sample: p.sample })}</small></h3>
              {p.titles.length ? (
                <ul>
                  {p.titles.slice(0, 3).map((x) => (
                    <li key={x.title.key}>
                      <span className="desk-more-title"><a href={titleHref(x, RETURN_TO)} lang="en">{x.title.title}</a><ReasonChips reasons={x.reasons.slice(0, 1)} locale={locale} /></span>
                      <span className="desk-more-views">{x.views ? <><b>{fmtCount(x.views.value)}</b><small>{t(locale, "research.col.views")}</small></> : <small>{t(locale, "ux.unknown")}</small>}</span>
                      <GrowthCell x={x} locale={locale} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t(locale, "desk.noSignals")}</p>
              )}
              <a className="desk-more-link" href={`/producer/explore/titles?platform=${p.platform}&newonly=1&mode=all`}>{t(locale, "desk.exploreNew", { platform: platformName(p.platform) })} →</a>
            </section>
          ))}
        </div>
      </section>
    </section>
  );
}
