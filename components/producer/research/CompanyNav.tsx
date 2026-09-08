import { t, type Locale } from '@/lib/i18n';
export default function CompanyNav({ active, locale }: {active:'titles'|'company'|'reports'|'simulation'; locale:Locale}) {
  return <nav className="tabs rs-tabs" aria-label={t(locale,'research.nav.titles')}>{(['titles','company','reports','simulation'] as const).map(id=><a key={id} className={`tab${id===active?' is-active':''}`} aria-current={id===active?'page':undefined} href={id==='company'?'/producer/company':`/producer/${id}`}>{t(locale,id==='simulation'?'sim.nav':id==='company'?'ux.company':id==='titles'?'research.nav.titles':'research.reports.title')}</a>)}</nav>;
}

