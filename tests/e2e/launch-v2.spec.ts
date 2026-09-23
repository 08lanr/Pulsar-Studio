import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { defaultLaunchSettings } from "../../lib/tiktok/settings";

async function chooseAccount(page: Page, name: RegExp) {
  const picker = page.locator("details.launch-account-picker");
  if (await picker.count() && await picker.getAttribute("open") === null) await picker.locator("summary").click();
  await page.getByRole("checkbox", { name }).check();
}
async function openControl(page: Page, name: string) {
  await page.getByRole("button", { name: "More campaign actions" }).first().click();
  await page.getByRole("button", { name, exact: true }).click();
  return page.getByRole("dialog", { name, exact: true });
}
async function amountControl(page: Page, name: string, amount: number, maximum?: string) {
  const dialog = await openControl(page, name);
  if (maximum) await expect(dialog).toContainText(maximum);
  await dialog.getByRole("spinbutton").fill(String(amount));
  const changed = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/controls"));
  await dialog.getByRole("button", { name: "Save change" }).click();
  expect((await changed).ok()).toBe(true);
  await expect(dialog).toBeHidden();
}

test.describe.configure({ mode: "serial" });

test("a preset created in a staff tab appears when returning to an open launch draft", async ({ page }) => {
  const base = test.info().project.use.baseURL ?? "http://localhost:3200";
  expect([200, 303]).toContain((await page.request.post("/api/auth/dev", { form: { kind: "producer" }, maxRedirects: 0 })).status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
  await page.goto("/producer/launch");
  await page.getByLabel("Launch name").fill("Keep this draft");
  await page.getByLabel(/^(Items|Spark codes) per campaign$/).fill("3");
  const staffContext = await page.context().browser()!.newContext({ baseURL: base });
  try {
    expect((await staffContext.request.post("/api/auth/dev", { form: { kind: "staff" }, maxRedirects: 0 })).status()).toBe(303);
    const staffTab = await staffContext.newPage();
    await staffTab.goto("/tiktok/templates");
    const name = `New tab preset ${Date.now()}`;
    const created = await staffContext.request.post("/api/admin/tiktok/presets", { data: {
      name, settings: { ...defaultLaunchSettings(), bid_strategy: "COST_CAP", bid_usd: 0.5 }, note: null,
    } });
    expect(created.ok()).toBe(true);
    await page.bringToFront();
    const refreshed = page.waitForResponse(response => response.url().endsWith("/api/producer/tiktok/presets") && response.request().method() === "GET");
    await page.getByLabel("Preset").focus();
    expect((await refreshed).ok()).toBe(true);
    await expect(page.getByLabel("Preset").locator("option", { hasText: name })).toHaveCount(1);
    await expect(page.getByLabel("Launch name")).toHaveValue("Keep this draft");
    await expect(page.getByLabel(/^(Items|Spark codes) per campaign$/)).toHaveValue("3");
    await page.getByLabel("Preset").selectOption({ label: name });
    await expect(page.getByLabel("Launch name")).toHaveValue("Keep this draft");
    await expect(page.getByLabel(/^(Items|Spark codes) per campaign$/)).toHaveValue("3");
  } finally {
    await staffContext.close();
  }
});

test("staff authorization and confirmation keep a preview intact when launch fails", async ({ page }) => {
  const base = test.info().project.use.baseURL ?? "http://localhost:3200";
  expect((await page.request.post("/api/auth/dev", { form: { kind: "staff" }, maxRedirects: 0 })).status()).toBe(303);
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
  expect((await page.request.post("/api/demo/reset", { data: { seed: "demo" } })).ok()).toBe(true);
  await page.goto("/promote/launches");
  const businessCenter = page.getByRole("combobox", { name: "Business Center" });
  await expect(businessCenter).toBeVisible();
  await expect(businessCenter).toBeDisabled();
  await page.getByRole("combobox", { name: "Producer", exact: true }).selectOption({ index: 1 });
  await expect(businessCenter).toBeEnabled();
  await chooseAccount(page, /Demo TikTok 1/);
  await page.getByLabel(/^(Items|Spark codes) per campaign$/).fill("1");
  await page.getByLabel("Paste all Spark codes, one per line").fill("STAFF-AUTH-SPARK");
  await page.getByLabel("Destination URL").fill("https://example.com/watch");
  await page.getByRole("button", { name: "Preview campaigns" }).click();
  const preview = page.locator(".launch-flow > .rs-panel").last();
  await expect(preview.getByText(/1 campaign across 1 ad account/)).toBeVisible();

  let posts = 0;
  await page.route("**/api/promote/launches/*/launch", async route => {
    posts++;
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Simulated launch rejection", code: "invalid" }) });
  });
  await page.getByRole("button", { name: /Launch 1 campaign/ }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm launch" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Confirm launch", exact: true }).click();
  await expect(confirm.getByRole("alert")).toContainText(/authorization note/i);
  expect(posts).toBe(0);
  await confirm.getByLabel(/Authorization note/).fill("Approved support request");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  expect(posts).toBe(0);
  await page.getByRole("button", { name: /Launch 1 campaign/ }).click();
  await confirm.getByLabel(/Authorization note/).fill("Approved support request");
  await confirm.getByRole("button", { name: "Confirm launch", exact: true }).click();
  await expect(preview.getByRole("alert")).toContainText("Simulated launch rejection");
  await expect(preview.getByText(/1 campaign across 1 ad account/)).toBeVisible();
  expect(posts).toBe(1);
});

test("Clips handoff, TikTok monitor, and Meta post plus finished-file paused launch", async ({ page }) => {
  const base = test.info().project.use.baseURL ?? "http://localhost:3200";
  const login = await page.request.post("/api/auth/dev", { form: { kind: "producer" }, maxRedirects: 0 });
  expect([200, 303]).toContain(login.status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
  await page.request.post("/api/demo/reset", { data: { seed: "demo" } });

  await page.goto("/producer/clips");
  await expect(page.getByRole("heading", { name: "Clips", exact: true })).toBeVisible();
  await expect(page.getByText(/download a finished clip, post it to your own account/i)).toBeVisible();

  await page.goto("/producer/launch");
  await expect(page.getByRole("heading", { name: "Launch", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Monitor", exact: true })).toHaveCount(0);
  await expect(page.locator(".launch-flow .page-head").getByRole("link", { name: "Monitor", exact: true })).toHaveAttribute("href", "/producer/monitor");
  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(navigation.getByRole("link", { name: "Launch", exact: true })).toHaveAttribute("href", "/producer/launch");
  await expect(navigation.getByRole("link", { name: "Monitor", exact: true })).toHaveAttribute("href", "/producer/monitor");
  await expect(page.getByLabel(/^(Items|Spark codes) per campaign$/)).toHaveValue("5");
  await page.getByLabel(/^(Items|Spark codes) per campaign$/).fill("1");
  await chooseAccount(page, /Demo TikTok 1/);
  await page.getByLabel("Paste all Spark codes, one per line").fill("TEST-LAUNCH-V2-SPARK");
  await page.getByLabel("Destination URL").fill("https://example.com/watch");
  let providerLaunchPosts = 0;
  await page.route("**/api/producer/launch/*/launch", async route => { providerLaunchPosts++; await route.continue(); });
  await page.getByRole("button", { name: "Launch on TikTok", exact: true }).click();
  const primaryConfirm = page.getByRole("dialog", { name: "Confirm launch" });
  // Round 3: the facts grid names the account and the count (the e2e server is a
  // sandbox, so the lede is the test-launch sentence); the Spark code is never printed.
  await expect(primaryConfirm.locator(".launch-confirm-facts")).toContainText("Demo TikTok 1");
  await expect(primaryConfirm.locator(".launch-confirm-facts")).toContainText("Campaigns");
  await expect(primaryConfirm).not.toContainText("TEST-LAUNCH-V2-SPARK");
  await expect(primaryConfirm.locator(".ad-card[data-content-id='TEST-LAUNCH-V2-SPARK']")).toHaveCount(1);
  await expect(primaryConfirm.locator(".launch-confirm-money")).toContainText("Total billed");
  await expect(primaryConfirm).toContainText("https://example.com/watch");
  expect(providerLaunchPosts).toBe(0);
  mkdirSync("docs/demo/launch-v2", { recursive: true });
  await primaryConfirm.screenshot({ path: `docs/demo/launch-v2/2026-09-16-${test.info().project.name}-launch-confirmation.png` });
  await primaryConfirm.getByRole("button", { name: "Cancel" }).click();
  await expect(primaryConfirm).toBeHidden();
  await expect(page.getByText(/1 campaign across 1 ad account/)).toBeVisible();
  expect(providerLaunchPosts).toBe(0);
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: `docs/demo/launch-v2/2026-09-16-${test.info().project.name}-launch-preview-final.png`, fullPage: true });
  await expect(page.getByRole("button", { name: /Launch 1 campaign/ })).toBeEnabled();
  await page.getByRole("button", { name: /Launch 1 campaign/ }).click();
  await page.getByRole("dialog", { name: "Confirm launch" }).getByRole("button", { name: "Confirm launch", exact: true }).click();
  await expect(page).toHaveURL(/\/producer\/monitor\?run=/);
  expect(providerLaunchPosts).toBe(1);
  await page.goto("/producer/monitor");
  await expect(page.getByRole("heading", { name: "Monitor", exact: true })).toBeVisible();
  await expect.poll(async () => {
    const response = await page.request.get("/api/producer/monitor?force=1");
    const data = await response.json() as { runs: { draft: { content: { value: string }[] }; status: string }[] };
    return data.runs.find((r) => r.draft.content.some((c) => c.value === "TEST-LAUNCH-V2-SPARK"))?.status;
  }, { timeout: 20_000 }).toBe("done");
  await page.getByRole("button", { name: "Refresh delivery" }).click();
  const launchedCampaign = page.locator("tr[data-campaign-id]").first();
  // Round 2: the row names the account; the account id lives in the expanded row.
  await expect(launchedCampaign).toContainText("Demo TikTok 1");
  await expect(page.getByRole("table", { name: "Campaigns" }).first()).toBeVisible();
  await expect(page.getByText("TEST-LAUNCH-V2-SPARK", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Details" }).first().click();
  await expect(page.locator(".lm-detail").first()).toContainText("7000000000000000001");
  // Round 2: the expanded row is the ads themselves, one card each.
  // Round 3: the Spark code is never printed; it lives in the card's title/data attributes.
  await expect(page.locator(".lm-detail").first().locator(".ad-card")).not.toContainText("TEST-LAUNCH-V2-SPARK");
  await expect(page.locator(".lm-detail").first().locator(".ad-card[data-content-id='TEST-LAUNCH-V2-SPARK']")).toHaveAttribute("title", "TEST-LAUNCH-V2-SPARK");
  await expect(page.getByText("TEST-LAUNCH-V2-SPARK", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Off", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Paused", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Resume campaign" }).first().click();
  await expect(page.getByText("On", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Delivering", { exact: true }).first()).toBeVisible();
  // Reducing a budget must not turn the edited amount into the approval ceiling.
  for (const dollars of [450, 500]) {
    await amountControl(page, "Change lifetime budget", dollars, "$500.00");
    // Round 3: the detail row no longer prints the budget; the edit dialog carries the current amount.
    const budget = await openControl(page, "Change lifetime budget");
    await expect(budget.getByRole("spinbutton")).toHaveValue(String(dollars));
    await budget.getByRole("button", { name: "Cancel" }).click();
    await expect(budget).toBeHidden();
  }
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: `docs/demo/launch-v2/2026-09-16-${test.info().project.name}-monitor-final.png`, fullPage: true });

  await expect.poll(async () => {
    const response = await page.request.get("/api/producer/launch/workspace");
    const data = await response.json() as { workspace: { library: { id: string; kind: string; label?: string }[] } };
    return data.workspace.library.find((item) => item.kind === "video") ?? null;
  }, { timeout: 60_000 }).not.toBeNull();
  const workspaceResponse = await page.request.get("/api/producer/launch/workspace");
  const workspaceData = await workspaceResponse.json() as { workspace: { library: { id: string; kind: string; label?: string }[] } };
  const video = workspaceData.workspace.library.find((item) => item.kind === "video")!;

  await page.goto("/producer/launch");
  await page.getByRole("button", { name: /Meta · Facebook/ }).click();
  await expect(page.getByLabel(/^(Items|Spark codes) per campaign$/)).toHaveValue("1");
  await chooseAccount(page, /Demo Meta 1/);
  await page.getByLabel(/^(Items|Spark codes) per campaign$/).fill("2");
  await page.getByLabel("Destination URL").fill("https://example.com/watch");
  // Since plan §5.2 the bare id box is one tab of the Choose content popup.
  await page.getByRole("button", { name: "Choose content", exact: true }).click();
  const contentPicker = page.getByRole("dialog", { name: "Choose ad content" });
  await contentPicker.getByRole("tab", { name: "Paste an id" }).click();
  await contentPicker.getByLabel("Existing post ID").fill("9000000000000010_9000000000001000");
  await contentPicker.getByRole("button", { name: "Add post" }).click();
  await expect(contentPicker.locator(".content-chosen-row")).toContainText("9000000000000010_9000000000001000");
  await contentPicker.getByRole("tab", { name: "Studio clips" }).click();
  await contentPicker.locator(`[data-clip-id="${video.id}"]`).getByRole("button", { name: "Use the finished file", exact: true }).click();
  await expect(contentPicker.locator(".content-chosen-row")).toHaveCount(2);
  await contentPicker.getByRole("button", { name: "Done", exact: true }).click();
  await expect(contentPicker).toBeHidden();
  await expect(page.locator(".launch-spark-count")).toContainText("2");
  await page.getByRole("button", { name: "Preview campaigns" }).click();
  await expect(page.getByText(/1 campaign across 1 ad account/)).toBeVisible();
  const mixedRow = page.locator(".gt-row").filter({ hasText: video.label ?? video.id });
  await expect(mixedRow.locator(".ad-card")).toHaveCount(2);
  // A pasted reference is named by what it is; the reference itself stays in the
  // card's title, so no cell leads with an id.
  await expect(mixedRow.locator(".ad-card").filter({ hasText: "Facebook post" })).toHaveAttribute("title", "9000000000000010_9000000000001000");
  await page.getByRole("button", { name: /Launch 1 campaign/ }).click();
  await page.getByRole("dialog", { name: "Confirm launch" }).getByRole("button", { name: "Confirm launch", exact: true }).click();
  await expect(page).toHaveURL(/\/producer\/monitor\?run=/);
  await expect.poll(async () => {
    const response = await page.request.get("/api/producer/monitor?force=1");
    const data = await response.json() as { runs: { status: string; draft: { provider: string; content: { value: string }[] }; campaigns: { status: string; snapshot: { delivery: string; configured_status?: string } | null }[] }[] };
    const run = data.runs.find((item) => item.draft.provider === "meta" && item.draft.content.some((content) => content.value === video.id));
    return run && { status: run.status, content: run.draft.content.length, campaign: run.campaigns[0]?.status, delivery: run.campaigns[0]?.snapshot?.delivery, configured: run.campaigns[0]?.snapshot?.configured_status };
  }, { timeout: 30_000 }).toEqual({ status: "done", content: 2, campaign: "done", delivery: "paused", configured: "PAUSED" });
  await page.goto("/producer/monitor");
  await expect(page.locator(".lm-eyebrow").getByText("Meta", { exact: true }).first()).toBeVisible();
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: `docs/demo/launch-v2/2026-09-16-${test.info().project.name}-meta-monitor-paused-final.png`, fullPage: true });
});

// docs/launch-ux-round-2.md §2.5: the content decides the platforms, so a
// post-only draft shows two ad cards with no copy boxes and no Placements
// control, the first campid names the campaigns, and the confirm dialog is a
// preview of the ads with no provider id anywhere in it.
test("Meta posts carry their own platform: cards without copy boxes, no Placements, campid naming, clean confirm", async ({ page }) => {
  const base = test.info().project.use.baseURL ?? "http://localhost:3200";
  expect((await page.request.post("/api/auth/dev", { form: { kind: "staff" }, maxRedirects: 0 })).status()).toBe(303);
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
  expect((await page.request.post("/api/demo/reset", { data: { seed: "demo" } })).ok()).toBe(true);

  await page.goto("/promote/launches");
  await page.getByRole("combobox", { name: "Producer", exact: true }).selectOption({ index: 1 });
  await page.getByRole("button", { name: /Meta · Facebook/ }).click();
  await chooseAccount(page, /Demo Meta 1/);
  await page.getByLabel(/^(Items|Spark codes) per campaign$/).fill("2");
  await page.getByLabel("Destination URL").fill("https://example.com/watch");

  await page.getByRole("button", { name: "Choose content", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose ad content" });
  await picker.getByRole("tab", { name: "From the Page" }).click();
  await picker.getByRole("combobox", { name: "Read posts from" }).selectOption({ label: "Demo Meta 1" });
  for (const caption of ["Behind the scenes from the set.", "Reel: the confession scene."])
    await picker.locator(".content-pick-row").filter({ hasText: caption }).getByRole("button", { name: "Add", exact: true }).click();
  // A pasted reference joins the draft named by what it is, never by its digits.
  await picker.getByRole("tab", { name: "Paste an id" }).click();
  await picker.getByLabel("Existing post ID").fill("9000000000000010_9000000000007777");
  await picker.getByRole("button", { name: "Add post", exact: true }).click();
  await picker.getByRole("button", { name: "Done", exact: true }).click();
  await expect(picker).toBeHidden();
  await page.getByLabel(/^(Items|Spark codes) per campaign$/).fill("3");

  const chosen = page.locator(".launch-content-item");
  await expect(chosen).toHaveCount(3);
  await expect(chosen.first().locator(".ad-card-badge")).toHaveText("Facebook");
  await expect(chosen.nth(1).locator(".ad-card-badge")).toHaveText("Instagram");
  await expect(chosen.locator("input")).toHaveCount(0);
  await expect(chosen.first()).toContainText("This ad uses the post's own caption.");
  await expect(page.locator(".launch-runs-on")).toContainText("Facebook · Instagram");
  await expect(page.getByLabel("Placements")).toHaveCount(0);

  await page.getByLabel("Campaign tag (campid)").fill("rlapple01");
  await expect(page.getByText(/will be named rlapple01/)).toBeVisible();
  await expect(page.getByText(/campid=rlapple01/)).toBeVisible();
  await expect(page.getByLabel("Daily total per campaign (USD)")).toBeVisible();

  await page.getByRole("button", { name: "Preview campaigns" }).click();
  await expect(page.getByText(/1 campaign across 1 ad account/)).toBeVisible();
  const row = page.locator(".gt-row").first();
  await expect(row).toContainText("rlapple01");
  await expect(row.getByRole("link", { name: /campid=rlapple01$/ })).toBeVisible();
  await expect(row.locator(".ad-card")).toHaveCount(3);

  await page.getByRole("button", { name: /Launch 1 campaign/ }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm launch" });
  await expect(confirm.locator(".ad-card")).toHaveCount(3);
  await expect(confirm).toContainText("Demo Meta 1");
  await expect(confirm).toContainText("Behind the scenes from the set.");
  await expect(confirm).toContainText("Facebook post");
  await expect(confirm).toContainText("rlapple01");
  // No provider reference of any kind is printed in the dialog.
  expect(await confirm.innerText()).not.toMatch(/\d{10,}/);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
});

test("Multi-account plan assigns distinct Spark posts to every campaign and monitors named accounts", async ({ page }) => {
  const base = test.info().project.use.baseURL ?? "http://localhost:3200";
  const login = await page.request.post("/api/auth/dev", { form: { kind: "producer" }, maxRedirects: 0 });
  expect([200, 303]).toContain(login.status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
  await page.request.post("/api/demo/reset", { data: { seed: "demo" } });

  await page.goto("/producer/launch");
  await chooseAccount(page, /Demo TikTok 1/);
  await chooseAccount(page, /Demo TikTok 2/);
  await page.getByLabel("Campaigns per account").fill("2");
  await page.getByLabel(/^(Items|Spark codes) per campaign$/).fill("2");
  const codes = Array.from({ length: 8 }, (_, i) => `TEST-MULTI-SPARK-${i + 1}`);
  await page.getByLabel("Paste all Spark codes, one per line").fill(codes.join("\n"));
  await page.getByLabel("Destination URL").fill("https://example.com/watch");
  await page.getByRole("button", { name: "Preview campaigns" }).click();
  await expect(page.getByText(/4 campaigns across 2 ad accounts/)).toBeVisible();
  for (let i = 0; i < 4; i++) {
    // Round 3: a Spark ad is never named by its code; the code is the card's data-content-id.
    const row = page.locator(".gt-row").filter({ has: page.locator(`[data-content-id='TEST-MULTI-SPARK-${2 * i + 1}']`) });
    await expect(row.locator(`[data-content-id='TEST-MULTI-SPARK-${2 * i + 2}']`)).toHaveCount(1);
    await expect(row).toContainText(i < 2 ? "7000000000000000001" : "7000000000000000002");
  }
  await expect(page.getByRole("button", { name: /Launch 4 campaigns/ })).toBeEnabled();
  await page.getByRole("button", { name: /Launch 4 campaigns/ }).click();
  await page.getByRole("dialog", { name: "Confirm launch" }).getByRole("button", { name: "Confirm launch", exact: true }).click();
  await expect(page).toHaveURL(/\/producer\/monitor\?run=/);
  await expect.poll(async () => {
    const response = await page.request.get("/api/producer/monitor?force=1");
    const data = await response.json() as { runs: { draft: { content: { value: string }[] }; status: string; campaigns: { status: string; content: unknown[]; budget_cents: number; connection_id: string }[] }[] };
    const run = data.runs.find((item) => item.draft.content.some((content) => content.value === codes[0]));
    return run && {
      status: run.status,
      campaigns: run.campaigns.length,
      finished: run.campaigns.filter((campaign) => campaign.status === "done").length,
      items: run.campaigns.map((campaign) => campaign.content.length),
      budget: run.campaigns.reduce((sum, campaign) => sum + campaign.budget_cents, 0),
      accounts: new Set(run.campaigns.map((campaign) => campaign.connection_id)).size,
    };
  }, { timeout: 30_000 }).toEqual({ status: "done", campaigns: 4, finished: 4, items: [2, 2, 2, 2], budget: 50_000, accounts: 2 });
  await page.goto("/producer/monitor");
  const launch = page.locator(".lm-run").first();
  await expect(launch.locator("tr[data-campaign-id]")).toHaveCount(4);
  await expect(launch.getByRole("table", { name: "Campaigns" })).toBeVisible();
  await expect(launch.locator(".lm-summary")).toContainText("Cost");
  await expect(launch.locator(".lm-summary")).toContainText("Clicks");
  await expect(launch.locator(".lm-summary")).toContainText("$/Click");
  await expect(launch.locator(".lm-summary")).toContainText("Conversions");
  await expect(launch.locator(".lm-summary")).toContainText("Approved total");
  await expect(launch.locator(".lm-summary")).toContainText("$500.00");
  await expect(launch.getByRole("columnheader", { name: "$/Conversion" })).toBeVisible();
  await expect(launch.getByRole("columnheader", { name: "CTR" })).toBeVisible();
  await expect(launch.locator("tr[data-campaign-id]").first()).toContainText("Demo TikTok 1");
  await expect(launch.locator("tr[data-campaign-id]").last()).toContainText("Demo TikTok 2");
  const monitorResponse = await page.request.get("/api/producer/monitor?force=1");
  expect(monitorResponse.ok()).toBe(true);
  const monitorRuns = await monitorResponse.json() as { runs: { draft: { content: { value: string }[] }; campaigns: { state: { campaign_id?: string }; snapshot: { spend_cents?: number | null; clicks?: number | null } | null }[] }[] };
  const monitoredRun = monitorRuns.runs.find(run => run.draft.content.some(content => content.value === codes[0]));
  const externalCampaignId = monitoredRun?.campaigns[0]?.state.campaign_id;
  expect(externalCampaignId).toBeTruthy();
  const totalCost = monitoredRun!.campaigns.reduce((sum, campaign) => sum + (campaign.snapshot?.spend_cents ?? 0), 0);
  const totalClicks = monitoredRun!.campaigns.reduce((sum, campaign) => sum + (campaign.snapshot?.clicks ?? 0), 0);
  if (monitoredRun!.campaigns.every(campaign => campaign.snapshot?.spend_cents != null))
    await expect(launch.locator(".lm-summary")).toContainText(new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(totalCost / 100));
  if (monitoredRun!.campaigns.every(campaign => campaign.snapshot?.clicks != null))
    await expect(launch.locator(".lm-summary")).toContainText(new Intl.NumberFormat("en-US").format(totalClicks));
  await page.getByRole("button", { name: "Details" }).first().click();
  // The provider's own campaign id is expanded detail, never the row's headline.
  await expect(page.locator(".lm-detail").first()).toContainText(externalCampaignId!);
  await expect(page.locator(".lm-detail").first()).toContainText("7000000000000000001");
  // Round 3: the Spark codes are present on the cards but never printed as text.
  await expect(page.locator(".lm-detail").first()).not.toContainText("TEST-MULTI-SPARK-1");
  await expect(page.locator(".lm-detail").first().locator(".ad-card[data-content-id='TEST-MULTI-SPARK-1']")).toHaveCount(1);
  await expect(page.locator(".lm-detail").first().locator(".ad-card[data-content-id='TEST-MULTI-SPARK-2']")).toHaveCount(1);
  const budget = await openControl(page, "Change lifetime budget");
  await expect(budget.getByRole("spinbutton")).toHaveValue("125");
  await budget.getByRole("button", { name: "Cancel" }).click();
  await expect(budget).toBeHidden();
  await expect(page.getByRole("button", { name: "Change daily budget" })).toHaveCount(0);
});

test("Daily cost-cap launch, controls, staff monitor, and higher-budget round", async ({ page }) => {
  test.setTimeout(180_000);
  type Campaign = { id: string; name: string; index: number; status: string; budget_cents: number; daily_budget_cents: number | null; state: { campaign_id?: string; desired_status?: string }; snapshot: { delivery: string; configured_status?: string; groups?: { bid_cents?: number | null }[] } | null };
  type Run = { id: string; round: number; parent_run_id: string | null; status: string; draft: { name: string; total_budget_cents: number; daily_budget_cents: number | null; tiktok_settings: { bid_strategy: string; bid_usd: number | null }; content: { value: string }[] }; campaigns: Campaign[] };
  const base = test.info().project.use.baseURL ?? "http://localhost:3200";
  const login = await page.request.post("/api/auth/dev", { form: { kind: "producer" }, maxRedirects: 0 });
  expect([200, 303]).toContain(login.status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
  expect((await page.request.post("/api/demo/reset", { data: { seed: "demo" } })).ok()).toBe(true);
  const staffContext = await page.context().browser()!.newContext({ baseURL: base });
  const staffLogin = await staffContext.request.post("/api/auth/dev", { form: { kind: "staff" }, maxRedirects: 0 });
  expect(staffLogin.status()).toBe(303);
  await staffContext.addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
  const presetName = `Acceptance cost cap ${test.info().project.name}-${Date.now()}`;
  const preset = await staffContext.request.post("/api/admin/tiktok/presets", { data: {
    name: presetName, settings: { ...defaultLaunchSettings(), budget_mode: "BUDGET_MODE_DAY", daily_budget_usd: 20, bid_strategy: "COST_CAP", bid_usd: 0.5, start_paused: true }, note: null,
  } });
  expect(preset.ok()).toBe(true);
  const readRun = async (id: string) => {
    const response = await page.request.get("/api/producer/monitor?force=1");
    expect(response.ok()).toBe(true);
    const data = await response.json() as { runs: Run[] };
    return data.runs.find((run) => run.id === id);
  };

  await page.goto("/producer/launch");
  await page.getByLabel("Launch name").fill("Acceptance pacing");
  await chooseAccount(page, /Demo TikTok 1/);
  await chooseAccount(page, /Demo TikTok 2/);
  await page.getByLabel("Campaigns per account").fill("2");
  await page.getByLabel(/^(Items|Spark codes) per campaign$/).fill("2");
  const codes = Array.from({ length: 8 }, (_, i) => `TEST-PACING-SPARK-${i + 1}`);
  await page.getByLabel("Paste all Spark codes, one per line").fill(codes.join("\n"));
  await page.getByLabel("Destination URL").fill("https://example.com/watch");
  await page.getByLabel("Preset").selectOption({ label: presetName });
  await expect(page.getByLabel("Daily total per campaign (USD)")).toHaveValue("20");
  const firstPreview = page.waitForResponse((response) => response.url().endsWith("/preview") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Preview campaigns" }).click();
  const plan = (await (await firstPreview).json()) as { plan: { campaign_count: number; total_budget_cents: number; daily_total_cents: number; rows: { budget_cents: number; daily_budget_cents: number; content: unknown[] }[] } };
  expect(plan.plan).toMatchObject({ campaign_count: 4, total_budget_cents: 50_000, daily_total_cents: 8_000 });
  expect(plan.plan.rows.map((row) => [row.budget_cents, row.daily_budget_cents, row.content.length])).toEqual(Array(4).fill([12_500, 2_000, 2]));
  await expect(page.getByText(/4 campaigns across 2 ad accounts/)).toBeVisible();
  await expect(page.getByText(/\$500\.00 lifetime total · \$80\.00 daily total/)).toBeVisible();
  const firstSubmit = page.waitForResponse((response) => response.url().endsWith("/launch") && response.request().method() === "POST");
  await page.getByRole("button", { name: /Launch 4 campaigns/ }).click();
  await page.getByRole("dialog", { name: "Confirm launch" }).getByRole("button", { name: "Confirm launch", exact: true }).click();
  const firstRun = (await (await firstSubmit).json()) as { run: { id: string } };
  await expect.poll(async () => (await readRun(firstRun.run.id))?.status, { timeout: 40_000 }).toBe("done");
  const launched = (await readRun(firstRun.run.id))!;
  expect(launched.campaigns).toHaveLength(4);
  expect(launched.campaigns.map((campaign) => campaign.state.campaign_id).every(Boolean)).toBe(true);
  expect(launched.campaigns.map((campaign) => campaign.snapshot?.delivery)).toEqual(Array(4).fill("paused"));
  expect(launched.draft.tiktok_settings).toMatchObject({ bid_strategy: "COST_CAP", bid_usd: 0.5 });

  await page.goto("/producer/monitor");
  await expect(page.getByText("Off", { exact: true })).toHaveCount(4);
  await page.getByRole("button", { name: "Details" }).first().click();
  await amountControl(page, "Change lifetime budget", 100, "$125.00");
  await expect.poll(async () => (await readRun(firstRun.run.id))?.campaigns[0].budget_cents).toBe(10_000);
  const overCap = await openControl(page, "Change lifetime budget");
  await overCap.getByRole("spinbutton").fill("126");
  await overCap.getByRole("button", { name: "Save change" }).click();
  await expect(overCap.getByRole("alert")).toContainText("approved maximum is $125.00");
  expect((await readRun(firstRun.run.id))?.campaigns[0].budget_cents).toBe(10_000);
  await overCap.getByRole("button", { name: "Cancel" }).click();
  await amountControl(page, "Change daily budget", 25);
  await expect.poll(async () => (await readRun(firstRun.run.id))?.campaigns[0].daily_budget_cents).toBe(2_500);
  await amountControl(page, "Set bid cap", 0.75);
  await expect.poll(async () => (await readRun(firstRun.run.id))?.campaigns[0].snapshot?.groups?.[0]?.bid_cents).toBe(75);
  const endDialog = await openControl(page, "End campaign");
  const endChange = page.waitForResponse(response => response.url().endsWith("/controls") && response.request().method() === "POST");
  await endDialog.getByRole("button", { name: "End campaign", exact: true }).click();
  expect((await endChange).ok()).toBe(true);
  await expect(endDialog).toBeHidden();
  await expect.poll(async () => (await readRun(firstRun.run.id))?.campaigns[0].snapshot?.delivery).toBe("ended");

  const staffPage = await staffContext.newPage();
  await staffPage.goto("/promote/monitor");
  // Round 2: Studio shows "<launch name> · <n>", never the campid or an lr_ key.
  await expect(staffPage.locator(`[data-campaign-id="${launched.campaigns[0].id}"]`)).toContainText("Acceptance pacing · 1");
  await expect(staffPage.locator(`[data-campaign-id="${launched.campaigns[0].id}"]`)).not.toContainText(launched.campaigns[0].name);
  const staffResponse = await staffContext.request.get("/api/promote/launches?force=1");
  expect(staffResponse.ok()).toBe(true);
  const staffRuns = (await staffResponse.json()) as { runs: Run[] };
  expect(staffRuns.runs.find((run) => run.id === firstRun.run.id)?.campaigns.map((campaign) => campaign.id)).toEqual(launched.campaigns.map((campaign) => campaign.id));

  let releaseRoundGet = () => {};
  const roundGetHeld = new Promise<void>((resolve) => { releaseRoundGet = resolve; });
  let signalRoundGet = () => {};
  const roundGetStarted = new Promise<void>((resolve) => { signalRoundGet = resolve; });
  await page.route(/\/api\/producer\/launch\/[0-9a-f-]{36}$/, async (route) => {
    if (route.request().method() === "GET") { signalRoundGet(); await roundGetHeld; }
    await route.continue();
  });
  const roundClick = page.getByRole("button", { name: "New round" }).first().click();
  await roundGetStarted;
  await expect(page.getByLabel("Overall lifetime budget (USD)")).toHaveCount(0, { timeout: 2_000 });
  releaseRoundGet();
  await roundClick;
  await page.unroute(/\/api\/producer\/launch\/[0-9a-f-]{36}$/);
  await expect(page).toHaveURL(/\/producer\/launch\/[0-9a-f-]+$/);
  const roundTwoId = page.url().split("/").at(-1)!;
  await expect(page.getByLabel("Launch name")).toHaveValue("Acceptance pacing-r2");
  await page.getByLabel("Overall lifetime budget (USD)").fill("600");
  const secondPreview = page.waitForResponse((response) => response.url().endsWith("/preview") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Preview campaigns" }).click();
  const nextPlan = (await (await secondPreview).json()) as { plan: { total_budget_cents: number; daily_total_cents: number; rows: { budget_cents: number }[] } };
  expect(nextPlan.plan.total_budget_cents).toBe(60_000);
  expect(nextPlan.plan.daily_total_cents).toBe(8_000);
  expect(nextPlan.plan.rows.map((row) => row.budget_cents)).toEqual(Array(4).fill(15_000));
  await page.getByRole("button", { name: /Launch 4 campaigns/ }).click();
  await page.getByRole("dialog", { name: "Confirm launch" }).getByRole("button", { name: "Confirm launch", exact: true }).click();
  await expect.poll(async () => (await readRun(roundTwoId))?.status, { timeout: 40_000 }).toBe("done");
  const roundTwo = (await readRun(roundTwoId))!;
  expect(roundTwo.round).toBe(2);
  expect(roundTwo.parent_run_id).toBe(firstRun.run.id);
  expect(roundTwo.campaigns.map((campaign) => campaign.state.campaign_id).every(Boolean)).toBe(true);
  expect(roundTwo.campaigns.map((campaign) => campaign.state.campaign_id).some((id) => launched.campaigns.some((original) => original.state.campaign_id === id))).toBe(false);
  expect(roundTwo.campaigns.map((campaign) => campaign.snapshot?.delivery)).toEqual(Array(4).fill("paused"));
  await staffContext.close();
});
