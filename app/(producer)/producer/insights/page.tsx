import { portalSession, producerLocale } from '@/components/producer/server';
import { getData } from '@/lib/data';
import { t } from '@/lib/i18n';
import { filterTitles, rankTitles, scoreSnapshot, tropeStats } from '@/lib/research/engine';
import { parseMarketFilter, type Query } from '@/lib/research/navigation';
import { snapshotAgeDays, STALE_AFTER_DAYS } from '@/lib/research/registry';
import { tropeLabel } from '@/lib/research/taxonomy';
import { fmtPct, fmtUtc, hrefWith, exploreHref, MetricLabel, StateBadge } from '@/components/producer/research/ui';
import MarketFilters from '@/components/producer/research/MarketFilters';
import DramaCard from '@/components/producer/research/DramaCard';
import OwnTitles from '@/components/producer/research/OwnTitles';
export const dynamic='force-dynamic';
export default async function Overview({searchParams}:{searchParams:Query}) {
 const session=await portalSession();const locale=producerLocale();const data=getData();
 const [market,profile,company,watchlist]=await Promise.all([data.getMarket(session),data.getResearchProfile(session),data.getCompanyIdentity(session),data.listWatchlist(session)]);
 const personal=!!profile&&searchParams.mode!=='all';const filter=parseMarketFilter(searchParams,personal?profile:null);const base={...searchParams,platform:filter.platform,audience:filter.audience,mode:personal?'company':'all',saved:undefined};
 const canAct=session.kind==='producer'&&['approver','reviewer'].includes(session.producerRole??'');
 const snapshot=market.latest;const scores=snapshot?scoreSnapshot(snapshot):new Map();const scoped=filterTitles(snapshot?.titles??[],filter);
 const relevant=personal&&!filter.trope?scoped.filter(x=>x.tropes.some(tr=>profile!.tropes.includes(tr.id))):scoped;
 const prominent=rankTitles(relevant,scores,6);const stats=snapshot?tropeStats(scoped,scores,snapshot.taxonomy_version):[];
 const returnTo=hrefWith('/producer/insights',base,{});
 return <div className="market-brief"><div className="page-head"><div><h1>{t(locale,'research.market.title')}</h1><p className="page-sub">{t(locale,'ux.overview.sub')}</p></div><a className="brief-company-link" href="/producer/company">{company?(locale==='en'?company.name_en||company.name_zh:company.name_zh):t(locale,'ux.company')}<small>{t(locale,'ux.edit')}&nbsp;→</small></a></div>

 {searchParams.saved==='1'&&<p className="note note-success" role="status">{t(locale,'ux.profileSaved')}</p>}
 <div className="brief-mode" role="group" aria-label={t(locale,'ux.relevance')}><a className={personal?'is-active':''} aria-current={personal?'true':undefined} href={profile?hrefWith('/producer/insights',base,{mode:'company',audience:searchParams.audience}):'/producer/company?edit=1'}>{t(locale,'ux.forCompany')}</a><a className={!personal?'is-active':''} aria-current={!personal?'true':undefined} href={hrefWith('/producer/insights',base,{mode:'all',audience:searchParams.audience})}>{t(locale,'ux.allTitles')}</a></div>
 <MarketFilters overview audience={filter.audience}/>
 <p className="brief-source-line">{t(locale,'ux.scope')}{snapshot&&<> · {snapshot.observed_at}</>} <a href="/producer/sources">{t(locale,'research.nav.sources')}</a>{snapshot?.platforms.filter(p=>p.status!=='ok'||(snapshotAgeDays(market)??0)>STALE_AFTER_DAYS).map(p=><span key={p.id}> · {p.id} <StateBadge status={p.status==='failed'?'failed':'stale'} locale={locale}/></span>)}</p>
 {!snapshot?<div className="rs-empty">{t(locale,'research.market.noData')}</div>:<>
 <section className="brief-section"><header><div><span className="brief-section-number">01</span><h2>{t(locale,'ux.dramas')}</h2><p>{t(locale,personal?'ux.dramas.personal':'ux.dramas.all')}</p></div><a href={exploreHref(base,{})}>{t(locale,'ux.exploreAll')}&nbsp;→</a></header>{prominent.length?<div className="brief-drama-grid">{prominent.map(x=><DramaCard key={x.key} title={x} locale={locale} mine={personal?profile?.tropes:[]} watching={watchlist.some(w=>w.listing_key===x.key)} canAct={canAct} returnTo={returnTo}/>)}</div>:<div className="rs-empty">{t(locale,'research.noResults')} <a href="/producer/insights?mode=all">{t(locale,'ux.allTitles')}</a></div>}</section>
 <div className="brief-bottom"><section className="brief-section"><header><div><span className="brief-section-number">02</span><h2>{t(locale,'ux.stories')}</h2><p>{t(locale,'ux.storyBasis')}</p></div></header><div className="rs-bars brief-bars">{stats.slice(0,6).map(s=><a key={s.id} className={`rs-bar${profile?.tropes.includes(s.id)?' is-mine':''}`} href={exploreHref(base,{trope:s.id})}><span className="rs-bar-label">{tropeLabel(s.id,locale)}</span><span className="rs-bar-track"><span className="rs-bar-fill" style={{width:`${s.cohort_share*100}%`}}/></span><span className="rs-bar-value">{fmtPct(s.cohort_share)}</span><span className="rs-bar-delta">{s.in_cohort}/{s.cohort}</span></a>)}</div><footer><MetricLabel metric="trope_cohort_share" locale={locale}>{t(locale,'ux.howCalculated')}</MetricLabel><a href={hrefWith('/producer/explore/tropes',base,{mode:'all'})}>{t(locale,'ux.allStories')}&nbsp;→</a></footer></section>
 <section className="brief-section"><header><div><span className="brief-section-number">03</span><h2>{t(locale,'ux.nextStep')}</h2><p>{t(locale,'ux.nextStep.sub')}</p></div><a href="/producer/titles">{t(locale,'research.nav.titles')}&nbsp;→</a></header><OwnTitles session={session} locale={locale} limit={3}/></section></div>
 <footer className="brief-source-line">{t(locale,'research.coverage',{listings:snapshot.titles.length,platforms:snapshot.platforms.length})} · {t(locale,'research.coverage.note')}</footer></>}
 </div>;
}
