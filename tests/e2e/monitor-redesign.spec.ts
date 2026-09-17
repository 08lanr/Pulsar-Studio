import { test, expect } from "@playwright/test";
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
  await expect(page.locator(`[data-run-id="${newer.external_id}"]`)).toBeVisible();
  await expect(page.locator(`[data-run-id="${older.external_id}"]`)).toHaveCount(0);
  await expect(page.getByText("Created", { exact: true })).toBeVisible();
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
