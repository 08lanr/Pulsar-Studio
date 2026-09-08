'use client';
import { useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useT } from '@/components/locale';
import { TROPES } from '@/lib/research/taxonomy';
import { safeSort } from '@/lib/research/navigation';
export default function MarketFilters({ overview = false, audience = 'all' }: { overview?: boolean; audience?: string }) {
  const { tt, locale } = useT();
  const router = useRouter(); const path = usePathname(); const params = useSearchParams();
  const [pending, start] = useTransition();
  function apply(form: HTMLFormElement, search = false) {
    const next = new URLSearchParams(params.toString());
    const fields = new FormData(form);
    for (const key of ['platform', 'audience', 'trope', 'q', 'sort', 'watched', 'newonly']) {
      if (!form.elements.namedItem(key)) continue;
      const value = String(fields.get(key) ?? '');
      if (value) next.set(key, value); else next.delete(key);
    }
    next.delete('page'); next.delete('saved');
    next.set('sort', safeSort(next.get('sort') ?? undefined, next.get('platform') as 'all' | 'reelshort' | 'dramabox'));
    start(() => router.push(`${search && overview ? '/producer/explore/titles' : path}?${next}`, {scroll:false}));
  }
  return <form key={params.toString()} className="brief-filters" aria-busy={pending} onSubmit={e => { e.preventDefault(); apply(e.currentTarget, true); }} onChange={e => { if ((e.target as HTMLInputElement).type !== 'search') apply(e.currentTarget); }}>
    <div className="brief-filter-main">
      <div className="brief-search"><input name="q" type="search" className="input" defaultValue={params.get('q') ?? ''} placeholder={tt('research.search.placeholder')} aria-label={tt('research.search.placeholder')} /><button type="submit" className="btn btn-outline">{tt('research.search.go')}</button></div>
      <label>{tt('research.filter.platform')}<select className="select" name="platform" defaultValue={params.get('platform') ?? 'all'}><option value="all">{tt('research.filter.all')}</option><option value="reelshort">ReelShort</option><option value="dramabox">DramaBox</option></select></label>
      <label>{tt('research.filter.trope')}<select className="select" name="trope" defaultValue={params.get('trope') ?? ''}><option value="">{tt('research.filter.all')}</option>{TROPES.map(x => <option key={x.id} value={x.id}>{x[locale]}</option>)}</select></label>
    </div>
    <details className="brief-advanced" open={['audience','watched','newonly'].some(k => params.has(k)) || undefined}><summary>{tt('ux.filters.more')}{pending && <span role="status"> · {tt('ux.loading')}</span>}</summary><div className="brief-filter-main">
      <label>{tt('research.filter.audience')}<select name="audience" className="select" defaultValue={params.get('audience') ?? audience}><option value="all">{tt('research.filter.all')}</option><option value="female">{tt('research.audience.female')}</option><option value="male">{tt('research.audience.male')}</option></select></label>
      {!overview && path.endsWith("/titles") && <label>{tt('research.explore.sort')}<select className="select" name="sort" defaultValue={safeSort(params.get('sort') ?? undefined, params.get('platform') as 'all')}>
        {['prominence','title','released','views','saves','episodes'].map(s => <option key={s} value={s} disabled={['views','saves'].includes(s) && !['reelshort','dramabox'].includes(params.get('platform') ?? '')}>{tt(`research.sort.${s}`)}</option>)}
      </select></label>}
      {!overview && <><label className="brief-check"><input name="watched" type="checkbox" value="1" defaultChecked={params.get('watched') === '1'} />{tt('research.watch.watching')}</label><label className="brief-check"><input name="newonly" type="checkbox" value="1" defaultChecked={params.get('newonly') === '1'} />{tt('research.col.new')}</label><small>{tt('ux.filters.counter')}</small></>}
    </div></details>
    <div className="brief-filter-status"><span role="status">{params.get("mode")==="company" ? `${tt("ux.forCompany")} · ` : ""}{pending ? tt('ux.loading') : [params.get('platform')==='dramabox'?'DramaBox':params.get('platform')==='reelshort'?'ReelShort':null,params.get('audience') && params.get('audience')!=='all' ? tt('research.audience.'+params.get('audience')) : null,params.get('trope') && TROPES.find(x=>x.id===params.get('trope'))?.[locale],params.get('q') && `“${params.get('q')}”`].filter(Boolean).join(' · ')}</span><a href={`${path}${overview ? '?mode=all' : ''}`}>{tt('research.filter.reset')}</a></div>
  </form>;
}
