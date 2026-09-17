import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { fixtureSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { runControl } from "@/lib/tiktok/control-actions";
import { POST as createOld } from "@/app/api/producer/promote/route";
import { POST as submitOld } from "@/app/api/producer/promote/[campaignId]/submit/route";

beforeEach(() => {
  process.env.DATA_SOURCE = "fixture";
  process.env.FIXTURE_PERSIST = "off";
  resetFixtureStore("demo");
});

const producer = () => fixtureSession("producer");
const conflict = (error: unknown) => (error as { code?: string }).code === "conflict";

test("earlier campaigns remain readable while both fixture creation and submission are retired", async () => {
  const rows = await fixtureData.listPromoCampaigns(producer());
  assert.ok(rows.length > 0, "demo history should remain visible");
  const original = rows[0];
  const detail = await fixtureData.getPromoCampaign(producer(), original.id);
  assert.equal(detail.campaign.id, original.id);
  await assert.rejects(fixtureData.createPromoCampaign(producer(), {
    title_id: original.title_id, name: "old", target_market: "US", objective: "views", spoiler_level: "low",
    destination_url: "https://example.com", creative_direction: null, exclusions: null, experiment: null,
  }), conflict);
  await assert.rejects(fixtureData.submitPromoCampaign(producer(), original.id), conflict);
  assert.equal((await fixtureData.listPromoCampaigns(producer())).length, rows.length);
});

test("direct old create and submit API requests cannot invoke the old engine", async () => {
  const create = await createOld(new NextRequest("http://localhost/api/producer/promote", { method: "POST" }));
  assert.equal(create.status, 409);
  const submit = await submitOld(new NextRequest("http://localhost/api/producer/promote/old/submit", { method: "POST" }), { params: { campaignId: "old" } });
  assert.equal(submit.status, 409);
});

test("earlier campaign controls reject activation, duplication and budget mutation", async () => {
  for (const action of [
    { action: "resume" },
    { action: "duplicate", copies: 1 },
    { action: "budget", budget_usd: 100 },
    { action: "adgroup_switch", adgroup_id: "123456", on: true },
  ] as const) {
    await assert.rejects(runControl(producer(), "old", action), conflict);
  }
});
