import { t, type Locale } from "@/lib/i18n";
import { whatToMakeNext } from "@/lib/research/next";
import type { MarketView } from "@/lib/research/snapshot";
import { snapshotHistory } from "@/lib/research/snapshot";
import { tropeLabel } from "@/lib/research/taxonomy";
import { fmtPct } from "./ui";
import { GrowthCell, LiftChip, ReasonChips, platformLabel, titleHref } from "./NextParts";

// The overview's small version of "what to make next": the story types the
// platforms are launching and the newest listings, each linking to the board.
export default function NextMini({ market, locale }: { market: MarketView; locale: Locale }) {
  const latest = market.latest;
  const head = (
    <header className="wf-section-head">
      <div>
        <h2 id="next-mini">{t(locale, "next.overview.title")}</h2>
        <p>{latest ? t(locale, "next.overview.sub", { date: latest.observed_at }) : t(locale, "next.overview.noData")}</p>
      </div>
      <a href="/producer/insights/next">{t(locale, "next.overview.link")}</a>
    </header>
  );
  if (!latest) return <section className="wf-section" aria-labelledby="next-mini">{head}</section>;
  const board = whatToMakeNext({ latest, previous: market.previous, history: snapshotHistory(), days: market.days, limits: { tropes: 4, titles: 2, movers: 0 } });
  const newest = board.platforms.flatMap((p) => p.titles).sort((a, b) => (b.prominence ?? -1) - (a.prominence ?? -1)).slice(0, 4);
  return (
    <section className="wf-section" aria-labelledby="next-mini">
      {head}
      <div className="nx-mini">
        <div>
          <h3>{t(locale, "next.overview.tropes")}</h3>
          <ul className="nx-mini-rows">
            {board.tropes.map((s) => (
              <li key={s.id} className="nx-mini-row">
                <a href={`/producer/explore/titles?trope=${s.id}&newonly=1&mode=all`}>{tropeLabel(s.id, locale)}</a>
                <span className="rs-bar-track"><span className="rs-bar-fill" style={{ width: `${Math.round(s.fresh_share * 100)}%` }} /></span>
                <b>{fmtPct(s.fresh_share)}</b>
                <LiftChip trope={s} locale={locale} />
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>{t(locale, "next.overview.titles")}</h3>
          <ul className="nx-mini-rows">
            {newest.map((x) => (
              <li key={x.title.key} className="nx-mini-title">
                <span style={{ minWidth: 0 }}>
                  <a href={titleHref(x, "/producer")} lang="en">{x.title.title}</a>
                  <small>{platformLabel(x)} · <ReasonChips reasons={x.reasons.slice(0, 1)} locale={locale} /></small>
                </span>
                <GrowthCell x={x} locale={locale} compact />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
