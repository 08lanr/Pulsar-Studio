import { expect, test } from "@playwright/test";

test("Launch keeps account, Spark, settings and validation decisions together", async ({ page }) => {
  const base = test.info().project.use.baseURL ?? "http://localhost:3202";
  const login = await page.request.post("/api/auth/dev", { form: { kind: "producer" }, maxRedirects: 0 });
  expect([200, 303]).toContain(login.status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
  await page.request.post("/api/demo/reset", { data: { seed: "demo" } });
  await page.goto("/producer/launch");
  const businessCenter = page.getByLabel("Business Center");
  await expect(businessCenter).toBeVisible();
  await expect(businessCenter.locator("option").last()).not.toHaveValue("");
  if (!await businessCenter.inputValue()) await businessCenter.selectOption({ index: 1 });

  const picker = page.locator(".launch-account-picker");
  await expect(picker).toContainText("0 selected");
  if (await picker.getAttribute("open") === null) await picker.locator("summary").click();
  await picker.getByRole("checkbox", { name: /Demo TikTok 1/ }).check();
  await picker.getByRole("checkbox", { name: /Demo TikTok 2/ }).check();
  await expect(picker).toContainText("2 selected");

  await page.getByLabel("Campaigns per account").fill("2");
  await page.getByLabel("Spark codes per campaign").fill("2");
  await expect(page.getByText(/4 unique codes per account; 8 total across 2 accounts/)).toBeVisible();
  const codes = Array.from({ length: 8 }, (_, i) => `REDESIGN-SPARK-${i + 1}`);
  await page.getByLabel("Paste all Spark codes, one per line").fill(codes.join("\n"));
  await expect(page.locator(".launch-spark-count")).toHaveClass(/ready/);
  await expect(page.locator(".launch-spark-count")).toContainText("8 / 8");
  await page.getByRole("button", { name: "Same content every campaign", exact: true }).click();
  await expect(page.getByText(/2 codes reused in each of 4 campaigns/)).toBeVisible();
  await page.getByRole("button", { name: "Unique per campaign", exact: true }).click();

  await page.getByRole("button", { name: "Customize for this launch" }).click();
  const dialog = page.getByRole("dialog", { name: "Ad group settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole("button", { name: "Preview campaigns" }).click();
  const preview = page.locator(".launch-flow > .rs-panel").last();
  await expect(preview.getByRole("alert")).toBeVisible();
  await page.getByLabel("Destination URL").fill("https://example.com/watch");
  await page.getByRole("button", { name: "Preview campaigns" }).click();
  await expect(preview.getByText(/4 campaigns across 2 ad accounts/)).toBeVisible();
  await page.getByRole("button", { name: /Launch 4 campaigns/ }).click();
  await page.getByRole("dialog", { name: "Confirm launch" }).getByRole("button", { name: "Confirm launch", exact: true }).click();
  await expect(page).toHaveURL(/\/producer\/monitor\?run=/);
});
