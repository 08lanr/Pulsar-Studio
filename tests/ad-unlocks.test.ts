// Ad unlocks in Studio (decision 2026-11-09): the AdMob network report's request and parse, the AdMob read (fake,
// not configured, not connected, a stubbed Google, its keeps), crazydramas' ad-unlocks report (whitelist, the read
// through the Studio API transport, a crazydramas without the route), the pure sums the tab shows and the tab
// itself. No request leaves the process: Google is a stub fetch, crazydramas the fake or a stub transport.

process.env.PROMO_RENDER = "off";

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ADMOB_FILE, readAdmobConnection, saveAdmobRefreshToken, clearAdmobRefreshToken } from "@/lib/admob/connection";
import { ADMOB_SCOPE, admobAuthUrl, admobMissingEnv, clearAdmobAccessToken, exchangeAdmobCode, type FetchLike } from "@/lib/admob/oauth";
import { ADMOB_CACHE_MS, clearAdmobCache, readAdmobReport } from "@/lib/admob/read";
import { admobReportSpec, admobReportUrl, parseAdmobReport, type AdmobRow } from "@/lib/admob/report";
import { AD_UNLOCKS_CACHE_MS, AD_UNLOCKS_PATH, clearAdUnlocksCache, readCrazydramasAdUnlocks } from "@/lib/crazydramas/ad-unlocks";
import {
  adDaysIn,
  admobEarningsByDay,
  admobTotals,
  admobVsOurs,
  adUnlockFrame,
  adUnlockSpans,
  adUnlockTotals,
  afterAds,
  capShare,
  episodesPerViewer,
  failuresByReason,
  fmtEcpm,
  grantedByDay,
  microsToCents,
  viewersPerDay,
} from "@/lib/crazydramas/ad-unlocks-summary";
import { AdUnlocksReportSchema, type AdUnlockDay, type AdUnlocksReport } from "@/lib/crazydramas/ad-unlocks-types";
import { fakeCrazydramasTransport as fake } from "@/lib/crazydramas/fake";
import { fakeAdmobRows, fakeAdUnlocksReport } from "@/lib/crazydramas/fake-ad-unlocks";
import { DASH_TABS, parseDashTab } from "@/lib/crazydramas/stats-summary";
import type { CrazydramasStudioTransport } from "@/lib/crazydramas/transport";

const ENV_KEYS = ["DATA_SOURCE", "CRAZYDRAMAS_LIVE_READ", "CRAZYDRAMAS_STUDIO_TOKEN", "ADMOB_OAUTH_CLIENT_ID", "ADMOB_OAUTH_CLIENT_SECRET", "ADMOB_LIVE_READ", "ADMOB_PUBLISHER_ID"] as const;
let saved: Record<string, string | undefined> = {};
const tokenFile = path.join(process.cwd(), ".uploads", ADMOB_FILE);

beforeEach(async () => {
  fake.reset();
  clearAdUnlocksCache();
  clearAdmobCache();
  clearAdmobAccessToken();
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  await rm(tokenFile, { force: true });
});
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(tokenFile, { force: true });
});

// ---- the AdMob report ------------------------------------------------------------------------------------------

/** What networkReport:generate answers: a header, rows, a footer. */
const googleReport = [
  { header: { dateRange: { startDate: { year: 2026, month: 11, day: 8 }, endDate: { year: 2026, month: 11, day: 9 } }, localizationSettings: { currencyCode: "USD", languageCode: "en-US" } } },
  {
    row: {
      dimensionValues: { DATE: { value: "20261108" }, APP: { value: "ca-app-pub-5711183345077823~8049760182", displayLabel: "CrazyDramas" }, PLATFORM: { value: "iOS" } },
      metricValues: { ESTIMATED_EARNINGS: { microsValue: "2150000" }, IMPRESSIONS: { integerValue: "150" }, AD_REQUESTS: { integerValue: "170" }, MATCHED_REQUESTS: { integerValue: "160" }, MATCH_RATE: { doubleValue: 0.9411 }, IMPRESSION_RPM: { doubleValue: 14.33 }, CLICKS: { integerValue: "3" } },
    },
  },
  {
    row: {
      dimensionValues: { DATE: { value: "20261109" }, APP: { value: "ca-app-pub-5711183345077823~1212889096", displayLabel: "CrazyDramas" }, PLATFORM: { value: "Android" } },
      metricValues: { ESTIMATED_EARNINGS: { microsValue: "900000" }, IMPRESSIONS: { integerValue: "100" }, AD_REQUESTS: { integerValue: "120" }, MATCHED_REQUESTS: { integerValue: "108" }, MATCH_RATE: { doubleValue: 0.9 }, CLICKS: { integerValue: "1" } },
    },
  },
  { row: { dimensionValues: { DATE: { value: "not a day" } }, metricValues: {} } },
  { footer: { matchingRowCount: "2", warnings: [{ type: "DATA_DELAYED", description: "Data for the last day is not final." }] } },
];

test("the report request asks for Pacific days by day, app and platform, in US dollars", () => {
  const spec = admobReportSpec("2026-08-12", "2026-11-09").reportSpec;
  assert.deepEqual(spec.dateRange, { startDate: { year: 2026, month: 8, day: 12 }, endDate: { year: 2026, month: 11, day: 9 } });
  assert.deepEqual(spec.dimensions, ["DATE", "APP", "PLATFORM"]);
  assert.deepEqual(spec.metrics, ["ESTIMATED_EARNINGS", "IMPRESSIONS", "AD_REQUESTS", "MATCHED_REQUESTS", "MATCH_RATE", "IMPRESSION_RPM", "CLICKS"]);
  assert.equal(spec.localizationSettings.currencyCode, "USD");
  assert.equal(spec.timeZone, "America/Los_Angeles");
  assert.equal(admobReportUrl(), "https://admob.googleapis.com/v1/accounts/pub-5711183345077823/networkReport:generate");
  process.env.ADMOB_PUBLISHER_ID = "pub-1234567890";
  assert.equal(admobReportUrl(), "https://admob.googleapis.com/v1/accounts/pub-1234567890/networkReport:generate");
  process.env.ADMOB_PUBLISHER_ID = "not-an-id";
  assert.match(admobReportUrl(), /pub-5711183345077823/);
});

test("the report's parse reads every row, micros as money, strings as counts, and keeps the footer's warnings", () => {
  const parsed = parseAdmobReport(JSON.parse(JSON.stringify(googleReport)));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.currency, "USD");
  assert.deepEqual(parsed.warnings, ["Data for the last day is not final."]);
  assert.equal(parsed.rows.length, 2, "the row with no readable day is skipped");
  assert.deepEqual(parsed.rows[0], {
    day: "2026-11-08", app_id: "ca-app-pub-5711183345077823~8049760182", app_name: "CrazyDramas", platform: "ios",
    earnings_micros: 2_150_000, impressions: 150, ad_requests: 170, matched_requests: 160, match_rate: 0.9411, impression_rpm: 14.33, clicks: 3,
  });
  assert.equal(parsed.rows[1].platform, "android");
  assert.equal(parsed.rows[1].impression_rpm, null);
});

test("the report's parse turns Google's errors into its message", () => {
  assert.deepEqual(parseAdmobReport({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }), { ok: false, error: "The caller does not have permission" });
  assert.deepEqual(parseAdmobReport([{ header: {} }, { error: { message: "Backend error" } }]), { ok: false, error: "Backend error" });
  assert.equal(parseAdmobReport(null).ok, false);
  assert.deepEqual(parseAdmobReport([]), { ok: true, rows: [], currency: null, warnings: [] });
});

// ---- Google OAuth ----------------------------------------------------------------------------------------------

type Call = { url: string; body: string };
function google(answers: Record<string, () => { status: number; body: unknown }>): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string, init: { body?: string }) => {
    calls.push({ url, body: init.body ?? "" });
    const key = Object.keys(answers).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected ${url}`);
    const a = answers[key]();
    return { status: a.status, text: async () => JSON.stringify(a.body) };
  }) as unknown as FetchLike & { calls: Call[] };
  f.calls = calls;
  return f;
}

test("Connect sends Google read-only AdMob, offline access, the consent screen and the state", () => {
  assert.deepEqual(admobMissingEnv(), ["ADMOB_OAUTH_CLIENT_ID", "ADMOB_OAUTH_CLIENT_SECRET"]);
  assert.throws(() => admobAuthUrl("http://localhost:3200/api/admin/admob/callback", "s1"));
  process.env.ADMOB_OAUTH_CLIENT_ID = "client-1.apps.googleusercontent.com";
  process.env.ADMOB_OAUTH_CLIENT_SECRET = "secret-1";
  assert.deepEqual(admobMissingEnv(), []);
  const url = new URL(admobAuthUrl("http://localhost:3200/api/admin/admob/callback", "s1"));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("scope"), ADMOB_SCOPE);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("state"), "s1");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:3200/api/admin/admob/callback");
  assert.ok(!url.toString().includes("secret-1"), "the secret never goes in the address");
});

test("the callback's exchange keeps the refresh token and refuses an answer without one", async () => {
  process.env.ADMOB_OAUTH_CLIENT_ID = "client-1";
  process.env.ADMOB_OAUTH_CLIENT_SECRET = "secret-1";
  const ok = google({ "oauth2.googleapis.com/token": () => ({ status: 200, body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3599, scope: ADMOB_SCOPE } }) });
  assert.deepEqual(await exchangeAdmobCode("code-1", "http://localhost:3200/api/admin/admob/callback", ok), { refresh_token: "rt-1" });
  assert.match(ok.calls[0].body, /grant_type=authorization_code/);
  assert.match(ok.calls[0].body, /code=code-1/);
  const noRefresh = google({ "oauth2.googleapis.com/token": () => ({ status: 200, body: { access_token: "at-1", expires_in: 3599, scope: ADMOB_SCOPE } }) });
  await assert.rejects(exchangeAdmobCode("code-1", "x", noRefresh), /no refresh token/);
  const refused = google({ "oauth2.googleapis.com/token": () => ({ status: 400, body: { error: "invalid_grant", error_description: "Bad Request" } }) });
  await assert.rejects(exchangeAdmobCode("code-1", "x", refused), /invalid_grant: Bad Request/);
});

test("the connection is a shared setting: who and when are readable, the token never is", async () => {
  assert.deepEqual(await readAdmobConnection(), { connected: false, connected_at: null, connected_by: null });
  await saveAdmobRefreshToken("rt-secret", "Ruobin");
  const c = await readAdmobConnection();
  assert.equal(c.connected, true);
  assert.equal(c.connected_by, "Ruobin");
  assert.ok(!JSON.stringify(c).includes("rt-secret"));
  await clearAdmobRefreshToken("Ruobin");
  assert.equal((await readAdmobConnection()).connected, false);
});

// ---- the AdMob read --------------------------------------------------------------------------------------------

const SPAN = { from: "2026-11-08", to: "2026-11-09" };

test("fixture mode reads invented AdMob rows and keeps them fifteen minutes", async () => {
  let now = Date.parse("2026-11-09T20:00:00Z");
  const a = await readAdmobReport({ from: "2026-08-12", to: "2026-11-09" }, { now: () => now });
  assert.ok(a.ok && a.mode === "fake");
  const b = await readAdmobReport({ from: "2026-08-12", to: "2026-11-09" }, { now: () => now });
  assert.equal(a, b, "kept");
  now += ADMOB_CACHE_MS + 1;
  const c = await readAdmobReport({ from: "2026-08-12", to: "2026-11-09" }, { now: () => now });
  assert.notEqual(a, c, "read again after fifteen minutes");
});

test("live without the OAuth client names the variables; without a token it is not connected", async () => {
  const none = await readAdmobReport(SPAN, { mode: "live" });
  assert.equal(none.ok, false);
  assert.equal(!none.ok && none.code, "not_configured");
  assert.deepEqual(!none.ok && none.code === "not_configured" && none.missing, ["ADMOB_OAUTH_CLIENT_ID", "ADMOB_OAUTH_CLIENT_SECRET"]);
  process.env.ADMOB_OAUTH_CLIENT_ID = "client-1";
  process.env.ADMOB_OAUTH_CLIENT_SECRET = "secret-1";
  const off = await readAdmobReport(SPAN, { mode: "live" });
  assert.equal(!off.ok && off.code, "not_connected");
});

test("live reads trade the stored token for an access token once, read the report and keep it", async () => {
  process.env.ADMOB_OAUTH_CLIENT_ID = "client-1";
  process.env.ADMOB_OAUTH_CLIENT_SECRET = "secret-1";
  await saveAdmobRefreshToken("rt-1", "Ruobin");
  const f = google({
    "oauth2.googleapis.com/token": () => ({ status: 200, body: { access_token: "at-1", expires_in: 3599 } }),
    "networkReport:generate": () => ({ status: 200, body: googleReport }),
  });
  let now = Date.parse("2026-11-09T20:00:00Z");
  const read = await readAdmobReport(SPAN, { mode: "live", fetch: f, now: () => now });
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.equal(read.rows.length, 2);
  assert.equal(read.connection?.connected_by, "Ruobin");
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].body, /grant_type=refresh_token/);
  const sent = JSON.parse(f.calls[1].body);
  assert.deepEqual(sent.reportSpec.dateRange.startDate, { year: 2026, month: 11, day: 8 });
  // Kept fifteen minutes; a fresh read asks for the report again but reuses the access token.
  assert.equal(await readAdmobReport(SPAN, { mode: "live", fetch: f, now: () => now }), read);
  now += 60_000;
  await readAdmobReport(SPAN, { mode: "live", fetch: f, now: () => now, fresh: true });
  assert.equal(f.calls.filter((c) => c.url.includes("token")).length, 1, "the access token is kept until it expires");
  assert.equal(f.calls.filter((c) => c.url.includes("networkReport")).length, 2);
});

test("Google's refusals come back as a message, a withdrawn token as 'connect again', never with a token", async () => {
  process.env.ADMOB_OAUTH_CLIENT_ID = "client-1";
  process.env.ADMOB_OAUTH_CLIENT_SECRET = "secret-1";
  await saveAdmobRefreshToken("rt-secret", "Ruobin");
  const denied = google({
    "oauth2.googleapis.com/token": () => ({ status: 200, body: { access_token: "at-secret", expires_in: 3599 } }),
    "networkReport:generate": () => ({ status: 403, body: { error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } } }),
  });
  const r = await readAdmobReport(SPAN, { mode: "live", fetch: denied });
  assert.equal(!r.ok && r.code, "google_error");
  assert.equal(!r.ok && r.error, "The caller does not have permission");
  assert.ok(!JSON.stringify(r).includes("secret"));
  clearAdmobAccessToken();
  const revoked = google({ "oauth2.googleapis.com/token": () => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }) });
  const g = await readAdmobReport(SPAN, { mode: "live", fetch: revoked, fresh: true });
  assert.equal(!g.ok && g.code, "revoked");
  assert.match(!g.ok ? g.error : "", /Connect again/);
  assert.ok(!JSON.stringify(g).includes("secret"));
});

// ---- crazydramas' report ---------------------------------------------------------------------------------------

function stub(status: number, body: unknown): CrazydramasStudioTransport & { calls: { method: string; path: string; body: unknown }[] } {
  const t = {
    mode: "live" as const,
    calls: [] as { method: string; path: string; body: unknown }[],
    async request(method: "GET" | "PUT" | "POST", p: string, b?: unknown) {
      t.calls.push({ method, path: p, body: b });
      return { status, body: JSON.parse(JSON.stringify(body)) };
    },
    async putUploadChunk(): Promise<never> {
      throw new Error("not used");
    },
    async checkImage() {
      return { ok: false, status: null, content_type: null, reason: "not used" } as never;
    },
  };
  return t;
}

const NOW = new Date("2026-11-09T20:00:00Z");
const report = (): AdUnlocksReport => AdUnlocksReportSchema.parse(fakeAdUnlocksReport([{ slug: "a", title: "A", status: "published" }, { slug: "b", title: "B", status: "published" }, { slug: "mock-x", title: "X", status: "published" }], NOW));

test("the fake report parses through the whitelist; another version or shape is refused whole", () => {
  const r = report();
  assert.equal(r.window.to, "2026-11-09");
  assert.equal(r.window.from, "2026-08-12");
  assert.ok(r.days.length > 0);
  assert.deepEqual(r.series.map((s) => s.slug).sort(), ["a", "b"], "mock series left out");
  const raw = fakeAdUnlocksReport([], NOW) as unknown as Record<string, unknown>;
  assert.equal(AdUnlocksReportSchema.safeParse({ ...raw, version: 2 }).success, false);
  assert.equal(AdUnlocksReportSchema.safeParse({ ...raw, days: [{ day: "2026-11-09", platform: "tv" }] }).success, false);
  // A refusal reason crazydramas leaves out reads zero; an unknown field is dropped.
  const day = { day: "2026-11-09", platform: "ios", provider: "admob", opened: 3, granted: 2, refused: { cap: 1 }, unfinished: 0, viewers: 2, granted_viewers: 2, capped_viewers: 0, ssv: 2, client: 0, extra: true };
  const parsed = AdUnlocksReportSchema.parse({ ...raw, days: [day] });
  assert.deepEqual(parsed.days[0].refused, { too_fast: 0, expired: 0, cap: 1, duplicate: 0, already_open: 0, unknown: 0 });
  assert.ok(!("extra" in parsed.days[0]));
});

test("fixture mode reads the fake's ad-unlocks report through the Studio API route, the team in the body", async () => {
  const read = await readCrazydramasAdUnlocks({ teamEmails: ["b@x.com", "a@x.com"] });
  assert.ok(read.ok, JSON.stringify(read));
  if (!read.ok) return;
  assert.equal(read.mode, "fake");
  assert.deepEqual(read.team_emails, ["a@x.com", "b@x.com"]);
  const s = stub(200, fakeAdUnlocksReport([], NOW));
  const live = await readCrazydramasAdUnlocks({ transport: s, teamEmails: ["a@x.com"] });
  assert.ok(live.ok);
  assert.deepEqual(s.calls, [{ method: "POST", path: AD_UNLOCKS_PATH, body: { team_emails: ["a@x.com"] } }]);
});

test("a crazydramas without the route is 'not deployed'; other answers keep crazydramas' code; reads are kept five minutes", async () => {
  const missing = await readCrazydramasAdUnlocks({ transport: stub(404, { error: "No such route" }), teamEmails: [] });
  assert.deepEqual(missing, { ok: false, code: "not_deployed", error: "crazydramas has no ad-unlocks report yet.", mode: "live" });
  const refused = await readCrazydramasAdUnlocks({ transport: stub(401, { code: "unauthorized", error: "Bad token" }), teamEmails: [] });
  assert.deepEqual(refused, { ok: false, code: "unauthorized", error: "Bad token", mode: "live" });
  const bad = await readCrazydramasAdUnlocks({ transport: stub(200, { version: 9 }), teamEmails: [] });
  assert.equal(!bad.ok && bad.code, "bad_response");
  let now = 1_000_000;
  const s = stub(200, fakeAdUnlocksReport([], NOW));
  const a = await readCrazydramasAdUnlocks({ transport: s, teamEmails: [], now: () => now });
  assert.equal(await readCrazydramasAdUnlocks({ transport: s, teamEmails: [], now: () => now }), a);
  now += AD_UNLOCKS_CACHE_MS + 1;
  await readCrazydramasAdUnlocks({ transport: s, teamEmails: [], now: () => now });
  assert.equal(s.calls.length, 2);
});

// ---- the sums --------------------------------------------------------------------------------------------------

const day = (d: string, platform: AdUnlockDay["platform"], over: Partial<AdUnlockDay> = {}): AdUnlockDay => ({
  day: d, platform, provider: platform === "web" ? "house" : "admob", opened: 10, granted: 7, refused: { too_fast: 1, expired: 0, cap: 0, duplicate: 0, already_open: 0, unknown: 0 }, unfinished: 2,
  viewers: 5, granted_viewers: 4, capped_viewers: 1, ssv: 6, client: 1, ...over,
});
const arow = (d: string, platform: AdmobRow["platform"], over: Partial<AdmobRow> = {}): AdmobRow => ({
  day: d, app_id: "app", app_name: null, platform, earnings_micros: 100_000, impressions: 8, ad_requests: 12, matched_requests: 9, match_rate: 0.75, impression_rpm: 12.5, clicks: 0, ...over,
});

test("totals add counts, keep viewers as viewer-days, and divide by them", () => {
  const t = adUnlockTotals([day("2026-11-08", "ios"), day("2026-11-09", "ios"), day("2026-11-09", "web", { granted: 3, granted_viewers: 2, capped_viewers: 0 })]);
  assert.equal(t.granted, 17);
  assert.equal(t.opened, 30);
  assert.equal(t.refused_total, 3);
  assert.equal(t.refused.too_fast, 3);
  assert.equal(t.granted_viewer_days, 10);
  assert.equal(t.by_platform.ios.granted, 14);
  assert.equal(t.by_platform.web.granted, 3);
  assert.equal(episodesPerViewer(t), 1.7);
  assert.equal(capShare(t), 0.2);
  assert.equal(viewersPerDay(t, { from: "2026-11-08", to: "2026-11-09" }), 5);
  assert.equal(episodesPerViewer(adUnlockTotals([])), null);
  assert.equal(capShare(adUnlockTotals([])), null);
});

test("AdMob totals: money from micros, eCPM and match rate from the sums", () => {
  const t = admobTotals([arow("2026-11-09", "ios", { earnings_micros: 2_000_000, impressions: 100, ad_requests: 120, matched_requests: 100 }), arow("2026-11-09", "android", { earnings_micros: 1_000_000, impressions: 100, ad_requests: 80, matched_requests: 80 })]);
  assert.equal(microsToCents(t.earnings_micros), 300);
  assert.equal(t.ecpm_micros, 15_000_000);
  assert.equal(fmtEcpm(t.ecpm_micros), "$15.00");
  assert.equal(t.match_rate, 0.9);
  assert.equal(admobTotals([]).ecpm_micros, null);
  assert.equal(fmtEcpm(null), "–");
  assert.deepEqual(admobEarningsByDay([arow("2026-11-09", "ios", { earnings_micros: 1_234_567 })], { from: "2026-11-08", to: "2026-11-09" }), [{ day: "2026-11-08", value: 0 }, { day: "2026-11-09", value: 123 }]);
});

test("AdMob next to ours: newest day first, iPhone then Android, web and other providers left out, the gap AdMob minus started", () => {
  const ours = [day("2026-11-08", "ios"), day("2026-11-09", "android"), day("2026-11-09", "web"), day("2026-11-09", "ios", { provider: "house" })];
  const admob = [arow("2026-11-09", "android", { impressions: 10 }), arow("2026-11-09", "ios", { impressions: 4 }), arow("2026-11-07", "ios")];
  const rows = admobVsOurs(ours, admob, { from: "2026-11-08", to: "2026-11-09" });
  assert.deepEqual(rows.map((r) => `${r.day} ${r.platform}`), ["2026-11-09 ios", "2026-11-09 android", "2026-11-08 ios"]);
  assert.equal(rows[0].ours, null, "a house ad on the phone is not AdMob's");
  assert.equal(rows[0].gap, null);
  assert.deepEqual(rows[1].ours, { opened: 10, granted: 7, unfinished: 2, started: 9 });
  assert.equal(rows[1].gap, 1);
  assert.equal(rows[2].admob, null);
  assert.deepEqual(admobVsOurs(null, null, { from: "2026-11-08", to: "2026-11-09" }), []);
});

test("failures by reason, the chart's stacks and the after panel", () => {
  const f = failuresByReason(
    [{ day: "2026-11-09", platform: "ios", reason: "no_fill", count: 2 }, { day: "2026-11-09", platform: "android", reason: "no_fill", count: 3 }, { day: "2026-11-09", platform: "ios", reason: "closed", count: 9 }, { day: "2026-11-01", platform: "ios", reason: "error", count: 50 }],
    { from: "2026-11-08", to: "2026-11-09" },
  );
  assert.deepEqual(f, [{ reason: "closed", count: 9, by_platform: { ios: 9 } }, { reason: "no_fill", count: 5, by_platform: { ios: 2, android: 3 } }]);
  const stacks = grantedByDay({ days: [day("2026-11-09", "ios"), day("2026-11-09", "web", { granted: 2 })] }, { from: "2026-11-08", to: "2026-11-09" });
  assert.deepEqual(stacks, [{ day: "2026-11-08", values: { ios: 0, android: 0, web: 0 } }, { day: "2026-11-09", values: { ios: 7, android: 0, web: 2 } }]);
  assert.equal(afterAds({ ad_viewers: 200, bought_after: 9, revenue_cents_after: 5391, bought_before_only: 2 }).share, 0.045);
  assert.equal(afterAds({ ad_viewers: 0, bought_after: 0, revenue_cents_after: 0, bought_before_only: 0 }).share, null);
});

test("the frame starts on the first day either source has ads; periods and the period before are cut from it", () => {
  const r = report();
  const frame = adUnlockFrame(r, null, "2026-11-09");
  assert.equal(frame.to, "2026-11-09");
  assert.equal(frame.from, "2026-10-21", "the fake's ads start 20 days before today");
  assert.equal(adUnlockFrame(null, [arow("2026-11-01", "ios")], "2026-11-09").from, "2026-11-01");
  assert.deepEqual(adUnlockFrame(null, null, "2026-11-09"), { from: "2026-11-09", to: "2026-11-09" });
  const week = adUnlockSpans(frame, "7d");
  assert.deepEqual(week.span, { from: "2026-11-03", to: "2026-11-09" });
  assert.deepEqual(week.prev, { from: "2026-10-27", to: "2026-11-02" });
  const all = adUnlockSpans(frame, "all");
  assert.deepEqual(all.span, frame);
  assert.equal(all.prev, null);
  const yesterday = adUnlockSpans(frame, "yesterday");
  assert.deepEqual(yesterday.span, { from: "2026-11-08", to: "2026-11-08" });
  assert.equal(yesterday.chart.to, "2026-11-08");
  // 30 days asks for more than there is: the period starts on the first ad, nothing before to compare with.
  const month = adUnlockSpans(frame, "30d");
  assert.equal(month.span.from, "2026-10-21");
  assert.equal(month.prev, null);
  assert.ok(adDaysIn(r, week.span).every((d) => d.day >= "2026-11-03"));
});

test("the fakes agree: AdMob's impressions sit at or under our started ads, day by day", () => {
  const r = report();
  const rows = fakeAdmobRows(r.window.from, r.window.to, NOW);
  const cmp = admobVsOurs(r.days, rows, { from: r.window.from, to: r.window.to });
  assert.ok(cmp.length > 0);
  for (const c of cmp) {
    assert.ok(c.admob && c.ours, `${c.day} ${c.platform} has both`);
    assert.ok(c.gap! <= 0 && c.gap! >= -c.ours!.unfinished);
  }
});

// ---- the tab ---------------------------------------------------------------------------------------------------

test("the Ad unlocks tab is its own tab, apart from TikTok's and Meta's ads", () => {
  assert.ok((DASH_TABS as readonly string[]).includes("adunlocks"));
  assert.equal(parseDashTab("adunlocks"), "adunlocks");
  assert.equal(parseDashTab(["adunlocks"]), "adunlocks");
  assert.equal(parseDashTab("ads"), "ads");
  assert.equal(parseDashTab("ad-unlocks"), "overview");
});
