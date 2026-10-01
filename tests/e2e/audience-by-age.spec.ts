import { expect, test, type Page } from "@playwright/test";

// Audience by age (decision 2026-10-01): the Campaigns tab of /crazydramas/stats shows all campaigns' age split and
// each campaign's, one column per TikTok age group; in fixture mode the invented campaigns carry an invented split.
// The Ads tab keeps Checkouts in view next to CTR.

async function signInAsStaff(page: Page) {
  const base = test.info().project.use.baseURL ?? "http://localhost:3202";
  expect((await page.request.post("/api/auth/dev", { form: { kind: "staff" }, maxRedirects: 0 })).status()).toBe(303);
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
}

const shot = (page: Page, name: string) => page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/audience-${name}.jpg`, type: "jpeg", quality: 72, fullPage: true });

test("the Campaigns tab shows the age split for all campaigns and each campaign", async ({ page }) => {
  await signInAsStaff(page);
  await page.goto("/crazydramas/stats?range=all&tab=campaigns");
  const card = page.getByTestId("audience-by-age");
  await expect(card.getByRole("heading", { name: "Audience by age" })).toBeVisible();
  const table = card.getByTestId("audience-table");
  for (const age of ["13–17", "18–24", "25–34", "35–44", "45–54", "55+"]) await expect(table.getByRole("columnheader", { name: age, exact: true })).toBeVisible();
  await expect(card.getByTestId("audience-total")).toContainText("All campaigns");
  await expect(card.getByTestId("audience-row").first()).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await shot(page, "campaigns");
});

test("the Ads tab's Checkouts column sits next to CTR, in view", async ({ page }) => {
  await signInAsStaff(page);
  await page.goto("/crazydramas/stats?range=all&tab=ads");
  const headers = page.getByTestId("ads-table").locator("thead th");
  const texts = await headers.allInnerTexts();
  const ctr = texts.findIndex((t) => t.startsWith("CTR"));
  expect(texts[ctr + 1]).toMatch(/^Checkouts/);
  await expect(page.getByTestId("ads-table").getByRole("button", { name: /^Checkouts/ }).first()).toBeInViewport();
  await shot(page, "ads");
});
