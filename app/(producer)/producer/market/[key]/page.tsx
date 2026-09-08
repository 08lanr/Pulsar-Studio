import Cover from '@/components/producer/research/Cover';
import { Counter } from '@/components/producer/research/DramaCard';
import { safeReturn } from '@/lib/research/navigation';
import { exploreHref } from '@/components/producer/research/ui';
import { notFound } from "next/navigation";
import WatchButton from "@/components/producer/research/WatchButton";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { EvidenceTag, MetricLabel, ObservationCell, Prominence, StateBadge, TropeChip, fmtCount, fmtSeconds, fmtUtc, platformName, unitLabel } from "@/components/producer/research/ui";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { findTitle, firstSentence, scoreSnapshot, similarTitles, tagCatalogTitle, tropeStats } from "@/lib/research/engine";
import { counterMovement, firstSeen, hasHistory, rankMovement } from "@/lib/research/history";
import { statusFor } from "@/lib/research/registry";
import { snapshotHistory } from "@/lib/research/snapshot";
import type { MarketTitle } from "@/lib/research/types";

// /producer/market/[key] — one platform listing, in six tabs:
// Overview · Trends · Story & format · Creative examples · Comparables ·
// Sources. Every number shows its evidence; the Sources tab shows the
// field, unit and read time behind each one. Trends say "collecting
// history" until a second observation day exists.

export const dynamic = "force-dynamic";

type Tab = "overview" | "trends" | "sources";
const TABS: Tab[] = ["overview", "trends", "sources"];

export default async function MarketTitlePage({ params, searchParams }: { params: { key: string }; searchParams: { tab?: string; returnTo?: string } }) {
  const session = await portalSession(`/producer/market/${params.key}`);
  const locale = producerLocale();
  const data = getData();
  const [market, profile, catalog, watchlist] = await Promise.all([data.getMarket(session), data.getResearchProfile(session), data.listCatalogForMatching(session), data.listWatchlist(session)]);
  if (!market.latest) notFound();
  const snapshot = market.latest;
  const canAct = !isStaffPreview(session) && (session.producerRole === "approver" || session.producerRole === "reviewer");
  const title = findTitle(snapshot, params.key);
  if (!title) notFound();
  const tab: Tab = TABS.includes(searchParams.tab as Tab) ? (searchParams.tab as Tab) : "overview";
  const scores = scoreSnapshot(snapshot);
  const score = scores.get(title.key)!;
  const stats = tropeStats(snapshot.titles, scores, snapshot.taxonomy_version);
  const hot = new Set(stats.slice(0, 10).map((s) => s.id));
  const mine = new Set(profile?.tropes ?? []);
  const similar = similarTitles(title, snapshot.titles, scores, 8);
  const targetTropes = new Set(title.tropes.map((x) => x.id));
  const run = snapshot.platforms.find((p) => p.id === title.platform)!;
  const history = hasHistory(market.days);
  const historyState = statusFor("history", { view: market, hasReports: false, hasProfile: Boolean(profile) });
  const previousTitle: MarketTitle | null = market.previous ? findTitle(market.previous, title.key) : null;
  const seen = history ? firstSeen(title.key, snapshotHistory()) : null;
  const comparable = catalog.rows
    .map((r) => ({ id: r.id, name_zh: r.name_zh, name_en: r.name_en, tropes: tagCatalogTitle(r) }))
    .map((c) => ({ ...c, overlap: c.tropes.filter((id) => targetTropes.has(id)) }))
    .filter((c) => c.overlap.length > 0)
    .sort((a, b) => b.overlap.length - a.overlap.length)
    .slice(0, 6);
  const returnTo=safeReturn(searchParams.returnTo);
  const base=Object.fromEntries(new URL(returnTo,'https://studio.local').searchParams);
  const tabHref=(x:Tab)=>`/producer/market/${title.key}?tab=${x}&returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <>
      <nav className="studio-crumbs" aria-label={t(locale, "v3.breadcrumbs")}>
        <a href="/producer">{t(locale, "research.nav.overview")}</a>
        <span>›</span>
        <a href={returnTo}>{t(locale, "research.explore.titles")}</a>
        <span>›</span>
        <span lang="en">{title.title}</span>
      </nav>

      <section className="rs-panel" style={{ padding: 18, marginBottom: 16 }}>
        <div className="rs-detail-hero">
          {/* eslint-disable-next-line @next/next/no-img-element -- third-party cover, not proxied */}
          <Cover src={title.cover} title={title.title} className="rs-cover rs-cover-lg"/>
          <div style={{ minWidth: 0, flex: 1 }}>
            <span className="page-kicker">
              {platformName(title.platform)}
              {title.audience ? ` · ${t(locale, `research.audience.${title.audience}`)}` : ""}
              {title.platform_new ? ` · ${t(locale, "research.title.platformNew")}` : ""}
              {run.status === "stale" ? " · " : ""}{run.status === "stale" && <StateBadge status="stale" locale={locale} />}
            </span>
            <h1 lang="en">{title.title}</h1>
            <div className="rs-tropes">
              {title.tropes.map((x) => <TropeChip key={x.id} id={x.id} locale={locale} hot={hot.has(x.id)} mine={mine.has(x.id)} evidence={x.evidence} href={exploreHref(base,{trope:x.id,page:undefined})} />)}
            </div>
            <div className="rs-hero-stats"><Counter title={title} kind="views" locale={locale}/><Counter title={title} kind="saves" locale={locale}/></div>
            <p style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <a className="btn btn-outline btn-sm" href={title.url} target="_blank" rel="noreferrer noopener">{t(locale, "research.title.open", { platform: platformName(title.platform) })}</a>
              <WatchButton listingKey={title.key} watching={watchlist.some((w) => w.listing_key === title.key)} canAct={canAct} />
            </p>
          </div>
        </div>
      </section>

      <nav className="tabs rs-tabs" aria-label={t(locale, "research.tab.overview")}>
        {TABS.map((x) => (
          <a key={x} className={`tab${x === tab ? " is-active" : ""}`} href={tabHref(x)} aria-current={x === tab ? "page" : undefined}>{t(locale, `research.tab.${x}`)}</a>
        ))}
      </nav>

      <div className="brief-detail-body">
      {tab === "overview" && (
        <div className="rs-detail">
          <div>
            <section className="rs-panel" style={{ marginBottom: 20 }}>
              <div className="rs-panel-head"><div><h2>{t(locale, "research.title.blurb")}</h2></div></div>
              <div className="rs-panel-body"><p lang="en" style={{ margin: 0, lineHeight: 1.6 }}>{title.blurb || "–"}</p></div>
            </section>
            <section className="rs-panel">
              <div className="rs-panel-head"><div><h2>{t(locale, "research.title.similar")}</h2><p>{t(locale, "research.title.similarNote")}</p></div></div>
              <ul className="rs-list">
                {similar.slice(0, 5).map((s) => (
                  <li key={s.title.key}>
                    <a href={`/producer/market/${s.title.key}?returnTo=${encodeURIComponent(returnTo)}`} className="rs-title-name" lang="en">{s.title.title}</a>
                    <span className="rs-platform">{platformName(s.title.platform)}</span>
                    <span className="rs-tropes clip">{s.overlap.slice(0, 3).map((id) => <TropeChip key={id} id={id} locale={locale} hot={hot.has(id)} />)}</span>
                    <span className="spacer" />

                  </li>
                ))}
              </ul>
            </section>
          </div>
          <aside>
            <section className="rs-panel" style={{ marginBottom: 20 }}>
              <dl className="rs-kv">
                <dt>{t(locale, "research.col.episodes")}</dt><dd>{title.episode_count ?? "–"}</dd>
                <dt><MetricLabel metric="paywall_episode" locale={locale}>{t(locale, "research.col.paywall")}</MetricLabel></dt><dd>{title.paywall_episode ?? "–"}</dd>
                <dt><MetricLabel metric="episode_length" locale={locale}>{t(locale, "research.stat.episodeSeconds")}</MetricLabel></dt><dd>{fmtSeconds(title.episode_seconds)}{title.episode_seconds_basis ? <small className="gt-muted"> ({t(locale, `research.basis.${title.episode_seconds_basis}`)})</small> : null}</dd>
                {title.released_at && <><dt>{t(locale, "research.col.released")}</dt><dd>{title.released_at} <EvidenceTag evidence="observed" locale={locale} /></dd></>}
                {seen && <><dt>{t(locale, "research.title.firstSeen")}</dt><dd>{seen}</dd></>}
                {title.metrics.rating && <><dt>{t(locale, "research.col.rating")}</dt><dd>{title.metrics.rating.value} <EvidenceTag evidence="observed" locale={locale} /></dd></>}
                <dt><MetricLabel metric="company_role" locale={locale}>{t(locale, "research.col.company")}</MetricLabel></dt>
                <dd>{title.companies.length === 0 ? <span className="gt-muted">{t(locale, "research.state.notShown")}</span> : title.companies.map((c) => <span key={`${c.role}|${c.name}`}>{c.name} <small className="gt-muted">({t(locale, `research.role.${c.role}`)})</small> <EvidenceTag evidence={c.evidence} locale={locale} /></span>)}</dd>
              </dl>
            </section>
            <section className="rs-panel">
              <div className="rs-panel-head"><div><h2>{t(locale, "research.title.placements")}</h2></div></div>
              <ul className="rs-list">
                {title.placements.map((p) => <li key={p.list}><span>{p.name}</span>{p.chart && <span className="ev ev-observed">{t(locale, "research.col.chartRank")}</span>}<span className="spacer" /><b>#{p.rank}</b></li>)}
              </ul>
            </section>
          </aside>
        </div>
      )}

      {tab === "trends" && (
        <section className="rs-panel">
          <div className="rs-panel-head"><div><h2>{t(locale, "research.tab.trends")}</h2><p>{t(locale, "research.market.observed", { date: snapshot.observed_at })}{market.previous ? ` · ${market.previous.observed_at}` : ""}</p></div><span className="rs-panel-aside"><StateBadge status={historyState} locale={locale} /></span></div>
          {!history ? (
            <div className="rs-empty">{t(locale, "research.title.trendsEmpty", { days: market.days.length })}</div>
          ) : (
            <dl className="rs-kv">
              {(["views", "saves"] as const).map((m) => {
                const mv = counterMovement(m, title, previousTitle, history);
                return (
                  <div key={m} style={{ display: "contents" }}>
                    <dt><MetricLabel metric="counter_velocity" locale={locale}>{m === "views" ? t(locale, "research.col.views") : t(locale, "research.col.saves")}</MetricLabel></dt>
                    <dd>
                      {mv.state === "ok" && <>{t(locale, "research.title.counter.ok", { delta: fmtCount(mv.delta), days: mv.elapsed_days, perDay: fmtCount(mv.per_day) })} <small className="gt-muted">{fmtUtc(mv.start_at)} → {fmtUtc(mv.end_at)}</small></>}
                      {mv.state === "anomaly" && <span className="ev ev-inferred">{t(locale, "research.title.counter.anomaly", { start: fmtCount(mv.start), end: fmtCount(mv.end) })}</span>}
                      {mv.state === "no_baseline" && (mv.reason === "first_seen" ? t(locale, "research.title.counter.noBaseline") : t(locale, "research.title.counter.noCounter"))}
                      {mv.state === "incomparable" && <>{t(locale, "research.title.counter.noCounter")} <small className="gt-muted">{mv.reason}</small></>}
                      {mv.state === "collecting_history" && <StateBadge status="collecting_history" locale={locale} />}
                    </dd>
                  </div>
                );
              })}
              {Array.from(new Set([...title.placements, ...(previousTitle?.placements ?? [])].filter((p) => p.chart).map((p) => p.list))).map((list) => {
                const rm = rankMovement(list, title, previousTitle, history);
                const name = [...title.placements, ...(previousTitle?.placements ?? [])].find((p) => p.list === list)?.name ?? list;
                return (
                  <div key={list} style={{ display: "contents" }}>
                    <dt><MetricLabel metric="rank_movement" locale={locale}>{name}</MetricLabel></dt>
                    <dd>
                      {rm.state === "ok" && t(locale, "research.title.rankMove.ok", { list: name, prior: rm.prior_rank, rank: rm.rank, movement: rm.movement > 0 ? `↑${rm.movement}` : rm.movement < 0 ? `↓${Math.abs(rm.movement)}` : "="})}
                      {rm.state === "entered" && t(locale, "research.title.rankMove.entered", { list: name, rank: rm.rank })}
                      {rm.state === "exited" && t(locale, "research.title.rankMove.exited", { list: name, rank: rm.prior_rank })}
                      {rm.state === "absent" && t(locale, "research.title.rankMove.absent")}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
        </section>
      )}

      {tab === "overview" && (
        <div className="rs-detail">
          <section className="rs-panel">
            <div className="rs-panel-head"><div><h2>{t(locale, "research.title.yourMatches")}</h2><p>{t(locale, "research.section.yourTitlesSub")}</p></div></div>
            {catalog.total === 0 ? (
              <div className="rs-empty">{t(locale, "research.state.noCatalog")}</div>
            ) : comparable.length === 0 ? (
              <div className="rs-empty">{t(locale, "research.mine.untagged")}</div>
            ) : (
              <ul className="rs-list">
                {comparable.map((c) => (
                  <li key={c.id}>
                    <a href={`/producer/titles/${c.id}`} className="rs-title-name bilingual" lang="zh-CN">{c.name_zh}{c.name_en ? ` · ${c.name_en}` : ""}</a>
                    <span className="rs-tropes clip">{c.overlap.slice(0, 3).map((id) => <TropeChip key={id} id={id} locale={locale} hot={hot.has(id)} evidence="inferred" />)}</span>
                  </li>
                ))}
              </ul>
            )}
            {catalog.truncated && <div className="rs-panel-foot">{t(locale, "research.mine.truncated", { shown: catalog.rows.length, total: catalog.total })}</div>}
          </section>
        </div>
      )}

      {tab === "sources" && (
        <section className="rs-panel">
          <div className="rs-panel-head"><div><h2>{t(locale, "research.tab.sources")}</h2><p>{t(locale, "research.title.sourcesNote")} {t(locale, "research.title.identityNote")}</p></div><span className="rs-panel-aside"><a href={`/producer/sources/${title.platform}_web`}>{t(locale, "research.nav.sources")} ›</a></span></div>
          <div className="gtable gtable-flush rs-table" style={{ ["--cols" as string]: "minmax(0,1.2fr) minmax(0,1fr) 110px 120px 170px 110px" }}>
            <div className="gt-head"><span>{t(locale, "research.sources.metrics")}</span><span>{t(locale, "research.title.field")}</span><span>{t(locale, "research.title.unit")}</span><span className="gt-num">{t(locale, "research.col.views")}</span><span>{t(locale, "research.title.observedAt")}</span><span>{t(locale, "research.sources.evidence")}</span></div>
            {(["views", "saves", "rating"] as const).map((m) => {
              const o = title.metrics[m];
              return (
                <div className="gt-row" key={m}>
                  <span><MetricLabel metric={m === "rating" ? "views_counter" : `${m}_counter`} locale={locale}>{m === "views" ? t(locale, "research.col.views") : m === "saves" ? t(locale, "research.col.saves") : t(locale, "research.col.rating")}</MetricLabel></span>
                  <span>{o?.source_field ?? <span className="gt-muted">{t(locale, "research.state.notShown")}</span>}</span>
                  <span>{o ? unitLabel(o.unit, locale) : "–"}</span>
                  <span className="gt-num">{o ? (o.value === 0 ? t(locale, "research.state.validZero") : o.value.toLocaleString("en-US")) : "–"}</span>
                  <span>{o ? fmtUtc(o.observed_at) : "–"}</span>
                  <span>{o ? <EvidenceTag evidence={o.evidence} locale={locale} /> : "–"}</span>
                </div>
              );
            })}
            <div className="gt-row"><span><MetricLabel metric="chart_visibility" locale={locale}>{t(locale, "research.col.chartRank")}</MetricLabel></span><span>placements[].rank</span><span>rank</span><span className="gt-num">{score.best_chart_rank ?? "–"}</span><span>{fmtUtc(run.fetched_at)}</span><span><EvidenceTag evidence="observed" locale={locale} /></span></div>
            <div className="gt-row"><span><MetricLabel metric="prominence" locale={locale}>{t(locale, "research.col.prominence")}</MetricLabel></span><span>view_percentile, chart_visibility</span><span>0–100</span><span className="gt-num">{score.prominence ?? "–"}</span><span>{fmtUtc(run.fetched_at)}</span><span><EvidenceTag evidence="inferred" locale={locale} /></span></div>
            {title.companies.map((c) => <div className="gt-row" key={c.name}><span><MetricLabel metric="company_role" locale={locale}>{t(locale, "research.col.company")}</MetricLabel></span><span>{c.via}</span><span>{t(locale, `research.role.${c.role}`)}</span><span className="gt-num">{c.name}</span><span>{fmtUtc(run.fetched_at)}</span><span><EvidenceTag evidence={c.evidence} locale={locale} /></span></div>)}
          </div>
          <dl className="rs-kv">
            <dt>{t(locale, "research.sources.source")}</dt><dd><a href={`/producer/sources/${title.platform}_web`}>{platformName(title.platform)}</a> · {run.source_urls[0]}</dd>
            <dt>{t(locale, "research.title.collectionLocale")}</dt><dd>{run.collection.locale}</dd>
            <dt>{t(locale, "research.title.audienceGeo")}</dt><dd>{t(locale, "research.geo.unknown")}</dd>
            <dt>{t(locale, "research.sources.version")}</dt><dd>{snapshot.run_id} · taxonomy {snapshot.taxonomy_version}</dd>
          </dl>
        </section>
      )}
      </div>
    </>
  );
}
