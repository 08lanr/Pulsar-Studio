import { expect, test, type Page } from "@playwright/test";

// The Ads tab of /crazydramas/stats (decision 2026-09-28, "Ad video stats"): in fixture mode the invented launches
// show six headline numbers, the median row, one row per ad creative with its ad type, an early ad marked, the
// columns sort, and the ad-type filter narrows the table. Every column's words live in its ⓘ.

async function signInAsStaff(page: Page) {
  const base = test.info().project.use.baseURL ?? "http://localhost:3202";
  expect((await page.request.post("/api/auth/dev", { form: { kind: "staff" }, maxRedirects: 0 })).status()).toBe(303);
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
}

const shot = (page: Page, name: string) => page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/ad-video-${name}.jpg`, type: "jpeg", quality: 72, fullPage: true });

test("the Ads tab shows each ad creative's TikTok numbers against the median", async ({ page }) => {
  await signInAsStaff(page);
  await page.goto("/crazydramas/stats?range=all&tab=ads");
  await expect(page.locator(".cdx-tabs").getByRole("link", { name: "Ads", exact: true })).toHaveAttribute("aria-current", "page");
  const kpis = page.getByTestId("ads-kpis");
  for (const label of ["Ad spend", "Impressions", "CTR", "Still watching at 6 s", "Checkouts", "Cost per checkout"]) await expect(kpis.getByText(label, { exact: true })).toBeVisible();
  // The invented launches: six clips, the most shown first.
  const rows = page.getByTestId("ads-row");
  await expect(rows).toHaveCount(6);
  await expect(rows.first()).toContainText("She flirted with the wrong CEO");
  await expect(page.getByTestId("ads-bench")).toContainText("Median of ads with 500+ impressions");
  await expect(page.getByTestId("ads-bench")).toContainText("5 ads");
  // The Dragon hook: 1,956 impressions, 0.7% CTR, 23.0% still watching at 2 s, 8.0% at 6 s, clearly below the median.
  const dragon = rows.filter({ hasText: "The Dragon King picked the maid" });
  await expect(dragon).toContainText("1,956");
  await expect(dragon).toContainText("0.7%");
  await expect(dragon).toContainText("23.0%");
  await expect(dragon.locator("td.cda-below").first()).toBeVisible();
  await expect(rows.filter({ hasText: "The night bus leaves" })).toContainText("early");
  // The ⓘ of a column explains it.
  await page.getByRole("button", { name: "About Still watching at 2 s" }).click();
  await expect(page.getByRole("tooltip")).toContainText("still watching after 2 seconds");
  await page.keyboard.press("Escape");
  await page.mouse.move(5, 5);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await shot(page, "ads-tab");
  // Sort by still watching at 6 s, lowest first.
  const sort6 = page.getByTestId("ads-table").getByRole("button", { name: "Still watching at 6 s", exact: true });
  await sort6.click();
  await sort6.click();
  await expect(rows.first()).toContainText("The Dragon King picked the maid");
  // Filter by ad type: the two hook ads.
  await page.getByRole("group", { name: "Filter the ads" }).locator("select").nth(1).selectOption("hook_ad");
  await expect(page).toHaveURL(/ad_type=hook_ad/);
  await expect(page.getByTestId("ads-row")).toHaveCount(2);
  // A period: this week's numbers, the archive's older ads left out.
  await page.goto("/crazydramas/stats?range=7d&tab=ads");
  await expect(page.getByTestId("ads-row")).toHaveCount(2);
  await expect(page.getByText(/4 more ads had no impressions in this period/)).toBeVisible();
});

test("the Clips page has a TikTok column for staff (empty for a clip never launched)", async ({ page }) => {
  await signInAsStaff(page);
  const answer = await page.request.get("/api/admin/crazydramas/ad-video");
  expect(answer.status()).toBe(200);
  expect(await answer.json()).toMatchObject({ clips: {}, failed: [] });
  await page.goto("/clips");
  await expect(page.getByText("TikTok ads, all time")).toBeVisible();
  await expect(page.locator(".clips-row").first()).toBeVisible();
  await page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/ad-video-clips.jpg`, type: "jpeg", quality: 72 });
});
