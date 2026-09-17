import assert from "node:assert/strict";
import { test } from "node:test";
import { eligibleMetaAssignment, eligibleTikTokBcAccount } from "../lib/launch/account-authority";
import type { LaunchConnection } from "../lib/launch/types";

test("TikTok BC accounts require this company's BC, current authorization, ready status, and a token", () => {
  const account = { id: "12345", bcId: "bc-own", status: "STATUS_ENABLE" };
  assert.equal(eligibleTikTokBcAccount("bc-own", ["bc-own"], account, true), true);
  assert.equal(eligibleTikTokBcAccount("bc-other", ["bc-own"], account, true), false);
  assert.equal(eligibleTikTokBcAccount("bc-own", ["bc-other"], account, true), false);
  assert.equal(eligibleTikTokBcAccount("bc-own", ["bc-own"], { ...account, status: "STATUS_DISABLE" }, true), false);
  assert.equal(eligibleTikTokBcAccount("bc-own", ["bc-own"], account, false), false);
});

test("Meta assignment requires the selected Page and Instagram identity to remain accessible", () => {
  const saved: LaunchConnection = { id: "id", producer_id: "producer", provider: "meta", advertiser_id: "act_12345", name: "Account", currency: "USD", timezone: "", page_id: "page-1", instagram_id: "ig-1", business_id: "business", assigned_by: "staff", verified_at: "", enabled: true };
  const inventory = { accounts: [{ id: "act_12345", name: "Account", account_status: 1, currency: "USD", timezone_name: "" }], pages: [{ id: "page-1", name: "Page" }], instagram: [{ id: "ig-1", account_id: "act_12345", username: "ig" }] };
  assert.equal(eligibleMetaAssignment(saved, inventory), true);
  assert.equal(eligibleMetaAssignment(saved, { ...inventory, pages: [{ id: "page-other", name: "Other Page" }] }), false);
  assert.equal(eligibleMetaAssignment(saved, { ...inventory, instagram: [{ id: "ig-1", account_id: "act_foreign", username: "ig" }] }), false);
  assert.equal(eligibleMetaAssignment(saved, { ...inventory, accounts: [{ ...inventory.accounts[0], account_status: 2 }] }), false);
});
