"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/api-client";
import { useT } from "@/components/locale";
import type { LaunchBlocker } from "@/lib/promote/launch-gate";
import type { PromoCampaignDetail, PromoCreative } from "@/lib/types";

function seconds(ms: number | null) { return ms === null ? "—" : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`; }

type Props = {
  detail: PromoCampaignDetail;
  /** Episode id -> source video url. */
  media: Record<string, string | null>;
  /** Creative id -> rendered ad url (the finished file), when rendered. */
  renders?: Record<string, string | null>;
  canAct?: boolean;
  canApprove?: boolean;
  /** Why launch is not available yet (empty = ready); shown beside the launch button. */
  blockers?: LaunchBlocker[];
  launchMode?: "fake" | "sandbox" | "production";
};

export default function PromoWorkspace({ detail, media, renders = {}, canAct = true, canApprove = false, blockers = [], launchMode = "fake" }: Props) {
  const { tt } = useT();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const active = detail.creatives.filter((x) => x.status !== "superseded");
  const approved = active.filter((x) => x.status === "approved").length;
  const pending = active.filter((x) => x.status === "ready").length;
  const status = detail.campaign.status;
  const locked = ["approved", "submitted", "launching", "live", "paused", "ended", "failed", "generating"].includes(status);
  const budgetReady = !detail.campaign.experiment || !!detail.campaign.experiment.approved_at;
  const generating = status === "generating" || status === "launching";

  // Renders and the launch run in the background: poll while the campaign is in a transient state.
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [generating, router]);

  async function act(key: string, path: string, body: Record<string, unknown> = {}) {
    setBusy(key); setError(null);
    try {
      const response = await postJson<{ error?: string }>(path, body);
      if (response.error) throw new Error(response.error);
      router.refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  async function review(c: PromoCreative, s: "approved" | "rejected") {
    await act(c.id, `/api/producer/promote/creatives/${c.id}/review`, { status: s, rejection_note: s === "rejected" ? notes[c.id] || null : null });
  }

  if (status === "generating") return <p role="status">{tt("workflow.hint.generating")}</p>;
  if (status === "failed" && !active.length) return <p role="alert">{tt("workflow.hint.failed")}</p>;
  if (!active.length && !detail.episodes.some(e => e.video_path)) return <section className="fc-empty"><p>{tt("launch.planNote")}</p><a className="btn btn-primary" href={`/producer/titles/${detail.title.id}/materials#add-episodes`}>{tt("ux.addMaterials")}</a></section>;
  if (!active.length) return <section className="fc-empty"><h3>{tt("promote.workspace.readyTitle")}</h3><p>{tt("promote.workspace.readyHint")}</p>{canAct && <button className="btn btn-primary" disabled={!!busy} onClick={() => act("generate", `/api/producer/promote/${detail.campaign.id}/generate`)}>{busy ? tt("common.loading") : tt("promote.workspace.generate")}</button>}{error && <p className="err" role="alert">{error}</p>}</section>;

  const anyRendered = active.some((c) => c.render_path && renders[c.id]);
  const launchBlocked = blockers.length > 0;

  return <div className="fc-ad-review">
    <div className="fc-review-toolbar">
      <p>{tt("fc.selection", { approved, total: active.length })}{!locked && detail.campaign.experiment && <small>{tt("ws.exp.selectBatch", { n: detail.campaign.experiment.first_batch, total: active.length })}</small>}</p>
      <div className="fc-toolbar-actions">
        {status === "review" && pending > 0 && <button className="btn btn-outline btn-sm" disabled={!!busy || !canAct} onClick={() => act("approve-all", `/api/producer/promote/${detail.campaign.id}/approve-all`)}>{busy === "approve-all" ? tt("common.loading") : tt("promote.workspace.approveAll", { n: pending })}</button>}
        {status === "review" && <button className="btn btn-approve" disabled={!!busy || !canApprove || approved === 0} onClick={() => act("approve-campaign", `/api/producer/promote/${detail.campaign.id}/approve`)}>{busy === "approve-campaign" ? tt("common.loading") : tt("promote.workspace.approveBatch")}</button>}
        {status === "approved" && <button className="btn btn-primary" disabled={!!busy || !canApprove || !budgetReady || launchBlocked} onClick={() => act("submit", `/api/producer/promote/${detail.campaign.id}/submit`)}>{busy === "submit" ? tt("common.loading") : tt("promote.workspace.submitLaunch")}</button>}
      </div>
    </div>
    {!locked && <p className="fc-review-guidance">{tt("review.selectionHint")}</p>}
    <p className="fc-review-guidance">{anyRendered ? tt("promote.workspace.renderedPreview") : tt("review.sourcePreview")}</p>
    {!canApprove && ["review", "approved"].includes(status) && <p className="fc-review-guidance">{tt("fc.approverNeeded")}</p>}
    {status === "approved" && !budgetReady && <p className="fc-review-guidance">{tt("fc.approveBudgetFirst")} <a href="#brief">{tt("ws.exp.brief")}</a></p>}
    {status === "approved" && budgetReady && launchBlocked && <div className="note note-warn" role="status"><strong>{tt("promote.workspace.blocked")}</strong><ul style={{ margin: "6px 0 0 18px" }}>{blockers.map((b) => <li key={b}>{tt(`promote.block.${b}`)}{(b === "no_launch_account" || b === "no_identity") && <> · <a href="/producer/company?tab=accounts">{tt("promote.block.setupLink")}</a></>}</li>)}</ul></div>}
    {status === "approved" && budgetReady && !launchBlocked && <p className="note note-info">{tt(launchMode === "fake" ? "promote.workspace.launchDemoNote" : launchMode === "sandbox" ? "promote.workspace.launchSandboxNote" : "promote.workspace.launchLiveNote")}</p>}
    {error && <p className="note note-warn" role="alert">{error}</p>}
    <div className="fc-ad-grid">{active.map((creative, index) => {
      const rendered = creative.render_path ? renders[creative.id] : null;
      const source = creative.source_episode_id ? media[creative.source_episode_id] : null;
      const ep = detail.episodes.find((x) => x.id === creative.source_episode_id);
      return <article className={`fc-ad ${creative.status}`} key={creative.id}>
        <header className="fc-ad-heading"><span className="fc-ad-number">{tt("fc.adNumber", { n: index + 1 })}</span><span>{tt(`promote.kind.${creative.kind}`)}</span><span className={`pill ${creative.status === "approved" ? "pill-success" : creative.status === "rejected" ? "pill-error" : "pill-neutral"}`}>{tt(`promote.creativeStatus.${creative.status}`)}</span></header>
        <div className="fc-ad-main">
          <div className="fc-ad-media">{rendered ? <video aria-label={tt("fc.preview", { n: index + 1 })} src={rendered} controls preload="metadata" /> : source ? <video aria-label={tt("fc.preview", { n: index + 1 })} src={`${source}#t=${Math.floor((creative.source_start_ms ?? 0) / 1000)}`} controls preload="metadata" /> : <div className="fc-no-preview">{tt("fc.noPreview")}</div>}</div>
          <div className="fc-ad-message"><h3>{creative.hypothesis}</h3><blockquote>{creative.hook}</blockquote><p className="fc-ad-source">{ep ? tt("portal.episode", { n: ep.number }) : tt("fc.sourceUnknown")} · {seconds(creative.source_start_ms)}–{seconds(creative.source_end_ms)}{!rendered && anyRendered && <> · {tt("promote.workspace.renderPending")}</>}</p>{creative.version > 1 && <span className="fc-version">{tt("promote.workspace.revised", { v: creative.version })}</span>}</div>
        </div>
        <details className="fc-ad-details"><summary>{tt("fc.copyDetails")}</summary><dl><dt>{tt("promote.workspace.caption")}</dt><dd>{creative.caption}</dd><dt>{tt("promote.workspace.description")}</dt><dd>{creative.ad_description}</dd>{creative.revision_note && <><dt>{tt("promote.workspace.revisionNote")}</dt><dd>{creative.revision_note}</dd></>}</dl></details>
        {creative.status === "rejected" && <p className="fc-change-sent">{tt("promote.workspace.changeSent")}{creative.rejection_note ? ` — ${creative.rejection_note}` : ""}</p>}
        {!locked && <footer className="fc-ad-actions"><button className={`btn btn-sm ${creative.status === "approved" ? "btn-outline" : "btn-primary"}`} disabled={!!busy || !canAct || creative.status === "approved"} onClick={() => review(creative, "approved")}>{busy === creative.id ? tt("common.loading") : creative.status === "approved" ? tt("promote.creativeStatus.approved") : tt("promote.workspace.keep")}</button><details className="fc-change-request"><summary>{tt("promote.workspace.requestChange")}</summary><label htmlFor={`change-${creative.id}`}>{tt("promote.workspace.changeHint")}</label><textarea id={`change-${creative.id}`} className="textarea" rows={2} disabled={!!busy || !canAct} value={notes[creative.id] ?? ""} onChange={(e) => setNotes({ ...notes, [creative.id]: e.target.value })}/><button className="btn btn-outline btn-sm" disabled={!!busy || !canAct || !(notes[creative.id] ?? "").trim()} onClick={() => review(creative, "rejected")}>{tt("promote.workspace.requestChange")}</button></details></footer>}
      </article>;
    })}</div>
  </div>;
}
