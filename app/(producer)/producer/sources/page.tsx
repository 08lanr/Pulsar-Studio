import { portalSession, producerLocale } from '@/components/producer/server';
import { EvidenceTag,StateBadge,fmtUtc,platformName } from '@/components/producer/research/ui';
import { getData } from '@/lib/data';
import { t } from '@/lib/i18n';
import { SOURCES,METRICS,statusFor,sourceStatus } from '@/lib/research/registry';
import { sourceCopy } from '@/lib/research/source-copy';
export const dynamic='force-dynamic';
export default async function SourcesPage(){
 const session=await portalSession('/producer/sources');const locale=producerLocale();const data=getData();const [market,profile,batches]=await Promise.all([data.getMarket(session),data.getResearchProfile(session),data.listReportBatches(session)]);
 const ctx={view:market,hasProfile:!!profile,hasReports:batches.some(b=>!b.reverted_at)};
 const used=SOURCES.filter(s=>['catalog','producer'].includes(s.status_rule)||s.key==='engine'||s.key==='producer_reports');
 const card=(s:typeof SOURCES[number])=>{const c=sourceCopy(s,locale);const run=market.latest?.platforms.find(p=>`${p.id}_web`===s.key);return <a className="brief-source-card" href={`/producer/sources/${s.key}`} key={s.key}><h3>{c.name}</h3><StateBadge status={sourceStatus(s,ctx)} locale={locale}/><p>{c.description}</p>{run&&<p>{t(locale,'research.results',{n:run.title_count})} · {fmtUtc(run.fetched_at)}</p>}</a>;};
 return <><div className="page-head"><div><h1>{t(locale,'research.sources.title')}</h1><p className="page-sub">{t(locale,'ux.scope')} · {t(locale,'research.coverage.note')}</p></div></div><h2>{t(locale,'ux.sources.connected')}</h2><div className="brief-source-cards">{used.map(card)}</div>
 <section className="brief-section"><h2>{t(locale,'ux.sources.metrics')}</h2>{METRICS.filter(m=>['catalog','producer'].includes(m.status_rule)).map(m=><details className="brief-trope" key={m.key}><summary>{locale==='zh'?m.name_zh:m.name_en} <EvidenceTag evidence={m.evidence} locale={locale}/></summary><p>{locale==='zh'?m.question_zh:m.question_en}</p><ul>{(locale==='zh'?m.limitations_zh:m.limitations_en).map(l=><li key={l}>{l}</li>)}</ul><a href={`/producer/sources/${m.key}`}>{t(locale,'ux.advancedData')}&nbsp;→</a></details>)}</section>
 <details className="brief-section"><summary>{t(locale,'ux.sources.planned')}</summary><div className="brief-source-cards">{SOURCES.filter(s=>!used.includes(s)).map(card)}</div>{METRICS.filter(m=>!['catalog','producer'].includes(m.status_rule)).map(m=><p key={m.key}><a href={`/producer/sources/${m.key}`}>{locale==='zh'?m.name_zh:m.name_en}</a> <StateBadge status={statusFor(m.status_rule,ctx)} locale={locale}/></p>)}</details>
 <details className="brief-section"><summary>{t(locale,'ux.advancedData')}</summary><p>{market.latest?.run_id} · {t(locale,'research.sources.history',{n:market.days.length})}</p>{market.latest?.platforms.map(p=><p key={p.id}>{platformName(p.id)} · {p.title_count} · {fmtUtc(p.fetched_at)}</p>)}{market.publication.last_failure&&<p role="alert">{t(locale,'research.sources.lastFailure')}: {fmtUtc(market.publication.last_failure.at)}</p>}</details></>;
}
