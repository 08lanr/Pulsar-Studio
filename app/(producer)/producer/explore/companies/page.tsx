import MarketFilters from '@/components/producer/research/MarketFilters';
import { parseMarketFilter, type Query } from '@/lib/research/navigation';
import { filterTitles } from '@/lib/research/engine';
import ExploreNav from "@/components/producer/research/ExploreNav";
import { portalSession, producerLocale } from "@/components/producer/server";
import { EvidenceTag, MetricLabel, TropeChip, platformName } from "@/components/producer/research/ui";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { companyStats, scoreSnapshot, tropeStats } from "@/lib/research/engine";

// /producer/explore/companies — companies as the platforms show them, with
// the role kept. A publisher label is not the production studio; neither
// platform exposes who made a title.

export const dynamic = "force-dynamic";

export default async function ExploreCompanies({searchParams}:{searchParams:Query}) {
  const session = await portalSession("/producer/explore/companies");
  const locale = producerLocale();
  const data = getData();
  const [market, profile] = await Promise.all([data.getMarket(session), data.getResearchProfile(session)]);
  if (!market.latest) {
    return (
      <>
        <ExploreNav active="companies" locale={locale} />
        <section className="rs-panel"><div className="rs-empty">{t(locale, "research.market.noData")}</div></section>
      </>
    );
  }
  const filter=parseMarketFilter(searchParams);
  const visible=filterTitles(market.latest.titles,filter);
  const snapshot = {...market.latest,titles:searchParams.mode==='company'&&profile&&!filter.trope?visible.filter(x=>x.tropes.some(tr=>profile.tropes.includes(tr.id))):visible};
  const scores = scoreSnapshot(market.latest);
  const companies = companyStats(snapshot.titles, scores);
  const hot = new Set(tropeStats(snapshot.titles, scores, snapshot.taxonomy_version).slice(0, 10).map((s) => s.id));
  const mine = new Set(profile?.tropes ?? []);
  const byKey = new Map(snapshot.titles.map((x) => [x.key, x]));

  return (
    <>
      <ExploreNav active="companies" locale={locale} />
      <MarketFilters/><div className="rs-meta"><span>{t(locale, "research.section.companiesSub")}</span><span className="ev ev-inferred">{t(locale, "research.role.note")}</span></div>
      <section className="rs-panel">
        <div className="gtable gtable-flush rs-table" style={{ ["--cols" as string]: "minmax(0,1.8fr) 120px 110px 70px 80px minmax(0,1.6fr) minmax(0,1.6fr)" }}>
          <div className="gt-head">
            <span>{t(locale, "research.col.company")}</span>
            <span><MetricLabel metric="company_role" locale={locale}>{t(locale, "research.col.role")}</MetricLabel></span>
            <span>{t(locale, "research.col.platform")}</span>
            <span className="gt-num">{t(locale, "research.col.count")}</span>
            <span className="gt-num">{t(locale, "research.col.inCohort")}</span>
            <span>{t(locale, "research.col.tropes")}</span>
            <span>{t(locale, "research.insight.examples")}</span>
          </div>
          {companies.length === 0 && <div className="gt-row gt-muted">{t(locale, "research.personal.none")}</div>}
          {companies.map((c) => (
            <div className="gt-row" key={`${c.role}|${c.name}`}>
              <span className="rs-title-name">{c.name}</span>
              <span>{t(locale, `research.role.${c.role}`)} <EvidenceTag evidence={c.evidence} locale={locale} /></span>
              <span className="rs-platform">{c.platforms.map(platformName).join(", ")}</span>
              <span className="gt-num">{c.titles}</span>
              <span className="gt-num strong">{c.in_cohort}</span>
              <span className="rs-tropes clip">{c.top_tropes.map((id) => <TropeChip key={id} id={id} locale={locale} hot={hot.has(id)} mine={mine.has(id)} />)}</span>
              <span className="rs-tropes clip">{c.example_keys.map((k) => <a key={k} className="trope" href={`/producer/market/${k}`} lang="en">{byKey.get(k)?.title ?? k}</a>)}</span>
            </div>
          ))}
        </div>
        <div className="rs-panel-foot">{t(locale, "research.role.note")}</div>
      </section>
    </>
  );
}
