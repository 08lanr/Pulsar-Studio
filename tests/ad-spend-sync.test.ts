// The ad-spend sync (decision 2026-10-29): TikTok's and Meta's spend per ad per day, read whole accounts (Meta's
// creator boosts left out), turned into whole cents by their digits and sent to crazydramas' PUT
// /api/studio/ad-spend in requests of at most 2,000 rows, behind CRAZYDRAMAS_SPEND_SYNC. Every provider and
// crazydramas here is a stub in this file; under node:test the gate refuses before anything is read.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { LaunchRun } from "@/lib/launch/types";
import type { MetaObject, MetaTransport } from "@/lib/meta/transport";
import type { TikTokResponse, TikTokTransport } from "@/lib/tiktok/transport";
import {
  AD_SPEND_MAX_ROWS,
  chunkRows,
  countOf,
  dayWindows,
  keepRow,
  linksToCrazydramas,
  spendByDay,
  spendCents,
  windowProblem,
} from "@/lib/crazydramas/spend-rows";
import { readMetaSpend, readTikTokSpend, recentWindow, spendAccounts, syncAdSpend, tickSpendSync } from "@/lib/crazydramas/spend-sync";
import { StudioClient, cdSpendGate, type AdSpendBody } from "@/lib/crazydramas/studio-client";
import { liveCrazydramasStudioTransport, CrazydramasApiError, type CrazydramasStudioTransport } from "@/lib/crazydramas/transport";

const ENV_KEYS = ["DATA_SOURCE", "CRAZYDRAMAS_SPEND_SYNC", "CRAZYDRAMAS_LIVE_WRITES", "CRAZYDRAMAS_STUDIO_TOKEN", "TIKTOK_DEFAULT_ADVERTISER_ID", "SCHEDULER_DISABLED"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.TIKTOK_DEFAULT_ADVERTISER_ID;
  delete process.env.SCHEDULER_DISABLED;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const OPEN = () => ({ enabled: true, reason: null });

// ---- stubs ------------------------------------------------------------------------------------------------------

type TtCall = { path: string; params: Record<string, string | number> };
type TtRow = { ad: string; day: string; spend: string | number; impressions?: string | number; clicks?: string | number; campaign?: string };

/** A TikTok with accounts of rows; `pageSize` pages the report as TikTok does; an account missing from `currency` is refused 40001. */
function tiktok(accounts: Record<string, TtRow[]>, opts: { currency?: Record<string, string>; pageSize?: number } = {}): TikTokTransport & { calls: TtCall[] } {
  const calls: TtCall[] = [];
  const currency = opts.currency ?? Object.fromEntries(Object.keys(accounts).map((a) => [a, "USD"]));
  const ok = (data: Record<string, unknown>): TikTokResponse => ({ code: 0, message: "OK", data });
  return {
    mode: "production",
    calls,
    async get(path, _token, params = {}) {
      calls.push({ path, params });
      if (path === "/advertiser/info/") {
        const id = JSON.parse(String(params.advertiser_ids))[0];
        if (!(id in currency)) return { code: 40001, message: `No permission to operate advertiser: ${id}` };
        return ok({ list: [{ advertiser_id: id, currency: currency[id] }] });
      }
      if (path === "/report/integrated/get/") {
        const id = String(params.advertiser_id);
        if (!(id in currency)) return { code: 40001, message: `No permission to operate advertiser: ${id}` };
        assert.deepEqual(JSON.parse(String(params.dimensions)), ["ad_id", "stat_time_day"]);
        assert.ok(JSON.parse(String(params.metrics)).includes("campaign_id"));
        assert.equal(params.data_level, "AUCTION_AD");
        assert.equal(params.filtering, undefined, "the whole account, not Studio's campaigns only");
        const rows = (accounts[id] ?? []).filter((r) => r.day >= String(params.start_date) && r.day <= String(params.end_date)).map((r) => ({
          dimensions: { ad_id: r.ad, stat_time_day: `${r.day} 00:00:00` },
          metrics: { spend: r.spend, impressions: r.impressions ?? "100", clicks: r.clicks ?? "3", campaign_id: r.campaign ?? "1700000000000001" },
        }));
        const size = opts.pageSize ?? Number(params.page_size);
        const page = Number(params.page);
        return ok({ list: rows.slice((page - 1) * size, page * size), page_info: { page, page_size: size, total_page: Math.max(1, Math.ceil(rows.length / size)) } });
      }
      return { code: 40002, message: `unexpected ${path}` };
    },
    async post() { throw new Error("the spend sync never writes to TikTok"); },
    async upload() { throw new Error("the spend sync never writes to TikTok"); },
  };
}

type MetaAd = { campaign: string; link?: string };
type MetaInsight = { ad: string; campaign: string; day: string; spend: string; impressions?: string; clicks?: string; currency?: string };

/** A Meta with accounts (currency, ads with their creative links, insight rows); lists are cursor-paged by `limit`. */
function meta(accounts: Record<string, { currency?: string; ads?: MetaAd[]; insights?: MetaInsight[]; fail?: string }>, pageSize = 100): MetaTransport & { calls: { path: string; params: MetaObject }[] } {
  const calls: { path: string; params: MetaObject }[] = [];
  const page = (rows: MetaObject[], params: MetaObject) => {
    const start = params.after ? Number(params.after) : 0;
    const slice = rows.slice(start, start + pageSize);
    const next = start + pageSize < rows.length ? String(start + pageSize) : null;
    return { data: slice, ...(next ? { paging: { next: "https://graph.facebook.com/next", cursors: { after: next } } } : {}) };
  };
  const t: MetaTransport & { calls: typeof calls } = {
    mode: "live",
    calls,
    async get<T extends MetaObject>(path: string, params: MetaObject = {}) {
      calls.push({ path, params });
      const [act, edge] = path.split("/");
      const a = accounts[act.replace(/^act_/, "")];
      if (!a) throw new Error("Meta rejected the request (HTTP 400, code 100)");
      if (a.fail) throw new Error(a.fail);
      if (!edge) return { id: act, currency: a.currency ?? "USD" } as unknown as T;
      if (edge === "ads") return page((a.ads ?? []).map((ad, i) => ({ id: `ad${i}`, campaign_id: ad.campaign, creative: ad.link ? { call_to_action: { type: "WATCH_MORE", value: { link: ad.link } } } : { source_instagram_media_id: "1" } })), params) as unknown as T;
      if (edge === "insights") {
        assert.equal(params.level, "ad");
        assert.equal(params.time_increment, 1);
        const range = params.time_range as { since: string; until: string };
        const rows = (a.insights ?? []).filter((r) => r.day >= range.since && r.day <= range.until).map((r) => ({
          ad_id: r.ad, campaign_id: r.campaign, spend: r.spend, impressions: r.impressions ?? "50", clicks: r.clicks ?? "2",
          account_currency: r.currency ?? a.currency ?? "USD", date_start: r.day, date_stop: r.day,
        }));
        return page(rows, params) as unknown as T;
      }
      throw new Error(`unexpected ${path}`);
    },
    async post() { throw new Error("the spend sync never writes to Meta"); },
    async upload() { throw new Error("the spend sync never writes to Meta"); },
    forPage() { return t; },
  };
  return t;
}

/** crazydramas' ad-spend route: records every request; `refuse` answers the nth request (1-based) with a 400. */
function crazydramas(opts: { refuse?: number } = {}): CrazydramasStudioTransport & { bodies: AdSpendBody[] } {
  const bodies: AdSpendBody[] = [];
  return {
    mode: "fake",
    bodies,
    async request(method, path, body) {
      assert.equal(method, "PUT");
      assert.equal(path, "/api/studio/ad-spend");
      const b = body as AdSpendBody;
      bodies.push(b);
      if (opts.refuse === bodies.length) return { status: 400, body: { error: "The body is not valid.", code: "bad_request", issues: [{ path: "rows.0.day", message: "bad day" }] } };
      const days = b.rows.map((r) => r.day).sort();
      return { status: 200, body: { platform: b.platform, rows: b.rows.length, from: days[0], to: days[days.length - 1], matched: b.rows.length, unmatched_ads: [] } };
    },
    async putUploadChunk() { throw new Error("no uploads here"); },
    async checkImage() { throw new Error("no images here"); },
  };
}

function run(provider: "tiktok" | "meta", account: string, opts: { mode?: LaunchRun["mode"]; campaign?: string } = {}): LaunchRun {
  const state = provider === "meta" ? { meta: { campaign_id: opts.campaign } } : { campaign_id: opts.campaign ?? "1700000000000001" };
  return { id: `r-${account}`, mode: opts.mode ?? "production", draft: { provider }, campaigns: [{ advertiser_id: account, state }] } as unknown as LaunchRun;
}

// ---- the arithmetic -----------------------------------------------------------------------------------------------

test("spend becomes whole cents by its digits, half up, never through a float", () => {
  assert.equal(spendCents("12.345"), 1235, "12.345 * 100 is 1234.4999… as a float");
  assert.equal(spendCents("12.344"), 1234);
  assert.equal(spendCents("1.005"), 101, "Math.round(1.005 * 100) is 100");
  assert.equal(spendCents("0.005"), 1);
  assert.equal(spendCents("0.0049"), 0);
  assert.equal(spendCents("12.3"), 1230);
  assert.equal(spendCents("12"), 1200);
  assert.equal(spendCents("2842.75"), 284275);
  assert.equal(spendCents("0"), 0);
  assert.equal(spendCents(12.345), 1235, "a number is written with six decimals first");
  assert.equal(spendCents(0.1 + 0.2), 30);
  for (const bad of ["-1", "abc", "", "-", "1,234.00", null, undefined, Number.NaN, -0.5]) assert.equal(spendCents(bad), null, String(bad));
  assert.equal(countOf("100"), 100);
  assert.equal(countOf(7), 7);
  for (const bad of ["-", "", "1.5", "-3", null, undefined]) assert.equal(countOf(bad), null, String(bad));
});

test("rows that neither spent nor were seen are left out; windows, chunks and per-day sums", () => {
  const row = (spend_cents: number, impressions: number | null) => ({ day: "2026-10-01", ad_id: "1", campaign_id: "2", spend_cents, impressions, clicks: null });
  assert.equal(keepRow(row(0, 0)), false);
  assert.equal(keepRow(row(0, null)), false);
  assert.equal(keepRow(row(0, 12)), true);
  assert.equal(keepRow(row(1, 0)), true);
  assert.deepEqual(dayWindows("2026-09-01", "2026-10-28"), [{ from: "2026-09-01", to: "2026-09-30" }, { from: "2026-10-01", to: "2026-10-28" }]);
  assert.deepEqual(dayWindows("2026-10-05", "2026-10-05"), [{ from: "2026-10-05", to: "2026-10-05" }]);
  assert.deepEqual(chunkRows([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(windowProblem("2026-10-28", "2026-10-01"), "--from is after --to.");
  assert.match(windowProblem("2025-12-31", "2026-01-05") ?? "", /2026-01-01/);
  assert.equal(windowProblem("2026-02-30", "2026-03-01"), "Days are written YYYY-MM-DD.");
  assert.deepEqual(spendByDay([row(5, 1), { ...row(7, 1), ad_id: "9" }, { ...row(1, 1), day: "2026-10-02" }]), [
    { day: "2026-10-01", spend_cents: 12, rows: 2, ads: 2 }, { day: "2026-10-02", spend_cents: 1, rows: 1, ads: 1 },
  ]);
  assert.deepEqual(recentWindow(Date.parse("2026-10-29T05:00:00Z")), { from: "2026-10-22", to: "2026-10-28" }, "to is today at UTC−12, never a day an account has not reached");
});

test("which accounts: the runs' own environment, the TikTok default in production, Meta's Studio campaigns", () => {
  process.env.TIKTOK_DEFAULT_ADVERTISER_ID = "7686288484534599696";
  const runs = [run("tiktok", "111"), run("tiktok", "222", { mode: "sandbox" }), run("tiktok", "333", { mode: "fake" }), run("meta", "act_444", { campaign: "120000000000000001" }), run("meta", "555", { mode: "fake", campaign: "9" })];
  assert.deepEqual(spendAccounts(runs, { tiktok: "production", meta: "live" }, "7686288484534599696"), { tiktok: ["111", "7686288484534599696"], meta: ["444"], meta_campaigns: ["120000000000000001"] });
  assert.deepEqual(spendAccounts(runs, { tiktok: "fake", meta: "fake" }, "7686288484534599696"), { tiktok: ["333"], meta: ["555"], meta_campaigns: ["9"] }, "fixture mode never reads a production account");
});

// ---- TikTok -------------------------------------------------------------------------------------------------------

test("TikTok: every page and every 30-day window of the whole account, zero rows dropped", async () => {
  const rows: TtRow[] = [];
  for (let i = 0; i < 7; i++) rows.push({ ad: String(1000 + i), day: "2026-10-02", spend: "1.005" });
  rows.push({ ad: "2000", day: "2026-09-15", spend: "3.50" }, { ad: "2001", day: "2026-09-15", spend: "0", impressions: "0" }, { ad: "2002", day: "2026-09-16", spend: "0.00", impressions: "40" });
  const tt = tiktok({ "111": rows }, { pageSize: 3 });
  const read = await readTikTokSpend(["111"], "2026-09-01", "2026-10-28", { transport: tt, tokenFor: () => "t" });
  assert.deepEqual(read.failed, []);
  assert.equal(read.rows.length, 9, "the zero-spend, unseen row is left out; the seen one is kept");
  assert.deepEqual(read.rows.map((r) => r.day), ["2026-09-15", "2026-09-16", ...Array(7).fill("2026-10-02")]);
  assert.equal(read.rows.find((r) => r.ad_id === "1000")?.spend_cents, 101);
  const reports = tt.calls.filter((c) => c.path === "/report/integrated/get/");
  assert.deepEqual(reports.map((c) => [c.params.start_date, c.params.end_date, c.params.page]), [
    ["2026-09-01", "2026-09-30", 1], ["2026-10-01", "2026-10-28", 1], ["2026-10-01", "2026-10-28", 2], ["2026-10-01", "2026-10-28", 3],
  ]);
});

test("TikTok: one account failing does not stop the others; a non-USD account is skipped before its report", async () => {
  const tt = tiktok({ "111": [{ ad: "1", day: "2026-10-01", spend: "2" }], "333": [{ ad: "3", day: "2026-10-01", spend: "9" }] }, { currency: { "111": "USD", "333": "EUR" } });
  const read = await readTikTokSpend(["111", "222", "333"], "2026-10-01", "2026-10-02", { transport: tt, tokenFor: () => "t" });
  assert.deepEqual(read.accounts, ["111"]);
  assert.deepEqual(read.rows.map((r) => r.ad_id), ["1"]);
  assert.deepEqual(read.failed, [{ account: "222", reason: "No permission to operate advertiser: 222" }]);
  assert.deepEqual(read.skipped, [{ account: "333", reason: "reports in EUR, not USD" }]);
  assert.ok(!tt.calls.some((c) => c.path === "/report/integrated/get/" && c.params.advertiser_id === "333"), "never read, never converted");
  const twice = tiktok({ "111": [{ ad: "1", day: "2026-10-01", spend: "2" }, { ad: "1", day: "2026-10-01", spend: "2" }] });
  const dup = await readTikTokSpend(["111"], "2026-10-01", "2026-10-01", { transport: twice, tokenFor: () => "t" });
  assert.match(dup.failed[0]?.reason ?? "", /listed 1 on 2026-10-01 twice/, "a day listed twice is refused, never summed");
});

// ---- Meta ---------------------------------------------------------------------------------------------------------

test("Meta: cursor pages, Crazy Drama's campaigns only (a crazydramas link or a Studio launch), the rest counted and left out", async () => {
  const insights: MetaInsight[] = [];
  for (let i = 0; i < 5; i++) insights.push({ ad: String(500 + i), campaign: "11", day: "2026-10-10", spend: "10.015" });
  insights.push({ ad: "600", campaign: "22", day: "2026-10-10", spend: "4.00" }, { ad: "700", campaign: "33", day: "2026-10-11", spend: "1.25" }, { ad: "800", campaign: "11", day: "2026-10-11", spend: "0", impressions: "0" });
  const m = meta({ "444": { ads: [{ campaign: "11", link: "https://crazydramas.com/watch/flirt?source=meta" }, { campaign: "22" }, { campaign: "33" }], insights } }, 2);
  const read = await readMetaSpend(["act_444"], "2026-10-01", "2026-10-28", { transport: m, studioCampaigns: ["33"] });
  assert.deepEqual(read.accounts, ["444"]);
  assert.deepEqual(read.rows.map((r) => r.ad_id), ["500", "501", "502", "503", "504", "700"], "campaign 33 is Studio's own; 800 spent nothing");
  assert.equal(read.rows[0].spend_cents, 1002);
  assert.deepEqual(read.excluded, { campaigns: ["22"], spend_cents: 400 }, "the creator boost is named and never sent");
  assert.ok(m.calls.filter((c) => c.path === "act_444/insights").length >= 4, "every cursor page was read");
  assert.ok(linksToCrazydramas({ asset_feed_spec: { link_urls: [{ website_url: "https://www.crazydramas.com/try/x" }] } }));
  assert.ok(!linksToCrazydramas({ call_to_action: { value: { link: "https://notcrazydramas.com/" } } }));
});

test("Meta: a non-USD account is skipped, a failing one named, the others read", async () => {
  const m = meta({ "1": { currency: "GBP", ads: [], insights: [] }, "2": { fail: "Meta rejected the request (HTTP 400, code 100)" }, "3": { ads: [{ campaign: "9", link: "https://crazydramas.com/" }], insights: [{ ad: "90", campaign: "9", day: "2026-10-01", spend: "1" }] } });
  const read = await readMetaSpend(["1", "2", "3"], "2026-10-01", "2026-10-01", { transport: m });
  assert.deepEqual(read.skipped, [{ account: "1", reason: "reports in GBP, not USD" }]);
  assert.deepEqual(read.failed.map((f) => f.account), ["2"]);
  assert.deepEqual(read.rows.map((r) => r.ad_id), ["90"]);
  assert.ok(!m.calls.some((c) => c.path === "act_1/insights"));
});

// ---- the send -----------------------------------------------------------------------------------------------------

test("the send: requests of at most 2,000 rows, each (day, ad) once, the strict body; a platform with no account read sends nothing", async () => {
  const rows: TtRow[] = [];
  for (let d = 1; d <= 9; d++) for (let a = 0; a < 500; a++) rows.push({ ad: String(10_000 + a), day: `2026-10-0${d}`, spend: "0.10" });
  const cd = crazydramas();
  const result = await syncAdSpend({
    from: "2026-10-01", to: "2026-10-09", runs: [run("tiktok", "111"), run("meta", "444")], gate: OPEN,
    tiktok: { transport: tiktok({ "111": rows }), tokenFor: () => "t" },
    meta: { transport: meta({ "999": {} }) },
    client: new StudioClient({ transport: cd, spendGate: OPEN }),
  });
  assert.equal(result.refused, null);
  const [tt, mt] = result.platforms;
  assert.equal(tt.outcome, "sent");
  assert.deepEqual(cd.bodies.map((b) => b.rows.length), [AD_SPEND_MAX_ROWS, AD_SPEND_MAX_ROWS, 500]);
  for (const b of cd.bodies) {
    assert.deepEqual(Object.keys(b).sort(), ["currency", "platform", "rows"]);
    assert.equal(b.platform, "tiktok");
    assert.equal(b.currency, "USD");
    assert.deepEqual(Object.keys(b.rows[0]).sort(), ["ad_id", "campaign_id", "clicks", "day", "impressions", "spend_cents"]);
    assert.equal(new Set(b.rows.map((r) => `${r.day}|${r.ad_id}`)).size, b.rows.length);
  }
  assert.equal(tt.answers.reduce((n, a) => n + a.rows, 0), 4500);
  assert.equal(mt.outcome, "no_reads", "Meta's only account failed: nothing is sent for Meta");
  assert.equal(mt.failed.length, 1);
  assert.ok(cd.bodies.every((b) => b.platform === "tiktok"));
});

test("the send stops at crazydramas' refusal and says it in its own words", async () => {
  const rows: TtRow[] = [];
  for (let a = 0; a < 2500; a++) rows.push({ ad: String(10_000 + a), day: "2026-10-01", spend: "1" });
  const cd = crazydramas({ refuse: 1 });
  const result = await syncAdSpend({
    from: "2026-10-01", to: "2026-10-01", platforms: ["tiktok"], runs: [run("tiktok", "111")], gate: OPEN,
    tiktok: { transport: tiktok({ "111": rows }), tokenFor: () => "t" }, client: new StudioClient({ transport: cd, spendGate: OPEN }),
  });
  assert.equal(result.platforms[0].outcome, "failed");
  assert.equal(result.platforms[0].error, "bad_request: The body is not valid. (rows.0.day: bad day)");
  assert.equal(cd.bodies.length, 1, "the second chunk is not sent after a refusal");
});

test("a dry run reads and sends nothing, with no gate at all", async () => {
  const cd = crazydramas();
  const result = await syncAdSpend({
    from: "2026-10-01", to: "2026-10-02", dryRun: true, runs: [run("tiktok", "111")], gate: () => ({ enabled: false, reason: "off" }),
    tiktok: { transport: tiktok({ "111": [{ ad: "1", day: "2026-10-01", spend: "5.555" }] }), tokenFor: () => "t" },
    meta: { transport: meta({}) }, client: new StudioClient({ transport: cd, spendGate: OPEN }),
  });
  assert.equal(result.refused, null);
  assert.deepEqual(result.platforms.map((p) => p.outcome), ["dry_run", "dry_run"]);
  assert.equal(result.platforms[0].rows[0].spend_cents, 556);
  assert.equal(cd.bodies.length, 0);
});

test("the gate refuses in tests whatever the environment says, before TikTok or Meta is read", async () => {
  process.env.DATA_SOURCE = "supabase";
  process.env.CRAZYDRAMAS_SPEND_SYNC = "enabled";
  process.env.CRAZYDRAMAS_LIVE_WRITES = "enabled";
  process.env.CRAZYDRAMAS_STUDIO_TOKEN = "x".repeat(64);
  const gate = cdSpendGate();
  assert.equal(gate.enabled, false);
  assert.match(gate.reason ?? "", /tests/);
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched += 1; throw new Error("no network in tests"); }) as typeof fetch;
  try {
    const tt = tiktok({ "111": [{ ad: "1", day: "2026-10-01", spend: "1" }] });
    const m = meta({ "444": {} });
    const result = await syncAdSpend({ from: "2026-10-01", to: "2026-10-02", runs: [run("tiktok", "111"), run("meta", "444")], tiktok: { transport: tt, tokenFor: () => "t" }, meta: { transport: m } });
    assert.match(result.refused ?? "", /tests/);
    assert.equal(tt.calls.length + m.calls.length, 0, "refused before any provider read");
    assert.equal(await tickSpendSync(), null, "the scheduler step does nothing");
    const answer = await new StudioClient({ transport: liveCrazydramasStudioTransport }).putAdSpend({ platform: "tiktok", currency: "USD", rows: [] });
    assert.equal(answer.ok, false);
    assert.equal(!answer.ok && answer.code, "writes_disabled", "the client's own gate refuses before the transport");
    await assert.rejects(liveCrazydramasStudioTransport.request("PUT", "/api/studio/ad-spend", { platform: "tiktok", currency: "USD", rows: [] }), CrazydramasApiError);
    assert.equal(fetched, 0, "nothing reached the network");
  } finally {
    globalThis.fetch = realFetch;
  }
});
