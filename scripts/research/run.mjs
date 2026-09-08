// One research run: both collectors under one RESEARCH_RUN_ID, then the
// builder, which validates and publishes atomically. A collector failure
// does not stop the run: its .failed.json lets the builder carry the
// platform forward as stale. Exit code is the builder's.
//
// Usage: npm run research:crawl        (RESEARCH_RUN_ID defaults to the UTC start time)

import { spawnSync } from "node:child_process";
import { runId } from "./lib.mjs";

const id = runId();
const env = { ...process.env, RESEARCH_RUN_ID: id };
console.error(`[research] run ${id}`);

for (const script of ["scripts/research/scrape-reelshort.mjs", "scripts/research/scrape-dramabox.mjs"]) {
  const r = spawnSync(process.execPath, [script], { stdio: "inherit", env });
  if (r.status !== 0) console.error(`[research] ${script} exited ${r.status}; the builder will mark the platform failed/stale`);
}

const build = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "scripts/research/build-snapshot.ts"], { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(build.status ?? 1);
