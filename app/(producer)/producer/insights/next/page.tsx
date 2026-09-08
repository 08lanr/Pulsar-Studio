import { portalSession, producerLocale } from "@/components/producer/server";
import { ChartCell, GrowthCell, LiftChip, ReasonChips, titleHref } from "@/components/producer/research/NextParts";
import { EvidenceTag, MetricLabel, ObservationCell, StateBadge, TropeChip, fmtPct, platformName } from "@/components/producer/research/ui";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { tagCatalogTitle } from "@/lib/research/engine";
import { whatToMakeNext, type RisingTrope } from "@/lib/research/next";
import { snapshotHistory } from "@/lib/research/snapshot";
import { tropeLabel } from "@/lib/research/taxonomy";
import { PLATFORMS, type Platform } from "@/lib/research/types";
export const dynamic = "force-dynamic";

// /producer/insights/next — What to make next (decision 2026-09-08, "status
// board"). Reads top-down: a four-tile summary of the collection, then the
// story-type leaderboard beside the three make-now briefs, then one panel per
// platform with its newest listings and its fastest movers. Every number keeps
// its evidence label; nothing here is pooled across platforms.

type Sort = "share" | "lift" | "growth";
const SORTS: Sort[] = ["share", "lift", "growth"];
const RETURN_TO = "/producer/insights/next";

function sortTropes(rows: RisingTrope[], sort: Sort): RisingTrope[] {
  const r = [...rows];
  if (sort === "lift") r.sort((a, b) => (b.lift ?? -1) - (a.lift ?? -1) || b.fresh_titles - a.fresh_titles);
  else if (sort === "growth") r.sort((a, b) => (b.growth_pct ?? -1) - (a.growth_pct ?? -1) || b.fresh_titles - a.fresh_titles);
  return r;
}

export default async function WhatToMakeNext({ searchParams }: { searchParams: { sort?: string } }) {
  const session = await portalSession("/producer/insights/next");
  const locale = producerLocale();
  const data = getData();
  const [market, profile, catalog] = await Promise.all([data.getMarket(session), data.getResearchProfile(session), data.listCatalogForMatching(session)]);
  const latest = market.latest;
  const sort: Sort = SORTS.includes(searchParams.sort as Sort) ? (searchParams.sort as Sort) : "share";
  const head = (
    <div className="page-head">
      <div>
        <h1>{t(locale, "next.title")}</h1>
        <p className="page-sub">{latest ? t(locale, "next.sub", { date: latest.observed_at }) : t(locale, "next.overview.noData")}</p>
      </div>
      <a className="btn btn-outline btn-sm" href="/producer/sources/fresh_share">{t(locale, "next.nav.sources")}</a>
    </div>
  );
  if (!latest) return <div className="market-brief nx-page">{head}<div className="rs-empty">{t(locale, "research.market.noData")}</div></div>;

  const board = whatToMakeNext({
    latest,
    previous: market.previous,
    history: snapshotHistory(),
    days: market.days,
    catalog: catalog.rows.map((r) => ({ id: r.id, tropes: tagCatalogTitle(r) })),
    limits: { tropes: 10, titles: 6, movers: 5 },
  });
  const tropes = sortTropes(board.tropes, sort);
  const recipes = board.tropes.slice(0, 3);
  const quoted = new Set<string>();
  const mine = new Set(profile?.tropes ?? []);
  const nameOf = (platform: Platform) => PLATFORMS.find((p) => p.id === platform)?.name ?? platformName(platform);
  const win = board.window.state === "ok" ? board.window : null;
  const historyOk = win !== null;

  // Summary tiles: the collection, the leading story type, the fastest riser, and the producer's own exposure.
  const leading = board.tropes[0] ?? null;
  const riser = historyOk ? [...board.tropes].filter((s) => s.growth_pct != null).sort((a, b) => (b.growth_pct ?? 0) - (a.growth_pct ?? 0))[0] ?? null : null;
  const mineOnTop = new Set(board.tropes.slice(0, 3).flatMap((s) => s.catalog_ids)).size;

  return (
    <div className="market-brief nx-page">
      {head}

      <div className="nx-summary">
        <div className="nx-tile">
          <span>{t(locale, "next.summary.fresh")}</span>
          <strong>{board.fresh_sample}<small>/ {board.sample}</small></strong>
          <small>{win ? t(locale, "next.window.ok", { start: win.start, end: win.end, days: win.days }) : t(locale, "next.window.collecting")} <StateBadge status={historyOk ? "available" : "collecting_history"} locale={locale} /></small>
        </div>
        <div className="nx-tile">
          <span>{t(locale, "next.summary.leading")}</span>
          <strong>{leading ? tropeLabel(leading.id, locale) : "—"}</strong>
          <small>{leading ? `${fmtPct(leading.fresh_share)} ${t(locale, "next.summary.ofNew")}` : t(locale, "next.mine.none")} <EvidenceTag evidence="inferred" locale={locale} /></small>
        </div>
        <div className="nx-tile">
          <span>{t(locale, "next.summary.rising")}</span>
          <strong>{riser ? tropeLabel(riser.id, locale) : "—"}</strong>
          <small>{riser ? `+${riser.growth_pct}% · ${t(locale, "next.growth.median", { n: riser.n_growth })}` : t(locale, "next.growth.collecting")}</small>
        </div>
        <div className="nx-tile">
          <span>{t(locale, "next.summary.mine")}</span>
          <strong>{mineOnTop}</strong>
          <small><a href="/producer/titles">{t(locale, "next.summary.mineHint")}</a></small>
        </div>
      </div>

      <div className="nx-columns">
        <section className="brief-section nx-board-section">
          <header>
            <div>
              <h2>{t(locale, "next.tropes.title")}</h2>
              <p>{t(locale, "next.tropes.oneLine")}</p>
            </div>
            <div className="rs-tool-row" role="group" aria-label={t(locale, "next.sort.label")}>
              {SORTS.map((s) => (
                <a key={s} className={`filter-chip${s === sort ? " on" : ""}`} href={s === "share" ? RETURN_TO : `${RETURN_TO}?sort=${s}`} aria-current={s === sort ? "true" : undefined}>{t(locale, `next.sort.${s}`)}</a>
              ))}
            </div>
          </header>
          <ol className="nx-board">
            <li className="nx-board-head" aria-hidden="true">
              <span />
              <span>{t(locale, "next.col.trope")}</span>
              <span>{t(locale, "next.board.share")} <EvidenceTag evidence="inferred" locale={locale} /></span>
              <span className="num"><MetricLabel metric="fresh_share" locale={locale}>{t(locale, "next.board.lift")}</MetricLabel></span>
              <span className="num"><MetricLabel metric="fresh_growth" locale={locale}>{t(locale, "next.col.viewGrowth")}</MetricLabel></span>
            </li>
            {tropes.map((s, i) => {
              const exploreHref = `/producer/explore/titles?trope=${s.id}&newonly=1&mode=all`;
              return (
                <li className="nx-board-row" key={s.id}>
                  <i aria-hidden="true">{i + 1}</i>
                  <div className="nx-board-name">
                    <div>
                      <a className="nx-board-title" href={exploreHref}>{tropeLabel(s.id, locale)}</a>
                      {mine.has(s.id) && <span className="nx-tag">{t(locale, "next.mine.profile")}</span>}
                    </div>
                    <small>
                      {s.pair && <>{t(locale, "next.col.pair")} {tropeLabel(s.pair, locale)} ({s.pair_titles}/{s.fresh_titles})</>}
                      {s.pair && s.catalog_ids.length > 0 && " · "}
                      {s.catalog_ids.length > 0 && <a href="/producer/titles">{t(locale, "next.mine.yours", { n: s.catalog_ids.length })}</a>}
                    </small>
                  </div>
                  <div className="nx-board-share">
                    <div className="bar">
                      <span className="rs-bar-track"><span className="rs-bar-fill" style={{ width: `${Math.round(s.fresh_share * 100)}%` }} /></span>
                      <b>{fmtPct(s.fresh_share)}</b>
                    </div>
                    <small>{t(locale, "next.board.ofNew", { n: s.fresh_titles, sample: s.fresh_sample })} · {Object.entries(s.by_platform).map(([p, n]) => `${nameOf(p as Platform)} ${n}`).join(" · ")} · <a href={exploreHref}>{t(locale, "next.board.see")} →</a></small>
                  </div>
                  <div className="nx-board-num">
                    <LiftChip trope={s} locale={locale} />
                    <small>{t(locale, "next.col.lift")}</small>
                  </div>
                  <div className="nx-board-num">
                    {s.growth_pct != null && historyOk ? <><b className={s.growth_pct >= 0 ? "nx-up" : ""}>{s.growth_pct >= 0 ? "+" : ""}{s.growth_pct}%</b><small>{t(locale, "next.growth.median", { n: s.n_growth })}</small></> : <><b className="gt-muted">—</b><small>{t(locale, historyOk ? "next.growth.none" : "next.growth.collecting")}</small></>}
                  </div>
                </li>
              );
            })}
          </ol>
          <footer className="nx-board-foot"><MetricLabel metric="fresh_share" locale={locale}>{t(locale, "next.tropes.subShort")}</MetricLabel></footer>
        </section>

        <section className="brief-section nx-recipes-section">
          <header>
            <div>
              <h2>{t(locale, "next.recipes.title")}</h2>
              <p>{t(locale, "next.recipes.sub")}</p>
            </div>
          </header>
          <div className="nx-recipes nx-recipes-stack">
            {recipes.map((s) => {
              const fmt = board.platforms.map((p) => p.format).find((f) => f && (s.by_platform[f.platform] ?? 0) > 0 && f.median_episodes != null) ?? null;
              const premise = s.premises.find((p) => !quoted.has(p.key)) ?? s.premises[0] ?? null;
              if (premise) quoted.add(premise.key);
              return (
                <article className="nx-recipe" key={s.id}>
                  <h3>{tropeLabel(s.id, locale)}{s.pair && <span> {t(locale, "next.recipe.with")} {tropeLabel(s.pair, locale)}</span>}</h3>
                  <div className="nx-recipe-share">
                    <span><b>{fmtPct(s.fresh_share)}</b> · {t(locale, "next.recipe.share", { n: s.fresh_titles, sample: s.fresh_sample })}</span>
                    {s.lift != null && <span>{t(locale, "next.recipe.lift", { lift: s.lift.toFixed(2) })}</span>}
                    {s.growth_pct != null && win && <span>{t(locale, "next.recipe.growth", { pct: s.growth_pct, start: win.start })}</span>}
                  </div>
                  <ul>
                    <li>{s.pair ? t(locale, "next.recipe.structure", { trope: tropeLabel(s.id, locale), pair: tropeLabel(s.pair, locale), n: s.pair_titles }) : t(locale, "next.recipe.structureSolo", { trope: tropeLabel(s.id, locale) })}</li>
                    {fmt && <li>{fmt.median_paywall_episode != null ? t(locale, "next.recipe.format", { platform: nameOf(fmt.platform), eps: fmt.median_episodes!, pay: fmt.median_paywall_episode }) : t(locale, "next.recipe.formatNoPay", { platform: nameOf(fmt.platform), eps: fmt.median_episodes! })}</li>}
                    <li>{s.catalog_ids.length ? t(locale, "next.recipe.mine", { n: s.catalog_ids.length }) : t(locale, "next.recipe.mineNone")}</li>
                  </ul>
                  {premise && (
                    <blockquote lang="en">
                      <span className="gt-muted">{t(locale, "next.recipe.premise")}: </span>{premise.sentence}
                      <cite>{premise.title} · {nameOf(premise.platform)}</cite>
                    </blockquote>
                  )}
                  <div className="nx-recipe-foot">
                    <a href={`/producer/explore/titles?trope=${s.id}&newonly=1&mode=all`}>{t(locale, "next.recipe.see")} →</a>
                    <EvidenceTag evidence="inferred" locale={locale} />
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </div>

      <div className="nx-platforms nx-platforms-grid">
        {board.platforms.map((p) => (
          <section className="brief-section nx-platform" key={p.platform} id={`new-${p.platform}`}>
            <header>
              <div>
                <h2>{t(locale, "next.platform.title", { platform: nameOf(p.platform) })}</h2>
                <p>{t(locale, historyOk ? "next.platform.sub" : "next.platform.subNoHistory", { fresh: p.fresh, sample: p.sample, platform: nameOf(p.platform) })}</p>
              </div>
              <a href={`/producer/explore/titles?platform=${p.platform}&newonly=1&mode=all`}>{t(locale, "next.more", { platform: nameOf(p.platform) })} →</a>
            </header>
            {p.titles.length === 0 ? (
              <div className="rs-empty">{t(locale, "next.platform.none", { platform: nameOf(p.platform) })}</div>
            ) : (
              <ol className="nx-fresh">
                <li className="nx-fresh-head" aria-hidden="true">
                  <span>{t(locale, "next.col.title")}</span>
                  <span><MetricLabel metric="views_counter" locale={locale}>{t(locale, "next.col.views")}</MetricLabel></span>
                  <span><MetricLabel metric="fresh_growth" locale={locale}>{t(locale, "next.col.growthDay")}</MetricLabel></span>
                  <span>{t(locale, "next.col.chart")}</span>
                </li>
                {p.titles.map((x) => (
                  <li className="nx-fresh-row" key={x.title.key}>
                    <div className="nx-title">
                      <a href={titleHref(x, RETURN_TO)} lang="en">{x.title.title}</a>
                      {x.premise && <span className="nx-premise" lang="en">{x.premise}</span>}
                      <div className="nx-fresh-tags">
                        <ReasonChips reasons={x.reasons.slice(0, 2)} locale={locale} />
                        <span className="rs-tropes nx-story">{x.title.tropes.slice(0, 2).map((tr) => <TropeChip key={tr.id} id={tr.id} locale={locale} evidence={tr.evidence} mine={mine.has(tr.id)} />)}</span>
                      </div>
                    </div>
                    <div className="nx-fresh-stat"><ObservationCell o={x.views} locale={locale} /></div>
                    <div className="nx-fresh-stat"><GrowthCell x={x} locale={locale} compact /></div>
                    <div className="nx-fresh-stat"><ChartCell x={x} locale={locale} /></div>
                  </li>
                ))}
              </ol>
            )}
            <div className="nx-movers-mini">
              <h3>{t(locale, "next.movers.title", { platform: nameOf(p.platform) })} <MetricLabel metric="counter_velocity" locale={locale}>{t(locale, "ux.howCalculated")}</MetricLabel></h3>
              {p.movers.length === 0 ? (
                <p className="gt-muted">{t(locale, "next.movers.collecting")}</p>
              ) : (
                <ol>
                  {p.movers.map((x, i) => (
                    <li key={x.title.key}>
                      <i aria-hidden="true">{i + 1}</i>
                      <a href={titleHref(x, RETURN_TO)} lang="en">{x.title.title}</a>
                      <GrowthCell x={x} locale={locale} compact />
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>
        ))}
      </div>

      <footer className="brief-source-line">{t(locale, "next.basis", { version: board.taxonomy_version })} · {t(locale, "research.coverage", { listings: latest.titles.length, platforms: latest.platforms.length })}</footer>
    </div>
  );
}
