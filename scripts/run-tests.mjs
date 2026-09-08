// Test runner: the suite assumes the bare fixture seed (the localization
// workflow tests start from an empty studio); tests that need the demo
// catalog reseed it explicitly with resetFixtureStore("demo").
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
const files = readdirSync("tests").filter((f) => f.endsWith(".test.ts")).map((f) => `tests/${f}`);
const r = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit", env: { ...process.env, FIXTURE_SEED: "empty" } });
process.exit(r.status ?? 1);
