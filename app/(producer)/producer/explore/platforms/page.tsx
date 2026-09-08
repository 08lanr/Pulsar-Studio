import MarketFilters from '@/components/producer/research/MarketFilters';
import { parseMarketFilter, type Query } from '@/lib/research/navigation';
import { filterTitles } from '@/lib/research/engine';
import ExploreNav from "@/components/producer/research/ExploreNav";
import { portalSession, producerLocale } from "@/components/producer/server";
import { EvidenceTag, MetricLabel, StateBadge, TropeChip, exploreHref, fmtPct, fmtSeconds, fmtUtc, platformName } from "@/components/producer/research/ui";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { formatStats, scoreSnapshot, tropeStats } from "@/lib/research/engine";
import { platformStatuses } from "@/lib/research/registry";
import type { Platform } from "@/lib/research/types";

// /producer/explore/platforms — the format drill-down that used to sit on
// the home page: medians per platform with sample sizes and the basis
// named, positioning split, coverage and freshness per platform.

export const dynamic = "force-dynamic";

export default async function ExplorePlatforms({searchParams}:{searchParams:Query}) {
  const session = await portalSession("/producer/explore/platforms");
  const locale = producerLocale();
  const data = getData();
  const [market, profile] = await Promise.all([data.getMarket(session), data.getResearchProfile(session)]);
  if (!market.latest) {
    return (
      <>
        <ExploreNav active="platforms" locale={locale} />
        <section className="rs-panel"><div className="rs-empty">{t(locale, "research.market.noData")}</div></section>
      </>
    );
  }
  const filter=parseMarketFilter(searchParams);
  const visible=filterTitles(market.latest.titles,filter);
  const snapshot = {...market.latest,titles:searchParams.mode==='company'&&profile&&!filter.trope?visible.filter(x=>x.tropes.some(tr=>profile.tropes.includes(tr.id))):visible};
  const scores = scoreSnapshot(market.latest);
  const formats = formatStats(snapshot.titles);
  const statuses = platformStatuses(market);
  const mine = new Set(profile?.tropes ?? []);

  return (
    <>
      <ExploreNav active="platforms" locale={locale} />
      <MarketFilters/><div className="rs-meta"><span>{t(locale, "research.formats.note")}</span></div>

      <div className="rs-grid">
        {formats.map((f) => {
          const run = snapshot.platforms.find((p) => p.id === f.platform)!;
          const st = statuses.find((s) => s.id === f.platform)!;
          const own = snapshot.titles.filter((x) => x.platform === f.platform);
          const stats = tropeStats(own, scores, snapshot.taxonomy_version).slice(0, 8);
          return (
            <section className="rs-panel" key={f.platform}>
              <div className="rs-panel-head">
                <div>
                  <h3>{platformName(f.platform)}</h3>
                  <p>{run.source_urls[0]} · {t(locale, "research.title.collectionLocale")}: {run.collection.locale} · {t(locale, "research.title.audienceGeo")}: {t(locale, "research.geo.unknown")}</p>
                </div>
                <span className="rs-panel-aside"><StateBadge status={st.status} locale={locale} /></span>
              </div>
              <dl className="rs-kv">
                <dt>{t(locale, "research.freshness")}</dt>
                <dd>{fmtUtc(run.fetched_at)}{run.stale_from_run ? ` · ${t(locale, "research.state.stale")} (${run.stale_from_run})` : ""}{run.error ? ` · ${run.error}` : ""}</dd>
                <dt>{t(locale, "research.col.count")}</dt>
                <dd>{f.titles} · {t(locale, "research.col.withViews").toLowerCase()} {f.with_views}{run.detail_coverage ? ` · ${t(locale, "research.sources.detailCoverage", { fetched: run.detail_coverage.fetched, requested: run.detail_coverage.requested })}` : ""}</dd>
                <dt><MetricLabel metric="episode_length" locale={locale}>{t(locale, "research.sort.episodes")}</MetricLabel></dt>
                <dd>{f.median_episodes ?? "–"} <small className="gt-muted">n={f.n_episodes}</small> <EvidenceTag evidence="observed" locale={locale} /></dd>
                <dt><MetricLabel metric="paywall_episode" locale={locale}>{t(locale, "research.stat.medianPaywall")}</MetricLabel></dt>
                <dd>{f.median_paywall_episode ?? "–"} <small className="gt-muted">n={f.n_paywall}</small> <EvidenceTag evidence="observed" locale={locale} /></dd>
                <dt><MetricLabel metric="episode_length" locale={locale}>{t(locale, "research.stat.episodeSeconds")}</MetricLabel></dt>
                <dd>{fmtSeconds(f.median_episode_seconds)} <small className="gt-muted">n={f.n_episode_seconds} · {t(locale, "research.col.basis")}: {f.episode_seconds_basis ? t(locale, `research.basis.${f.episode_seconds_basis}`) : "–"}</small></dd>
                <dt><MetricLabel metric="audience_positioning" locale={locale}>{t(locale, "research.stat.femaleShare")}</MetricLabel></dt>
                <dd>{fmtPct(f.female_audience_share)} <small className="gt-muted">n={f.n_audience}</small> <span title={t(locale, "research.audience.note")}><EvidenceTag evidence="observed" locale={locale} /></span></dd>
                <dt>{t(locale, "research.col.new")}</dt>
                <dd>{f.platform_new}</dd>
                <dt>{t(locale, "research.col.tropes")}</dt>
                <dd className="rs-tropes">{stats.map((s) => <TropeChip key={s.id} id={s.id} locale={locale} mine={mine.has(s.id)} href={exploreHref({ platform: f.platform }, { trope: s.id })} />)}</dd>
              </dl>
              <div className="rs-panel-foot"><a href={exploreHref(searchParams, { platform: f.platform })}>{t(locale, "research.explore.titles")} ›</a> · <a href={`/producer/sources/${f.platform}_web`}>{t(locale, "research.nav.sources")} ›</a></div>
            </section>
          );
        })}
      </div>

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat">
          <p className="stat-label">{t(locale, "research.stat.titles")}</p>
          <p className="stat-value">{snapshot.titles.length}</p>
          <p className="stat-foot">{t(locale, "research.coverage.note")}</p>
        </div>
        {(["reelshort", "dramabox"] as Platform[]).map((p) => {
          const f = formats.find((x) => x.platform === p);
          return (
            <div className="stat" key={p}>
              <p className="stat-label">{platformName(p)}</p>
              <p className="stat-value">{f?.titles ?? 0}</p>
              <p className="stat-foot">{t(locale, "research.col.withViews")}: {f?.with_views ?? 0}</p>
            </div>
          );
        })}
      </div>
    </>
  );
}
