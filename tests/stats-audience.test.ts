// Audience by age (2026-10-01): TikTok's AUDIENCE report by campaign and age, read per ad account with that
// account's own token over spans of at most 30 days, and summed into each campaign's age split and all campaigns'.
// Nothing here leaves the process.

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ageLabel, audienceTable } from "@/lib/crazydramas/stats-audience";
import type { LaunchRun } from "@/lib/launch/types";
import { ageCellsFromRows, clearAudienceCache, readTikTokAudience } from "@/lib/tiktok/audience";
import { fakeTransport } from "@/lib/tiktok/fake";
import type { TikTokResponse, TikTokTransport } from "@/lib/tiktok/transport";

beforeEach(() => clearAudienceCache());

type Call = { path: string; token: string; params: Record<string, string | number> };
function stub(answer: (c: Call) => TikTokResponse, mode: TikTokTransport["mode"] = "production"): TikTokTransport & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    mode, calls,
    async get(path, token, params = {}) { const c = { path, token, params }; calls.push(c); return answer(c); },
    async post() { throw new Error("no writes"); },
    async upload() { throw new Error("no writes"); },
  };
}
const idsOf = (c: Call) => JSON.parse(JSON.parse(String(c.params.filtering))[0].filter_value) as string[];
const row = (campaign: string, age: string, spend: number, impressions = 0, clicks = 0, conversion = 0) => ({ dimensions: { campaign_id: campaign, age }, metrics: { spend: String(spend), impressions, clicks, conversion } });

function run(id: string, campaigns: [string, string][], mode: LaunchRun["mode"] = "production"): LaunchRun {
  return {
    id, external_id: `lr_${id}`, producer_id: "p", mode, created_at: "2026-09-20T00:00:00.000Z",
    draft: { provider: "tiktok", name: `Launch ${id}`, content: [] },
    campaigns: campaigns.map(([advertiser, campaign], i) => ({ id: `${id}-c${i}`, run_id: id, index: i, advertiser_id: advertiser, name: `c${i}`, content: [], state: { campaign_id: campaign }, snapshot: null })),
  } as unknown as LaunchRun;
}

test("TikTok's age groups read as people say them", () => {
  assert.deepEqual(["AGE_13_17", "AGE_25_34", "AGE_55_100", "NONE"].map((g) => ageLabel(g as never, "Unknown")), ["13–17", "25–34", "55+", "Unknown"]);
});

test("the report's rows add up by campaign and age; spend comes as text", () => {
  const cells = ageCellsFromRows([row("c1", "AGE_13_17", 1.25, 100, 3, 1), row("c1", "AGE_13_17", 0.75, 50, 1, 0), row("c1", "AGE_25_34", 2, 80, 2, 1), { dimensions: { campaign_id: "" }, metrics: {} }]);
  assert.deepEqual(cells.c1.AGE_13_17, { spend: 2, impressions: 150, clicks: 4, conversion: 1 });
  assert.equal(cells.c1.AGE_25_34.spend, 2);
});

test("the read: per ad account with its own token, AUDIENCE by campaign and age, 30-day spans; a failing account is named and unknown", async () => {
  const runs = [run("r1", [["adv-A", "c1"], ["adv-A", "c2"]]), run("r2", [["adv-B", "c3"]]), run("fake", [["adv-A", "cf"]], "fake")];
  const tt = stub((c) => {
    if (c.params.advertiser_id === "adv-B") return { code: 40001, message: "No permission for this ad account" };
    const ids = idsOf(c);
    return { code: 0, message: "OK", data: { list: ids.includes("c1") ? [row("c1", "AGE_13_17", 6), row("c1", "AGE_25_34", 4)] : [], page_info: { total_page: 1 } } };
  });
  const read = await readTikTokAudience(runs, { from: "2026-08-01", to: "2026-09-14" }, { transport: tt, tokenFor: (a) => ({ "adv-A": "tok-A", "adv-B": "tok-B" })[a] ?? null });
  assert.ok(tt.calls.every((c) => c.path === "/report/integrated/get/" && c.params.report_type === "AUDIENCE" && c.params.data_level === "AUCTION_CAMPAIGN" && c.params.dimensions === JSON.stringify(["campaign_id", "age"])));
  assert.deepEqual(tt.calls.map((c) => [c.params.advertiser_id, c.token, c.params.start_date, c.params.end_date]), [
    ["adv-A", "tok-A", "2026-08-01", "2026-08-30"],
    ["adv-A", "tok-A", "2026-08-31", "2026-09-14"],
    ["adv-B", "tok-B", "2026-08-01", "2026-08-30"],
  ]);
  assert.ok(!tt.calls.some((c) => idsOf(c).includes("cf")), "no campaign of another environment");
  assert.deepEqual(read.failed, [{ advertiser_id: "adv-B", error: "No permission for this ad account" }]);
  assert.deepEqual(read.covered.sort(), ["c1", "c2"]);
  assert.equal(read.campaigns.c1.AGE_13_17.spend, 12, "both spans summed");

  const table = audienceTable(read, [{ key: "k1", campaign_id: "c1", name: "One" }, { key: "k2", campaign_id: "c2", name: "Two" }, { key: "k3", campaign_id: "c3", name: "Three" }, { key: "x", campaign_id: null, name: "No id" }], "All campaigns");
  assert.deepEqual(table.rows.map((r) => [r.name, r.known]), [["One", true], ["Three", false]], "a campaign with no spend is left out; an unanswered one stays, unknown");
  assert.equal(table.unknown, 1);
  assert.equal(table.total.spend_cents, 2000);
  assert.equal(table.total.ages.AGE_13_17.share, 0.6);
  assert.equal(table.rows[1].ages.AGE_13_17.share, null, "unknown, never zero");
  assert.ok(!table.groups.includes("NONE"), "no Unknown column when no campaign has any");
});

test("the fake transport answers the age split by campaign, shares that add up to the campaign", async () => {
  const original = fakeTransport.get;
  try {
    fakeTransport.get = async (p, _t, params) => {
      if (p !== "/report/integrated/get/") return { code: 1, message: "not modelled" };
      assert.equal(params?.report_type, "AUDIENCE");
      return { code: 0, message: "OK", data: { list: [row("c9", "AGE_13_17", 3, 300, 6, 1), row("c9", "AGE_35_44", 1, 100, 2, 0), row("c9", "NONE", 1, 10, 0, 0)], page_info: { total_page: 1 } } };
    };
    const read = await readTikTokAudience([run("r", [["adv", "c9"]], "fake")], { from: "2026-09-25", to: "2026-09-30" }, { transport: fakeTransport, tokenFor: () => "fake-token" });
    const table = audienceTable(read, [{ key: "k", campaign_id: "c9", name: "Nine" }], "All");
    assert.equal(table.total.ages.AGE_13_17.share, 0.6);
    assert.ok(table.groups.includes("NONE"), "Unknown shown when TikTok has some");
  } finally {
    fakeTransport.get = original;
  }
});
