"use client";

// The last screen before real money moves (docs/launch-ux-round-2.md §1.6/§2.4,
// rebuilt 2026-09-17 after "this UI is completely garbage").
//
// A confirmation is not a summary of everything we know; it restates the one
// request with its one consequence, in the order a person decides in:
//   title → what this does → the facts, scannable → the ads → the money → act.
// So: one sentence naming the account, the provider and the campaign count and
// saying that nothing spends yet; a two-column fact grid; the ads grouped under
// their campaign; the bill as three right-aligned numbers instead of a sentence;
// then a footer that stays put, so the buttons are never below the fold.
//
// Nothing a person does not decide with is allowed to be headline content: the
// Spark code, the advertiser id and the tracking query string live in `title=`,
// `data-content-id` and a link labelled by its host. The dialog prints no raw
// provider reference at all.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/components/locale";
import { usd } from "@/components/tiktok/api";
import { planScale } from "./plan-summary";
import AdCard, { type AdCardProps } from "./AdCard";
import { billedTotalUsd, feeLineVars, serviceFeeUsd } from "@/lib/promote/fee";
import type { LaunchContent, LaunchPlan, LaunchProvider, LaunchRun, MetaPlatform } from "@/lib/launch/types";

const PROVIDER_WORD: Record<LaunchProvider, string> = { tiktok: "TikTok", meta: "Meta" };

/** A tracking link is read by where it goes, never by its query string. */
function linkWord(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export default function LaunchConfirmDialog({ name, plan, destination, destinationNote, optimizes, pixelNote, startPaused, provider, mode, accountNames, cards, pageDesign, adLine, staff, note, onNoteChange, error, onClose, onConfirm }: {
  name: string; plan: LaunchPlan; destination: string; startPaused: boolean;
  /**
   * TikTok: what each ad promotes and the exact link it carries (a launch may
   * promote several titles, each ad its own). Null link: the ad carries an
   * Instant Page.
   */
  adLine?: (item: LaunchContent, campaignUrl?: string) => { title: string; link: string | null } | null;
  /** One line under the destination: for TikTok, what its literal macros become. */
  destinationNote?: string;
  /** TikTok Website purchases: the pixel event, pixel and attribution the ad groups are created with. */
  optimizes?: string;
  /** TikTok Website purchases: the plain words for a pixel ID set by hand, which TikTok cannot confirm yet (planPixelNote). */
  pixelNote?: string;
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
      const controls = Array.from(panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href]"));
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [onClose]);

  const providerWord = PROVIDER_WORD[provider];
  const scale = planScale(tt, plan.campaign_count, plan.account_count);
  const one = plan.campaign_count === 1;
  // The accounts are named, in the order the plan uses them, never as `act_…`.
  const accounts: string[] = [];
  for (const row of plan.rows) {
    const label = accountNames[row.connection_id] ?? tt("lv2.account");
    if (!accounts.includes(label)) accounts.push(label);
  }
  // What this does, in one sentence. A test run keeps the existing wording,
  // because the only consequence worth stating there is that there is none.
  const creates = mode === "production"
    ? (accounts.length === 1
      ? tt("lr3.createsIn", { campaigns: scale.campaigns, provider: providerWord, account: accounts[0] })
      : tt("lr3.createsAcross", { campaigns: scale.campaigns, provider: providerWord, accounts: scale.accounts }))
    : tt("launchFeedback.testCreation", { provider: providerWord });
  const outcome = startPaused
    ? tt(one ? "lr3.startsPausedOne" : "lr3.startsPausedMany")
    : tt(one ? "lr3.startsLiveOne" : "lr3.startsLiveMany", { provider: providerWord });

  // One link for every ad reads as one destination; several titles in one
  // launch are named under each ad instead.
  const adLinks = new Set(adLine ? plan.rows.flatMap(row => row.content.map(item => adLine(item, row.tracking_url)?.link ?? destination)) : []);
  const perAd = adLinks.size > 1;

  const budgetUsd = plan.total_budget_cents / 100;
  const billed = usd(billedTotalUsd(budgetUsd));
  // The button says what pressing it commits to; its accessible name stays the
  // two words every habit — and every spec file — locates this action by.
  const confirmWord = tt("launchFeedback.confirm");
  const confirmLabel = mode === "production" ? tt("lr3.confirmBilled", { total: billed }) : confirmWord;

  return createPortal(<div className="launch-dialog-backdrop launch-confirm-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="launch-dialog launch-confirm-dialog" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="launch-confirm-title" aria-describedby="launch-confirm-summary">
      <header className="launch-confirm-header">
        <h2 id="launch-confirm-title">{confirmWord}</h2>
        <p id="launch-confirm-summary" className="launch-confirm-lede">{creates} {outcome}</p>
      </header>
      <div className="launch-confirm-body">
        <dl className="launch-confirm-facts">
          <div><dt>{tt("lv2.name")}</dt><dd>{name}</dd></div>
          <div><dt>{tt("lv2.provider")}</dt><dd>{providerWord}</dd></div>
          <div><dt>{tt("lv2.accounts")}</dt><dd>{accounts.join(" · ")}</dd></div>
          <div><dt>{tt("lr3.factCampaigns")}</dt><dd>{plan.campaign_count}</dd></div>
          {/* The exact string the provider receives (TikTok's macros literal), and one line on what they become. */}
          <div className="launch-confirm-fact-wide"><dt>{tt("lv2.destination")}</dt><dd>{perAd
            ? <span data-testid="confirm-destination-per-ad">{tt("lpt.destinationPerAd", { n: adLinks.size })}</span>
            : <span className={`launch-confirm-url${destinationNote ? " launch-confirm-url-full" : ""}`} title={destination} data-testid="confirm-destination">{destination}</span>}{destinationNote && <small className="launch-confirm-url-note">{destinationNote}</small>}</dd></div>
          {optimizes && <div className="launch-confirm-fact-wide"><dt>{tt("lpx.factOptimizes")}</dt><dd><span data-testid="confirm-optimizes">{optimizes}</span>{pixelNote && <small className="launch-confirm-url-note" data-testid="confirm-pixel-unverified">{pixelNote}</small>}</dd></div>}
          {pageDesign && <div className="launch-confirm-fact-wide"><dt>{tt("lr3.factLandingPage")}</dt><dd title={pageDesign.name}>{tt("salesLaunch.sales")} · {pageDesign.button_text} · {tt(`tipTemplates.background.${pageDesign.background}`)}{pageDesign.hand_cursor ? ` · ${tt("tipTemplates.handCursor")}` : ""}</dd></div>}
        </dl>
        {/* One block per campaign: which account, how much, then the ads. An ad
            with no picture and no words of its own is a line, not an empty frame. */}
        <div className="launch-confirm-rows">{plan.rows.map(row => {
          const ads: { item: LaunchContent; platform?: MetaPlatform }[] = row.ad_sets?.length
            ? row.ad_sets.flatMap(set => set.content.map(item => ({ item, platform: set.platform })))
            : row.content.map(item => ({ item }));
          return <article className="launch-confirm-row" key={row.index}>
            <p className="launch-confirm-head">
              <strong>{tt("lr3.campaignNumber", { n: row.index })}</strong>
              <span className="launch-confirm-account">{accountNames[row.connection_id] ?? tt("lv2.account")}</span>
              <span className="launch-confirm-budget">{usd(row.budget_cents / 100)}</span>
            </p>
            <div className="launch-confirm-ads">{ads.map(({ item, platform }, index) => {
              const card = cards?.[`${item.kind}:${item.value}`] ?? {
                platform: item.kind === "instagram_post" ? "instagram" as const : item.kind === "spark" ? "tiktok" as const : "facebook" as const,
                // Never `item.value`: that is the Spark code, and naming an ad by it is what made this dialog unreadable.
                kind: item.kind, label: item.label ?? "", caption: item.text ?? null, headline: item.headline ?? null,
                thumbnail_url: null, media_url: null, id: item.value,
              };
              const pictured = Boolean(card.thumbnail_url || card.media_url);
              const line = adLine?.(item, row.tracking_url);
              return <div className="launch-confirm-ad" key={`${platform ?? ""}:${item.kind}:${item.value}:${index}`}>
                <AdCard {...card} compact line={!pictured} fallbackName={pictured ? undefined : tt("lr3.adNumber", { n: index + 1 })}
                  {...(platform ? { platform, platforms: undefined } : {})} />
                {line && <p className="launch-confirm-adlink" data-testid="confirm-ad-title"><strong>{line.title}</strong>{line.link && perAd ? <span className="launch-confirm-url launch-confirm-url-full" title={line.link}>{line.link}</span> : null}</p>}
              </div>;
            })}</div>
            {row.campid && <p className="launch-confirm-ref"><small>{tt("mr2.campid")} {row.campid}{row.tracking_url ? <> · <a href={row.tracking_url} target="_blank" rel="noreferrer" title={row.tracking_url}>{linkWord(row.tracking_url)}</a></> : null}</small></p>}
          </article>;
        })}</div>
        {plan.warnings.length > 0 && <div className="note note-warn launch-confirm-warnings"><strong>{tt("lr3.checkFirst")}</strong><ul>{plan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
        {/* The bill, as three numbers a person can add up, not as a sentence. */}
        <dl className="launch-confirm-money">
          <div><dt>{tt("lr3.mediaBudget")}</dt><dd>{usd(budgetUsd)}</dd></div>
          <div><dt>{tt("lr3.serviceFee", { pct: feeLineVars(budgetUsd).pct })}</dt><dd>{usd(serviceFeeUsd(budgetUsd))}</dd></div>
          <div className="launch-confirm-total"><dt>{tt("lr3.totalBilled")}</dt><dd>{billed}</dd></div>
        </dl>
        <p className="launch-confirm-fineprint">{tt("lr3.mediaOnly")}</p>
        {staff && <div className="launch-confirm-note">
          <div className="launch-confirm-note-head"><label htmlFor="launch-authorization">{tt("lr3.noteLabel")}</label><small>{tt("lr3.noteRequired")}</small></div>
          <textarea id="launch-authorization" className="input" rows={2} required aria-describedby="launch-authorization-help" value={note} onChange={event => onNoteChange(event.target.value)} />
          <p className="hint" id="launch-authorization-help">{tt("lr3.noteHelp")}</p>
        </div>}
        {error && <p className="note note-warn" role="alert" tabIndex={-1} ref={errorBox}>{error}</p>}
      </div>
      <div className="rs-tool-row launch-confirm-footer">
        <button type="button" className="btn btn-outline" onClick={onClose}>{tt("common.cancel")}</button>
        <button type="button" className="btn btn-approve" aria-label={confirmWord} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </div>
  </div>, document.body);
}
