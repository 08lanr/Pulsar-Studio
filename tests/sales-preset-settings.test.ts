import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { defaultLaunchSettings, defaultSalesLaunchSettings, normalizeLaunchSettings } from "@/lib/tiktok/settings";
import { producer, staff } from "./seed-minute";

beforeEach(() => { process.env.FIXTURE_SEED = "empty"; resetFixtureStore(); });
afterEach(() => { resetFixtureStore(); });

test("Sales preset save and reload preserves its objective and frozen Instant Page design while old settings remain Traffic", async () => {
  const sales = defaultSalesLaunchSettings();
  const design = { ...sales.instant_page_template!, name: "Black page", button_text: "Read now", background: "black" as const, hand_cursor: true };
  const saved = await fixtureData.saveLaunchPreset(staff(), { name: "Sales black page", settings: { ...sales, instant_page_template: design } });
  const loaded = (await fixtureData.listLaunchPresets(producer())).find(preset => preset.id === saved.id);
  assert.ok(loaded);
  const normalized = normalizeLaunchSettings(loaded.settings);
  assert.equal(normalized.objective_type, "WEB_CONVERSIONS");
  assert.deepEqual(normalized.instant_page_template, design);
  assert.equal(normalized.optimization_goal, "CONVERT");
  assert.equal(normalized.bid_usd, 0.2);
  const legacy = normalizeLaunchSettings({ location_ids: ["6252001"] });
  assert.deepEqual(legacy, defaultLaunchSettings());
  assert.equal(legacy.objective_type, undefined);
  assert.equal(legacy.instant_page_template, undefined);
});
