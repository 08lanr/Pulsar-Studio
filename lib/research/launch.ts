import { tagCatalogTitle, type CatalogRow } from './engine';
import type { MarketTitle } from './types';

/** Metadata similarity only. Never a measured US audience score. */
export function assessLaunch(title: CatalogRow, market: MarketTitle[]) {
  const hasSynopsis = Boolean(title.synopsis_en?.trim() || title.synopsis_zh?.trim());
  const tags = hasSynopsis ? tagCatalogTitle(title) : [];
  const comparables = market.map(row => ({ row, overlap: row.tropes.filter(t => tags.includes(t.id)).length }))
    .filter(x => x.overlap > 0).sort((a, b) => b.overlap - a.overlap || a.row.key.localeCompare(b.row.key))
    .slice(0, 4).map(x => x.row);
  return { hasSynopsis, tags, comparables, audienceResponse: 'untested' as const };
}
