"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/api-client";
import { useT } from "@/components/locale";
import { ANGLES, ANGLE_ORDER, angleOf, budgetCheck, type AngleId } from "@/lib/angles";
import type { LaunchBlocker } from "@/lib/promote/launch-gate";
import type { PromoCampaignDetail, PromoCreative } from "@/lib/types";

// The ad review of one campaign (decision 2026-09-14 "angles, clips and a
// budget-gated pick", UI pass the same day: "the budget / ad interaction
// should be obvious; the angles more obvious, e.g. tabs on top").
//
// - The budget card turns the money into slots: budget ÷ the per-ad
//   minimum. Chosen ads fill slots; when they are full every Choose button
//   greys out and the card says what to do (unselect, or raise the budget).
// - Angles are tabs above the ads: direct clips today, narration as a
//   disabled "coming soon" tab. Each card says how much it reserves.
// - Approving the ads is refused while the pick is over budget (the data
//   layer enforces it too); a chosen ad can be unselected.

function seconds(ms: number | null) { return ms === null ? "—" : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`; }
const usd = (n: number) => `$${Math.round(n)}`;

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
  const [tab, setTab] = useState<AngleId>("direct_clip");
  const active = detail.creatives.filter((x) => x.status !== "superseded");
  const approved = active.filter((x) => x.status === "approved").length;
  const pending = active.filter((x) => x.status === "ready").length;
  const status = detail.campaign.status;
  const locked = ["approved", "submitted", "launching", "live", "paused", "ended", "failed", "generating"].includes(status);
  const budgetReady = !detail.campaign.experiment || !!detail.campaign.experiment.approved_at;
  const generating = status === "generating" || status === "launching";
  const budgetUsd = detail.campaign.experiment?.budget_usd ?? 0;
  const minUsd = ANGLES.direct_clip.min_budget_usd;
  const budget = budgetCheck(active, budgetUsd);
  const slotsLeft = Math.max(0, budget.covers - budget.chosen);
  const slotsFull = budget.covers > 0 && slotsLeft === 0;
  const overBudget = !budget.ok;

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
  async function review(c: PromoCreative, s: "approved" | "rejected" | "ready") {
    await act(c.id, `/api/producer/promote/creatives/${c.id}/review`, { status: s, rejection_note: s === "rejected" ? notes[c.id] || null : null });
  }

  if (status === "generating") return <p role="status">{tt("workflow.hint.generating")}</p>;
  if (status === "failed" && !active.length) return <p role="alert">{tt("workflow.hint.failed")}</p>;
  if (!active.length && !detail.episodes.some(e => e.video_path)) return <section className="fc-empty"><p>{tt("launch.planNote")}</p><a className="btn btn-primary" href={`/producer/titles/${detail.title.id}/materials#add-episodes`}>{tt("ux.addMaterials")}</a></section>;
  if (!active.length) return <section className="fc-empty"><h3>{tt("promote.workspace.readyTitle")}</h3><p>{tt("promote.workspace.readyHint")}</p>{canAct && <button className="btn btn-primary" disabled={!!busy} onClick={() => act("generate", `/api/producer/promote/${detail.campaign.id}/generate`)}>{busy ? tt("common.loading") : tt("promote.workspace.generate")}</button>}{error && <p className="err" role="alert">{error}</p>}</section>;

  const anyRendered = active.some((c) => c.render_path && renders[c.id]);
  const launchBlocked = blockers.length > 0;
  const byAngle = new Map<AngleId, PromoCreative[]>();
  for (const c of active) {
    const a = angleOf(c.kind);
    byAngle.set(a, [...(byAngle.get(a) ?? []), c]);
  }
  const numberOf = new Map(active.map((c, i) => [c.id, i + 1]));

  const card = (creative: PromoCreative) => {
    const n = numberOf.get(creative.id) ?? 0;
    const rendered = creative.render_path ? renders[creative.id] : null;
    const source = creative.source_episode_id ? media[creative.source_episode_id] : null;
    const ep = detail.episodes.find((x) => x.id === creative.source_episode_id);
    const settings = (creative.render_settings ?? {}) as { source?: string; moment?: string };
    const fromClips = settings.source === "auto_clip";
    const chosen = creative.status === "approved";
    const chooseBlocked = !chosen && slotsFull;
    return <article className={`fc-ad ${creative.status}`} key={creative.id}>
      <header className="fc-ad-heading"><span className="fc-ad-number">{tt("fc.adNumber", { n })}</span><span>{tt(`promote.kind.${creative.kind}`)}</span>{settings.moment && <span>{tt(`clips.moment.${settings.moment}`)}</span>}<span className="fc-ad-reserve">{tt("angles.reserves", { min: usd(ANGLES[angleOf(creative.kind)].min_budget_usd) })}</span><span className={`pill ${chosen ? "pill-success" : creative.status === "rejected" ? "pill-error" : "pill-neutral"}`}>{tt(`promote.creativeStatus.${creative.status}`)}</span></header>
      <div className="fc-ad-main">
        <div className="fc-ad-media">{rendered ? <video aria-label={tt("fc.preview", { n })} src={rendered} controls preload="metadata" /> : source ? <video aria-label={tt("fc.preview", { n })} src={`${source}#t=${Math.floor((creative.source_start_ms ?? 0) / 1000)}`} controls preload="metadata" /> : <div className="fc-no-preview">{tt("fc.noPreview")}</div>}</div>
        <div className="fc-ad-message"><h3>{creative.hypothesis}</h3>{creative.hook ? <blockquote>{creative.hook}</blockquote> : <p className="fc-ad-nohook">{tt("clips.noHook")}</p>}<p className="fc-ad-source">{ep ? tt("portal.episode", { n: ep.number }) : tt("fc.sourceUnknown")} · {seconds(creative.source_start_ms)}–{seconds(creative.source_end_ms)} · {tt(fromClips ? "angles.fromClips" : "angles.fixedOffsets")}{!rendered && anyRendered && <> · {tt("promote.workspace.renderPending")}</>}</p>{creative.version > 1 && <span className="fc-version">{tt("promote.workspace.revised", { v: creative.version })}</span>}</div>
      </div>
      <details className="fc-ad-details"><summary>{tt("fc.copyDetails")}</summary><dl><dt>{tt("promote.workspace.caption")}</dt><dd>{creative.caption}</dd><dt>{tt("promote.workspace.description")}</dt><dd>{creative.ad_description}</dd>{creative.revision_note && <><dt>{tt("promote.workspace.revisionNote")}</dt><dd>{creative.revision_note}</dd></>}</dl></details>
      {creative.status === "rejected" && <p className="fc-change-sent">{tt("promote.workspace.changeSent")}{creative.rejection_note ? ` — ${creative.rejection_note}` : ""}</p>}
      {!locked && <footer className="fc-ad-actions">
        {chosen
          ? <button className="btn btn-sm btn-outline" disabled={!!busy || !canAct} onClick={() => review(creative, "ready")}>{busy === creative.id ? tt("common.loading") : tt("angles.unselect")}</button>
          : <button className="btn btn-sm btn-primary" disabled={!!busy || !canAct || chooseBlocked} title={chooseBlocked ? tt("angles.slots.full") : undefined} onClick={() => review(creative, "approved")}>{busy === creative.id ? tt("common.loading") : tt("promote.workspace.keep")}</button>}
        <details className="fc-change-request"><summary>{tt("promote.workspace.requestChange")}</summary><label htmlFor={`change-${creative.id}`}>{tt("promote.workspace.changeHint")}</label><textarea id={`change-${creative.id}`} className="textarea" rows={2} disabled={!!busy || !canAct} value={notes[creative.id] ?? ""} onChange={(e) => setNotes({ ...notes, [creative.id]: e.target.value })}/><button className="btn btn-outline btn-sm" disabled={!!busy || !canAct || !(notes[creative.id] ?? "").trim()} onClick={() => review(creative, "rejected")}>{tt("promote.workspace.requestChange")}</button></details>
      </footer>}
    </article>;
  };

  // The slot meter: one box per slot the budget covers; chosen slots filled; extra chosen ads shown as over.
  const slotCount = Math.max(budget.covers, budget.chosen);
  const slots = Array.from({ length: slotCount }, (_, i) => (i < budget.chosen ? (i < budget.covers ? "is-chosen" : "is-over") : ""));
  const slotLine = !detail.campaign.experiment
    ? tt("angles.slots.none")
    : overBudget
      ? tt("angles.overBudget", { chosen: budget.chosen, covers: budget.covers, over: budget.chosen - budget.covers })
      : slotsFull
        ? tt("angles.slots.full")
        : tt("angles.slots.left", { n: slotsLeft });

  return <div className="fc-ad-review">
    <section className="fc-budget-card" aria-label={tt("angles.slots.title")}>
      <div className="fc-budget-head"><strong>{tt("angles.slots.title")}</strong><span>{tt("angles.slots.budget", { budget: usd(budgetUsd), min: usd(minUsd) })}</span></div>
      <div className="fc-slots" role="img" aria-label={tt("angles.slots.used", { chosen: budget.chosen, covers: budget.covers })}>{slots.map((cls, i) => <span className={`fc-slot ${cls}`} key={i} />)}</div>
      <p className={`fc-budget-line${slotsFull || overBudget ? " is-full" : ""}`}><strong>{tt("angles.slots.used", { chosen: budget.chosen, covers: budget.covers })}</strong> · {slotLine}</p>
      <div className="fc-toolbar-actions">
        {status === "review" && pending > 0 && pending <= slotsLeft && <button className="btn btn-outline btn-sm" disabled={!!busy || !canAct} onClick={() => act("approve-all", `/api/producer/promote/${detail.campaign.id}/approve-all`)}>{busy === "approve-all" ? tt("common.loading") : tt("promote.workspace.approveAll", { n: pending })}</button>}
        {status === "review" && <button className="btn btn-approve" disabled={!!busy || !canApprove || approved === 0 || overBudget} onClick={() => act("approve-campaign", `/api/producer/promote/${detail.campaign.id}/approve`)}>{busy === "approve-campaign" ? tt("common.loading") : tt("promote.workspace.approveBatch")}</button>}
        {status === "approved" && <button className="btn btn-primary" disabled={!!busy || !canApprove || !budgetReady || launchBlocked} onClick={() => act("submit", `/api/producer/promote/${detail.campaign.id}/submit`)}>{busy === "submit" ? tt("common.loading") : tt("promote.workspace.submitLaunch")}</button>}
      </div>
    </section>
    {!locked && <p className="fc-review-guidance">{tt("review.selectionHint")}</p>}
    {status === "review" && detail.campaign.status_note && <p className="note note-info">{detail.campaign.status_note}</p>}
    <p className="fc-review-guidance">{anyRendered ? tt("promote.workspace.renderedPreview") : tt("review.sourcePreview")}</p>
    {!canApprove && ["review", "approved"].includes(status) && <p className="fc-review-guidance">{tt("fc.approverNeeded")}</p>}
    {status === "approved" && !budgetReady && <p className="fc-review-guidance">{tt("fc.approveBudgetFirst")} <a href="#brief">{tt("ws.exp.brief")}</a></p>}
    {status === "approved" && budgetReady && launchBlocked && <div className="note note-warn" role="status"><strong>{tt("promote.workspace.blocked")}</strong><ul style={{ margin: "6px 0 0 18px" }}>{blockers.map((b) => <li key={b}>{tt(`promote.block.${b}`)}{(b === "no_launch_account" || b === "no_identity") && <> · <a href="/producer/company?tab=accounts">{tt("promote.block.setupLink")}</a></>}</li>)}</ul></div>}
    {status === "approved" && budgetReady && !launchBlocked && <p className="note note-info">{tt(launchMode === "fake" ? "promote.workspace.launchDemoNote" : launchMode === "sandbox" ? "promote.workspace.launchSandboxNote" : "promote.workspace.launchLiveNote")}</p>}
    {error && <p className="note note-warn" role="alert">{error}</p>}

    <div className="fc-angle-tabs" role="tablist" aria-label={tt("angles.title")}>
      {ANGLE_ORDER.map((angleId) => {
        const angle = ANGLES[angleId];
        const soon = angle.status === "coming_soon";
        const count = (byAngle.get(angleId) ?? []).length;
        return <button type="button" role="tab" key={angleId} id={`angle-tab-${angleId}`} aria-selected={tab === angleId} aria-controls={`angle-panel-${angleId}`} disabled={soon} onClick={() => setTab(angleId)}>
          {tt(`angles.${angleId}`)}
          <span className="pill pill-neutral">{soon ? tt("angles.comingSoon") : tt("angles.tab.count", { n: count })}</span>
        </button>;
      })}
    </div>
    {ANGLE_ORDER.map((angleId) => {
      if (tab !== angleId) return null;
      const angle = ANGLES[angleId];
      const ads = byAngle.get(angleId) ?? [];
      return <section className="fc-angle-panel" role="tabpanel" id={`angle-panel-${angleId}`} aria-labelledby={`angle-tab-${angleId}`} key={angleId}>
        <p>{tt(`angles.${angleId}.hint`, { min: usd(angle.min_budget_usd) })}</p>
        {angle.status === "coming_soon"
          ? <div className="fc-angle-soon"><h3>{tt(`angles.${angleId}`)}</h3><p>{tt(`angles.${angleId}.hint`)}</p></div>
          : <div className="fc-ad-grid">{ads.map(card)}</div>}
      </section>;
    })}
  </div>;
}
