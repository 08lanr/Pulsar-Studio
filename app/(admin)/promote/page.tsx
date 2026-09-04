import Link from "next/link";
import { adminLocale, staffSession } from "@/components/admin/server";
import { formatDate } from "@/components/admin/format";
import { getData } from "@/lib/data";
import { t, type Locale } from "@/lib/i18n";
import type { PromoCampaignSummary } from "@/lib/types";

// /promote — Pulsar's Promote desk. Every producer campaign, sorted into
// what needs Pulsar now (change requests to answer, launches to run), what
// is waiting on the producer, and what is already out.

export const dynamic = "force-dynamic";

type Queue = "action" | "producer" | "done";

function queueOf(c: PromoCampaignSummary): Queue {
  if (c.status === "review" && c.change_count > 0) return "action";
  if (c.status === "submitted" || c.status === "launching" || c.status === "failed") return "action";
  if (c.status === "live") return "done";
  return "producer";
}

function nextStep(locale: Locale, c: PromoCampaignSummary): string {
  if (c.status === "review" && c.change_count > 0) return t(locale, "admin.promote.next.changes", { n: c.change_count });
  if (c.status === "submitted") return t(locale, "admin.promote.next.launch");
  if (c.status === "launching") return t(locale, "admin.promote.next.launching");
  if (c.status === "failed") return t(locale, "admin.promote.next.failed");
  if (c.status === "live") return t(locale, "admin.promote.next.done");
  return t(locale, "admin.promote.next.producer");
}

const STATUS_CLASS: Record<PromoCampaignSummary["status"], string> = {
  draft: "pill-neutral", generating: "pill-neutral", review: "status-review", approved: "status-approved",
  submitted: "pill-accent", launching: "status-adapting", live: "status-live", failed: "pill-error",
};

export default async function PromoteDesk() {
  const session = await staffSession();
  const locale = adminLocale();
  const campaigns = await getData().listPromoCampaigns(session);
  const queues: { key: Queue; rows: PromoCampaignSummary[] }[] = (["action", "producer", "done"] as Queue[]).map((key) => ({ key, rows: campaigns.filter((c) => queueOf(c) === key) }));

  return <>
    <div className="page-head"><div><h2>{t(locale, "admin.promote.title")}</h2><p className="page-sub">{t(locale, "admin.promote.sub")}</p></div></div>
    {!campaigns.length && <div className="empty"><p>{t(locale, "admin.promote.empty")}</p></div>}
    {queues.filter((q) => q.rows.length).map((q) => <section className="pd-queue" key={q.key}>
      <h3 className="section-title">{t(locale, `admin.promote.queue.${q.key}`)} <span className="pd-count">{q.rows.length}</span></h3>
      <div className="gtable" style={{ "--cols": "minmax(220px,2fr) minmax(140px,1fr) 150px 110px minmax(180px,1.4fr) 120px" } as React.CSSProperties}>
        <div className="gt-head"><span>{t(locale, "admin.promote.col.campaign")}</span><span>{t(locale, "admin.promote.col.producer")}</span><span>{t(locale, "admin.promote.col.status")}</span><span>{t(locale, "admin.promote.col.creatives")}</span><span>{t(locale, "admin.promote.col.next")}</span><span>{t(locale, "admin.promote.col.updated")}</span></div>
        {q.rows.map((c) => <Link key={c.id} className="gt-row clickable" href={`/promote/${c.id}`}>
          <span><strong>{c.name}</strong><small className="gt-muted bilingual" lang="zh-CN">{c.title_name_en || c.title_name_zh} · {c.target_market}</small></span>
          <span>{c.producer_name_en || c.producer_name_zh}</span>
          <span><span className={`pill ${STATUS_CLASS[c.status]}`}>{t(locale, `admin.promote.status.${c.status}`)}</span></span>
          <span className="gt-num">{c.approved_count}/{c.creative_count}</span>
          <span className={q.key === "action" ? "pd-next-action" : ""}>{nextStep(locale, c)}</span>
          <span>{formatDate(c.updated_at, locale)}</span>
        </Link>)}
      </div>
    </section>)}
  </>;
}
