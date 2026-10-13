import "@/app/creators.css";
import { adminLocale, staffSession } from "@/components/admin/server";
import { getData } from "@/lib/data";
import { creatorsGate, lastCreatorsRun } from "@/lib/creators/sweeps";
import { t } from "@/lib/i18n";

// Creator accounts (decision 2026-10-12): every Instagram account Studio runs,
// with the automatic sweep's status line (process-local, like the
// auto-poster's: the last run this server made, or why nothing runs).

export const dynamic = "force-dynamic";

export default async function CreatorsPage() {
  const session = await staffSession();
  const locale = adminLocale();
  const tt = (key: string, vars?: Record<string, string | number>) => t(locale, key, vars);
  const data = getData();
  const [accounts, posts] = await Promise.all([data.listCreatorAccounts(session), data.listCreatorPosts(session)]);
  const gate = creatorsGate();
  const last = lastCreatorsRun();
  return (
    <>
      <div className="page-head">
        <h1>{tt("cr.title")}</h1>
        <p className="section-sub">{tt("cr.sub")}</p>
      </div>
      <p className="hint cr-status-line" role="status">
        {gate ? tt("cr.sweep.off", { why: gate })
          : last ? tt("cr.sweep.last", { at: new Date(last.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }), started: last.posts.started, sent: last.replies.sent, drafted: last.comments.drafted, flagged: last.comments.flagged })
          : tt("cr.sweep.never")}
        {last && last.errors.length > 0 && <> {tt("cr.sweep.errors", { n: last.errors.length, first: last.errors[0] })}</>}
      </p>
      {accounts.length ? (
        <div className="gtable" style={{ "--cols": "minmax(220px, 2fr) 110px 110px 90px 110px" } as React.CSSProperties}>
          <div className="gt-head">
            <span>{tt("cr.col.account")}</span><span>{tt("cr.col.status")}</span><span className="gt-num">{tt("cr.col.scheduled")}</span>
            <span className="gt-num">{tt("cr.col.failed")}</span><span>{tt("cr.col.autoReply")}</span>
          </div>
          {accounts.map(a => (
            <a key={a.id} className="gt-row" href={`/creators/${a.id}`}>
              <span><strong>{a.display_name}</strong> <span className="gt-muted">@{a.handle}</span></span>
              <span><span className={`pill ${a.status === "active" ? "pill-success" : "pill-neutral"}`}>{tt(`cr.status.${a.status}`)}</span></span>
              <span className="gt-num">{posts.filter(p => p.account_id === a.id && p.status === "scheduled").length}</span>
              <span className="gt-num">{posts.filter(p => p.account_id === a.id && p.status === "failed").length}</span>
              <span>{a.settings.auto_reply ? tt("cr.on") : tt("cr.off")}</span>
            </a>
          ))}
        </div>
      ) : <p className="empty">{tt("cr.empty")}</p>}
    </>
  );
}
