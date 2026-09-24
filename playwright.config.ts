import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// End-to-end tests own an isolated fixture server on port 3202. They reset
// demo data, so never reuse the interactive demo on port 3200. Persistence
// is disabled; screenshots cover desktop and presentation viewports.
// Screenshots land in docs/demo/e2e/<project>/ as evidence of the rehearsal.

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "tmp/playwright-report" }]],
  outputDir: "tmp/playwright-results",
  use: {
    baseURL: process.env.STUDIO_URL ?? "http://localhost:3202",
    locale: "en-US",
    colorScheme: "light",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "presentation", use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } } },
  ],
  // STUDIO_URL is an explicit opt-in to a separately managed test server.
  webServer: process.env.STUDIO_URL ? undefined : {
    command: "npx next dev -p 3202",
    url: "http://localhost:3202/login",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATA_SOURCE: "fixture", TIKTOK_MODE: "sandbox", TIKTOK_LIVE: "",
      META_LIVE_WRITES: "", FIXTURE_PERSIST: "off", FIXTURE_SEED: "demo",
      NEXT_DIST_DIR: ".next-redesign-e2e", SCHEDULER_DISABLED: "1", PROMO_RENDER: "on",
      // The workspace import (decision 2026-09-22): the checked-in fixture films, a local tier and scratch of the
      // e2e server's own, and no quiet period (git just wrote the fixture files).
      WORKSPACE_ROOT: path.resolve(__dirname, "tests", "fixtures", "workspace"),
      STUDIO_LOCAL_MEDIA_DIR: ".uploads-e2e/local", STUDIO_WORK_DIR: ".uploads-e2e/work", STUDIO_IMPORT_QUIET_MS: "0",
      // The e2e server's own computer file, so a films folder connected on the real Studio never reaches it (lib/computer.ts).
      STUDIO_COMPUTER_FILE: ".uploads-e2e/computer.json",
      // Segment a film (decision 2026-09-23): the fake pipeline runner stands in for python, so a run walks every
      // stage over the fixture workspace without whisper, ffmpeg or a vision key (tests/e2e/segment.spec.ts).
      STUDIO_FAKE_PIPELINE: "1",
    },
  },
});
