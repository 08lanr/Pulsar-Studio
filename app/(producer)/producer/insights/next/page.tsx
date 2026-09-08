import { portalSession, producerLocale } from "@/components/producer/server";
import InsightsNav from "@/components/producer/research/InsightsNav";
import { ChartCell, GrowthCell, LiftChip, ReasonChips, WhenCell, titleHref } from "@/components/producer/research/NextParts";
import { EvidenceTag, MetricLabel, ObservationCell, StateBadge, TropeChip, fmtPct, platformName } from "@/components/producer/research/ui";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { tagCatalogTitle } from "@/lib/research/engine";
import { whatToMakeNext, type RisingTrope } from "@/lib/research/next";
import { snapshotHistory } from "@/lib/research/snapshot";
import { tropeLabel } from "@/lib/research/taxonomy";
import { PLATFORMS, type Platform } from "@/lib/research/types";
export const dynamic = "force-dynamic";

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
    <>
      <div className="page-head">
        <div>
          <h1>{t(locale, "next.title")}</h1>
          <p className="page-sub">{latest ? t(locale, "next.sub", { date: latest.observed_at }) : t(locale, "next.overview.noData")}</p>
        </div>
      </div>
      <InsightsNav active="next" locale={locale} />
    </>
  );
  if (!latest) return <div className="market-brief">{head}<div className="rs-empty">{t(locale, "research.market.noData")}</div></div>;

  const board = whatToMakeNext({
    latest,
    previous: market.previous,
    history: snapshotHistory(),
    days: market.days,
    catalog: catalog.rows.map((r) => ({ id: r.id, tropes: tagCatalogTitle(r) })),
    limits: { tropes: 12, titles: 12, movers: 8 },
  });
  const tropes = sortTropes(board.tropes, sort);
  const recipes = tropes.slice(0, 3);
  const quoted = new Set<string>();
  const mine = new Set(profile?.tropes ?? []);
  const nameOf = (platform: Platform) => PLATFORMS.find((p) => p.id === platform)?.name ?? platformName(platform);
  const titleByKey = new Map(latest.titles.map((x) => [x.key, x]));

  return (
    <div className="market-brief">
      {head}
      <div className="nx-status">
        <span>{board.window.state === "ok" ? t(locale, "next.window.ok", { start: board.window.start, end: board.window.end, days: board.window.days }) : t(locale, "next.window.collecting")}</span>
        <StateBadge status={board.window.state === "ok" ? "available" : "collecting_history"} locale={locale} />
        <span>{t(locale, "next.fresh", { fresh: board.fresh_sample, sample: board.sample })}</span>
        <a href="/producer/sources/fresh_share">{t(locale, "next.nav.sources")}</a>
      </div>

      <section className="brief-section">
        <header>
          <div>
            <h2>{t(locale, "next.tropes.title")}</h2>
            <p>{t(locale, "next.tropes.sub")}</p>
          </div>
          <div className="rs-tool-row" role="group" aria-label={t(locale, "next.sort.label")}>
            {SORTS.map((s) => (
              <a key={s} className={`filter-chip${s === sort ? " on" : ""}`} href={s === "share" ? RETURN_TO : `${RETURN_TO}?sort=${s}`} aria-current={s === sort ? "true" : undefined}>{t(locale, `next.sort.${s}`)}</a>
            ))}
          </div>
        </header>
        <div className="gtable gtable-flush rs-table nx-tropes" style={{ ["--cols" as string]: "minmax(150px,1.2fr) minmax(170px,1.3fr) 110px 120px minmax(120px,1fr) 90px minmax(180px,1.6fr)" }}>
          <div className="gt-head">
            <span>{t(locale, "next.col.trope")}</span>
            <span><MetricLabel metric="fresh_share" locale={locale}>{t(locale, "next.col.freshShare")}</MetricLabel> <EvidenceTag evidence="inferred" locale={locale} /></span>
            <span>{t(locale, "next.col.lift")}</span>
            <span className="gt-num"><MetricLabel metric="fresh_growth" locale={locale}>{t(locale, "next.col.growth")}</MetricLabel></span>
            <span>{t(locale, "next.col.pair")}</span>
            <span>{t(locale, "next.col.mine")}</span>
            <span>{t(locale, "next.col.examples")}</span>
          </div>
          {tropes.map((s) => (
            <div className="gt-row" key={s.id}>
              <span className="nx-trope"><a href={`/producer/explore/titles?trope=${s.id}&newonly=1&mode=all`}>{tropeLabel(s.id, locale)}</a>{mine.has(s.id) && <small>{t(locale, "next.mine.profile")}</small>}</span>
              <span className="nx-share">
                <span className="rs-bar-track"><span className="rs-bar-fill" style={{ width: `${Math.round(s.fresh_share * 100)}%` }} /></span>
                <b>{fmtPct(s.fresh_share)}</b>
                <small>{s.fresh_titles}/{s.fresh_sample} · {Object.entries(s.by_platform).map(([p, n]) => `${nameOf(p as Platform)} ${n}`).join(" · ")}</small>
              </span>
              <span><LiftChip trope={s} locale={locale} /><br /><small className="gt-muted">{fmtPct(s.share)} {t(locale, "next.col.lift").toLowerCase()}</small></span>
              <span className="gt-num">{s.growth_pct != null ? <span className="nx-growth"><b>+{s.growth_pct}%</b><small>{t(locale, "next.growth.median", { n: s.n_growth })}</small></span> : <span className="nx-growth is-empty">{t(locale, board.window.state === "ok" ? "next.growth.none" : "next.growth.collecting")}</span>}</span>
              <span>{s.pair ? <>{tropeLabel(s.pair, locale)} <small className="gt-muted">{s.pair_titles}/{s.fresh_titles}</small></> : "—"}</span>
              <span>{s.catalog_ids.length ? <a href="/producer/titles">{t(locale, "next.mine.count", { n: s.catalog_ids.length })}</a> : <span className="gt-muted">{t(locale, "next.mine.none")}</span>}</span>
              <span className="nx-examples">
                {s.examples.slice(0, 2).map((k) => {
                  const x = titleByKey.get(k);
                  return x ? <a key={k} href={`/producer/market/${k}?returnTo=${encodeURIComponent(RETURN_TO)}`} lang="en">{x.title} <small>{nameOf(x.platform)}</small></a> : null;
                })}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="brief-section">
        <header>
          <div>
            <h2>{t(locale, "next.recipes.title")}</h2>
            <p>{t(locale, "next.recipes.sub")}</p>
          </div>
        </header>
        <div className="nx-recipes">
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
                  {s.growth_pct != null && board.window.state === "ok" && <span>{t(locale, "next.recipe.growth", { pct: s.growth_pct, start: board.window.start })}</span>}
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

      <div className="nx-platforms">
        {board.platforms.map((p) => (
          <section className="rs-panel" key={p.platform} id={`new-${p.platform}`}>
            <div className="rs-panel-head">
              <div>
                <h2>{t(locale, "next.platform.title", { platform: nameOf(p.platform) })}</h2>
                <p>{t(locale, board.window.state === "ok" ? "next.platform.sub" : "next.platform.subNoHistory", { fresh: p.fresh, sample: p.sample, platform: nameOf(p.platform) })}</p>
              </div>
              <span className="rs-panel-aside"><a href={`/producer/explore/titles?platform=${p.platform}&newonly=1&mode=all`}>{t(locale, "next.more", { platform: nameOf(p.platform) })} →</a></span>
            </div>
            {p.titles.length === 0 ? (
              <div className="rs-empty">{t(locale, "next.platform.none", { platform: nameOf(p.platform) })}</div>
            ) : (
              <div className="gtable gtable-flush rs-table" style={{ ["--cols" as string]: "minmax(200px,1.8fr) minmax(170px,1.3fr) minmax(130px,1fr) 100px 110px minmax(100px,.8fr) minmax(190px,1.5fr)" }}>
                <div className="gt-head">
                  <span>{t(locale, "next.col.title")}</span>
                  <span>{t(locale, "next.col.why")}</span>
                  <span>{t(locale, "next.col.when")}</span>
                  <span className="gt-num"><MetricLabel metric="views_counter" locale={locale}>{t(locale, "next.col.views")}</MetricLabel></span>
                  <span className="gt-num"><MetricLabel metric="fresh_growth" locale={locale}>{t(locale, "next.col.growthDay")}</MetricLabel></span>
                  <span>{t(locale, "next.col.chart")}</span>
                  <span>{t(locale, "next.col.story")}</span>
                </div>
                {p.titles.map((x) => (
                  <div className="gt-row" key={x.title.key}>
                    <span className="nx-title">
                      <a href={titleHref(x, RETURN_TO)} lang="en">{x.title.title}</a>
                      {x.premise && <span className="nx-premise" lang="en">{x.premise}</span>}
                    </span>
                    <span><ReasonChips reasons={x.reasons} locale={locale} /></span>
                    <span><WhenCell x={x} locale={locale} /></span>
                    <span className="gt-num"><ObservationCell o={x.views} locale={locale} /></span>
                    <span className="gt-num"><GrowthCell x={x} locale={locale} /></span>
                    <span><ChartCell x={x} locale={locale} /></span>
                    <span className="rs-tropes nx-story">{x.title.tropes.slice(0, 3).map((tr) => <TropeChip key={tr.id} id={tr.id} locale={locale} evidence={tr.evidence} mine={mine.has(tr.id)} />)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>

      <section className="brief-section">
        <header>
          <div>
            <h2>{t(locale, "next.sort.growth")}</h2>
            <p>{board.window.state === "ok" ? t(locale, "next.window.ok", { start: board.window.start, end: board.window.end, days: board.window.days }) : t(locale, "next.movers.collecting")}</p>
          </div>
          <MetricLabel metric="counter_velocity" locale={locale}>{t(locale, "ux.howCalculated")}</MetricLabel>
        </header>
        <div className="nx-movers">
          {board.platforms.map((p) => (
            <div className="rs-panel" key={p.platform}>
              <div className="rs-panel-head">
                <div>
                  <h3>{t(locale, "next.movers.title", { platform: nameOf(p.platform) })}</h3>
                  <p>{t(locale, "next.movers.sub", { platform: nameOf(p.platform) })}</p>
                </div>
              </div>
              {p.movers.length === 0 ? (
                <div className="rs-empty">{t(locale, "next.movers.collecting")}</div>
              ) : (
                p.movers.map((x, i) => (
                  <div className="nx-mover" key={x.title.key}>
                    <i>{i + 1}</i>
                    <span className="nx-title">
                      <a href={titleHref(x, RETURN_TO)} lang="en">{x.title.title}</a>
                      {x.reasons.length > 0 && <ReasonChips reasons={x.reasons.slice(0, 2)} locale={locale} />}
                    </span>
                    <GrowthCell x={x} locale={locale} />
                  </div>
                ))
              )}
            </div>
          ))}
        </div>
      </section>

      <footer className="brief-source-line">{t(locale, "next.basis", { version: board.taxonomy_version })} · {t(locale, "research.coverage", { listings: latest.titles.length, platforms: latest.platforms.length })}</footer>
    </div>
  );
}
