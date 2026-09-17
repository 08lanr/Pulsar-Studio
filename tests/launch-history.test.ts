import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureSession } from "@/lib/auth";
import { getData } from "@/lib/data";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { createLaunchData, resetLaunchFixture } from "@/lib/data/launch";
import { defaultLaunchDraft } from "@/lib/launch/plan";

test("launch history stays company-scoped and readable without account discovery or media", async () => {
  process.env.DATA_SOURCE = "fixture";
  process.env.FIXTURE_PERSIST = "off";
  process.env.FIXTURE_SEED = "empty";
  resetFixtureStore(); resetLaunchFixture();
  const producer = fixtureSession("producer");
  const saved = await getData().saveLaunchDraft(producer, { ...defaultLaunchDraft(), name: "Saved history" });
  const unavailable = async () => { throw new Error("Provider inventory is unavailable"); };
  const data = createLaunchData({ ...fixtureData, getLaunchBusinessCenter: unavailable, listTitles: unavailable });
  await assert.rejects(data.getLaunchWorkspace(producer), /unavailable/);
  assert.deepEqual((await data.listLaunchRuns(producer)).map(r => r.id), [saved.id]);
  assert.equal((await data.listLaunchRuns(fixtureSession("staff"))).length, 1);
  assert.deepEqual(await data.listLaunchRuns({ ...producer, producerId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }), []);
});
