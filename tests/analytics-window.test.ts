import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { demoTitleId } from "@/data/fixture/demo-catalog";
import { spendInPeriod, titleHealth } from "@/lib/analytics/health";
import { parseWindow } from "@/lib/analytics/types";

const producer = () => fixtureSession("producer");
const T8 = demoTitleId(8); // Rise of the Son-in-Law: linked, reporting, one finished round

test("parseWindow accepts an ordered ISO pair and refuses anything else", () => {
  assert.deepEqual(parseWindow("2026-08-01", "2026-08-31"), { from: "2026-08-01", to: "2026-08-31" });
  assert.equal(parseWindow("2026-08-31", "2026-08-01"), null);
  assert.equal(parseWindow("2026-02-30", "2026-03-01"), null);
  assert.equal(parseWindow("2026-08-01", undefined), null);
  assert.equal(parseWindow("2024-01-01", "2026-01-01"), null, "longer than a year");
});

test("a custom window becomes the reporting period, clamped to the data, with a same-length previous period", async () => {
  resetFixtureStore("demo");
  const rec = await fixtureData.getTitleAnalytics(producer(), T8, { window: { from: "2026-08-15", to: "2026-08-28" } });
  assert.equal(rec.range, "custom");
  assert.deepEqual([rec.period!.from, rec.period!.to, rec.period!.days], ["2026-08-15", "2026-08-28", 14]);
  assert.ok(rec.overview, "the record has data");
  assert.deepEqual([rec.overview!.previous_period!.from, rec.overview!.previous_period!.to], ["2026-08-01", "2026-08-14"]);
  const late = await fixtureData.getTitleAnalytics(producer(), T8, { window: { from: "2026-09-01", to: "2026-12-31" } });
  assert.equal(late.period!.to, late.freshness.data_through, "the window is clamped to the last delivered day");
  const preset = await fixtureData.getTitleAnalytics(producer(), T8, { range: "30d" });
  assert.equal(preset.range, "30d");
});

test("title health reads trend, catalog position and blended ROAS without inventing values", async () => {
  resetFixtureStore("demo");
  const rec = await fixtureData.getTitleAnalytics(producer(), T8, { range: "30d" });
  const catalog = await fixtureData.listTitlePerformance(producer(), { range: "30d" });
  const h = titleHealth(rec, catalog)!;
  assert.ok(h, "health is computed when the record has data");
  assert.equal(h.rows.length, 5);
  const byKey = Object.fromEntries(h.rows.map((r) => [r.key, r]));
  assert.equal(byKey.revenue.tone === "na", false, "revenue has a previous period to compare with");
  assert.ok(byKey.conversion.verdict_key === "an.health.verdict.below", "0.45% is below the catalog median");
  const spend = spendInPeriod(rec);
  assert.ok(spend != null && spend > 0, "round 1 spend overlaps the period");
  assert.ok(byKey.roas.value != null && byKey.roas.value > 0);
  assert.equal(byKey.roas.note_key, "an.health.note.roas");
  // A title with no ad results reports no ROAS rather than 0.
  const t7 = await fixtureData.getTitleAnalytics(producer(), demoTitleId(7), { range: "30d" });
  const h7 = titleHealth(t7, catalog)!;
  assert.equal(h7.rows.find((r) => r.key === "roas")!.value, null);
  assert.equal(h7.rows.find((r) => r.key === "roas")!.note_key, "an.health.note.noSpend");
  // No data → no panel.
  const t13 = await fixtureData.getTitleAnalytics(producer(), demoTitleId(13), { range: "30d" });
  assert.equal(titleHealth(t13, catalog), null);
});
