// The fake crazydramas' stats report (fixture mode and tests): the same
// shape GET /api/studio/stats answers, built from the fake's own series.
// Deterministic for a given series list and day: every number comes from a
// small hash of the series' slug and the day, so a screen and a test see the
// same figures. Invented numbers for a demo; nothing here is measured.

import type { LaunchRun } from "@/lib/launch/types";
import { CdStatsPlaybackSchema, type CdStatsCohort, type CdStatsDay, type CdStatsDrop, type CdStatsPlayback, type CdStatsReport, type CdStatsSeries, type CdStatsSource } from "./stats-types";

/**
 * The fake's ads: TikTok-shaped ids in two campaigns, the first optimizing purchases (ads 1 and 2), the second
 * clicks (ads 3 and 4, the same two clips again). The Monitor's fake launches carry other ids; the stats pages
 * in fixture mode add the invented launches of `fakeStatsLaunches` so the Campaigns tab has spend to show.
 */
export const FAKE_STATS_ADS = ["1877000000000001", "1877000000000002", "1877000000000003", "1877000000000004"];
export const FAKE_STATS_CAMPAIGNS = ["1877000000000100", "1877000000000200"];

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

/**
 * Invented playback reports (the last two days, as the real ones start 2026-09-25): TikTok on iPhone has the phone
 * pausing it more, Android freezes more, and about half of episode 1's views end early.
 */
function fakePlayback(views: number, device: string, later: boolean): CdStatsPlayback {
  const pb = CdStatsPlaybackSchema.parse({});
  if (views <= 0) return pb;
  const iphone = device === "tiktok_iphone";
  const android = device.includes("android");
  const n = (share: number) => Math.round(views * share);
  pb.views = views;
  pb.started = n(0.93);
  pb.start_hist = [0, 0.1, 0.3, 0.3, 0.15, 0.08, 0.05, 0.02, 0, 0].map((w) => Math.round(pb.started * w));
  if (!later) {
    pb.landing_split = pb.started;
    pb.landing_page_ms = pb.started * 700;
    pb.landing_player_ms = pb.started * 400;
    pb.landing_video_ms = pb.started * (android ? 1900 : 1300);
  }
  pb.stall_views = n(android ? 0.18 : 0.08);
  pb.stalls = Math.round(pb.stall_views * 1.6);
  pb.stall_ms = pb.stalls * 2400;
  pb.watched_ms = views * (later ? 70000 : 38000);
  pb.phone_pause_views = n(iphone ? 0.2 : 0.07);
  pb.phone_pauses = Math.round(pb.phone_pause_views * 1.4);
  pb.phone_pauses_sound = Math.round(pb.phone_pauses * 0.8);
  pb.phone_pauses_early = Math.round(pb.phone_pauses * 0.6);
  pb.viewer_pause_views = n(0.12);
  pb.restart_views = pb.phone_pause_views;
  pb.error_views = n(0.01);
  pb.quality_ms = { "480p": Math.round(pb.watched_ms * 0.6), "720p": Math.round(pb.watched_ms * 0.35), "270p": Math.round(pb.watched_ms * 0.05) };
  pb.conn = iphone ? { unknown: views } : { "4g": n(0.85), "3g": views - n(0.85) };
  const early = later ? 0.35 : 0.55;
  pb.ends = {
    finished: n(later ? 0.4 : 0.3),
    next: n(1 - early - (later ? 0.4 : 0.3)),
    left_playing: n(early * 0.45),
    left_paused: n(early * 0.1),
    left_frozen: n(early * (android ? 0.12 : 0.05)),
    left_phone_paused: n(early * (iphone ? 0.15 : 0.04)),
    left_before_start: n(early * 0.06),
    closed_playing: n(early * 0.12),
    closed_frozen: n(early * 0.04),
  };
  return pb;
}

const ENDINGS = ["left_playing", "left_frozen", "left_phone_paused", "left_paused", "closed_playing", "left_before_start", "closed_frozen"] as const;

/** Invented early endings for the drill-down, newest first. */
function fakeDrops(dramas: string[], now: Date): CdStatsDrop[] {
  const out: CdStatsDrop[] = [];
  for (let i = 0; i < 30 && dramas.length; i++) {
    const r = (k: string) => unit(`drop${i}${k}`);
    const ended = ENDINGS[Math.floor(r("e") * ENDINGS.length)];
    const device = ["tiktok_android", "tiktok_iphone", "iphone"][Math.floor(r("d") * 3)];
    const frame = ended === "left_before_start" ? null : Math.round(900 + r("f") * 4000);
    const stalls = ended.includes("frozen") ? 1 + Math.floor(r("s") * 3) : r("s") > 0.8 ? 1 : 0;
    const phone = ended === "left_phone_paused" ? 1 + Math.floor(r("p") * 2) : 0;
    const watched = frame === null ? 0 : Math.round(3 + r("w") * 40);
    const timeline: [number, string, number][] = frame === null ? [] : [[frame, "play", 0]];
    if (phone) timeline.push([frame! + 1800, "pause_phone", 1.8], [frame! + 1800, "restart", 1.8], [frame! + 1850, "resume", 1.9]);
    if (stalls) timeline.push([frame! + 6000, "stall", 5], ...(ended.includes("frozen") ? [] : ([[frame! + 9000, "resume", 5]] as [number, string, number][])));
    timeline.push([frame === null ? 4200 : frame + watched * 1000 + stalls * 2400, "hidden", watched]);
    out.push({
      code: Math.floor(r("c") * 2176782336).toString(36).padStart(6, "0").slice(-6),
      at: new Date(now.getTime() - i * 47 * 60_000).toISOString(),
      drama_id: dramas[Math.floor(r("m") * dramas.length)],
      episode: r("n") > 0.75 ? 2 : 1,
      device,
      country: "US",
      source: r("o") > 0.8 ? "no_ad" : "ad",
      ended,
      first_frame_ms: frame,
      stalls,
      stall_ms: stalls * 2400,
      phone_pauses: phone,
      phone_pauses_sound: phone,
      viewer_pauses: ended === "left_paused" ? 1 : 0,
      restarts: phone,
      watched_s: watched,
      on_screen_s: watched + (frame ?? 4200) / 1000 + stalls * 2.4,
      position_s: watched,
      duration_s: 115,
      quality: device === "tiktok_iphone" ? "720p" : "480p",
      conn: device === "tiktok_iphone" ? null : r("k") > 0.8 ? "3g" : "4g",
      bw_kbps: device === "tiktok_iphone" ? null : Math.round(800 + r("b") * 4000),
      timeline,
    });
  }
  return out;
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
      // A landing with only TikTok's click id is TikTok with no campaign (since 2026-09-26).
      const [campA, campB] = FAKE_STATS_CAMPAIGNS;
      const shares: [string, string | null, string | null, boolean, string, number][] = [
        ["tiktok", campA, FAKE_STATS_ADS[0], false, "tiktok_android", 0.25],
        ["tiktok", campA, FAKE_STATS_ADS[0], false, "tiktok_iphone", 0.12],
        ["tiktok", campA, FAKE_STATS_ADS[1], false, "tiktok_android", 0.18],
        ["tiktok", campB, FAKE_STATS_ADS[2], false, "tiktok_android", 0.1],
        ["tiktok", campB, FAKE_STATS_ADS[3], false, "tiktok_android", 0.05],
        ["tiktok", null, null, true, "tiktok_android", 0.12],
        ["tiktok", null, null, false, "tiktok_android", 0.05],
        ["organic", null, null, false, "iphone", 0.1],
      ];
      // Where each source's people were (the organic ones landed before places were recorded).
      const places: [string | null, string | null][] = [["US", "CA"], ["US", "TX"], ["US", "NY"], ["PH", null], ["US", "WA"], ["US", "FL"], ["US", "GA"], [null, null]];
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
          revenue_d0_cents: q(Math.round(cents * 0.55)), revenue_d7_cents: q(Math.round(cents * 0.85)),
          returned: q(Math.round(started * 0.12)), errors: q(Math.round(opened * 0.01)),
          restarted: recent ? ep1(0.1) : 0, restarted_muted: recent ? ep1(0.08) : 0, blocked: recent ? ep1(0.05) : 0,
          survey_ep1_shown: recent ? ep1(0.2) : 0,
          survey_ep1: recent ? qs({ not_for_me: started * 0.05, too_slow: started * 0.03, av_problem: started * 0.01, browsing: started * 0.02 }) : {},
          survey_paywall_shown: recent ? q(paywall) : 0,
          survey_paywall: recent ? qs({ price: paywall * 0.3, more_free: paywall * 0.2, payment_trust: paywall * 0.05, browsing: paywall * 0.1 }) : {},
          load_hist: loadHist.map((v) => q(v)), start_hist: startHist.map((v) => q(v)), wait_hist: waitHist.map((v) => (iphone ? q(v) : q(v))),
          play_ep1: recent ? fakePlayback(q(started), device, false) : CdStatsPlaybackSchema.parse({}),
          play_later: recent ? fakePlayback(q(epsStarted[1] ?? 0), device, true) : CdStatsPlaybackSchema.parse({}),
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
  const buyers = fakeBuyers(live, now);
  const money = fakeMoney(live, from, to, (d) => watchersOn(d));
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
    drops: fakeDrops(live.map((x) => x.id), now),
    ...buyers,
    ...money,
  };
}

/**
 * Invented coins and VIP (crazydramas since 2026-09-28): every payment of the last 60 days (coin packs, the $1.99
 * VIP first week, new VIP, renewals, a few refunds), the wallets' coins per day, every VIP, and the unlock sheet and
 * pop-ups per day. About one in 25 new watchers pays; a third of the $1.99 weeks renew.
 */
function fakeMoney(live: FakeSeriesIn[], from: string, to: string, watchersOn: (day: string) => number): Pick<CdStatsReport, "payments" | "coins" | "vip" | "paywall_days"> {
  if (!live.length) return { payments: [], coins: { days: [], unspent_paid: 0, unspent_paid_cents: 0, unspent_bonus: 0, series_days: [] }, vip: [], paywall_days: [] };
  const packs: [string, number, number, number][] = [
    ["coins:c500first", 499, 500, 75],
    ["coins:c500", 499, 500, 25],
    ["coins:c1000", 999, 1000, 100],
    ["coins:c2000", 1999, 2000, 400],
    ["coins:c5000", 4999, 5000, 2500],
  ];
  const [campA, campB] = FAKE_STATS_CAMPAIGNS;
  const payments: NonNullable<CdStatsReport["payments"]> = [];
  const coinDays = new Map<string, NonNullable<CdStatsReport["coins"]>["days"][number]>();
  const seriesDays: NonNullable<CdStatsReport["coins"]>["series_days"] = [];
  const paywallDays: NonNullable<CdStatsReport["paywall_days"]> = [];
  const vip: NonNullable<CdStatsReport["vip"]> = [];
  const start = addDays(to, -59) > from ? addDays(to, -59) : from;
  let n = 0;
  for (let day = start; day <= to; day = addDays(day, 1)) {
    const r = (k: string) => unit(`${day}:${k}`);
    const watchers = Math.max(20, watchersOn(day));
    const views = Math.round(watchers * (0.35 + 0.1 * r("v")));
    const payers = Math.max(1, Math.round(watchers / (22 + 8 * r("p"))));
    const coin = { day, bought: 0, bonus: 0, reward: Math.round(watchers * 4 * (0.6 + r("rw"))), spent_paid: 0, spent_bonus: 0, expired: Math.round(watchers * 1.5 * r("ex")), clawed_back: 0, unlocks: 0 };
    const checkouts = { sheet: 0, gift: 0, retention: 0, store: 0 };
    for (let i = 0; i < payers; i++) {
      n++;
      const person = `f${n.toString(36).padStart(5, "0")}`;
      const x = r(`k${i}`);
      const series = live[i % live.length];
      const fromAd = r(`a${i}`) < 0.75;
      const placement = (["sheet", "sheet", "sheet", "gift", "retention", "store"] as const)[Math.floor(r(`pl${i}`) * 6)];
      checkouts[placement] += 1 + (r(`c${i}`) < 0.6 ? 1 : 0);
      const base = { day, person, first: true, refunded: r(`rf${i}`) < 0.03, placement, drama_id: placement === "store" ? null : series.id, platform: fromAd ? "tiktok" : "organic", campaign: fromAd ? (i % 3 === 0 ? campB : campA) : null, paid_after_s: Math.round(600 + 5400 * r(`t${i}`)) };
      if (x < 0.6) {
        // Coins: the first-time $4.99 pack most often, then bigger ones; a quarter of buyers come back for more.
        const [product, cents, coins, bonus] = packs[x < 0.3 ? 0 : x < 0.45 ? 2 : x < 0.55 ? 3 : 4];
        payments.push({ ...base, kind: "coins", product, cents, offer: null });
        coin.bought += coins;
        coin.bonus += bonus;
        if (r(`again${i}`) < 0.25) {
          const [p2, c2, k2, b2] = packs[1 + Math.floor(r(`p2${i}`) * 3)];
          payments.push({ ...base, first: false, refunded: false, kind: "coins", product: p2, cents: c2, offer: null });
          coin.bought += k2;
          coin.bonus += b2;
        }
      } else if (x < 0.85) {
        // The $1.99 VIP first week; a third renew at $6.99 a week later.
        payments.push({ ...base, kind: "vip_intro", product: "all_access_weekly", cents: 199, offer: "first_week" });
        const renews = r(`rn${i}`) < 0.34;
        const renewDay = addDays(day, 7);
        if (renews && renewDay <= to) payments.push({ ...base, day: renewDay, first: false, refunded: false, kind: "vip_renewal", product: "all_access_weekly", cents: 699, offer: null, placement: null });
        const end = renews ? addDays(day, 14) : renewDay;
        vip.push({ plan: "all_access_weekly", intro: !renews && renewDay > to, active: end >= to, expires_day: end });
      } else {
        const monthly = x < 0.95;
        payments.push({ ...base, kind: "vip", product: monthly ? "vip_monthly" : "vip_yearly", cents: monthly ? 1399 : 6999, offer: null });
        const end = addDays(day, monthly ? 30 : 365);
        if (monthly && end <= to) payments.push({ ...base, day: end, first: false, refunded: false, kind: "vip_renewal", product: "vip_monthly", cents: 1399, offer: null, placement: null });
        vip.push({ plan: monthly ? "vip_monthly" : "vip_yearly", intro: false, active: true, expires_day: monthly && end <= to ? addDays(end, 30) : end });
      }
    }
    // Coins spent on episodes: most of what was bought and given, bonus first.
    const unlocks = Math.round((coin.bought + coin.bonus + coin.reward) * (0.7 + 0.2 * r("u")) / 60);
    coin.unlocks = unlocks;
    coin.spent_bonus = Math.min(coin.bonus + coin.reward, unlocks * 60);
    coin.spent_paid = unlocks * 60 - coin.spent_bonus;
    coinDays.set(day, coin);
    const weightSum = live.reduce((a, _sr, i) => a + 1 / (i + 1), 0);
    live.forEach((sr, i) => {
      const part = 1 / (i + 1) / weightSum;
      const u = Math.round(unlocks * part);
      if (!u) return;
      const paid = Math.round(coin.spent_paid * part);
      seriesDays.push({ day, drama_id: sr.id, spent_paid: Math.min(paid, u * 60), spent_bonus: Math.max(0, u * 60 - paid), cents: Math.min(paid, u * 60), unlocks: u });
    });
    paywallDays.push({
      day,
      views: views + Math.round(views * 0.3),
      viewers: views,
      unlocks,
      unlockers: Math.round(unlocks / 2.5),
      checkouts,
      gift_shown: Math.round(watchers * 0.15),
      retention_shown: Math.round(views * 0.4),
      not_completed: Math.round(payers * 0.6),
    });
  }
  const unspentPaid = Math.max(0, Math.round([...coinDays.values()].reduce((a, d) => a + d.bought - d.spent_paid, 0) * 0.35));
  return {
    payments: payments.sort((a, b) => b.day.localeCompare(a.day)),
    coins: { days: [...coinDays.values()], unspent_paid: unspentPaid, unspent_paid_cents: Math.round(unspentPaid * 0.998), unspent_bonus: Math.round(unspentPaid * 0.2), series_days: seriesDays },
    vip,
    paywall_days: paywallDays,
  };
}

// ---- invented buyers (2026-09-26): payments under person codes, and each buyer's steps -------------------------

type FakeBuyer = {
  person: string;
  browser: string;
  /** Hours before now of the landing, and of the payment. */
  landed_h: number;
  paid_h: number;
  series: 0 | 1;
  amount: number;
  renewal?: boolean;
  source: { platform: string; campaign: string | null; ad: string | null; stored_copy?: boolean; device: string; country: string | null; region: string | null };
  /** Episodes watched after paying; `skim`: swiped to the last free episodes instead of watching them all. */
  after: number;
  skim?: boolean;
  left?: boolean;
};

/**
 * Six people, eight payments across two series: one person paid on two browsers (TikTok's, then Safari), one paid
 * twice on one, one arrived from TikTok with no campaign tag, two came from the clicks campaign.
 */
function fakeBuyers(live: FakeSeriesIn[], now: Date): Pick<CdStatsReport, "purchases" | "journeys" | "people"> {
  if (!live.length) return { purchases: [], journeys: {}, people: { buyers: 0, purchases: 0, revenue_cents: 0 } };
  const [campA, campB] = FAKE_STATS_CAMPAIGNS;
  const [ad1, ad2, ad3, ad4] = FAKE_STATS_ADS;
  const tt = (campaign: string | null, ad: string | null, device: string, region: string) => ({ platform: "tiktok", campaign, ad, device, country: "US", region });
  const list: FakeBuyer[] = [
    { person: "m4rq2z", browser: "b7k2", landed_h: 5.2, paid_h: 4.9, series: 0, amount: 199, source: tt(campA, ad1, "tiktok_android", "CA"), after: 2 },
    { person: "m4rq2z", browser: "x9d1", landed_h: 2.1, paid_h: 1.8, series: 1, amount: 199, source: { platform: "direct", campaign: null, ad: null, device: "iphone", country: "US", region: "CA" }, after: 1, skim: true, left: true },
    { person: "t8wd1c", browser: "p3n8", landed_h: 30, paid_h: 29.4, series: 0, amount: 199, source: tt(campA, ad2, "tiktok_iphone", "TX"), after: 2 },
    { person: "t8wd1c", browser: "p3n8", landed_h: 27, paid_h: 26.5, series: 1, amount: 499, source: tt(campA, ad2, "tiktok_iphone", "TX"), after: 1, skim: true, left: true },
    { person: "w5ee3r", browser: "r1q6", landed_h: 52, paid_h: 51.2, series: 0, amount: 199, source: tt(campA, ad2, "tiktok_android", "NY"), after: 8 },
    { person: "q2nn7e", browser: "h4v0", landed_h: 9.5, paid_h: 9, series: 1, amount: 199, source: tt(campB, ad3, "tiktok_android", "WA"), after: 2, left: true },
    { person: "z1ab5k", browser: "s8c3", landed_h: 76, paid_h: 75.1, series: 0, amount: 999, source: tt(campB, ad4, "tiktok_android", "GA"), after: 7 },
    { person: "h7yy0p", browser: "e2m5", landed_h: 20, paid_h: 19.6, series: 1, amount: 199, source: tt(null, null, "tiktok_android", "FL"), after: 3, left: true },
  ];
  const at = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const purchases: NonNullable<CdStatsReport["purchases"]> = [];
  const journeys: Record<string, NonNullable<CdStatsReport["journeys"]>[string]> = {};
  list.forEach((b, i) => {
    const s = live[Math.min(b.series, live.length - 1)];
    const free = s.free_episode_count > 0 ? s.free_episode_count : 5;
    const landed = now.getTime() - b.landed_h * 3_600_000;
    const paid = now.getTime() - b.paid_h * 3_600_000;
    const steps = (journeys[b.person] ??= []);
    const iso = (t: number) => new Date(t).toISOString();
    steps.push({ at: iso(landed), drama_id: s.id, kind: "landing", platform: b.source.platform, campaign: b.source.campaign, ad: b.source.ad });
    // The free episodes, a couple left unfinished; then the paywall, checkout, payment, and some after.
    const before = paid - 90_000;
    const per = (before - landed - 30_000) / (b.skim ? 2 : free);
    const firstEp = b.skim ? free - 1 : 1;
    for (let n = firstEp; n <= free; n++) {
      const t0 = landed + 20_000 + (n - firstEp) * per;
      steps.push({ at: iso(t0), drama_id: s.id, kind: "ep_start", episode: n });
      if (n !== 2 || i % 2 === 0) steps.push({ at: iso(t0 + per * 0.9), drama_id: s.id, kind: "ep_finish", episode: n });
    }
    steps.push({ at: iso(before), drama_id: s.id, kind: "paywall", episode: free + 1 });
    steps.push({ at: iso(before + 40_000), drama_id: s.id, kind: "checkout", episode: free + 1 });
    steps.push({ at: iso(paid), drama_id: s.id, kind: "paid", episode: free + 1, amount_cents: b.amount });
    for (let k = 0; k < b.after; k++) {
      const t0 = paid + 30_000 + k * 110_000;
      steps.push({ at: iso(t0), drama_id: s.id, kind: "ep_start", episode: free + 1 + k });
      if (k < b.after - 1 || !b.left) steps.push({ at: iso(t0 + 100_000), drama_id: s.id, kind: "ep_finish", episode: free + 1 + k });
    }
    if (b.left) steps.push({ at: iso(paid + 30_000 + b.after * 110_000), drama_id: s.id, kind: "left", episode: free + b.after });
    purchases.push({
      id: `pay_${String(i + 1).padStart(3, "0")}`,
      at: at(b.paid_h),
      drama_id: s.id,
      amount_cents: b.amount,
      renewal: !!b.renewal,
      person: b.person,
      browser: b.browser,
      source: { stored_copy: false, ...b.source },
      first_seen_at: at(b.landed_h),
      paid_after_s: Math.round((paid - landed) / 1000),
    });
  });
  for (const k of Object.keys(journeys)) journeys[k].sort((a, b) => a.at.localeCompare(b.at));
  purchases.sort((a, b) => b.at.localeCompare(a.at));
  return {
    purchases,
    journeys,
    people: { buyers: new Set(purchases.map((p) => p.person)).size, purchases: purchases.length, revenue_cents: purchases.reduce((a, p) => a + p.amount_cents, 0) },
  };
}

// ---- invented launches for the fake's ads (fixture mode only) ---------------------------------------------------

/** One invented ad: its campaign, its clip, TikTok's numbers over its life. */
const FAKE_LAUNCH_ADS = [
  { ad: 0, campaign: 0, clip: "fake-clip-flirt-hook-v1", spend: 1040, clicks: 412, impressions: 21400, purchases: 2 },
  { ad: 1, campaign: 0, clip: "fake-clip-flirt-v4", spend: 778, clicks: 305, impressions: 16800, purchases: 3 },
  { ad: 2, campaign: 1, clip: "fake-clip-flirt-v4", spend: 621, clicks: 520, impressions: 19100, purchases: null },
  { ad: 3, campaign: 1, clip: "fake-clip-flirt-hook-v1", spend: 512, clicks: 388, impressions: 15300, purchases: null },
] as const;

/** The invented clips those ads played (fixture mode: `adCreatives` reads them as it reads studio.clips). */
export const FAKE_STATS_CLIPS = [
  { id: "fake-clip-flirt-hook-v1", title_id: "fake-title", ad_format: "hook_ad", hook_en: "She flirted with the wrong CEO, and he flirted back.", render_path: "fake-title/ep1/upload-0123456789abcdef-flirt-hook-v1.mp4" },
  { id: "fake-clip-flirt-v4", title_id: "fake-title", ad_format: "narration_trailer", hook_en: "I thought one night would end it. It started everything.", render_path: "fake-title/ep1/upload-fedcba9876543210-flirt-v4.mp4" },
] as const;

/**
 * Launch records for the fake's two campaigns (fixture mode only, never written anywhere): the purchases
 * campaign with TikTok's own purchases, the clicks one without, each ad's lifetime numbers, the content items
 * that name the clips, and TikTok's days for the period's spend (the last six days).
 */
export function fakeStatsLaunches(now: Date = new Date()): {
  runs: LaunchRun[];
  days: { ok: true; from: string; to: string; campaigns: string[]; days: Record<string, { day: string; spend_cents: number | null; impressions: number | null; clicks: number | null }[]> };
} {
  const launched = new Date(now.getTime() - 6 * 86_400_000 + 3_600_000).toISOString();
  const to = pacificDay(now);
  const from = addDays(to, -29);
  const names = ["da4a", "0d76"];
  const days: Record<string, { day: string; spend_cents: number | null; impressions: number | null; clicks: number | null }[]> = {};
  for (const a of FAKE_LAUNCH_ADS) {
    // Six days, rising: the lifetime spread so it adds up exactly.
    const weights = [1, 2, 3, 3, 4, 5];
    const total = weights.reduce((x, y) => x + y, 0);
    const left: Record<"spend" | "impressions" | "clicks", number> = { spend: a.spend, impressions: a.impressions, clicks: a.clicks };
    const part = (k: keyof typeof left, i: number, w: number) => {
      const v = i === weights.length - 1 ? left[k] : Math.round((a[k] * w) / total);
      left[k] -= v;
      return v;
    };
    days[FAKE_STATS_ADS[a.ad]] = weights.map((w, i) => ({ day: addDays(to, i - weights.length + 1), spend_cents: part("spend", i, w), impressions: part("impressions", i, w), clicks: part("clicks", i, w) }));
  }
  const runs = [0, 1].map((ci) => {
    const website = ci === 0;
    const ads = FAKE_LAUNCH_ADS.filter((a) => a.campaign === ci);
    const settings = website
      ? { objective_type: "WEB_CONVERSIONS", sales_destination: "website", optimization_goal: "CONVERT", optimization_event: "SHOPPING" }
      : { objective_type: "TRAFFIC", optimization_goal: "CLICK" };
    const sum = (k: "spend" | "clicks" | "impressions") => ads.reduce((x, a) => x + a[k], 0);
    const content = ads.map((a) => {
      const clip = FAKE_STATS_CLIPS.find((c) => c.id === a.clip)!;
      return { kind: "video" as const, value: clip.id, clip_id: clip.id, title_id: clip.title_id, text: clip.hook_en, file_path: clip.render_path };
    });
    return {
      id: `fake-stats-run-${ci + 1}`,
      external_id: `lr_fakestats${ci + 1}`,
      producer_id: "fake-stats",
      draft: { provider: "tiktok", name: `Invented launch · ${names[ci]}`, content, tiktok_settings: settings },
      round: 1,
      parent_run_id: null,
      status: "done",
      revision: 1,
      snapshot_hash: null,
      approved_by: null,
      approved_at: launched,
      approval_note: null,
      created_by: "fake-stats",
      created_at: launched,
      updated_at: launched,
      mode: "fake",
      error: null,
      lease_owner: null,
      lease_until: null,
      campaigns: [
        {
          id: `fake-stats-campaign-${ci + 1}`,
          run_id: `fake-stats-run-${ci + 1}`,
          index: 0,
          connection_id: "fake-stats",
          advertiser_id: "7000000000000000001",
          name: names[ci],
          content,
          budget_cents: 5000,
          daily_budget_cents: null,
          status: "done",
          error: null,
          state: { campaign_id: FAKE_STATS_CAMPAIGNS[ci], settings, groups: [{ ads: Object.fromEntries(ads.map((a) => [a.clip, FAKE_STATS_ADS[a.ad]])) }] },
          snapshot: {
            delivery: "live",
            note: null,
            checked_at: now.toISOString(),
            spend_cents: sum("spend"),
            impressions: sum("impressions"),
            clicks: sum("clicks"),
            conversions: sum("clicks"),
            cpc_cents: Math.round(sum("spend") / sum("clicks")),
            web: website ? { purchases: 5, purchase_value_cents: 995, cost_per_purchase_cents: Math.round(sum("spend") / 5), roas: 0.55, checkouts: 9, cost_per_checkout_cents: null, event: "SHOPPING", attribution: "7-day click, 1-day view" } : null,
            ads: ads.map((a) => ({
              id: FAKE_STATS_ADS[a.ad],
              status: "live",
              content_value: a.clip,
              stats: {
                spend_cents: a.spend,
                impressions: a.impressions,
                clicks: a.clicks,
                ctr: a.clicks / a.impressions,
                cpc_cents: Math.round(a.spend / a.clicks),
                conversions: a.clicks,
                web: a.purchases === null ? null : { purchases: a.purchases, purchase_value_cents: a.purchases * 199, cost_per_purchase_cents: Math.round(a.spend / a.purchases), roas: null, checkouts: null, cost_per_checkout_cents: null },
              },
            })),
          },
        },
      ],
    };
  }) as unknown as LaunchRun[];
  return { runs, days: { ok: true, from, to, campaigns: [...FAKE_STATS_CAMPAIGNS], days } };
}
