import { portalSession, producerLocale } from "@/components/producer/server";
import { EvidenceTag, MetricLabel, TropeChip, platformName } from "@/components/producer/research/ui";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { premiseExamples, scoreSnapshot, tropeStats } from "@/lib/research/engine";

export const dynamic = "force-dynamic";
const statusClass = (status: string) => status === "live" || status === "submitted" ? "pill-success" : status === "review" ? "pill-warning" : "pill-neutral";

export default async function PromoteHome() {
  const session = await portalSession("/producer/promote"); const locale = producerLocale();
  const data = getData();
  const [campaigns, market, profile] = await Promise.all([data.listPromoCampaigns(session), data.getMarket(session), data.getResearchProfile(session)]);
  // Premise examples from prominent titles (docs/market-desk-plan.md): the
  // opening sentence of prominent listings' blurbs for the producer's
  // tropes. Examples of how a premise is stated, NOT tested hooks: no
  // creative-outcome evidence exists in Studio.
  const snapshot = market.latest;
  const scores = snapshot ? scoreSnapshot(snapshot) : new Map();
  const hot = new Set(snapshot ? tropeStats(snapshot.titles, scores, snapshot.taxonomy_version).slice(0, 10).map((s) => s.id) : []);
  const examples = snapshot ? premiseExamples(profile?.tropes ?? [], snapshot.titles, scores, 6) : [];
  const hooksPanel = examples.length > 0 ? (
    <section className="rs-panel" style={{ marginBottom: 20 }}>
      <div className="rs-panel-head">
        <div>
          <h3><MetricLabel metric="premise_examples" locale={locale}>{t(locale, "research.premise.title")}</MetricLabel></h3>
          <p>{t(locale, "research.premise.sub")}</p>
        </div>
        <span className="rs-panel-aside">{profile?.tropes?.length ? t(locale, "research.premise.forYou") : t(locale, "research.premise.all")}</span>
      </div>
      <div className="rs-hooks">
        {examples.map((h) => (
          <div className="rs-hook" key={h.key}>
            <q lang="en">{h.sentence}</q>
            <footer>
              <a href={`/producer/market/${h.key}`} lang="en">{h.title}</a>
              <span>{platformName(h.platform)}</span>
              <EvidenceTag evidence="observed" locale={locale} />
              {h.tropes.slice(0, 3).map((id) => <TropeChip key={id} id={id} locale={locale} hot={hot.has(id)} />)}
            </footer>
          </div>
        ))}
      </div>
    </section>
  ) : null;
  return <><div className="page-head"><div><span className="page-kicker">{t(locale, "promote.home.kicker")}</span><h2>{t(locale, "promote.home.title")}</h2><p className="page-sub">{t(locale, "promote.home.sub")}</p></div><a className="btn btn-primary" href="/producer/promote/new">{t(locale, "promote.home.new")}</a></div>{hooksPanel}{campaigns.length === 0 ? <section className="promo-empty"><span className="promo-empty-mark">▶</span><h3>{t(locale, "promote.home.emptyTitle")}</h3><p>{t(locale, "promote.home.emptyHint")}</p><a className="btn btn-primary" href="/producer/promote/new">{t(locale, "promote.home.emptyCta")}</a></section> : <section className="promo-campaign-grid">{campaigns.map((c) => <a href={`/producer/promote/${c.id}`} className="promo-campaign-card" key={c.id}><header><span className={`pill ${statusClass(c.status)}`}>{t(locale, `promote.status.${c.status}`)}</span><span>{c.target_market}</span></header><h3>{c.name}</h3><p className="bilingual">{c.title_name_en || c.title_name_zh}</p><footer><span>{t(locale, "promote.home.creatives", { n: c.creative_count })}</span><strong>{t(locale, "promote.home.approved", { n: c.approved_count })}</strong></footer></a>)}</section>}</>;
}
