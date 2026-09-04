// Number, money and date formatting for the admin screens. Pure and tiny;
// imported by server and client components alike. Dates are formatted in
// server components only (a client render could disagree with the server's
// time zone and trip hydration).

import type { Locale } from "@/lib/i18n";

/** jobs.cost_cents -> "$1.23"; cents are integers so two decimals are exact. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatDate(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

export function formatDateTime(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** 0–100, clamped, as an integer: the .track width and the number beside it. */
export function percent(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** mm:ss for a clip range; hours only when reached. */
export function clock(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function clockRange(start: number | null | undefined, end: number | null | undefined): string {
  const a = clock(start);
  const b = clock(end);
  return a && b ? `${a}–${b}` : a || b;
}
