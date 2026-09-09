import Link from "next/link";
import { adminLocale, staffSession } from "@/components/admin/server";
import { formatDate } from "@/components/admin/format";
import { getData } from "@/lib/data";
import { t, type Locale } from "@/lib/i18n";
import type { PromoCampaignSummary } from "@/lib/types";

// /promote — Pulsar's Promote desk. Every producer campaign, sorted into
// what needs Pulsar now (change requests to answer, failed launches), what
// is launched on TikTok (monitor: status, TikTok's note), and what is
// waiting on the producer. Staff do not approve launches (decision
// 2026-09-09); they watch and intervene.

export const dynamic = "force-dynamic";

type Queue = "action" | "launched" | "producer";

function queueOf(c: PromoCampaignSummary): Queue {
  if (c.status === "review" && c.change_count > 0) return "action";
  if (c.status === "failed") return "action";
  if (["launching", "submitted", "live", "paused", "ended"].includes(c.status)) return "launched";
  return "producer";
}

function nextStep(locale: Locale, c: PromoCampaignSummary): string {
  if (c.status === "review" && c.change_count > 0) return t(locale, "admin.promote.next.changes", { n: c.change_count });
  if (c.status === "launching") return t(locale, "admin.promote.next.launching");
  if (c.status === "submitted") return t(locale, "admin.promote.next.launch");
  if (c.status === "failed") return t(locale, "admin.promote.next.failed");
  if (c.status === "live") return t(locale, "admin.promote.next.done");
  if (c.status === "paused") return t(locale, "admin.promote.next.paused");
  if (c.status === "ended") return t(locale, "admin.promote.next.ended");
  return t(locale, "admin.promote.next.producer");
}

const STATUS_CLASS: Record<PromoCampaignSummary["status"], string> = {
  draft: "pill-neutral", generating: "pill-neutral", review: "status-review", approved: "status-approved",
  submitted: "pill-accent", launching: "status-adapting", live: "status-live", paused: "pill-warning", ended: "pill-neutral", failed: "pill-error",
};

export default async function PromoteDesk() {
  const session = await staffSession();
  const locale = adminLocale();
  const campaigns = await getData().listPromoCampaigns(session);
  const queues: { key: Queue; rows: PromoCampaignSummary[] }[] = (["action", "launched", "producer"] as Queue[]).map((key) => ({ key, rows: campaigns.filter((c) => queueOf(c) === key) }));

  return <>
    <div className="page-head"><div><h1>{t(locale, "admin.promote.title")}</h1><p className="page-sub">{t(locale, "admin.promote.sub")}</p></div><Link className="btn btn-outline" href="/tiktok">{t(locale, "admin.nav.tiktok")}</Link></div>
    {!campaigns.length && <div className="empty"><p>{t(locale, "admin.promote.empty")}</p></div>}
    {queues.filter((q) => q.rows.length).map((q) => <section className="pd-queue" key={q.key}>
      <h2 className="section-title">{t(locale, `admin.promote.queue.${q.key}`)} <span className="pd-count">{q.rows.length}</span></h2>
      <div className="gtable" style={{ "--cols": "minmax(220px,2fr) minmax(140px,1fr) 130px 90px minmax(180px,1.4fr) minmax(160px,1.4fr) 110px" } as React.CSSProperties}>
        <div className="gt-head"><span>{t(locale, "admin.promote.col.campaign")}</span><span>{t(locale, "admin.promote.col.producer")}</span><span>{t(locale, "admin.promote.col.status")}</span><span>{t(locale, "admin.promote.col.creatives")}</span><span>{t(locale, "admin.promote.col.next")}</span><span>{t(locale, "admin.promote.col.note")}</span><span>{t(locale, "admin.promote.col.updated")}</span></div>
        {q.rows.map((c) => <Link key={c.id} className="gt-row clickable" href={`/promote/${c.id}`}>
          <span><strong>{c.name}</strong><small className="gt-muted bilingual" lang="zh-CN">{c.title_name_en || c.title_name_zh} · {c.target_market}</small></span>
          <span>{c.producer_name_en || c.producer_name_zh}</span>
          <span><span className={`pill ${STATUS_CLASS[c.status]}`}>{t(locale, `admin.promote.status.${c.status}`)}</span></span>
          <span className="gt-num">{c.approved_count}/{c.creative_count}</span>
          <span className={q.key === "action" ? "pd-next-action" : ""}>{nextStep(locale, c)}</span>
          <span className="gt-muted" style={{ whiteSpace: "normal" }}>{c.status_note ?? (c.grow_campaign_id ? <span className="pd-mono">{c.grow_campaign_id}</span> : "")}</span>
          <span>{formatDate(c.updated_at, locale)}</span>
        </Link>)}
      </div>
    </section>)}
  </>;
}
