// The fake crazydramas' ad-unlocks report and the fake AdMob report (fixture mode and tests; decision 2026-11-09,
// "Ad unlocks in Studio"). Deterministic for a day: every number comes from a small hash of the day and platform,
// so the two fakes agree (AdMob's impressions sit just under our granted + unfinished) and a screen and a test see
// the same figures. Ads start 20 days before today, so the 7- and 30-day periods have a period before to compare
// with. Invented numbers for a demo; nothing here is measured.

import type { AdmobRow } from "@/lib/admob/report";
import type { AdPlatform, AdUnlockDay, AdUnlockFailure, AdUnlockSeries, AdUnlocksReport } from "./ad-unlocks-types";

const WINDOW_DAYS = 90;
const ADS_FOR_DAYS = 20;

function unit(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const pacificDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

const BASE: Record<AdPlatform, number> = { ios: 140, android: 90, web: 25 };
/** Dollars per 1,000 impressions the fake AdMob pays. */
const ECPM: Record<"ios" | "android", number> = { ios: 14, android: 9 };

/** One platform's invented day of ads, or null before the ads started (or for the web before its house ads did). */
function fakeDay(day: string, platform: AdPlatform, today: string): AdUnlockDay | null {
  const start = addDays(today, -(ADS_FOR_DAYS - 1));
  if (day < start || day > today) return null;
  if (platform === "web" && day < addDays(today, -6)) return null;
  const age = Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000);
  const grow = 0.45 + age / ADS_FOR_DAYS;
  const r = (k: string) => unit(`${day}|${platform}|${k}`);
  const opened = Math.round(BASE[platform] * grow * (0.8 + 0.4 * r("opened")));
  const granted = Math.round(opened * (0.72 + 0.1 * r("granted")));
  const unfinished = Math.round(opened * (0.08 + 0.06 * r("unfinished")));
  const left = Math.max(0, opened - granted - unfinished);
  const cap = Math.round(left * 0.45), too_fast = Math.round(left * 0.25), expired = Math.round(left * 0.15), duplicate = Math.round(left * 0.1);
  const refused = { too_fast, expired, cap, duplicate, already_open: Math.max(0, left - cap - too_fast - expired - duplicate), unknown: 0 };
  const viewers = Math.max(1, Math.round(opened / (1.7 + 0.4 * r("viewers"))));
  const granted_viewers = Math.min(viewers, Math.max(1, Math.round(granted / (1.5 + 0.4 * r("gv")))));
  const capped_viewers = Math.round(granted_viewers * (0.1 + 0.1 * r("capped")));
  const ssv = platform === "web" ? 0 : Math.round(granted * 0.96);
  return { day, platform, provider: platform === "web" ? "house" : "admob", opened, granted, refused, unfinished, viewers, granted_viewers, capped_viewers, ssv, client: granted - ssv };
}

/** crazydramas' report as the fake answers it: the last 90 days, ads on iPhone, Android and (house ads) the web. */
export function fakeAdUnlocksReport(series: { slug: string; title: string; status: string }[], now: Date = new Date(), teamEmails = 0): AdUnlocksReport {
  const to = pacificDay(now);
  const from = addDays(to, -(WINDOW_DAYS - 1));
  const days: AdUnlockDay[] = [];
  const failures: AdUnlockFailure[] = [];
  for (let day = addDays(to, -(ADS_FOR_DAYS - 1)); day <= to; day = addDays(day, 1)) {
    for (const platform of ["ios", "android", "web"] as const) {
      const d = fakeDay(day, platform, to);
      if (!d) continue;
      days.push(d);
      for (const reason of ["no_fill", "closed", "timeout", "error", "refused:cap"]) {
        const count = Math.round(d.opened * 0.06 * unit(`${day}|${platform}|${reason}`) * (reason === "closed" ? 2 : 1));
        if (count > 0) failures.push({ day, platform, reason, count });
      }
    }
  }
  const granted = days.reduce((a, d) => a + d.granted, 0);
  const opened = days.reduce((a, d) => a + d.opened, 0);
  const live = series.filter((s) => s.status !== "archived" && !s.slug.startsWith("mock-"));
  const weights = live.map((s) => 0.2 + unit(`ads|${s.slug}`));
  const total = weights.reduce((a, w) => a + w, 0) || 1;
  const rows: AdUnlockSeries[] = live
    .map((s, i) => {
      const g = Math.round((granted * weights[i]) / total);
      return { slug: s.slug, title: s.title, granted: g, opened: Math.round((opened * weights[i]) / total), viewers: Math.round(g / 2.4), top_episode: 4 + Math.floor(unit(`top|${s.slug}`) * 12) };
    })
    .sort((a, b) => b.granted - a.granted || a.slug.localeCompare(b.slug))
    .slice(0, 50);
  const ad_viewers = Math.max(0, Math.round(granted / 3.1) - teamEmails);
  const bought_after = Math.round(ad_viewers * 0.045);
  return {
    version: 1,
    generated_at: now.toISOString(),
    tz: "America/Los_Angeles",
    window: { from, to },
    switch: { on: true, web: "house", admob_units: 2, daily_cap: 3 },
    days,
    series: rows,
    failures,
    after: { ad_viewers, bought_after, revenue_cents_after: bought_after * 599 + Math.round(bought_after * 0.3) * 1999, bought_before_only: Math.round(ad_viewers * 0.012) },
  };
}

/** AdMob's report as the fake answers it: iPhone and Android, a day's impressions just under our granted + unfinished. */
export function fakeAdmobRows(from: string, to: string, now: Date = new Date()): AdmobRow[] {
  const today = pacificDay(now);
  const out: AdmobRow[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    for (const platform of ["ios", "android"] as const) {
      const d = fakeDay(day, platform, today);
      if (!d) continue;
      const r = (k: string) => unit(`${day}|${platform}|admob|${k}`);
      const ad_requests = Math.round(d.opened * (1.04 + 0.08 * r("req")));
      const matched_requests = Math.round(ad_requests * (0.9 + 0.08 * r("match")));
      const impressions = Math.max(0, d.granted + d.unfinished - Math.round(d.unfinished * r("lost")));
      const earnings_micros = Math.round(impressions * ECPM[platform] * (0.8 + 0.4 * r("ecpm")) * 1000);
      out.push({
        day,
        app_id: platform === "ios" ? "ca-app-pub-5711183345077823~8049760182" : "ca-app-pub-5711183345077823~1212889096",
        app_name: "CrazyDramas",
        platform,
        earnings_micros,
        impressions,
        ad_requests,
        matched_requests,
        match_rate: ad_requests ? matched_requests / ad_requests : null,
        impression_rpm: impressions ? earnings_micros / impressions / 1000 : null,
        clicks: Math.round(impressions * 0.02 * r("clicks")),
      });
    }
  }
  return out;
}
