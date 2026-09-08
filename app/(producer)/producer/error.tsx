'use client';
import { useT } from '@/components/locale';
export default function ProducerError({reset}:{reset:()=>void}){const {tt}=useT();return <section className="rs-panel rs-empty" role="alert"><h2>{tt('ux.error.title')}</h2><p>{tt('ux.error.body')}</p><button className="btn btn-primary" onClick={reset}>{tt('ux.retry')}</button> <a className="btn btn-outline" href="/producer">{tt('research.nav.overview')}</a></section>;}
