import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { defaultLaunchDraft } from "../../lib/launch/plan";

test("monitor keeps newest launch visible, focuses a linked run, and survives workspace failure", async ({ page }) => {
  const base = test.info().project.use.baseURL ?? "http://localhost:3200";
  const login = await page.request.post("/api/auth/dev", { form: { kind: "producer" }, maxRedirects: 0 });
  expect([200, 303]).toContain(login.status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
  expect((await page.request.post("/api/demo/reset", { data: { seed: "demo" } })).ok()).toBe(true);

  const create = async (name: string) => {
    const response = await page.request.post("/api/producer/launch", { data: { draft: { ...defaultLaunchDraft(), name } } });
    expect(response.ok()).toBe(true);
    return (await response.json() as { run: { id: string; external_id: string } }).run;
  };
  const older = await create("Monitor older run");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const newer = await create("Monitor newest run");
  await page.route("**/api/producer/launch/workspace", (route) => route.abort());
  await page.goto(`/producer/monitor?run=${newer.external_id}`);
  const newest = page.locator(`[data-run-id="${newer.external_id}"]`);
  await expect(newest).toBeVisible();
  await expect(page.locator(`[data-run-id="${older.external_id}"]`)).toHaveCount(0);
  // The grey line under the name is provider · round · date, with no "Created" label.
  await expect(newest.locator(".lm-eyebrow")).toContainText("TikTok");
  await expect(newest.locator(".lm-eyebrow")).toContainText("Round 1");
  await expect(page.getByText("Created", { exact: true })).toHaveCount(0);
  // A draft has no campaigns, so nothing is ever "not checked yet" about it.
  await expect(newest.locator(".mr2-checked")).toHaveText("Not launched yet");
  await expect(page.getByText("Not checked yet")).toHaveCount(0);

  // Renaming is inline, on the name itself, and Enter saves it.
  await newest.getByRole("button", { name: "Rename this launch" }).click();
  const field = newest.getByRole("textbox", { name: "Launch name" });
  await field.fill("Xinghai · Sep 17");
  await field.press("Enter");
  await expect(newest.getByRole("link", { name: "Xinghai · Sep 17" })).toBeVisible();
  await page.reload();
  await expect(page.locator(`[data-run-id="${newer.external_id}"]`).getByRole("link", { name: "Xinghai · Sep 17" })).toBeVisible();

  await page.getByRole("button", { name: "Show all launches" }).click();
  const cards = page.locator("[data-run-id]");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toHaveAttribute("data-run-id", newer.external_id);
  await page.getByRole("searchbox", { name: "Search" }).fill("Monitor older");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("data-run-id", older.external_id);
  const staff = await page.context().browser()!.newContext({ baseURL: base });
  try {
    const staffLogin = await staff.request.post("/api/auth/dev", { form: { kind: "staff" }, maxRedirects: 0 });
    expect([200, 303]).toContain(staffLogin.status());
    await staff.addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
    const staffPage = await staff.newPage();
    await staffPage.goto(`/promote/monitor?run=${newer.id}`);
    await expect(staffPage.locator(`[data-run-id="${newer.external_id}"]`)).toBeVisible();
    await expect(staffPage.locator(`[data-run-id="${older.external_id}"]`)).toHaveCount(0);
    await expect(staffPage.getByRole("heading", { name: "Launch", exact: true })).toHaveCount(0);
    await staffPage.getByRole("button", { name: "Show all launches" }).click();
    await expect(staffPage.locator("[data-run-id]")).toHaveCount(2);
  } finally {
    await staff.close();
  }
});

test("campaign table scrolls within a narrow Monitor page", async ({ page }) => {
  const base = test.info().project.use.baseURL ?? "http://localhost:3202";
  expect([200, 303]).toContain((await page.request.post("/api/auth/dev", { form: { kind: "producer" }, maxRedirects: 0 })).status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
  expect((await page.request.post("/api/demo/reset", { data: { seed: "demo" } })).ok()).toBe(true);
  const workspaceResponse = await page.request.get("/api/producer/launch/workspace");
  expect(workspaceResponse.ok()).toBe(true);
  const workspace = await workspaceResponse.json() as { workspace: { connections: { id: string; provider: string; name: string }[] } };
  const account = workspace.workspace.connections.find(connection => connection.provider === "tiktok" && /Demo TikTok 1/.test(connection.name));
  expect(account).toBeDefined();
  const draft = { ...defaultLaunchDraft("tiktok"), name: "Narrow monitor table", account_ids: [account!.id], content_per_campaign: 1,
    content: [{ kind: "spark", value: "MOBILE-MONITOR-SPARK" }], destination_url: "https://example.com/watch" };
  const savedResponse = await page.request.post("/api/producer/launch", { data: { draft } });
  expect(savedResponse.ok()).toBe(true);
  const saved = await savedResponse.json() as { run: { id: string; revision: number; external_id: string } };
  expect((await page.request.post(`/api/producer/launch/${saved.run.id}/preview`)).ok()).toBe(true);
  expect((await page.request.post(`/api/producer/launch/${saved.run.id}/launch`, { data: { revision: saved.run.revision } })).ok()).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/producer/monitor?run=${saved.run.external_id}`);
  const run = page.locator(`[data-run-id="${saved.run.external_id}"]`);
  await expect(run.locator("tr[data-campaign-id]")).toHaveCount(1);
  // The campaign is the launch's own name and number, never `launch-…-001`.
  await expect(run.locator(".lm-campaign-name")).toHaveText("Narrow monitor table · 1");
  const widths = await page.evaluate(() => {
    const tableScroll = document.querySelector<HTMLElement>(".lm-table-scroll")!;
    return { viewport: innerWidth, body: document.body.scrollWidth, table: tableScroll.scrollWidth, visibleTable: tableScroll.clientWidth };
  });
  expect(widths.body).toBeLessThanOrEqual(widths.viewport + 1);
  expect(widths.table).toBeGreaterThan(widths.visibleTable);
  await page.evaluate(() => window.scrollTo({ left: 9999 }));
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
  const tableEnd = await page.evaluate(() => { const scroller = document.querySelector<HTMLElement>(".lm-table-scroll")!; scroller.scrollLeft = scroller.scrollWidth; return { left: scroller.scrollLeft, maximum: scroller.scrollWidth - scroller.clientWidth }; });
  expect(tableEnd.left).toBeGreaterThan(0);
  expect(tableEnd.left).toBe(tableEnd.maximum);
  await expect(run.getByRole("button", { name: "Details" })).toBeVisible();
  await page.evaluate(() => { document.querySelector<HTMLElement>(".lm-table-scroll")!.scrollLeft = 0; });
  if (test.info().project.name === "desktop") {
    mkdirSync("docs/demo/launch-v2", { recursive: true });
    const themeButton = page.getByRole("button", { name: "Toggle theme" });
    for (const theme of ["light", "dark"] as const) {
      if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) { await themeButton.click(); await page.waitForTimeout(250); }
      for (const width of [1440, 1920, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.waitForTimeout(100);
        if (width === 390) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
        await page.screenshot({ path: `docs/demo/launch-v2/2026-09-16-monitor-${theme}-${width}.png`, fullPage: width !== 390 });
      }
    }
  }
});

/** A Meta launch on one account whose content spans both platforms. */
async function launchMeta(page: Page, name: string) {
  const workspace = await (await page.request.get("/api/producer/launch/workspace")).json() as
    { workspace: { connections: { id: string; provider: string; name: string }[] } };
  const account = workspace.workspace.connections.find(c => c.provider === "meta" && /Demo Meta 1/.test(c.name));
  expect(account, "the demo seed assigns a Meta account").toBeDefined();
  const base = defaultLaunchDraft("meta");
  const draft = {
    ...base, name, account_ids: [account!.id], campaigns_per_account: 1, content_per_campaign: 2,
    destination_url: "https://example.com/watch", campid_start: "rlapple01",
    meta_settings: { ...base.meta_settings, placements: ["facebook", "instagram"] },
    content: [{ kind: "facebook_post", value: "9000000000000010_123" }, { kind: "instagram_post", value: "9000000000000020" }],
  };
  const created = await page.request.post("/api/producer/launch", { data: { draft } });
  expect(created.ok(), await created.text()).toBe(true);
  const run = (await created.json() as { run: { id: string; revision: number; external_id: string } }).run;
  const preview = await page.request.post(`/api/producer/launch/${run.id}/preview`);
  expect(preview.ok(), await preview.text()).toBe(true);
  const launched = await page.request.post(`/api/producer/launch/${run.id}/launch`, { data: { revision: run.revision } });
  expect(launched.ok(), await launched.text()).toBe(true);
  return run;
}

test("the staff monitor names the launch, badges its ad sets, and turns a Meta refusal into a next step", async ({ page }) => {
  const base = test.info().project.use.baseURL ?? "http://localhost:3202";
  expect([200, 303]).toContain((await page.request.post("/api/auth/dev", { form: { kind: "producer" }, maxRedirects: 0 })).status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
  expect((await page.request.post("/api/demo/reset", { data: { seed: "demo" } })).ok()).toBe(true);
  const run = await launchMeta(page, "Xinghai · Sep 17");

  expect([200, 303]).toContain((await page.request.post("/api/auth/dev", { form: { kind: "staff" }, maxRedirects: 0 })).status());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/promote/monitor?run=${run.external_id}`);
  const card = page.locator(`[data-run-id="${run.external_id}"]`);
  await expect(card).toBeVisible();
  const row = card.locator("tr[data-campaign-id]").first();

  // The campaign is "<launch name> · 1", the account name sits under it, and the
  // ad sets carry a badge each. No `act_…` id anywhere in the collapsed row.
  await expect(row.locator(".lm-campaign-name")).toHaveText("Xinghai · Sep 17 · 1");
  await expect(row.locator(".lm-account-line")).toContainText("Demo Meta 1");
  await expect(row.locator(".mr2-badge")).toHaveText(["Facebook", "Instagram"]);
  expect(await row.innerText()).not.toContain("act_");

  // Either the first sweep has already settled the switch, or the row says so in
  // words — never "Switch unknown" and never "Checking".
  const delivery = row.locator(".lm-delivery");
  await expect(delivery).not.toHaveText("Checking");
  await expect(row.locator(".lm-state-toggle")).toBeVisible();
  await expect(page.getByText("Switch unknown")).toHaveCount(0);
  await expect(delivery).toHaveText(/Paused|In review|Delivering|Created paused on Meta|Not checked yet/);
  // The sweep starts by itself; within ten seconds the launch has a real time.
  await expect(card.locator(".mr2-checked")).toContainText("Last checked", { timeout: 10_000 });

  // The ids live in the expanded row, with the campid and the tracking link.
  await row.getByRole("button", { name: "Details" }).click();
  const detail = card.locator(".lm-detail").first();
  await expect(detail.locator(".mr2-detail-links")).toContainText("rlapple01");
  await expect(detail.locator(".mr2-detail-links a")).toHaveAttribute("href", /campid=rlapple01/);
  await expect(detail.locator(".mr2-detail-links")).toContainText("act_");
  await expect(detail.locator(".mr2-ads .ad-card")).toHaveCount(2);
  await expect(detail.locator(".mr2-group .mr2-badge")).toHaveText(["Facebook", "Instagram"]);
  await row.getByRole("button", { name: "Hide" }).click();

  if (test.info().project.name === "desktop") {
    mkdirSync("docs/demo/launch-v2", { recursive: true });
    await page.screenshot({ path: "docs/demo/launch-v2/2026-09-17-desktop-monitor-healthy.png", fullPage: true });
  }

  // A failed campaign carrying Meta's development-mode refusal reads as a next
  // step: the hint sentence first, Meta's own words beneath, then Retry.
  const refusal = "Meta rejected the request (HTTP 400, code 100/1885183): Invalid parameter — The Marketing API call cannot be made while the app is in Development mode.";
  await page.route("**/api/promote/launches*", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { runs: { external_id: string; status: string; error: string | null; campaigns: { status: string; error: string | null }[] }[] };
    for (const item of body.runs) {
      if (item.external_id !== run.external_id) continue;
      item.status = "failed";
      item.error = refusal;
      for (const campaign of item.campaigns) { campaign.status = "failed"; campaign.error = refusal; }
    }
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  const failed = page.locator(`[data-run-id="${run.external_id}"]`);
  const block = failed.locator("[data-failure]").first();
  await expect(block.locator(".mr2-hint")).toContainText("Your Meta app is in Development mode");
  await expect(block.locator(".mr2-hint")).toContainText("Publish");
  await expect(block.locator(".mr2-said")).toContainText("Meta said:");
  await expect(block.locator(".mr2-said")).toContainText("code 100/1885183");
  await expect(block.getByRole("button", { name: "Retry" })).toBeVisible();

  if (test.info().project.name === "desktop") {
    await page.screenshot({ path: "docs/demo/launch-v2/2026-09-17-desktop-monitor-failed.png", fullPage: true });
  }
  await page.unroute("**/api/promote/launches*");
});
