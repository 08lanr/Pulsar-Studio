// The system actor (lib/auth systemSession) runs the clip engine, the
// transcription run and, from 2026-09-22, the workspace import — with no
// person's cookie behind it. In supabase mode the data layer switches it to
// the service role (dbFor); these fixture checks pin the behaviour both
// backends must share: a title it creates records the real caller, the edit
// check refuses before any storage write, and a job's finish and heartbeat
// carry the session that recorded it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureSession, systemSession } from "@/lib/auth";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { producer, seedMinute, staff } from "./seed-minute";

test("createTitle as the system actor names the real caller and the source locale", async () => {
  resetFixtureStore();
  const who = producer();
  const title = await fixtureData.createTitle(systemSession(), {
    name_zh: "Mafia King",
    name_en: "Mafia King",
    producer_id: who.producerId!,
    source_locale: "en-US",
    created_by: who.userId,
  });
  assert.equal(title.source_locale, "en-US");
  assert.equal(title.producer_id, who.producerId);
  assert.equal((await fixtureData.getTitle(staff(), title.id)).adaptation.created_by, who.userId);

  const bare = await fixtureData.createTitle(systemSession(), { name_zh: "无人", producer_id: who.producerId! });
  assert.equal((await fixtureData.getTitle(staff(), bare.id)).adaptation.created_by, null, "no profile row behind the system actor: nothing is recorded");

  const own = await fixtureData.createTitle(who, { name_zh: "自家", producer_id: "ignored" });
  assert.equal(own.source_locale, "zh-CN", "the default locale is unchanged");
  assert.equal((await fixtureData.getTitle(staff(), own.id)).adaptation.created_by, who.userId);
});

test("assertTitleEditable answers like every write: editors pass, a viewer is refused, a stranger sees nothing", async () => {
  const title = await seedMinute();
  assert.equal((await fixtureData.assertTitleEditable(producer(), title.id)).id, title.id);
  assert.equal((await fixtureData.assertTitleEditable(staff(), title.id)).id, title.id);
  assert.equal((await fixtureData.assertTitleEditable(systemSession(), title.id)).id, title.id);

  const viewer = { ...producer(), producerRole: "viewer" as const };
  await assert.rejects(fixtureData.assertTitleEditable(viewer, title.id), { code: "forbidden" });

  const other = await fixtureData.createProducer(staff(), { name_zh: "别家影视" });
  await assert.rejects(fixtureData.assertTitleEditable(fixtureSession("producer", other.id), title.id), { code: "not_found" });
  await assert.rejects(fixtureData.assertTitleEditable(staff(), "00000000-0000-0000-0000-000000000000"), { code: "not_found" });
});

test("finishJob and heartbeatJob take the session that recorded the job", async () => {
  const title = await seedMinute();
  const wb = await fixtureData.getWorkbench(producer(), title.id, 1);
  const sys = systemSession();
  const job = await fixtureData.recordJob(sys, {
    kind: "cut_clips",
    title_id: title.id,
    episode_id: wb.episode.id,
    target_type: "episode",
    target_id: wb.episode.id,
    idempotency_key: `cut_clips:${wb.episode.id}:system-actor-test`,
  });
  await fixtureData.heartbeatJob(sys, job.id);

  const viewer = { ...producer(), producerRole: "viewer" as const };
  await assert.rejects(fixtureData.heartbeatJob(viewer, job.id), { code: "forbidden" });
  await assert.rejects(fixtureData.finishJob(viewer, job.id, { status: "done", cost_cents: 0 }), { code: "forbidden" });
  assert.equal((await fixtureData.latestEpisodeJob(sys, title.id, 1, "cut_clips"))?.status, "running", "a refused finish changed nothing");

  const done = await fixtureData.finishJob(sys, job.id, { status: "done", cost_cents: 0, output: { ok: true } });
  assert.equal(done.status, "done");
  assert.deepEqual(done.output, { ok: true });
});
