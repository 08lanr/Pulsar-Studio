import Link from "next/link";
import { adminLocale, staffSession } from "@/components/admin/server";
import { formatCents, formatDate, percent } from "@/components/admin/format";
import { TitlePill, titleStatusKey } from "@/components/admin/StatusPill";
import TitleProducerFilter from "@/components/admin/TitleProducerFilter";
import { CrazydramasChip } from "@/components/producer/CrazydramasChip";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";
import { crazydramasStatesByTitle } from "@/lib/research/title-workspace";

export const dynamic = "force-dynamic";

export default async function TitlesPage({ searchParams }: { searchParams?: { producer?: string } }) {
  const session = await staffSession();
  const locale = adminLocale();
  const [all, crazydramas] = await Promise.all([getData().listTitles(session), crazydramasStatesByTitle(session)]);
  // One option per company that actually has a title, named the way the rest of
  // the row is, and sorted so the list does not reshuffle as titles change.
  const producers = [...new Map(all
    .filter((title) => title.producer_id)
    .map((title) => [title.producer_id!, { id: title.producer_id!, name: title.producer_name_en || title.producer_name_zh }]))
    .values()].sort((a, b) => a.name.localeCompare(b.name));
  const chosen = searchParams?.producer && producers.some((p) => p.id === searchParams.producer) ? searchParams.producer : "";
  const titles = chosen ? all.filter((title) => title.producer_id === chosen) : all;
  return <>
    <div className="page-head"><div><h1>{t(locale, "admin.titles.title")}</h1><p className="page-sub">{t(locale, "admin.titles.sub")}</p></div><Link className="btn btn-primary" href="/titles/new">{t(locale, "admin.titles.new")}</Link></div>
    {producers.length > 1 && <div className="staff-titles-filters">
      <TitleProducerFilter producers={producers} value={chosen} />
      <span className="hint">{t(locale, "admin.titles.count").replace("{n}", String(titles.length))}</span>
    </div>}
    <p className="staff-scroll-hint" id="staff-titles-scroll">{t(locale, "redesign.scrollTable")}</p>
    <div className="gtable staff-titles-table" role="region" aria-label={t(locale, "admin.titles.title")} aria-describedby="staff-titles-scroll" tabIndex={0} style={{ "--cols": "minmax(220px,2fr) minmax(140px,1fr) minmax(130px,0.8fr) minmax(170px,1fr) 90px 120px" } as React.CSSProperties}>
      <div className="gt-head"><span>{t(locale,"term.title")}</span><span>{t(locale,"admin.titles.producer")}</span><span>{t(locale,"admin.titles.status")}</span><span>{t(locale,"admin.titles.progress")}</span><span>{t(locale,"admin.titles.cost")}</span><span>{t(locale,"admin.titles.updated")}</span></div>
      {titles.map((title) => <Link key={title.id} className="gt-row clickable" href={`/titles/${title.id}`}>
        <span className="staff-title-name"><strong className="bilingual" lang="zh-CN">{title.name_zh}</strong>{title.name_en && title.name_en !== title.name_zh && <small className="gt-muted bilingual" lang="en">{title.name_en}</small>}</span>
        <span>{title.producer_name_en || title.producer_name_zh}</span>
        {title.uses_translation === false || title.video_only ? <>
          {/* An imported film (2026-09-24), or a title made from videos alone (UI sweep): its state is its episodes and crazydramas, not the translation workflow it never entered. */}
          <span><span className="pill pill-neutral" data-imported={title.uses_translation === false ? "true" : undefined}>{t(locale, title.uses_translation === false ? "admin.titles.imported" : "admin.titles.videoOnly", { n: title.episodes_ingested })}</span></span>
          <span><CrazydramasChip {...(crazydramas[title.id] ?? { state: "not_linked", stale: false, older: false })} locale={locale} /></span>
        </> : <>
          <span><TitlePill status={title.status} label={t(locale,titleStatusKey(title.status))} /></span>
          <span><span>{title.episodes_ingested}/{title.episode_count || "—"} · {percent(title.percent_adapted)}%</span><span className="track"><span style={{width:`${percent(title.percent_adapted)}%`}} /></span></span>
        </>}
        <span className="gt-num">{formatCents(title.cost_cents)}</span><span>{formatDate(title.updated_at,locale)}</span>
      </Link>)}
      {!titles.length && <div className="empty"><p>{t(locale, chosen ? "admin.titles.emptyProducer" : "admin.titles.empty")}</p></div>}
    </div>
  </>;
}
