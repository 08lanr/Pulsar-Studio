import NewPromoForm from "@/components/producer/promote/NewPromoForm";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { IconPlus } from "@/components/producer/icons";

export const dynamic = "force-dynamic";

// Two-step brief: pick the drama first (cards), then fill the brief with the
// drama locked in. Uploading a new drama from here returns to this flow.

export default async function NewPromotion({ searchParams }: { searchParams: { title?: string } }) {
  const session = await portalSession("/producer/promote/new"); const locale = producerLocale(); const data = getData();
  const summaries = await data.listTitles(session); const details = await Promise.all(summaries.map((x) => data.getTitle(session, x.id)));
  const titles = details.map((d) => ({ id: d.title.id, name: d.title.name_en || d.title.name_zh, episodeCount: d.episodes.length, hasVideo: d.episodes.some((e) => e.has_video) }));
  const picked = titles.find((x) => x.id === searchParams.title);
  return <><nav className="studio-crumbs"><a href="/producer/promote">{t(locale, "promote.home.title")}</a><span>›</span><span>{t(locale, "promote.new.title")}</span></nav><div className="page-head"><div><span className="page-kicker">{t(locale, "promote.new.kicker")}</span><h2>{t(locale, "promote.new.title")}</h2><p className="page-sub">{t(locale, "promote.new.sub")}</p></div></div>{picked ? <NewPromoForm titles={titles} initialTitleId={picked.id} readOnly={isStaffPreview(session)} /> : titles.length === 0 ? <section className="promo-empty"><h3>{t(locale, "promote.new.noTitles")}</h3><p>{t(locale, "promote.new.noTitlesHint")}</p><a className="btn btn-primary" href="/producer/titles/new?from=promote">{t(locale, "v3.nav.newTitle")}</a></section> : <><div className="field-group-title">{t(locale, "promote.new.pickTitle")}</div><p className="page-sub">{t(locale, "promote.new.pickHint")}</p><section className="promo-campaign-grid">{titles.map((title) => { const body = <><header><span className={`pill ${title.hasVideo ? "pill-success" : "pill-warning"}`}>{t(locale, title.hasVideo ? "promote.new.pickReady" : "promote.new.noVideo")}</span></header><h3 className="bilingual">{title.name}</h3><footer><span>{title.episodeCount} {t(locale, "promote.new.episodes")}</span></footer></>; return title.hasVideo ? <a key={title.id} className="promo-campaign-card promo-pick-card" href={`/producer/promote/new?title=${title.id}`}>{body}</a> : <div key={title.id} className="promo-campaign-card promo-pick-card is-disabled" title={t(locale, "promote.new.videoRequired")}>{body}</div>; })}<a className="promo-campaign-card promo-pick-new" href="/producer/titles/new?from=promote"><IconPlus /> {t(locale, "v3.nav.newTitle")}</a></section></>}</>;
}
