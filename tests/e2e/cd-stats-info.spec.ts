import { expect, test, type Page } from "@playwright/test";

// The CrazyDramas stats' ⓘ buttons (Ruobin, 2026-09-25: "the information buttons don't work"): each one is a
// real button whose explanation opens on a click or a tap, stays on screen, closes on a tap elsewhere or
// Escape, and never follows the link of the card it sits on; the card itself still picks the chart.

async function signInAsStaff(page: Page) {
  const base = test.info().project.use.baseURL ?? "http://localhost:3202";
  expect((await page.request.post("/api/auth/dev", { form: { kind: "staff" }, maxRedirects: 0 })).status()).toBe(303);
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
}

test("the ⓘ on a headline card explains it, closes, and leaves the card's link alone", async ({ page }) => {
  await signInAsStaff(page);
  await page.goto("/crazydramas/stats?range=7d");
  const url = page.url();
  const info = page.getByRole("button", { name: "Visitors" }).first();
  await info.click();
  const pop = page.getByRole("tooltip");
  await expect(pop).toBeVisible();
  await expect(pop).toContainText("Real people who saw the watch page");
  expect(page.url()).toBe(url);
  const box = await pop.boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  expect(box && box.x >= 0 && box.x + box.width <= width).toBeTruthy();
  await page.mouse.click(5, 5);
  await expect(pop).toHaveCount(0);
  // The card itself still picks the chart.
  await page.locator(".cdx-kpi-click").nth(1).click({ position: { x: 20, y: 60 } });
  await expect(page).toHaveURL(/metric=started/);
});

test("the Playback tab's ⓘ open on a click and close on Escape", async ({ page }) => {
  await signInAsStaff(page);
  await page.goto("/crazydramas/stats?range=7d&tab=playback");
  await page.getByRole("button", { name: "About Why episode 1 ended early" }).click();
  await expect(page.getByRole("tooltip")).toContainText("Something went wrong");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.getByRole("button", { name: "About Where the start time goes" }).click();
  await expect(page.getByRole("tooltip")).toBeVisible();
});
