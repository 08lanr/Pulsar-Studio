import assert from "node:assert/strict";
import { test } from "node:test";
import { accountFilterCounts, accountMatches, type AccountScan } from "../lib/launch/account-filters";
import type { LaunchConnection } from "../lib/launch/types";

const connection = (id: string): LaunchConnection => ({ id, producer_id: "p", provider: "tiktok", advertiser_id: id, name: id, currency: "USD", timezone: "UTC", page_id: null, instagram_id: null, business_id: "bc", assigned_by: "staff", verified_at: "", enabled: true });
test("account filters count scanned history and exclude failed or missing scans", () => {
  const connections = ["fresh", "used", "failed", "pending"].map(connection);
  const scans: Record<string, AccountScan> = {
    fresh: { connection_id: "fresh", accountId: "fresh", campaigns: 0, active: 0, reach: 0, sales: 0, leadgen: 0, geoCountries: 33 },
    used: { connection_id: "used", accountId: "used", campaigns: 4, active: 1, reach: 1, sales: 2, leadgen: 1, geoCountries: 66 },
    failed: { connection_id: "failed", accountId: "failed", campaigns: 0, active: 0, error: "unavailable" },
  };
  const counts = accountFilterCounts(connections, scans, 65);
  assert.equal(counts.all, 4);
  assert.equal(counts.never, 1);
  assert.equal(counts.inactive, 1);
  assert.equal(counts.warmed, 1);
  assert.equal(counts.unwarmed, 1);
  assert.equal(counts.full, 1);
  assert.equal(counts.limited, 1);
  assert.equal(counts.sales, 1);
  assert.equal(counts.nosales, 1);
  assert.equal(counts.leadgen, 1);
  assert.equal(accountMatches("noleadgen", scans.failed, 65), false);
  assert.equal(accountMatches("noleadgen", undefined, 65), false);
});
