import { t, type Locale } from '@/lib/i18n';
import type { MarketTitle } from '@/lib/research/types';
import { tropeLabel, type TropeId } from '@/lib/research/taxonomy';
import Cover from './Cover';
import WatchButton from './WatchButton';
import MetricInfo from './MetricInfo';
import {fmtCount,fmtUtc,platformName,unitLabel} from './ui';
export function Counter({title,kind,locale}:{title:MarketTitle;kind:'views'|'saves';locale:Locale}) {
  const o=title.metrics[kind]; if(!o)return <span className="brief-counter"><small>{t(locale,`research.col.${kind}`)}</small>{t(locale,'ux.unknown')}</span>;
  return <span className="brief-counter"><small>{unitLabel(o.unit,locale)}</small><MetricInfo name={`${platformName(title.platform)} · ${unitLabel(o.unit,locale)}`} question={t(locale,'ux.counter.note')} limitations={[t(locale,'ux.counter.limit')]} href={title.url} detail={<dl className="rs-kv"><dt>{t(locale,'research.reports.value')}</dt><dd>{o.value.toLocaleString(locale==='zh'?'zh-CN':'en-US')} {unitLabel(o.unit,locale)}</dd><dt>{t(locale,'research.title.observedAt')}</dt><dd>{fmtUtc(o.observed_at)}</dd><dt>{t(locale,'research.title.field')}</dt><dd>{o.source_field}</dd><dt>{t(locale,'research.sources.evidence')}</dt><dd>{t(locale,`research.evidence.${o.evidence}`)}</dd></dl>}>{fmtCount(o.value)}</MetricInfo></span>;
}
export default function DramaCard({title,locale,mine=[],watching=false,canAct=false,returnTo}:{title:MarketTitle;locale:Locale;mine?:TropeId[];watching?:boolean;canAct?:boolean;returnTo:string}) {
  const chart=[...title.placements].filter(p=>p.chart).sort((a,b)=>a.rank-b.rank)[0];const overlap=title.tropes.filter(x=>mine.includes(x.id));
  const href=`/producer/market/${title.key}?returnTo=${encodeURIComponent(returnTo)}`;
  return <article className="brief-drama"><a href={href} className="brief-drama-link"><Cover src={title.cover} title={title.title}/><span className="rs-platform">{platformName(title.platform)}</span><h3 lang="en">{title.title}</h3></a><p className="brief-chart">{chart?`${chart.name} · #${chart.rank}`:t(locale,'ux.catalogListing')}</p><div className="brief-counters"><Counter title={title} kind="views" locale={locale}/><Counter title={title} kind="saves" locale={locale}/></div><p className="brief-relevance">{overlap.length?t(locale,'ux.matches',{tropes:overlap.slice(0,2).map(x=>tropeLabel(x.id,locale)).join(' · ')}):title.tropes.slice(0,2).map(x=>tropeLabel(x.id,locale)).join(' · ')||t(locale,'ux.catalogListing')}</p><WatchButton listingKey={title.key} watching={watching} canAct={canAct}/></article>;
}
