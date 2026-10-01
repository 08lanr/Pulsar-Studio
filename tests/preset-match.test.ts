import assert from "node:assert/strict";
import { test } from "node:test";
import { builtInPresetOf } from "@/lib/tiktok/preset-match";
import { defaultSalesLaunchSettings, defaultWebsitePurchaseSettings } from "@/lib/tiktok/settings";

// 2026-10-01: choosing "(default) · Website purchases" left the preset menu on "Custom", because the menu still
// required comments off after both defaults turned comments on (8746737).
test("each built-in default reads as itself in the preset menu, paused or live", () => {
  for (const start_paused of [false, true]) {
    assert.equal(builtInPresetOf({ ...defaultWebsitePurchaseSettings(), start_paused }), "__default_website__");
    assert.equal(builtInPresetOf({ ...defaultSalesLaunchSettings(), start_paused }), "__default_sales__");
  }
});

test("a changed field reads as Custom", () => {
  const website = defaultWebsitePurchaseSettings();
  assert.equal(builtInPresetOf({ ...website, comments_disabled: !website.comments_disabled }), "");
  assert.equal(builtInPresetOf({ ...website, duplicate_copies: 1 }), "");
  const sales = defaultSalesLaunchSettings();
  assert.equal(builtInPresetOf({ ...sales, comments_disabled: !sales.comments_disabled }), "");
  assert.equal(builtInPresetOf({ ...sales, bid_usd: 0.3 }), "");
});
