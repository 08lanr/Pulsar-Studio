import "@/app/crazydramas-stats.css";
import "@/app/creators.css";
import { notFound } from "next/navigation";
import { adminLocale, staffSession } from "@/components/admin/server";
import Character from "@/components/admin/creators/Character";
import Comments from "@/components/admin/creators/Comments";
import Library from "@/components/admin/creators/Library";
import Queue from "@/components/admin/creators/Queue";
import ReadNow from "@/components/admin/creators/ReadNow";
import { KpiCard, TrendChart } from "@/components/admin/cd-stats/Overview";
import { getData } from "@/lib/data";
import { isDataError } from "@/lib/data/errors";
import { mediaJson } from "@/lib/creators/routes";
import { accountOverview } from "@/lib/creators/service";
import { formatInZone } from "@/lib/creators/time";
import { t } from "@/lib/i18n";

// One creator account (decision 2026-10-12): Queue · Library · Comments ·
// Stats · Character, one tab at a time (?tab=). Stats is the dashboard: five
// numbers with their lines, one chart, ⓘ definitions, the per-post table.

export const dynamic = "force-dynamic";
const TABS = ["queue", "library", "comments", "stats", "character"] as const;
type Tab = (typeof TABS)[number];

export default async function CreatorPage({ params, searchParams }: { params: { id: string }; searchParams: { tab?: string } }) {
  const session = await staffSession();
  const locale = adminLocale();
  const tt = (key: string, vars?: Record<string, string | number>) => t(locale, key, vars);
  const tab: Tab = (TABS as readonly string[]).includes(searchParams.tab ?? "") ? (searchParams.tab as Tab) : "queue";
  const data = getData();
  const overview = await accountOverview(session, params.id).catch(e => { if (isDataError(e) && e.code === "not_found") notFound(); throw e; });
  const { account, headline } = overview;
  const canAdmin = session.staffRole === "admin";
  const tz = account.settings.timezone;
  const [posts, media] = await Promise.all([data.listCreatorPosts(session, { account_id: account.id }), data.listCreatorMedia(session, account.id)]);
  const live = posts.filter(p => p.status !== "cancelled");
  const mediaViews = media.map(m => mediaJson(m, live.filter(p => p.media_ids.includes(m.id)).length));
  const n0 = (v: number | null) => (v === null ? tt("cr.stats.unknown") : v.toLocaleString("en-US"));

  return (
    <>
      <a className="title-back" href="/creators">← {tt("cr.back")}</a>
      <div className="page-head cr-head">
        <h1>{account.display_name} <span className="gt-muted">@{account.handle}</span></h1>
        <span className={`pill ${account.status === "active" ? "pill-success" : "pill-neutral"}`}>{tt(`cr.status.${account.status}`)}</span>
        <a className="btn btn-sm btn-ghost" href={`https://www.instagram.com/${account.handle}/`} target="_blank" rel="noreferrer">{tt("cr.openInstagram")}&nbsp;→</a>
      </div>
      <nav className="tabs cdx-tabs" aria-label={account.display_name}>
        {TABS.map(x => (
          <a key={x} className={`tab${x === tab ? " on" : ""}`} aria-current={x === tab ? "page" : undefined} href={`/creators/${account.id}?tab=${x}`}>{tt(`cr.tab.${x}`)}</a>
        ))}
      </nav>

      {tab === "queue" && <Queue accountId={account.id} handle={account.handle} timezone={tz} posts={posts} media={mediaViews} canAdmin={canAdmin} />}
      {tab === "library" && <Library accountId={account.id} media={mediaViews} />}
      {tab === "comments" && (
        <Comments accountId={account.id} handle={account.handle} timezone={tz} autoReply={account.settings.auto_reply} canAdmin={canAdmin}
          comments={await data.listCreatorComments(session, { account_id: account.id })} />
      )}
      {tab === "character" && <Character account={account} canAdmin={canAdmin} />}
      {tab === "stats" && (
        <>
          <div className="cr-toolbar">
            <span className="hint">{headline.read_at ? tt("cr.stats.readAt", { at: formatInZone(headline.read_at, tz) }) : tt("cr.stats.never")}</span>
            {canAdmin && <ReadNow accountId={account.id} />}
          </div>
          <div className="cdx-kpis cdx-kpis-5">
            <KpiCard label={tt("cr.stats.followers")} info={tt("cr.stats.followersInfo")} value={n0(headline.followers)}
              sub={headline.followers_change_7d === null ? null : tt("cr.stats.change", { n: `${headline.followers_change_7d >= 0 ? "+" : ""}${headline.followers_change_7d}` })}
              spark={headline.followers_by_day.map(d => d.value)} />
            <KpiCard label={tt("cr.stats.reach")} info={tt("cr.stats.reachInfo")} value={n0(headline.reach_7d)} spark={headline.reach_by_day.map(d => d.value)} />
            <KpiCard label={tt("cr.stats.posts")} info={tt("cr.stats.postsInfo")} value={String(headline.published_30d)} sub={tt("cr.stats.scheduled", { n: headline.scheduled })} spark={headline.posts_by_day} />
            <KpiCard label={tt("cr.stats.replies")} info={tt("cr.stats.repliesInfo")} value={String(headline.replies_sent_7d)} sub={tt("cr.stats.flagged", { n: headline.flagged_open })} spark={headline.replies_by_day} />
            <KpiCard label={tt("cr.stats.best")} info={tt("cr.stats.bestInfo")} value={headline.best_post ? tt("cr.stats.reachOf", { n: headline.best_post.reach.toLocaleString("en-US") }) : "–"}
              sub={headline.best_post ? (headline.best_post.caption || headline.best_post.ig_media_id).slice(0, 60) : null} href={headline.best_post?.permalink ?? undefined} />
          </div>
          {headline.followers_by_day.length > 1 && <TrendChart title={tt("cr.stats.chart")} points={headline.followers_by_day} tableLabel={tt("cr.stats.table")} />}
          <h2 className="section-title">{tt("cr.stats.perPost")}</h2>
          <div className="gtable" style={{ "--cols": "minmax(200px, 2fr) repeat(6, 80px)" } as React.CSSProperties}>
            <div className="gt-head">
              <span>{tt("cr.stats.col.post")}</span>
              {(["reach", "likes", "comments", "saved", "shares", "views"] as const).map(k => <span key={k} className="gt-num">{tt(`cr.stats.col.${k}`)}</span>)}
            </div>
            {headline.media.map(m => {
              const post = posts.find(p => p.ig_media_id === m.ig_media_id);
              return (
                <div key={m.ig_media_id} className="gt-row">
                  <span className="cr-ellipsis">{post?.permalink ? <a href={post.permalink} target="_blank" rel="noreferrer">{post.caption || post.external_id}</a> : <span className="gt-muted">{m.ig_media_id}</span>}</span>
                  {(["reach", "likes", "comments", "saved", "shares", "views"] as const).map(k => <span key={k} className="gt-num">{m[k] === null ? "–" : m[k]!.toLocaleString("en-US")}</span>)}
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
