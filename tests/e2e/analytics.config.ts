import { defineConfig, devices } from "@playwright/test";

// Minimal config for the analytics e2e pass against the already-running dev
// server (npm run dev on :3200). Run: npx playwright test --config tests/e2e/analytics.config.ts
export default defineConfig({
  testDir: ".",
  testMatch: /analytics\.spec\.ts/,
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3200",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    screenshot: "off",
  },
});
