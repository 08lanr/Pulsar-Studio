import NewPromoForm from "@/components/producer/promote/NewPromoForm";
import { isStaffPreview, portalSession, producerLocale } from "@/components/producer/server";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { IconPlus } from "@/components/producer/icons";
import { titleName } from "@/components/producer/TitleShell";

export const dynamic = "force-dynamic";

// Two-step brief: pick the drama first (cards), then fill the brief with the
// drama locked in. Uploading a new drama from here returns to this flow.

export default async function NewPromotion({ searchParams }: { searchParams: { title?: string } }) {
  const session = await portalSession("/producer/promote/new"); const locale = producerLocale(); const data = getData();
  const summaries = await data.listTitles(session); const details = await Promise.all(summaries.map((x) => data.getTitle(session, x.id)));
  // Names follow the chrome locale like every other surface; titles ready to generate ads come first.
  const titles = details
    .map((d) => ({ id: d.title.id, name: titleName(locale, d.title.name_zh, d.title.name_en).primary, episodeCount: d.episodes.length, hasVideo: d.episodes.some((e) => e.has_video) }))
    .sort((a, b) => Number(b.hasVideo) - Number(a.hasVideo) || a.name.localeCompare(b.name, locale === "zh" ? "zh" : "en"));
  const picked = titles.find((x) => x.id === searchParams.title);
  return <><nav className="studio-crumbs"><a href="/producer/promote">{t(locale, "ws.nav.launch")}</a><span>›</span><span>{t(locale, "promote.new.title")}</span></nav><div className="page-head"><div><span className="page-kicker">{t(locale, "promote.new.kicker")}</span><h1>{t(locale, "promote.new.title")}</h1><p className="page-sub">{t(locale, "promote.new.sub")}</p></div></div>{picked ? <NewPromoForm titles={titles} initialTitleId={picked.id} readOnly={isStaffPreview(session) || session.producerRole === "viewer"} /> : titles.length === 0 ? <section className="promo-empty"><h2>{t(locale, "promote.new.noTitles")}</h2><p>{t(locale, "promote.new.noTitlesHint")}</p><a className="btn btn-primary" href="/producer/titles/new?from=promote">{t(locale, "v3.nav.newTitle")}</a></section> : <><h2 className="field-group-title">{t(locale, "promote.new.pickTitle")}</h2><p className="page-sub">{t(locale, "promote.new.pickHint")}</p>{titles.some((x) => !x.hasVideo) && <p className="note note-info">{t(locale, "promote.new.someNoVideo")}</p>}<section className="promo-campaign-grid">{titles.map((title) => { const body = <><header><span className={`pill ${title.hasVideo ? "pill-success" : "pill-warning"}`}>{t(locale, title.hasVideo ? "promote.new.pickReady" : "promote.new.noVideo")}</span></header><h3 className="bilingual">{title.name}</h3><footer><span>{title.episodeCount} {t(locale, "promote.new.episodes")}</span></footer></>; return <a key={title.id} className="promo-campaign-card promo-pick-card" href={`/producer/promote/new?title=${title.id}`}>{body}</a>; })}<a className="promo-campaign-card promo-pick-new" href="/producer/titles/new?from=promote"><IconPlus /> {t(locale, "v3.nav.newTitle")}</a></section></>}</>;
}
