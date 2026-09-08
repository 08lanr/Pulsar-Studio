import { redirect } from 'next/navigation';
import MarketFilters from '@/components/producer/research/MarketFilters';
import { Counter } from '@/components/producer/research/DramaCard';
import Cover from '@/components/producer/research/Cover';
import WatchButton from '@/components/producer/research/WatchButton';
import { safeSort } from '@/lib/research/navigation';
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

type Search = { platform?: string; audience?: string; trope?: string; q?: string; sort?: string; page?: string; newonly?: string; watched?: string; mode?:string };
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
 const session=await portalSession('/producer/explore/titles'); const locale=producerLocale();const data=getData();
 const [market,profile,watchlist]=await Promise.all([data.getMarket(session),data.getResearchProfile(session),data.listWatchlist(session)]);
 const {filter,page,newonly}=parse(searchParams); const sort=safeSort(searchParams.sort,filter.platform) as Sort;
 if(searchParams.sort && searchParams.sort!==sort)redirect(exploreHref(searchParams,{sort,page:undefined}));
 const watched=searchParams.watched==='1';const keys=new Set(watchlist.map(w=>w.listing_key));const canAct=session.kind==='producer'&&['approver','reviewer'].includes(session.producerRole??'');
 const snapshot=market.latest;const scores=snapshot?scoreSnapshot(snapshot):new Map();let rows=filterTitles(snapshot?.titles??[],filter);
 if(searchParams.mode==='company'&&profile&&!filter.trope)rows=rows.filter(x=>x.tropes.some(tr=>profile.tropes.includes(tr.id)));
 if(newonly)rows=rows.filter(x=>x.platform_new);if(watched)rows=rows.filter(x=>keys.has(x.key));
 const sorted=sortRows(rows,sort,scores);const pages=Math.max(1,Math.ceil(sorted.length/PAGE_SIZE));const current=Math.min(Math.floor(page),pages);
 const slice=sorted.slice((current-1)*PAGE_SIZE,current*PAGE_SIZE);const base={...searchParams,sort};const returnTo=exploreHref(base,{page:String(current)});
 return <><ExploreNav active="titles" locale={locale}/><MarketFilters/><div className="rs-meta"><strong>{t(locale,'research.results',{n:sorted.length})}</strong><span>{t(locale,'research.page',{page:current,pages})}</span>{filter.q&&<span>{t(locale,'ux.searchMatch',{q:filter.q})}</span>}</div>
 {slice.length===0?<div className="rs-panel rs-empty">{t(locale,snapshot?'research.noResults':'research.market.noData')} <a href="/producer/explore/titles">{t(locale,'research.filter.reset')}</a></div>:<section className="rs-panel brief-explorer"><div className="brief-result-head"><span>{t(locale,'research.col.title')}</span><span>{t(locale,'research.col.tropes')}</span><span>{t(locale,'ux.platformCounters')}</span><span>{t(locale,'ux.savedTitles')}</span></div>{slice.map(x=>{
 const chart=[...x.placements].filter(p=>p.chart).sort((a,b)=>a.rank-b.rank)[0];
 return <article className="brief-result" key={x.key}><a className="brief-result-title" href={`/producer/market/${x.key}?returnTo=${encodeURIComponent(returnTo)}`}><Cover src={x.cover} title={x.title} className="brief-result-cover"/><span><strong lang="en">{x.title}</strong><small>{platformName(x.platform)} · {x.companies[0]?.name??t(locale,'ux.catalogListing')}</small>{chart&&<small>{chart.name} · #{chart.rank}</small>}</span></a><div className="rs-tropes">{x.tropes.slice(0,3).map(tr=><TropeChip key={tr.id} id={tr.id} locale={locale} mine={profile?.tropes.includes(tr.id)} href={exploreHref(base,{trope:tr.id,page:undefined})}/>)}</div><div className="brief-counters"><Counter title={x} kind="views" locale={locale}/><Counter title={x} kind="saves" locale={locale}/></div><WatchButton listingKey={x.key} watching={keys.has(x.key)} canAct={canAct}/></article>;
 })}<div className="rs-panel-foot rs-pager"><span>{t(locale,'ux.counter.limit')}</span><span className="spacer"/>{current>1&&<a className="btn btn-outline btn-sm" href={exploreHref(base,{page:String(current-1)})}>{t(locale,'research.prev')}</a>}{current<pages&&<a className="btn btn-outline btn-sm" href={exploreHref(base,{page:String(current+1)})}>{t(locale,'research.next')}</a>}</div></section>}</>;
}
