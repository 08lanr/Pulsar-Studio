// The fake crazydramas' stats report (fixture mode and tests): the same
// shape GET /api/studio/stats answers, built from the fake's own series.
// Deterministic for a given series list and day: every number comes from a
// small hash of the series' slug and the day, so a screen and a test see the
// same figures. Invented numbers for a demo; nothing here is measured.

import type { CdStatsCohort, CdStatsDay, CdStatsReport, CdStatsSeries, CdStatsSource } from "./stats-types";

/** The fake's ads: TikTok-shaped ids, one campaign; the Monitor's fake launches carry other ids, so these read as ads Studio did not launch. */
export const FAKE_STATS_ADS = ["1877000000000001", "1877000000000002", "1877000000000003"];

type FakeSeriesIn = { id: string; slug: string; title: string; status: string; free_episode_count: number };
type FakeEpisodeIn = { drama_id: string; episode_number: number; duration_seconds: number | null };

const DAYS = 120;
const STEP = 15;

/** A number in [0, 1) from a string, stable across runs. */
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

export function fakeStatsReport(series: FakeSeriesIn[], episodes: FakeEpisodeIn[], now: Date = new Date(), teamEmails = 0): CdStatsReport {
  const to = pacificDay(now);
  const from = addDays(to, -(DAYS - 1));
  // Traffic starts two weeks ago and grows, as the ads did.
  const live = series.filter((s) => s.status !== "archived" && !s.slug.startsWith("mock-"));
  const out: CdStatsSeries[] = [];
  const sources: CdStatsSource[] = [];
  const perDay = new Map<string, { opened: number; watchers: number; first: number; renewals: number; cents: number; robots: number; unseen: number }>();

  for (const s of live) {
    const eps = episodes.filter((e) => e.drama_id === s.id).sort((a, b) => a.episode_number - b.episode_number);
    const count = eps.length ? eps[eps.length - 1].episode_number : 12;
    const duration = eps.find((e) => e.episode_number === 1)?.duration_seconds ?? 110;
    const steps = Math.max(1, Math.ceil(duration / STEP));
    const cohorts: CdStatsCohort[] = [];
    const weight = 0.4 + unit(s.slug);
    for (let back = 13; back >= 0; back--) {
      const day = addDays(to, -back);
      const r = (k: string) => unit(`${s.slug}|${day}|${k}`);
      const opened = Math.round((20 + (13 - back) * 12) * weight * (0.7 + 0.6 * r("o")));
      const started = Math.round(opened * (0.4 + 0.2 * r("s")));
      const reached: number[] = [];
      let still = started;
      for (let k = 0; k < steps; k++) {
        reached.push(still);
        still = Math.round(still * (k === 0 ? 0.68 + 0.1 * r("q") : 0.93 + 0.05 * r(`d${k}`)));
      }
      const finished = Math.min(still, reached[reached.length - 1]);
      const epsStarted: number[] = [];
      const epsWatched: number[] = [];
      let people = started;
      for (let n = 1; n <= count; n++) {
        if (n > 1) people = n > s.free_episode_count ? Math.round(people * 0.08) : Math.round(people * (n === 2 ? 0.35 : 0.7));
        epsStarted.push(people);
        epsWatched.push(Math.round(people * (n === 1 ? 0.66 : 0.6)));
      }
      const paywall = Math.round(opened * (0.04 + 0.04 * r("p")));
      const watchedBefore = Math.round(paywall * 0.25);
      const checkouts = Math.round(paywall * 0.3);
      const buyers = Math.round(checkouts * 0.5);
      const renewals = r("w") > 0.7 ? 1 : 0;
      const cents = buyers * 199 + renewals * 699;
      const robots = Math.round(opened * (0.1 + 0.3 * r("r")));
      const seconds = reached.reduce((a, v) => a + v * STEP, 0);
      const noEvents = Math.round((opened - started) * 0.3);
      const neverStarted = opened - started - noEvents;
      const soundKnown = back <= 1 ? started : 0;
      // Pages TikTok loaded out of sight, the player's restarts and the timing histograms (recorded since 2026-09-25: the last two days).
      const unseen = Math.round(opened * (0.15 + 0.2 * r("u")));
      const recent = back <= 1;
      const spread = (n: number, shape: number[]) => shape.map((w) => Math.round(n * w));
      const loadHist = recent ? spread(opened, [0.05, 0.3, 0.3, 0.2, 0.08, 0.04, 0.02, 0.01, 0, 0]) : [];
      const startHist = recent ? spread(started, [0, 0.08, 0.25, 0.35, 0.18, 0.08, 0.04, 0.02, 0, 0]) : [];
      const waitHist = recent ? spread(Math.round(neverStarted * 0.7), [0.3, 0.15, 0.1, 0.12, 0.1, 0.08, 0.06, 0.05, 0.03, 0.01]) : [];
      cohorts.push({
        day,
        opened,
        unseen,
        browsed: Math.round(opened * 0.05),
        no_events: noEvents,
        never_started: neverStarted,
        left_waiting: Math.round(neverStarted * 0.7),
        left_waiting_seconds: Math.round(neverStarted * 0.7 * (3 + 4 * r("w8"))),
        started_ep1: started,
        finished_ep1: finished,
        ep1_seconds: Math.round(Math.min(seconds, started * duration)),
        ep1_reached: reached,
        ep1_sound_known: soundKnown,
        ep1_sound_on: Math.round(soundKnown * 0.8),
        episodes: epsStarted,
        episodes_watched: epsWatched,
        paywall,
        paywall_watched: watchedBefore,
        paywall_skipped: paywall - watchedBefore,
        checkouts,
        buyers,
        revenue_cents: cents,
        returned: Math.round(started * 0.12),
        errors: Math.round(opened * 0.01),
        restarted: recent ? Math.round(started * 0.1) : 0,
        restarted_muted: recent ? Math.round(started * 0.08) : 0,
        blocked: recent ? Math.round(started * 0.05) : 0,
        load_hist: loadHist,
        start_hist: startHist,
        wait_hist: waitHist,
        survey_ep1_shown: back <= 1 ? Math.round(started * 0.2) : 0,
        survey_ep1: back <= 1 ? { not_for_me: Math.round(started * 0.05), too_slow: Math.round(started * 0.03), av_problem: Math.round(started * 0.01), browsing: Math.round(started * 0.02) } : {},
        survey_paywall_shown: back <= 1 ? paywall : 0,
        survey_paywall: back <= 1 ? { price: Math.round(paywall * 0.3), more_free: Math.round(paywall * 0.2), payment_trust: Math.round(paywall * 0.05), browsing: Math.round(paywall * 0.1) } : {},
        robots,
        team: 0,
      });
      // The same people by where they came from: three ads (Android and iPhone), TikTok's stored copy, and no ad.
      const shares: [string, string | null, string | null, boolean, string, number][] = [
        ["tiktok", "1877000000000000", FAKE_STATS_ADS[0], false, "tiktok_android", 0.3],
        ["tiktok", "1877000000000000", FAKE_STATS_ADS[0], false, "tiktok_iphone", 0.15],
        ["tiktok", "1877000000000000", FAKE_STATS_ADS[1], false, "tiktok_android", 0.2],
        ["tiktok", "1877000000000000", FAKE_STATS_ADS[2], false, "tiktok_android", 0.1],
        ["tiktok", null, null, true, "tiktok_android", 0.15],
        ["organic", null, null, false, "iphone", 0.1],
      ];
      // Where each source's people were (the organic ones landed before places were recorded).
      const places: [string | null, string | null][] = [["US", "CA"], ["US", "TX"], ["US", "NY"], ["PH", null], ["US", "FL"], [null, null]];
      for (const [i, [platform, campaign, ad, stored, device, share]] of shares.entries()) {
        const [country, region] = places[i];
        const q = (v: number) => Math.round(v * share * (0.8 + 0.4 * r(`${ad}${device}`)));
        const qs = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, q(v)]));
        // TikTok on iPhone: most of its pages are loaded out of sight; Android waits longer for a start.
        const iphone = device === "tiktok_iphone";
        const ep1 = (f: number) => q(Math.round(started * f));
        sources.push({
          day, drama_id: s.id, platform, campaign, ad, stored_copy: stored, device, country, region,
          opened: q(opened), unseen: iphone ? q(unseen) * 4 : q(unseen) / 2 | 0,
          no_events: iphone ? q(noEvents) * 2 : q(noEvents) / 2 | 0, never_started: q(neverStarted),
          left_waiting: q(Math.round(neverStarted * 0.7)), left_waiting_seconds: q(Math.round(neverStarted * 0.7 * (iphone ? 2 : 9))),
          started_ep1: q(started), ep1_25: ep1(0.55), ep1_50: ep1(0.45), ep1_75: ep1(0.4), finished_ep1: q(finished),
          watched_ep2: q(epsWatched[1] ?? 0), watched_ep3: q(epsWatched[2] ?? 0),
          ep1_sound_known: q(soundKnown), ep1_sound_on: q(Math.round(soundKnown * 0.8)),
          paywall: q(paywall), paywall_watched: q(watchedBefore), paywall_skipped: q(paywall - watchedBefore),
          checkouts: q(checkouts), buyers: q(buyers), revenue_cents: q(cents),
          returned: q(Math.round(started * 0.12)), errors: q(Math.round(opened * 0.01)),
          restarted: recent ? ep1(0.1) : 0, restarted_muted: recent ? ep1(0.08) : 0, blocked: recent ? ep1(0.05) : 0,
          survey_ep1_shown: recent ? ep1(0.2) : 0,
          survey_ep1: recent ? qs({ not_for_me: started * 0.05, too_slow: started * 0.03, av_problem: started * 0.01, browsing: started * 0.02 }) : {},
          survey_paywall_shown: recent ? q(paywall) : 0,
          survey_paywall: recent ? qs({ price: paywall * 0.3, more_free: paywall * 0.2, payment_trust: paywall * 0.05, browsing: paywall * 0.1 }) : {},
          load_hist: loadHist.map((v) => q(v)), start_hist: startHist.map((v) => q(v)), wait_hist: waitHist.map((v) => (iphone ? q(v) : q(v))),
          robots: platform === "organic" ? q(robots) * 3 : q(robots) / 3 | 0,
        });
      }
      const d = perDay.get(day) ?? { opened: 0, watchers: 0, first: 0, renewals: 0, cents: 0, robots: 0, unseen: 0 };
      d.opened += opened;
      d.unseen += unseen;
      d.watchers += started;
      d.first += buyers;
      d.renewals += renewals;
      d.cents += cents;
      d.robots += robots;
      perDay.set(day, d);
    }
    out.push({ drama_id: s.id, slug: s.slug, title: s.title, status: s.status, free_episodes: s.free_episode_count, episode_count: count, ep1_duration_s: duration, cohorts });
  }

  const days: CdStatsDay[] = [];
  const watchersOn = (day: string) => perDay.get(day)?.watchers ?? 0;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const d = perDay.get(day);
    const span = (n: number) => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += watchersOn(addDays(day, -i));
      // Some people come back on other days: a week holds fewer different people than the sum of its days.
      return Math.round(sum * (n === 1 ? 1 : 0.85));
    };
    days.push({
      day,
      visitors: d?.opened ?? 0,
      watchers: d?.watchers ?? 0,
      new_watchers: Math.round((d?.watchers ?? 0) * 0.9),
      wau: span(7),
      mau: span(30),
      robots: d?.robots ?? 0,
      unseen: d?.unseen ?? 0,
      payments: (d?.first ?? 0) + (d?.renewals ?? 0),
      first_purchases: d?.first ?? 0,
      renewals: d?.renewals ?? 0,
      revenue_cents: d?.cents ?? 0,
    });
  }
  const robots = days.reduce((a, d) => a + d.robots, 0);
  return {
    version: 1,
    generated_at: now.toISOString(),
    timezone: "America/Los_Angeles",
    from,
    to,
    ep1_step_s: STEP,
    robots: { people: robots, crawler_ua: Math.round(robots * 0.06), burst: Math.round(robots * 0.72), end_jump: Math.round(robots * 0.1), link_check: robots - Math.round(robots * 0.06) - Math.round(robots * 0.72) - Math.round(robots * 0.1) },
    timing_edges_s: [1, 2, 3, 5, 8, 13, 20, 30, 60],
    team: { people: teamEmails * 2, payments: teamEmails, revenue_cents: teamEmails * 99 },
    days,
    series: out,
    sources,
  };
}
