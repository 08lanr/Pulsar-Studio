import { getData } from '@/lib/data';
import type { Session } from '@/lib/auth';
import { t, type Locale } from '@/lib/i18n';
import { assessLaunch } from '@/lib/research/launch';

export default async function LaunchCatalog({session, locale, limit}: {session:Session;locale:Locale;limit?:number}) {
  const data = getData();
  const [catalog, market] = await Promise.all([data.listCatalogForMatching(session), data.getMarket(session)]);
  if (!catalog.rows.length) return <section className="rs-panel"><p>{t(locale,'launch.empty')}</p><a className="btn btn-primary" href="/producer/titles/new">{t(locale,'research.nav.addTitle')}</a></section>;
  return <div className="launch-catalog">{catalog.rows.slice(0,limit).map(row => {
    const assessment = assessLaunch(row, market.latest?.titles ?? []);
    return <article className="rs-panel" key={row.id}><span className="pill pill-neutral">{t(locale,'launch.unknown')}</span>
      <h3>{locale==='en' ? row.name_en || row.name_zh : row.name_zh}</h3>
      <p>{t(locale,!assessment.hasSynopsis?'launch.missing':assessment.comparables.length?'launch.matched':'launch.noMatch')}</p>
      <a className="btn btn-primary" href={`/producer/titles/${row.id}/preparation`}>{t(locale,'launch.assess')}&nbsp;→</a>
    </article>;
  })}{catalog.truncated&&<p>{t(locale,'research.mine.truncated',{shown:catalog.rows.length,total:catalog.total})}</p>}</div>;
}
