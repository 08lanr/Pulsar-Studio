import ExploreNav from "@/components/producer/research/ExploreNav";
import { portalSession, producerLocale } from "@/components/producer/server";
import { EvidenceTag, MetricLabel, StateBadge, TropeChip, exploreHref, fmtPct, marketHref, platformName } from "@/components/producer/research/ui";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { filterTitles, scoreSnapshot, tropePairs, tropeStats, type MarketFilter } from "@/lib/research/engine";
import { hasHistory } from "@/lib/research/history";
import { statusFor } from "@/lib/research/registry";
import { tropeLabel } from "@/lib/research/taxonomy";
import { PLATFORMS, type Audience, type Platform } from "@/lib/research/types";

// /producer/explore/tropes — story types: share of the prominence cohort
// and of the sample, with denominators, lift, change (when history exists)
// and the most common pairs. Multi-label: shares sum above 100%.

export const dynamic = "force-dynamic";

type Search = { platform?: string; audience?: string };
const PLATFORM_IDS = new Set<string>(PLATFORMS.map((p) => p.id));

export default async function ExploreTropes({ searchParams }: { searchParams: Search }) {
  const session = await portalSession("/producer/explore/tropes");
  const locale = producerLocale();
  const data = getData();
  const [market, profile] = await Promise.all([data.getMarket(session), data.getResearchProfile(session)]);
  const filter: MarketFilter = {
    platform: searchParams.platform && PLATFORM_IDS.has(searchParams.platform) ? (searchParams.platform as Platform) : "all",
    audience: searchParams.audience === "female" || searchParams.audience === "male" ? (searchParams.audience as Audience) : "all",
  };
  const base = { platform: filter.platform, audience: filter.audience };
  if (!market.latest) {
    return (
      <>
        <ExploreNav active="tropes" locale={locale} />
        <section className="rs-panel"><div className="rs-empty">{t(locale, "research.market.noData")}</div></section>
      </>
    );
  }
  const snapshot = market.latest;
  const scores = scoreSnapshot(snapshot);
  const titles = filterTitles(snapshot.titles, filter);
  const previous = market.previous ? { titles: filterTitles(market.previous.titles, filter), scores: scoreSnapshot(market.previous), taxonomy_version: market.previous.taxonomy_version } : null;
  const stats = tropeStats(titles, scores, snapshot.taxonomy_version, previous);
  const pairs = tropePairs(titles, scores, 12);
  const mine = new Set(profile?.tropes ?? []);
  const history = hasHistory(market.days);
  const historyState = statusFor("history", { view: market, hasReports: false, hasProfile: Boolean(profile) });
  const cohort = stats[0]?.cohort ?? 0;
  const byPlatform = stats[0]?.cohort_by_platform ?? {};
  const href = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...base, ...patch })) if (v && v !== "all") p.set(k, v);
    const q = p.toString();
    return q ? `/producer/explore/tropes?${q}` : "/producer/explore/tropes";
  };

  return (
    <>
      <ExploreNav active="tropes" locale={locale} />
      <div className="rs-toolbar">
        <div className="filter-row">
          <span className="rs-toolbar-label">{t(locale, "research.filter.platform")}</span>
          <a className={`filter-chip${filter.platform === "all" ? " on" : ""}`} href={href({ platform: "all" })}>{t(locale, "research.filter.all")}</a>
          {PLATFORMS.map((p) => <a key={p.id} className={`filter-chip${filter.platform === p.id ? " on" : ""}`} href={href({ platform: p.id })}>{p.name}</a>)}
        </div>
        <div className="filter-row">
          <span className="rs-toolbar-label">{t(locale, "research.filter.audience")}</span>
          <a className={`filter-chip${filter.audience === "all" ? " on" : ""}`} href={href({ audience: "all" })}>{t(locale, "research.filter.all")}</a>
          <a className={`filter-chip${filter.audience === "female" ? " on" : ""}`} href={href({ audience: "female" })}>{t(locale, "research.audience.female")}</a>
          <a className={`filter-chip${filter.audience === "male" ? " on" : ""}`} href={href({ audience: "male" })}>{t(locale, "research.audience.male")}</a>
        </div>
      </div>
      <div className="rs-meta">
        <span>{t(locale, "research.section.storyMixSub")}</span>
        <span>n={cohort}{Object.entries(byPlatform).map(([p, n]) => ` · ${platformName(p as Platform)} ${n}`).join("")} · {t(locale, "research.results", { n: titles.length })}</span>
        {!history && <StateBadge status={historyState} locale={locale} />}
      </div>

      <section className="rs-panel" style={{ marginBottom: 20 }}>
        <div className="gtable gtable-flush rs-table" style={{ ["--cols" as string]: "minmax(0,1.6fr) 90px 100px 90px 100px 70px 90px minmax(0,1.6fr)" }}>
          <div className="gt-head">
            <span>{t(locale, "research.filter.trope")}</span>
            <span className="gt-num">{t(locale, "research.col.inCohort")}</span>
            <span className="gt-num"><MetricLabel metric="trope_cohort_share" locale={locale}>{t(locale, "research.col.cohortShare")}</MetricLabel></span>
            <span className="gt-num">{t(locale, "research.col.count")}</span>
            <span className="gt-num">{t(locale, "research.col.sampleShare")}</span>
            <span className="gt-num"><MetricLabel metric="trope_lift" locale={locale}>{t(locale, "research.col.lift")}</MetricLabel></span>
            <span className="gt-num"><MetricLabel metric="trope_share_change" locale={locale}>{t(locale, "research.col.delta")}</MetricLabel></span>
            <span>{t(locale, "research.insight.examples")}</span>
          </div>
          {stats.map((s) => (
            <div className="gt-row" key={s.id}>
              <span><TropeChip id={s.id} locale={locale} mine={mine.has(s.id)} href={marketHref(base, { trope: s.id })} /> <small className="gt-muted">{fmtPct(s.observed_share)} {t(locale, "research.evidence.observed").toLowerCase()}</small></span>
              <span className="gt-num">{s.in_cohort}/{s.cohort}</span>
              <span className="gt-num strong">{fmtPct(s.cohort_share)}</span>
              <span className="gt-num">{s.titles}/{s.sample}</span>
              <span className="gt-num">{fmtPct(s.share)}</span>
              <span className="gt-num">{s.lift == null ? "–" : `${s.lift.toFixed(2)}×`}</span>
              <span className={`gt-num${s.delta_pts == null ? " gt-muted" : s.delta_pts > 0 ? " delta-up" : s.delta_pts < 0 ? " delta-down" : ""}`}>
                {s.delta_pts == null ? "–" : s.delta_pts > 0 ? `↑ ${t(locale, "research.delta.up", { n: s.delta_pts })}` : s.delta_pts < 0 ? `↓ ${t(locale, "research.delta.down", { n: Math.abs(s.delta_pts) })}` : t(locale, "research.delta.flat")}
              </span>
              <span className="rs-tropes clip">{s.examples.map((k) => <a key={k} className="trope" href={`/producer/market/${k}`}>{snapshot.titles.find((x) => x.key === k)?.title ?? k}</a>)}</span>
            </div>
          ))}
        </div>
        <div className="rs-panel-foot"><EvidenceTag evidence="observed" locale={locale} /> <EvidenceTag evidence="inferred" locale={locale} /> {t(locale, "research.evidence.legend")} {!history && t(locale, "research.state.collectingHint")}</div>
      </section>

      <section className="rs-panel">
        <div className="rs-panel-head">
          <div>
            <h3>{t(locale, "research.col.pairs")}</h3>
            <p>{t(locale, "research.section.storyMixSub")}</p>
          </div>
        </div>
        <div className="gtable gtable-flush rs-table" style={{ ["--cols" as string]: "minmax(0,2fr) 90px 90px minmax(0,2fr)" }}>
          <div className="gt-head">
            <span>{t(locale, "research.col.pair")}</span>
            <span className="gt-num">{t(locale, "research.col.count")}</span>
            <span className="gt-num">{t(locale, "research.col.inCohort")}</span>
            <span>{t(locale, "research.insight.examples")}</span>
          </div>
          {pairs.map((p) => (
            <div className="gt-row" key={`${p.a}|${p.b}`}>
              <span className="rs-tropes"><TropeChip id={p.a} locale={locale} mine={mine.has(p.a)} /> + <TropeChip id={p.b} locale={locale} mine={mine.has(p.b)} /></span>
              <span className="gt-num">{p.titles}</span>
              <span className="gt-num">{p.in_cohort}/{cohort}</span>
              <span className="rs-tropes clip">{p.examples.map((k) => <a key={k} className="trope" href={`/producer/market/${k}`}>{snapshot.titles.find((x) => x.key === k)?.title ?? k}</a>)}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="rs-legend">
        <a href={exploreHref(base, {})}>{t(locale, "research.explore.titles")} ›</a>
        <span className="gt-muted">{tropeLabel(stats[0]?.id ?? "revenge", locale)}</span>
      </div>
    </>
  );
}
