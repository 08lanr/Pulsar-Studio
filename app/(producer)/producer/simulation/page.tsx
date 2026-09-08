import CompanyNav from '@/components/producer/research/CompanyNav';
import ProducerSimulation from '@/components/producer/research/ProducerSimulation';
import { portalSession, producerLocale } from '@/components/producer/server';
import { t } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

export default async function SimulationPage() {
  await portalSession('/producer/simulation');
  const locale = producerLocale();
  return <><div className="page-head"><div><span className="page-kicker">{t(locale, 'sim.nav')}</span><h2>{t(locale, 'sim.title')}</h2></div></div>
    <CompanyNav active="simulation" locale={locale}/><ProducerSimulation locale={locale}/></>;
}
