// The ad-spend sync's arithmetic (decision 2026-10-29, "The ad-spend sync"):
// pure, no provider and no network, so the rules are tested on their own.
// lib/crazydramas/spend-sync.ts reads TikTok and Meta and sends what these
// functions keep to crazydramas' `PUT /api/studio/ad-spend`.
//
//   money    a provider's decimal string ("12.345") to whole cents by its
//            digits, half up (1235), never through a float (12.345 * 100 is
//            1234.4999…); a number is first written with six decimals
//   counts   whole and >= 0, else null (unknown, never zero)
//   rows     kept when they spent or were seen: zero spend AND zero (or
//            unknown) impressions is left out, as the contract asks
//   requests at most AD_SPEND_MAX_ROWS rows each, (day, ad) unique in each
//            because they are unique in the whole read
//   windows  TikTok refuses a day breakdown over more than 30 days, so a long
//            backfill is read 30 days at a time on both platforms

import type { AdSpendRow } from "./studio-client";

export type { AdSpendRow } from "./studio-client";
export type SpendPlatform = "tiktok" | "meta";
export const SPEND_PLATFORMS: readonly SpendPlatform[] = ["tiktok", "meta"];

/** The contract's ceiling per request. */
export const AD_SPEND_MAX_ROWS = 2000;
/** Days per provider report (TikTok's limit for `stat_time_day`; Meta is read the same way). */
export const SPEND_WINDOW_DAYS = 30;
/** crazydramas refuses a day before this one (`400 bad_day`). */
export const AD_SPEND_FIRST_DAY = "2026-01-01";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day written YYYY-MM-DD. */
export function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** [from, to] in spans of at most `span` days, oldest first. */
export function dayWindows(from: string, to: string, span = SPEND_WINDOW_DAYS): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (let start = from; start <= to; start = addDays(start, span)) {
    const end = addDays(start, span - 1);
    out.push({ from: start, to: end < to ? end : to });
  }
  return out;
}

/** Why a window cannot be synced, or null. */
export function windowProblem(from: string, to: string): string | null {
  if (!isDay(from) || !isDay(to)) return "Days are written YYYY-MM-DD.";
  if (from > to) return "--from is after --to.";
  if (from < AD_SPEND_FIRST_DAY) return `crazydramas takes days from ${AD_SPEND_FIRST_DAY} on.`;
  return null;
}

/** A provider's spend as whole cents, rounded half up on its own digits; null when it is not a non-negative amount. */
export function spendCents(value: unknown): number | null {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    text = value.toFixed(6);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return null;
  }
  const m = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!m) return null;
  const fraction = (m[2] ?? "").padEnd(3, "0");
  const cents = Number(m[1]) * 100 + Number(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1 : 0);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** A provider's count: a whole number >= 0, else null (unknown). */
export function countOf(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Zero spend and nothing seen says nothing: the contract leaves such rows out. */
export function keepRow(row: AdSpendRow): boolean {
  return row.spend_cents > 0 || (row.impressions ?? 0) > 0;
}

/** Oldest day first, then ad id: the order rows are sent in. */
export function sortRows(rows: readonly AdSpendRow[]): AdSpendRow[] {
  return [...rows].sort((a, b) => a.day.localeCompare(b.day) || a.ad_id.localeCompare(b.ad_id));
}

/** The first (day, ad) that appears twice, or null. A read that lists one twice is refused rather than summed. */
export function duplicateRow(rows: readonly AdSpendRow[]): string | null {
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.day}|${r.ad_id}`;
    if (seen.has(key)) return `${r.ad_id} on ${r.day}`;
    seen.add(key);
  }
  return null;
}

/** Requests of at most `size` rows. */
export function chunkRows<T>(rows: readonly T[], size = AD_SPEND_MAX_ROWS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export type SpendDay = { day: string; spend_cents: number; rows: number; ads: number };

/** Per day, oldest first: spend, rows and distinct ads (the dry run's table). */
export function spendByDay(rows: readonly AdSpendRow[]): SpendDay[] {
  const days = new Map<string, { spend_cents: number; rows: number; ads: Set<string> }>();
  for (const r of rows) {
    const d = days.get(r.day) ?? { spend_cents: 0, rows: 0, ads: new Set<string>() };
    d.spend_cents += r.spend_cents;
    d.rows += 1;
    d.ads.add(r.ad_id);
    days.set(r.day, d);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, d]) => ({ day, spend_cents: d.spend_cents, rows: d.rows, ads: d.ads.size }));
}

/** A provider's id: digits only (the contract's ad and campaign ids are numeric), else "". */
export function idOf(value: unknown): string {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return /^\d{1,30}$/.test(text) ? text : "";
}

/**
 * Does any address anywhere in this object (a Meta creative: its call to
 * action, story spec or asset feed) point at crazydramas.com or one of its
 * subdomains? How a Meta campaign is told to be Crazy Drama's (2026-10-29: the
 * ad account also runs a creator account's boosts, which link nowhere).
 */
export function linksToCrazydramas(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    if (!/^https?:\/\//i.test(value.trim())) return false;
    try {
      const host = new URL(value.trim()).hostname.toLowerCase();
      return host === "crazydramas.com" || host.endsWith(".crazydramas.com");
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some((v) => linksToCrazydramas(v, depth + 1));
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).some((v) => linksToCrazydramas(v, depth + 1));
  return false;
}

/** Cents as dollars, "$1,234.56". */
export function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
