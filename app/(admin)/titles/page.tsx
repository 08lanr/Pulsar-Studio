import Link from "next/link";
import { adminLocale, staffSession } from "@/components/admin/server";
import { formatCents, formatDate, percent } from "@/components/admin/format";
import { TitlePill, titleStatusKey } from "@/components/admin/StatusPill";
import { getData } from "@/lib/data";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function TitlesPage() {
  const session = await staffSession();
  const locale = adminLocale();
  const titles = await getData().listTitles(session);
  return <>
    <div className="page-head"><div><h1>{t(locale, "admin.titles.title")}</h1><p className="page-sub">{t(locale, "admin.titles.sub")}</p></div><Link className="btn btn-primary" href="/titles/new">{t(locale, "admin.titles.new")}</Link></div>
    <p className="staff-scroll-hint" id="staff-titles-scroll">{t(locale, "redesign.scrollTable")}</p>
    <div className="gtable staff-titles-table" role="region" aria-label={t(locale, "admin.titles.title")} aria-describedby="staff-titles-scroll" tabIndex={0} style={{ "--cols": "minmax(220px,2fr) minmax(140px,1fr) 110px minmax(150px,1fr) 90px 120px" } as React.CSSProperties}>
      <div className="gt-head"><span>{t(locale,"term.title")}</span><span>{t(locale,"admin.titles.producer")}</span><span>{t(locale,"admin.titles.status")}</span><span>{t(locale,"admin.titles.progress")}</span><span>{t(locale,"admin.titles.cost")}</span><span>{t(locale,"admin.titles.updated")}</span></div>
      {titles.map((title) => <Link key={title.id} className="gt-row clickable" href={`/titles/${title.id}`}>
        <span className="staff-title-name"><strong className="bilingual" lang="zh-CN">{title.name_zh}</strong>{title.name_en && <small className="gt-muted bilingual" lang="en">{title.name_en}</small>}</span>
        <span>{title.producer_name_en || title.producer_name_zh}</span>
        <span><TitlePill status={title.status} label={t(locale,titleStatusKey(title.status))} /></span>
        <span><span>{title.episodes_ingested}/{title.episode_count || "—"} · {percent(title.percent_adapted)}%</span><span className="track"><span style={{width:`${percent(title.percent_adapted)}%`}} /></span></span>
        <span className="gt-num">{formatCents(title.cost_cents)}</span><span>{formatDate(title.updated_at,locale)}</span>
      </Link>)}
      {!titles.length && <div className="empty"><p>{t(locale,"admin.titles.empty")}</p></div>}
    </div>
  </>;
}
