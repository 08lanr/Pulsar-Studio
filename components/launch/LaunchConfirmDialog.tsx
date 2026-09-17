"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/components/locale";
import { usd } from "@/components/tiktok/api";
import { planSummary } from "./plan-summary";
import AdCard, { type AdCardProps } from "./AdCard";
import { feeLineVars } from "@/lib/promote/fee";
import type { LaunchContent, LaunchPlan, LaunchProvider, LaunchRun, MetaPlatform } from "@/lib/launch/types";

export default function LaunchConfirmDialog({ name, plan, destination, startPaused, provider, mode, accountNames, cards, pageDesign, staff, note, onNoteChange, error, onClose, onConfirm }: {
  name: string; plan: LaunchPlan; destination: string; startPaused: boolean;
  provider: LaunchProvider; mode: LaunchRun["mode"]; accountNames: Record<string, string>;
  /** One resolved card per content entry, keyed `kind:value`, shared with step 3 and the preview. */
  cards?: Record<string, AdCardProps>;
  pageDesign?: { name: string; button_text: string; background: "white" | "black"; hand_cursor: boolean };
  staff: boolean; note: string; onNoteChange: (value: string) => void; error: string;
  onClose: () => void; onConfirm: () => void;
}) {
  const { tt } = useT();
  const panel = useRef<HTMLDivElement>(null);
  const errorBox = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) { errorBox.current?.focus({ preventScroll: true }); errorBox.current?.scrollIntoView({ block: "nearest" }); }
  }, [error]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab" || !panel.current) return;
      const controls = Array.from(panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), textarea:not(:disabled), input:not(:disabled)"));
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [onClose]);
  return createPortal(<div className="launch-dialog-backdrop launch-confirm-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="launch-dialog launch-confirm-dialog" style={{ width: "min(920px, 100%)", maxWidth: 920 }} ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="launch-confirm-title" aria-describedby="launch-confirm-summary">
      <h2 id="launch-confirm-title">{tt("launchFeedback.confirm")}</h2>
      <p className="note">{tt(mode === "production" ? "launchFeedback.realCreation" : "launchFeedback.testCreation", { provider: provider === "tiktok" ? "TikTok" : "Meta" })}</p>
      <p id="launch-confirm-summary">{name}: {planSummary(tt, plan, (cents) => usd(cents / 100))}</p>
      <p>{tt("lv2.destination")}: {destination}</p>
      {pageDesign && <p className="note">{tt("salesLaunch.sales")}: {pageDesign.name} · {tt("tipTemplates.button")}: {pageDesign.button_text} · {tt(`tipTemplates.background.${pageDesign.background}`)}{pageDesign.hand_cursor ? ` · ${tt("tipTemplates.handCursor")}` : ""}</p>}
      {/* A preview of the ads, not a list of references: the account and the
          money, then one card per ad, then one small line with the campid and
          its tracking link. No raw provider id appears anywhere here. */}
      <div className="launch-confirm-rows">{plan.rows.map(row => {
        const ads: { item: LaunchContent; platform?: MetaPlatform }[] = row.ad_sets?.length
          ? row.ad_sets.flatMap(set => set.content.map(item => ({ item, platform: set.platform })))
          : row.content.map(item => ({ item }));
        return <article className="launch-confirm-row" key={row.index}>
          <p className="launch-confirm-head"><strong>{accountNames[row.connection_id] ?? tt("lv2.account")}</strong><span className="launch-confirm-budget">{usd(row.budget_cents / 100)}</span></p>
          <div className="launch-confirm-ads">{ads.map(({ item, platform }, index) => {
            const card = cards?.[`${item.kind}:${item.value}`] ?? {
              platform: item.kind === "instagram_post" ? "instagram" as const : item.kind === "spark" ? "tiktok" as const : "facebook" as const,
              kind: item.kind, label: item.label || item.value, caption: item.text ?? null, headline: item.headline ?? null,
              thumbnail_url: null, media_url: null, id: item.value,
            };
            return <AdCard key={`${platform ?? ""}:${item.kind}:${item.value}:${index}`} {...card} compact {...(platform ? { platform, platforms: undefined } : {})} />;
          })}</div>
          <p className="launch-confirm-ref">{row.campid && <small>{tt("mr2.campid")}: {row.campid}{row.tracking_url ? ` · ${row.tracking_url}` : ""}</small>}</p>
        </article>;
      })}</div>
      {plan.warnings.length > 0 && <ul>{plan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      <p className="note">{tt("lv2.feeLine", feeLineVars(plan.total_budget_cents / 100))}</p>
      <p className="note">{tt(startPaused ? "launchFeedback.pausedConfirmation" : "launchFeedback.liveConfirmation")}</p>
      {staff && <label className="tk-field launch-confirm-note">{tt("lv2.onBehalfNote")}<textarea className="input" required aria-describedby="launch-authorization-help" value={note} onChange={event => onNoteChange(event.target.value)} /><span className="hint" id="launch-authorization-help">{tt("launchFeedback.noteHelp")}</span></label>}
      {error && <p className="note note-warn" role="alert" tabIndex={-1} ref={errorBox}>{error}</p>}
      <div className="rs-tool-row"><button type="button" className="btn btn-outline" onClick={onClose}>{tt("common.cancel")}</button><button type="button" className="btn btn-approve" onClick={onConfirm}>{tt("launchFeedback.confirm")}</button></div>
    </div>
  </div>, document.body);
}
