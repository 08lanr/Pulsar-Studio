'use client';
import { useT } from '@/components/locale';
export default function ProducerError({reset}:{reset:()=>void}){const {tt}=useT();return <section className="rs-panel rs-empty" role="alert"><h1>{tt('ux.error.title')}</h1><p>{tt('ux.error.body')}</p><button className="btn btn-primary" onClick={reset}>{tt('ux.retry')}</button> <a className="btn btn-outline" href="/producer/titles">{tt('ws.nav.catalog')}</a></section>;}
