import { t, type Locale } from '@/lib/i18n';
import { AUDIENCE_REVIEWED_AT, AUDIENCE_SOURCES, CHANNEL_DEMOGRAPHICS, REELSHORT_FEMALE_SHARE, US_DEMAND_TITLES } from '@/lib/research/audience';
import { EvidenceTag } from './ui';

/** Public research remains visible even when no catalog snapshot is available. */
export default function AudienceResearch({ locale }: { locale: Locale }) {
  const source = (key: keyof typeof AUDIENCE_SOURCES, page?: number) => {
    const s = AUDIENCE_SOURCES[key];
    return <a href={`${s.url}${page ? `#page=${page}` : ''}`} target="_blank" rel="noreferrer">{s.name}{page ? ` · p. ${page}` : ''}</a>;
  };
  return <section className="brief-section audience-research" aria-labelledby="audience-research-title">
    <header><div><h2 id="audience-research-title">{t(locale, 'audience.title')}</h2><p>{t(locale, 'audience.intro')}</p></div><a href="/producer/sources/reelshort_us_female_share">{t(locale, 'audience.methods')}&nbsp;→</a></header>
    <p className="brief-source-line">{t(locale, 'audience.reviewed', { date: AUDIENCE_REVIEWED_AT })}</p>
    <div className="audience-finding">
      <h3>{t(locale, 'audience.reelshort', { share: REELSHORT_FEMALE_SHARE })} <EvidenceTag evidence="estimated" locale={locale}/></h3>
      <p>{t(locale, 'audience.reelshort.scope')}</p>
      <p>{source('sensor', 13)}</p>
    </div>
    <div className="audience-finding">
      <h3>{t(locale, 'audience.genre.title')} <EvidenceTag evidence="inferred" locale={locale}/></h3>
      <p>{t(locale, 'audience.genre.finding')}</p>
      <p>{source('sensor', 12)}</p>
      <p>{t(locale, 'audience.selection')}</p>
    </div>
    <details className="brief-trope">
      <summary>{t(locale, 'audience.demand.title')}</summary>
      <p>{t(locale, 'audience.demand.scope')}</p>
      <ul lang="en">{US_DEMAND_TITLES.map(title => <li key={title}>{title}</li>)}</ul>
      <p>{source('yougov')}</p>
    </details>
    <details className="brief-trope">
      <summary>{t(locale, 'audience.channels.title')}</summary>
      <p>{t(locale, 'audience.channels.scope')} <EvidenceTag evidence="estimated" locale={locale}/></p>
      <div className="audience-table-scroll" tabIndex={0} role="region" aria-label={t(locale, 'audience.channels.title')}>
        <table className="audience-table"><caption>{t(locale, 'audience.channels.caption')}</caption>
          <thead><tr><th scope="col">{t(locale, 'audience.platform')}</th>{['18–29', '30–49', '50–64', '65+'].map(age => <th scope="col" key={age}>{age}</th>)}<th scope="col">{t(locale, 'audience.women')}</th><th scope="col">{t(locale, 'audience.men')}</th></tr></thead>
          <tbody>{CHANNEL_DEMOGRAPHICS.map(row => <tr key={row.platform}><th scope="row">{row.platform}</th>{[...row.ages, row.women, row.men].map((share, index) => <td key={index}>{share}%</td>)}</tr>)}</tbody>
        </table>
      </div>
      <p>{t(locale, 'audience.channels.example')}</p>
      <p>{source('pew')}</p>
      <p><a href="/producer/sources/us_platform_use_by_demographic">{t(locale, 'audience.methods')}&nbsp;→</a></p>
    </details>
    <details className="brief-trope">
      <summary>{t(locale, 'audience.gaps.title')}</summary>
      <p>{t(locale, 'audience.gaps.detail')}</p>
      <p>{t(locale, 'audience.access')}</p>
    </details>
  </section>;
}
