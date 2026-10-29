// The ad-spend sync (decision 2026-10-29, "The ad-spend sync"): Crazy Drama's
// `ad_spend` table was empty, so its dashboard could not cost a buyer or say
// what an ad dollar returned. Studio holds the TikTok and Meta credentials, so
// Studio reads each ad's spend per day and sends it to crazydramas'
// `PUT /api/studio/ad-spend` (crazydramas docs/STUDIO_API.md), which ties
// every ad to its series from its own landings. Server-only.
//
//   TikTok  every ad account Studio's launch runs used (in the transport's own
//           environment) plus TIKTOK_DEFAULT_ADVERTISER_ID, read WHOLE so an ad
//           made in Ads Manager counts too: verified 2026-10-29 that the one
//           readable account carries Crazy Drama campaigns only. The currency
//           from /advertiser/info/, then the AUCTION_AD report by ["ad_id",
//           "stat_time_day"] with campaign_id, 30 days a report, paged as
//           lib/tiktok/ad-days.ts pages, each account with its own token.
//   Meta    every ad account of Studio's Meta launch runs: the currency from
//           act_<id>, then act_<id>/insights at level=ad, time_increment=1,
//           cursor-paged (metaList). The account also runs Chloe Lin's
//           Instagram boosts, which are not Crazy Drama's, so only campaigns
//           with an ad linking to crazydramas.com, or launched by Studio, are
//           kept; the rest is counted in `excluded`, never sent. Clicks are
//           Meta's `clicks`, as the Monitor reads them (lib/meta/driver.ts).
//
// Every provider call is a GET; nothing is created, changed or paused. One
// account that fails or reports in another currency is left out whole and
// named (`failed`, `skipped`); the others are sent. A platform with no account
// read sends nothing. Rows are cents by their digits, zero rows dropped and
// at most 2,000 a request (lib/crazydramas/spend-rows.ts). crazydramas replaces
// what it holds for the same platform, day and ad, so a window can always be
// sent again.
//
// The send is behind its own gate, `cdSpendGate` (DATA_SOURCE=supabase AND
// CRAZYDRAMAS_SPEND_SYNC=enabled AND the token, never under node:test), checked
// before any provider is read. A dry run reads and sends nothing, gate or not.
// The scheduler (lib/tiktok/scheduler.ts, step 10) sends the last 7 days every
// 6 hours; scripts/ad-spend-sync.ts backfills.

import { systemSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import type { LaunchRun } from "@/lib/launch/types";
import { metaTransport } from "@/lib/meta";
import { metaList, type MetaObject, type MetaTransport } from "@/lib/meta/transport";
import { accessTokenFor, tiktokTransport } from "@/lib/tiktok";
import { tiktokDefaultAdvertiserId } from "@/lib/tiktok/defaults";
import type { TikTokTransport } from "@/lib/tiktok/transport";
import {
  addDays,
  chunkRows,
  countOf,
  dayWindows,
  dollars,
  duplicateRow,
  idOf,
  isDay,
  keepRow,
  linksToCrazydramas,
  SPEND_PLATFORMS,
  spendCents,
  sortRows,
  windowProblem,
  type AdSpendRow,
  type SpendPlatform,
} from "./spend-rows";
import { cdSpendGate, studioClient, type AdSpendAnswer, type StudioClient } from "./studio-client";

/** The scheduler's cadence and window. */
export const SPEND_SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
export const SPEND_SYNC_DAYS = 7;

const TIKTOK_METRICS = ["spend", "impressions", "clicks", "campaign_id"] as const;
const TIKTOK_PAGE_SIZE = 1000;
const TIKTOK_MAX_PAGES = 100;
const META_FIELDS = "ad_id,campaign_id,spend,impressions,clicks,account_currency,date_start";
const META_AD_FIELDS = "campaign_id,creative{call_to_action,object_story_spec,asset_feed_spec}";

type Row = Record<string, unknown>;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const log = (m: string) => console.log(`[spend-sync] ${m}`);

/** An account left out whole: why, in words (a provider's sentence, never a credential). */
export type AccountProblem = { account: string; reason: string };

export type PlatformRead = {
  platform: SpendPlatform;
  from: string;
  to: string;
  /** The accounts read in full; their rows are all here. */
  accounts: string[];
  /** Kept rows, oldest day first. */
  rows: AdSpendRow[];
  /** Another currency than USD: never converted, never sent. */
  skipped: AccountProblem[];
  /** Could not be read; the next run tries again. */
  failed: AccountProblem[];
  /** Campaigns on a read account that are not Crazy Drama's (Meta), and what they spent: never sent. */
  excluded: { campaigns: string[]; spend_cents: number };
};

const emptyRead = (platform: SpendPlatform, from: string, to: string): PlatformRead => ({
  platform, from, to, accounts: [], rows: [], skipped: [], failed: [], excluded: { campaigns: [], spend_cents: 0 },
});

/** An account whose currency is not USD: skipped, not failed. */
class CurrencySkip extends Error {}

// ---- which accounts -------------------------------------------------------------------------------------------

export type SpendAccounts = { tiktok: string[]; meta: string[]; meta_campaigns: string[] };

/**
 * The ad accounts to read: every account of Studio's launch runs in the
 * transports' own environments (a sandbox run's account is never read in
 * production, nor a fake one live), plus the operator's TikTok default in
 * production; and the Meta campaigns Studio launched, which are Crazy Drama's
 * by construction.
 */
export function spendAccounts(
  runs: readonly LaunchRun[],
  modes: { tiktok: TikTokTransport["mode"]; meta: MetaTransport["mode"] },
  defaultTikTok: string | null,
): SpendAccounts {
  const tiktok = new Set<string>();
  const meta = new Set<string>();
  const metaCampaigns = new Set<string>();
  for (const run of runs) {
    const provider = run.draft?.provider;
    if (provider === "tiktok" && run.mode === modes.tiktok) {
      for (const c of run.campaigns ?? []) if (idOf(c.advertiser_id)) tiktok.add(idOf(c.advertiser_id));
    }
    if (provider === "meta" && (run.mode === "fake") === (modes.meta === "fake")) {
      for (const c of run.campaigns ?? []) {
        const account = idOf(String(c.advertiser_id ?? "").replace(/^act_/, ""));
        if (account) meta.add(account);
        const campaign = idOf((c.state?.meta as { campaign_id?: unknown } | undefined)?.campaign_id);
        if (campaign) metaCampaigns.add(campaign);
      }
    }
  }
  if (defaultTikTok && modes.tiktok === "production") tiktok.add(defaultTikTok);
  return { tiktok: [...tiktok].sort(), meta: [...meta].sort(), meta_campaigns: [...metaCampaigns].sort() };
}

// ---- TikTok ---------------------------------------------------------------------------------------------------

async function tiktokCurrency(tt: TikTokTransport, token: string, advertiser: string): Promise<string> {
  const res = await tt.get("/advertiser/info/", token, { advertiser_ids: JSON.stringify([advertiser]), fields: JSON.stringify(["advertiser_id", "currency"]) });
  if (res.code !== 0) throw new Error(res.message || "TikTok did not describe the ad account.");
  const row = ((res.data?.list ?? []) as Row[]).find((a) => idOf(a.advertiser_id) === advertiser);
  if (!row) throw new Error("TikTok did not return the ad account.");
  return typeof row.currency === "string" ? row.currency : "";
}

/** One report row as a contract row; null when it spent nothing and was not seen. A kept row without its ids or spend is refused. */
function tiktokRow(row: Row): AdSpendRow | null {
  const dims = (row.dimensions ?? {}) as Row;
  const m = (row.metrics ?? {}) as Row;
  const ad = idOf(dims.ad_id);
  const day = String(dims.stat_time_day ?? "").slice(0, 10);
  const spend = spendCents(m.spend);
  const impressions = countOf(m.impressions);
  if (spend === 0 && !impressions) return null;
  if (!ad || !isDay(day)) throw new Error("TikTok's daily ad report listed a row without its ad or day.");
  if (spend === null) throw new Error(`TikTok's daily ad report listed ad ${ad} on ${day} without a readable spend.`);
  const campaign = idOf(m.campaign_id);
  if (!campaign) throw new Error(`TikTok's daily ad report listed ad ${ad} without its campaign.`);
  return { day, ad_id: ad, campaign_id: campaign, spend_cents: spend, impressions, clicks: countOf(m.clicks) };
}

/** One account's days over one window of at most 30 days, every page: a page missing is never a day with no spend. */
async function tiktokWindow(tt: TikTokTransport, token: string, advertiser: string, window: { from: string; to: string }): Promise<AdSpendRow[]> {
  const rows: AdSpendRow[] = [];
  let total = 1;
  for (let page = 1; page <= total; page++) {
    if (page > TIKTOK_MAX_PAGES) throw new Error(`TikTok's daily ad report ran past ${TIKTOK_MAX_PAGES} pages.`);
    const res = await tt.get("/report/integrated/get/", token, {
      advertiser_id: advertiser, report_type: "BASIC", data_level: "AUCTION_AD",
      dimensions: JSON.stringify(["ad_id", "stat_time_day"]), metrics: JSON.stringify(TIKTOK_METRICS),
      start_date: window.from, end_date: window.to, page, page_size: TIKTOK_PAGE_SIZE,
    });
    if (res.code !== 0) throw new Error(res.message || "TikTok did not return the daily ad report.");
    const list = res.data?.list;
    if (!Array.isArray(list)) throw new Error("TikTok's daily ad report came back without its rows.");
    for (const item of list) {
      const row = tiktokRow(item as Row);
      if (row) rows.push(row);
    }
    const pages = (res.data?.page_info as { total_page?: number } | undefined)?.total_page;
    if (pages === undefined && list.length >= TIKTOK_PAGE_SIZE) throw new Error("TikTok's daily ad report came back without its page count.");
    total = pages === undefined ? 1 : Math.max(1, Number(pages));
  }
  return rows;
}

/** Every ad's spend per day on these TikTok ad accounts, whole accounts. */
export async function readTikTokSpend(
  accounts: readonly string[],
  from: string,
  to: string,
  opts: { transport?: TikTokTransport; tokenFor?: (advertiserId: string) => string | null } = {},
): Promise<PlatformRead> {
  const tt = opts.transport ?? tiktokTransport();
  const tokenFor = opts.tokenFor ?? accessTokenFor;
  const out = emptyRead("tiktok", from, to);
  for (const advertiser of accounts) {
    try {
      const token = tokenFor(advertiser);
      if (!token) throw new Error(`No TikTok connection covers ad account ${advertiser}.`);
      const currency = await tiktokCurrency(tt, token, advertiser);
      if (currency !== "USD") throw new CurrencySkip(`reports in ${currency || "an unknown currency"}, not USD`);
      const own: AdSpendRow[] = [];
      for (const window of dayWindows(from, to)) own.push(...(await tiktokWindow(tt, token, advertiser, window)));
      const twice = duplicateRow(own);
      if (twice) throw new Error(`TikTok's daily ad report listed ${twice} twice.`);
      out.rows.push(...own.filter(keepRow));
      out.accounts.push(advertiser);
    } catch (e) {
      (e instanceof CurrencySkip ? out.skipped : out.failed).push({ account: advertiser, reason: errorText(e) });
    }
  }
  out.rows = sortRows(out.rows);
  return out;
}

// ---- Meta -----------------------------------------------------------------------------------------------------

/** The campaigns of an ad account with an ad whose creative links to crazydramas.com. */
async function metaCrazydramasCampaigns(transport: MetaTransport, account: string): Promise<Set<string>> {
  const ads = await metaList(transport, `act_${account}/ads`, { fields: META_AD_FIELDS });
  const out = new Set<string>();
  for (const ad of ads) {
    const campaign = idOf(ad.campaign_id);
    if (campaign && linksToCrazydramas(ad.creative)) out.add(campaign);
  }
  return out;
}

/** One insights row as a contract row; null when it spent nothing and was not seen. */
function metaRow(row: MetaObject): AdSpendRow | null {
  if (row.account_currency !== undefined && row.account_currency !== "USD") throw new CurrencySkip(`reports in ${String(row.account_currency)}, not USD`);
  const spend = spendCents(row.spend);
  const impressions = countOf(row.impressions);
  if (spend === 0 && !impressions) return null;
  const ad = idOf(row.ad_id);
  const campaign = idOf(row.campaign_id);
  const day = String(row.date_start ?? "");
  if (!ad || !campaign || !isDay(day)) throw new Error("Meta's insights listed a row without its ad, campaign or day.");
  if (spend === null) throw new Error(`Meta's insights listed ad ${ad} on ${day} without a readable spend.`);
  return { day, ad_id: ad, campaign_id: campaign, spend_cents: spend, impressions, clicks: countOf(row.clicks) };
}

/** Every Crazy Drama ad's spend per day on these Meta ad accounts. */
export async function readMetaSpend(
  accounts: readonly string[],
  from: string,
  to: string,
  opts: { transport?: MetaTransport; studioCampaigns?: Iterable<string> } = {},
): Promise<PlatformRead> {
  const transport = opts.transport ?? metaTransport();
  const studio = new Set(opts.studioCampaigns ?? []);
  const out = emptyRead("meta", from, to);
  const excluded = new Set<string>();
  for (const raw of accounts) {
    const account = raw.replace(/^act_/, "");
    try {
      const info = await transport.get(`act_${account}`, { fields: "currency" });
      const currency = typeof info.currency === "string" ? info.currency : "";
      if (currency !== "USD") throw new CurrencySkip(`reports in ${currency || "an unknown currency"}, not USD`);
      const ours = await metaCrazydramasCampaigns(transport, account);
      for (const id of studio) ours.add(id);
      const own: AdSpendRow[] = [];
      const left = new Set<string>();
      let leftCents = 0;
      for (const window of dayWindows(from, to)) {
        const list = await metaList(transport, `act_${account}/insights`, {
          level: "ad", time_increment: 1, time_range: { since: window.from, until: window.to }, fields: META_FIELDS,
        });
        for (const item of list) {
          const row = metaRow(item);
          if (!row) continue;
          if (ours.has(row.campaign_id)) own.push(row);
          else { left.add(row.campaign_id); leftCents += row.spend_cents; }
        }
      }
      const twice = duplicateRow(own);
      if (twice) throw new Error(`Meta's insights listed ${twice} twice.`);
      out.rows.push(...own.filter(keepRow));
      out.accounts.push(account);
      for (const id of left) excluded.add(id);
      out.excluded.spend_cents += leftCents;
    } catch (e) {
      (e instanceof CurrencySkip ? out.skipped : out.failed).push({ account, reason: errorText(e) });
    }
  }
  out.rows = sortRows(out.rows);
  out.excluded.campaigns = [...excluded].sort();
  return out;
}

// ---- the sync -------------------------------------------------------------------------------------------------

export type PlatformSync = PlatformRead & {
  /**
   * dry_run    read, nothing sent
   * sent       every request answered 200
   * failed     a request was refused (`error`); later chunks were not sent
   * nothing    accounts were read but no ad spent or was seen
   * no_reads   no account was read (all failed or skipped, or none): nothing sent
   */
  outcome: "dry_run" | "sent" | "failed" | "nothing" | "no_reads";
  answers: AdSpendAnswer[];
  error: string | null;
};

export type SpendSyncResult = { from: string; to: string; dry_run: boolean; refused: string | null; platforms: PlatformSync[] };

export type SpendSyncOptions = {
  from: string;
  to: string;
  platforms?: readonly SpendPlatform[];
  /** Read the providers and send nothing; needs no gate. */
  dryRun?: boolean;
  /** Studio's launch runs; read as the system actor when absent. */
  runs?: readonly LaunchRun[];
  tiktok?: { transport?: TikTokTransport; tokenFor?: (advertiserId: string) => string | null };
  meta?: { transport?: MetaTransport };
  client?: StudioClient;
  /** The send gate; `cdSpendGate` by default. */
  gate?: () => { enabled: boolean; reason: string | null };
};

/** A refusal in crazydramas' own words, with the first of its `issues` when it sent them. */
function refusalText(fail: { code: string; error: string; body: Record<string, unknown> }): string {
  const issues = Array.isArray(fail.body.issues) ? (fail.body.issues as { path?: unknown; message?: unknown }[]).slice(0, 3).map((i) => `${String(i.path ?? "")}: ${String(i.message ?? "")}`) : [];
  return `${fail.code}: ${fail.error}${issues.length ? ` (${issues.join("; ")})` : ""}`;
}

/** Read [from, to] on each platform and, unless a dry run, send it. The gate is asked before anything is read. */
export async function syncAdSpend(opts: SpendSyncOptions): Promise<SpendSyncResult> {
  const problem = windowProblem(opts.from, opts.to);
  if (problem) throw new Error(problem);
  const dry = !!opts.dryRun;
  const result: SpendSyncResult = { from: opts.from, to: opts.to, dry_run: dry, refused: null, platforms: [] };
  let client: StudioClient | null = null;
  if (!dry) {
    const gate = (opts.gate ?? cdSpendGate)();
    if (!gate.enabled) return { ...result, refused: gate.reason ?? "The ad-spend sync is off." };
    client = opts.client ?? studioClient();
  }
  const tt = opts.tiktok?.transport ?? tiktokTransport();
  const meta = opts.meta?.transport ?? metaTransport();
  const runs = opts.runs ?? (await getData().listLaunchRuns(systemSession()));
  const accounts = spendAccounts(runs, { tiktok: tt.mode, meta: meta.mode }, tiktokDefaultAdvertiserId());
  for (const platform of opts.platforms ?? SPEND_PLATFORMS) {
    const read = platform === "tiktok"
      ? await readTikTokSpend(accounts.tiktok, opts.from, opts.to, { transport: tt, tokenFor: opts.tiktok?.tokenFor })
      : await readMetaSpend(accounts.meta, opts.from, opts.to, { transport: meta, studioCampaigns: accounts.meta_campaigns });
    const sync: PlatformSync = { ...read, outcome: "nothing", answers: [], error: null };
    if (dry) sync.outcome = "dry_run";
    else if (!read.accounts.length) sync.outcome = "no_reads";
    else if (read.rows.length) {
      sync.outcome = "sent";
      for (const rows of chunkRows(read.rows)) {
        const answer = await client!.putAdSpend({ platform, currency: "USD", rows });
        if (!answer.ok) {
          sync.outcome = "failed";
          sync.error = refusalText(answer);
          break;
        }
        sync.answers.push(answer.data);
      }
    }
    result.platforms.push(sync);
  }
  return result;
}

/** One line per platform, for the log and the CLI: what was read, sent and left out. Ids and sentences only. */
export function syncSummary(r: SpendSyncResult): string {
  if (r.refused) return `${r.from}..${r.to} not sent: ${r.refused}`;
  return r.platforms.map((p) => {
    const spent = p.rows.reduce((n, row) => n + row.spend_cents, 0);
    const parts = [`${p.platform} ${p.outcome}: ${p.rows.length} rows, ${dollars(spent)}, ${p.accounts.length} account${p.accounts.length === 1 ? "" : "s"} read`];
    if (p.answers.length) {
      const matched = p.answers.reduce((n, a) => n + a.matched, 0);
      const unmatched = [...new Set(p.answers.flatMap((a) => a.unmatched_ads))];
      parts.push(`${p.answers.length} request${p.answers.length === 1 ? "" : "s"}, matched ${matched}${unmatched.length ? `, unmatched ${unmatched.slice(0, 5).join(" ")}${unmatched.length > 5 ? " …" : ""}` : ""}`);
    }
    if (p.error) parts.push(`refused ${p.error}`);
    for (const s of p.skipped) parts.push(`skipped ${s.account} (${s.reason})`);
    for (const f of p.failed) parts.push(`failed ${f.account} (${f.reason})`);
    if (p.excluded.campaigns.length) parts.push(`left out ${p.excluded.campaigns.length} non-Crazy-Drama campaign${p.excluded.campaigns.length === 1 ? "" : "s"}, ${dollars(p.excluded.spend_cents)}`);
    return `${r.from}..${r.to} ${parts.join("; ")}`;
  }).join("\n");
}

// ---- the scheduler's step -------------------------------------------------------------------------------------

/**
 * The last SPEND_SYNC_DAYS days ending on today's date at UTC−12, the
 * earliest date on Earth, so `to` is never a day an ad account has not
 * reached yet; the hours that lags behind are sent by the next run.
 */
export function recentWindow(now: number): { from: string; to: string } {
  const to = new Date(now - 12 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { from: addDays(to, -(SPEND_SYNC_DAYS - 1)), to };
}

// On globalThis, not module-level: Next bundles lib/ separately into every route.
type TickState = { running: boolean; nextAt: number };
const holder = globalThis as typeof globalThis & { __studioSpendSync?: TickState };
const tickState = (): TickState => (holder.__studioSpendSync ??= { running: false, nextAt: 0 });

/** Step 10 of the scheduler: the last 7 days, both platforms, every 6 hours, behind the gate and SCHEDULER_DISABLED. Never throws. */
export async function tickSpendSync(opts: { now?: () => number } = {}): Promise<SpendSyncResult | null> {
  if (process.env.SCHEDULER_DISABLED === "1") return null;
  if (!cdSpendGate().enabled) return null;
  const s = tickState();
  const now = (opts.now ?? Date.now)();
  if (s.running || now < s.nextAt) return null;
  s.running = true;
  try {
    const result = await syncAdSpend(recentWindow(now));
    log(syncSummary(result));
    return result;
  } catch (e) {
    log(`failed: ${errorText(e)}`);
    return null;
  } finally {
    s.running = false;
    s.nextAt = now + SPEND_SYNC_EVERY_MS;
  }
}
