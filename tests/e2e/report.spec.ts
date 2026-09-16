import { test, expect, type Page } from "@playwright/test";

// The one-page title report (decision 2026-09-15): the outbound artifact a
// producer saves as a PDF and forwards. It assembles the same numbers the
// workspace sections show — score, latest round results, TikTok summary,
// readiness — with their demo labels intact, and exposes the print action.

const T1 = "00000030-0000-4000-8000-000000000001"; // Reborn as the CEO's First Love
const T_PENDING = "00000030-0000-4000-8000-000000000004"; // Fake Heiress: campaign drafted, no results yet
const T_EMPTY = "00000030-0000-4000-8000-00000000000d"; // Campus Sweetheart: no campaigns, not linked

async function signIn(page: Page) {
  const base = test.info().project.use.baseURL ?? "http://localhost:3200";
  const res = await page.request.post(`${base}/api/auth/dev`, { form: { kind: "producer" }, maxRedirects: 0 });
  expect([200, 303]).toContain(res.status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("the title overview links to the report and the sheet carries every section", async ({ page }) => {
  const reset = await page.request.post("/api/demo/reset", { data: { seed: "demo" } });
  expect(reset.ok(), "demo reset is available in fixture mode").toBeTruthy();

  await page.goto(`/producer/titles/${T1}`);
  await page.getByRole("link", { name: "Export report" }).click();
  await expect(page).toHaveURL(new RegExp(`/producer/titles/${T1}/report$`));

  const sheet = page.locator(".report-sheet");
  await expect(sheet.getByRole("heading", { level: 1 })).toContainText("Reborn as the CEO's First Love");
  await expect(sheet.locator(".ps-score b")).toHaveText(/\d+/);
  await expect(sheet.locator(".report-components tbody tr")).toHaveCount(5);

  // The latest round's per-ad rows against the benchmarks, with the demo label.
  await expect(sheet.locator(".report-results tbody tr")).toHaveCount(2);
  await expect(sheet).toContainText("Demo results (simulated)");
  await expect(sheet.locator(".report-facts").first()).toBeVisible();

  // The print action sits outside the sheet and never prints into it.
  await expect(page.getByRole("button", { name: "Save as PDF" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Save as PDF" })).toHaveCount(0);
});

test("a campaign that has not reported prints its status, never 'no campaign'", async ({ page }) => {
  const reset = await page.request.post("/api/demo/reset", { data: { seed: "demo" } });
  expect(reset.ok()).toBeTruthy();
  await page.goto(`/producer/titles/${T_PENDING}/report`);
  const sheet = page.locator(".report-sheet");
  await expect(sheet).toContainText("Fake-heiress reveal");
  await expect(sheet).toContainText("No ad results yet");
  await expect(sheet).not.toContainText("No ad campaign on this title yet");
});

test("a title without campaigns or a TikTok link still renders a full report", async ({ page }) => {
  await page.goto(`/producer/titles/${T_EMPTY}/report`);
  const sheet = page.locator(".report-sheet");
  await expect(sheet.getByRole("heading", { level: 1 })).toContainText("Campus Sweetheart");
  await expect(sheet.locator(".ps-score b")).toHaveText(/\d+/);
  // Empty sections say so instead of inventing zeros.
  expect(await sheet.locator(".report-empty").count()).toBeGreaterThanOrEqual(2);
});
