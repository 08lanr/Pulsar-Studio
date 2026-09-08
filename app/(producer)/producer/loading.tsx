import { producerLocale } from '@/components/producer/server';
import { t } from '@/lib/i18n';
export default function Loading(){return <section className="brief-section" role="status" aria-busy="true"><p>{t(producerLocale(),'ux.loading')}</p><div className="brief-loading" aria-hidden="true"/></section>;}
