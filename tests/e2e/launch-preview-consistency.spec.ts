import { test, expect } from "@playwright/test";

test("staff preview locks the selected company and draft until confirmation matches the saved run", async ({ page }) => {
  const base = test.info().project.use.baseURL ?? "http://localhost:3202";
  expect((await page.request.post("/api/auth/dev", { form: { kind: "staff" }, maxRedirects: 0 })).status()).toBe(303);
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
  await page.goto("/promote/launches");

  const producer = page.getByRole("combobox", { name: "Producer", exact: true });
  const xinghaiId = await producer.locator("option").filter({ hasText: /Xinghai/i }).getAttribute("value");
  expect(xinghaiId).toBeTruthy();
  await producer.selectOption(xinghaiId!);
  const chosenProducer = await producer.inputValue();
  await page.locator("details.launch-account-picker").getByRole("checkbox", { name: /Demo TikTok 1/ }).check();
  await page.getByLabel("Launch name").fill("Preview consistency check");
  await page.getByLabel(/^(Items|Spark codes) per campaign$/).fill("1");
  await page.getByLabel("Paste all Spark codes, one per line").fill("PREVIEW-CONSISTENCY-SPARK");
  await page.getByLabel("Destination URL").fill("https://example.com/preview-check");

  let releasePreview!: () => void;
  const held = new Promise<void>(resolve => { releasePreview = resolve; });
  let previewRequested!: () => void;
  const reached = new Promise<void>(resolve => { previewRequested = resolve; });
  let launchPosts = 0;
  await page.route("**/api/promote/launches/*/launch", route => { launchPosts++; return route.abort(); });
  await page.route("**/api/promote/launches/*/preview", async route => {
    const response = await route.fetch();
    previewRequested();
    await held;
    await route.fulfill({ response });
  });

  try {
    await page.getByRole("button", { name: "Preview campaigns" }).click();
    await reached;
    await expect(producer).toBeDisabled();
    await expect(page.getByLabel("Launch name")).toBeDisabled();
    await expect(page.getByLabel("Destination URL")).toBeDisabled();
    await expect(page.getByLabel("Paste all Spark codes, one per line")).toBeDisabled();
  } finally {
    releasePreview();
  }

  await expect(page.getByText(/1 campaigns across 1 accounts/)).toBeVisible();
  expect(await producer.inputValue()).toBe(chosenProducer);
  const saved = await page.request.get("/api/promote/launches/workspace?producer_id=" + encodeURIComponent(chosenProducer));
  expect(saved.ok()).toBe(true);
  const data = await saved.json() as { workspace: { runs: { draft: { name: string; destination_url: string; content: { value: string }[]; total_budget_cents: number }; revision: number }[] } };
  const run = data.workspace.runs.find(r => r.draft.name === "Preview consistency check");
  expect(run?.revision).toBeGreaterThan(0);
  expect(run?.draft.destination_url).toBe("https://example.com/preview-check");
  expect(run?.draft.content.map(c => c.value)).toEqual(["PREVIEW-CONSISTENCY-SPARK"]);

  await page.getByRole("button", { name: /Launch 1 campaigns/ }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm launch" });
  await confirm.getByLabel(/Reason for launching on behalf of the producer/).fill("Regression test approval note");
  await expect(confirm).toContainText(run!.draft.name);
  await expect(confirm).toContainText(run!.draft.destination_url);
  await expect(confirm).toContainText("1 campaigns across 1 accounts");
  await expect(confirm).toContainText("$500.00");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(launchPosts).toBe(0);
});
