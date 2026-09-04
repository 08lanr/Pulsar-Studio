import { portalSession, producerLocale } from "@/components/producer/server";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";
const statusClass = (status: string) => status === "live" || status === "submitted" ? "pill-success" : status === "review" ? "pill-warning" : "pill-neutral";

export default async function PromoteHome() {
  const session = await portalSession("/producer/promote"); const locale = producerLocale(); const campaigns = await getData().listPromoCampaigns(session);
  return <><div className="page-head"><div><span className="page-kicker">{t(locale, "promote.home.kicker")}</span><h2>{t(locale, "promote.home.title")}</h2><p className="page-sub">{t(locale, "promote.home.sub")}</p></div><a className="btn btn-primary" href="/producer/promote/new">{t(locale, "promote.home.new")}</a></div>{campaigns.length === 0 ? <section className="promo-empty"><span className="promo-empty-mark">▶</span><h3>{t(locale, "promote.home.emptyTitle")}</h3><p>{t(locale, "promote.home.emptyHint")}</p><a className="btn btn-primary" href="/producer/promote/new">{t(locale, "promote.home.emptyCta")}</a></section> : <section className="promo-campaign-grid">{campaigns.map((c) => <a href={`/producer/promote/${c.id}`} className="promo-campaign-card" key={c.id}><header><span className={`pill ${statusClass(c.status)}`}>{t(locale, `promote.status.${c.status}`)}</span><span>{c.target_market}</span></header><h3>{c.name}</h3><p className="bilingual">{c.title_name_en || c.title_name_zh}</p><footer><span>{t(locale, "promote.home.creatives", { n: c.creative_count })}</span><strong>{t(locale, "promote.home.approved", { n: c.approved_count })}</strong></footer></a>)}</section>}</>;
}
