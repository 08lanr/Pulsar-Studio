// The fixture persona cookie may name a company (QA 2026-09-15): a company
// staff created during the session can be walked as its producer.
import { test } from "node:test";
import assert from "node:assert/strict";

import { FIXTURE_PRODUCER_ID, fixtureSession, parseDevCookie, parseUserKind } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { producer, staff } from "./seed-minute";

test("the dev cookie parses staff, producer and producer:<uuid>; anything else is no session", () => {
  assert.deepEqual(parseDevCookie("staff"), { kind: "staff" });
  assert.deepEqual(parseDevCookie("producer"), { kind: "producer" });
  assert.deepEqual(parseDevCookie("producer:0f0e0d0c-0b0a-4009-8008-070605040302"), { kind: "producer", producerId: "0f0e0d0c-0b0a-4009-8008-070605040302" });
  assert.equal(parseDevCookie("producer:not-a-uuid"), null);
  assert.equal(parseDevCookie("admin"), null);
  assert.equal(parseUserKind("producer:0f0e0d0c-0b0a-4009-8008-070605040302"), "producer");
});

test("a session for a company created in the fixture sees that company's titles and not the demo studio's", async () => {
  resetFixtureStore();
  const company = await fixtureData.createProducer(staff(), { name_zh: "测试公司", name_en: "Clip Launch QA" });
  const mine = fixtureSession("producer", company.id);
  assert.equal(mine.producerId, company.id);
  assert.notEqual(mine.producerId, FIXTURE_PRODUCER_ID);
  const title = await fixtureData.createTitle(mine, { name_zh: "测试剧", name_en: "QA title", producer_id: "ignored" });
  assert.equal(title.producer_id, company.id);
  assert.deepEqual((await fixtureData.getProducerTitles(mine)).map((t) => t.id), [title.id]);
  assert.equal((await fixtureData.getProducerTitles(producer())).some((t) => t.id === title.id), false, "the demo studio does not see it");
  await assert.rejects(fixtureData.getTitle(producer(), title.id), (e: Error & { code?: string }) => e.code === "not_found");
});
