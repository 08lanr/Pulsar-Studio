import { t, type Locale } from "@/lib/i18n";
import type { CrazydramasState, EpisodeVerdict } from "@/lib/crazydramas/match";

// The crazydramas chip (plan A3/A4, phase 3a): one chip per series state, in
// plain words and never a number on the catalog (decision 2026-09-08,
// "status board"). The same chip sits on My catalog, in the title header
// beside the TikTok and ad chips, on the CrazyDramas section and on each
// Import films row. The state itself is derived by lib/crazydramas/match
// (never stored); this module only says it in words and carries the pure
// formatting helpers the section page shares with its tests.

export type ChipTone = "is-live" | "is-warn" | "is-bad" | "is-wait" | "is-none";

const TONE: Record<CrazydramasState, ChipTone> = {
  not_linked: "is-none",
  not_checked: "is-wait",
  not_live: "is-wait",
  read_failed: "is-bad",
  live_complete: "is-live",
  live_partial: "is-warn",
  live_differs: "is-warn",
  live_unverified: "is-warn",
  local_newer: "is-warn",
};

/** The chip's colour family; every tone also carries its words (colour never carries meaning alone). */
export function chipTone(state: CrazydramasState): ChipTone {
  return TONE[state];
}

/** The i18n key of the chip's words. On the Import page an unlinked film says what to do about it. */
export function chipKey(state: CrazydramasState, context: "catalog" | "import" = "catalog"): string {
  return state === "not_linked" && context === "import" ? "cd.chip.not_linked.import" : `cd.chip.${state}`;
}

/** The small qualifier some states carry ("not uploaded, or draft"); null for the rest. */
export function chipHintKey(state: CrazydramasState): string | null {
  return state === "not_live" || state === "read_failed" || state === "live_unverified" ? `cd.chip.${state}.hint` : null;
}

/** "$9.99" from cents; "—" when the series carries no price. */
export function fmtPriceCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

/** Seconds to at most three decimals, no trailing zeros ("116.567", "112"). */
export function fmtSeconds(s: number | null | undefined): string | null {
  if (s == null || !Number.isFinite(s)) return null;
  return String(Number(s.toFixed(3)));
}

/** A frame delta with its sign ("+3", "−14", "0"). */
export function fmtDelta(d: number | null | undefined): string | null {
  if (d == null || !Number.isFinite(d)) return null;
  return d > 0 ? `+${d}` : d < 0 ? `−${Math.abs(d)}` : "0";
}

/** The checked time as "2026-09-23 07:40 UTC": deterministic on server and client, no timezone math. */
export function checkedAtText(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

export const VERDICT_PILL: Record<EpisodeVerdict, string> = {
  missing: "pill-error",
  extra: "pill-neutral",
  not_ready: "pill-accent",
  same_length: "pill-success",
  close: "pill-warning",
  different_length: "pill-error",
  unknown: "pill-neutral",
  identical: "pill-success",
};

export function CrazydramasChip({ state, locale, stale = false, context = "catalog" }: { state: CrazydramasState; locale: Locale; stale?: boolean; context?: "catalog" | "import" }) {
  // A failed read says "showing the last good read" only when there is one (stale); with none, the words stop at the failure.
  const hint = state === "read_failed" && !stale ? null : chipHintKey(state);
  return (
    <span className={`tw-chip tw-chip-cd ${chipTone(state)}`} data-cd-state={state}>
      <i aria-hidden="true" />
      {t(locale, chipKey(state, context))}
      {hint && <small> · {t(locale, hint)}</small>}
      {stale && state !== "read_failed" && <small> · {t(locale, "cd.chip.stale")}</small>}
    </span>
  );
}
