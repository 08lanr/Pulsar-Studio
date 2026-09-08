import { isTropeId } from './taxonomy';
import type { MarketFilter } from './engine';
import type { ResearchProfile } from './types';

export type Query = Record<string, string | undefined>;
export function parseMarketFilter(q: Query, profile?: ResearchProfile | null): MarketFilter {
  return {
    platform: q.platform === 'reelshort' || q.platform === 'dramabox' ? q.platform : 'all',
    audience: q.audience === 'female' || q.audience === 'male' ? q.audience : q.audience === 'all' ? 'all' : q.mode !== 'all' && profile?.audience && profile.audience !== 'both' ? profile.audience : 'all',
    trope: q.trope && isTropeId(q.trope) ? q.trope : null,
    q: q.q?.slice(0, 80) ?? null,
  };
}
export function safeReturn(value?: string): string {
  if (!value) return '/producer/explore/titles';
  try {
    const url = new URL(value, 'https://studio.local');
    return url.origin === 'https://studio.local' && (url.pathname === '/producer' || url.pathname === '/producer/insights' || /^\/producer\/titles\/[a-f0-9-]+(\/potential|\/preparation)?$/.test(url.pathname) || /^\/producer\/explore\/(titles|tropes|platforms|companies)$/.test(url.pathname)) ? url.pathname + url.search : '/producer/explore/titles';
  } catch { return '/producer/explore/titles'; }
}
export function safeSort(sort: string | undefined, platform: MarketFilter['platform']): string {
  if ((sort === 'views' || sort === 'saves') && (!platform || platform === 'all')) return 'prominence';
  return ['prominence', 'views', 'saves', 'episodes', 'title', 'released'].includes(sort ?? '') ? sort! : 'prominence';
}
export function toggleDistribution(values: ResearchProfile['distribution'], value: ResearchProfile['distribution'][number]): ResearchProfile['distribution'] {
  if (values.includes(value)) return values.filter(x => x !== value);
  return value === 'none' ? ['none'] : [...values.filter(x => x !== 'none'), value];
}
export function normalizeMarkets(values:string[]):string[] {
  const aliases:Record<string,string>={USA:'US','UNITED STATES':'US','美国':'US',UK:'GB','UNITED KINGDOM':'GB','英国':'GB','加拿大':'CA','澳大利亚':'AU'};
  return [...new Set(values.map(x=>x.trim()).filter(Boolean).map(x=>aliases[x.toUpperCase()]??(/^[a-z]{2}$/i.test(x)?x.toUpperCase():x)))];
}
