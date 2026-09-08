import { defineConfig, devices } from "@playwright/test";

// End-to-end smoke tests against the fixture-mode dev server (port 3200).
// `npm run test:e2e` reuses a running `npm run dev`; without one it starts
// it. Two viewports: a desktop and the size a projector usually gets.
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
    baseURL: process.env.STUDIO_URL ?? "http://localhost:3200",
    locale: "en-US",
    colorScheme: "light",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "presentation", use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } } },
  ],
  webServer: {
    command: "npm run dev",
    url: process.env.STUDIO_URL ? `${process.env.STUDIO_URL}/login` : "http://localhost:3200/login",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
