// The segment worker as its own process (plan B1; docs/segment-a-film.md):
//
//   npx tsx scripts/segment-worker.ts            poll every 5 s until stopped
//   npx tsx scripts/segment-worker.ts --once     one tick, then exit (a cron, a test)
//
// Reads .env.local like the dev server does (@next/env), so DATA_SOURCE,
// WORKSPACE_ROOT, STUDIO_WORK_DIR, DRAMA_REMIX_ROOT, STUDIO_PIPELINE_PYTHON
// and the model keys come from there or from the shell. Supabase mode is
// the one this process is for: fixture mode keeps its runs in the dev
// server's memory, where the same loop runs in-process, so here it refuses
// unless STUDIO_FAKE_PIPELINE=1 asks for a fake run over an empty store (a
// smoke of the loop itself). Ctrl-C stops the loop after the current stage
// writes its state; the next start resumes from the row and the artifacts.

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());
process.env.PROMO_RENDER ??= "off";

async function main(): Promise<void> {
  const { dataSource } = await import("@/lib/data-source");
  const { SegmentWorker, runTick } = await import("@/lib/segment/worker");
  const { fakePipeline, filmRoot, segmentWorkDir } = await import("@/lib/segment/stages");
  const { dramaRemixRoot, pipelinePython } = await import("@/lib/python");
  const { workerName } = await import("@/lib/locks");

  const once = process.argv.includes("--once");
  if (dataSource() !== "supabase" && !fakePipeline()) {
    console.error("segment-worker: DATA_SOURCE is not supabase. Fixture mode keeps its runs in the dev server's memory, and the dev server runs this loop itself (lib/segment/worker.ts ensureInProcessWorker); a separate process would see no runs. Set DATA_SOURCE=supabase, or STUDIO_FAKE_PIPELINE=1 for a fake run over an empty store.");
    process.exit(2);
  }
  console.log(`segment-worker ${workerName()}: ${dataSource()} data, film root ${filmRoot() ?? "(WORKSPACE_ROOT not set)"}, work dir ${segmentWorkDir()}, python ${pipelinePython()}, drama-remix ${dramaRemixRoot()}${fakePipeline() ? ", FAKE pipeline" : ""}`);
  if (once) {
    const r = await runTick({ awaitRuns: true });
    console.log(`tick: ${r.considered} runs, started ${r.started.length}, skipped ${r.skipped.length}`);
    return;
  }
  const worker = new SegmentWorker({ pollMs: 5000 });
  worker.start();
  const stop = () => {
    console.log("segment-worker: stopping after the current stage writes its state");
    worker.stop();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise<void>(() => undefined);
}

main().catch((e) => {
  console.error(`segment-worker: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
