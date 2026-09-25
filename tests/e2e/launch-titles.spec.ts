import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { chooseTikTokTitle, WAR_GOD_LINK, WAR_GOD_TITLE } from "./tiktok-title";

// A title per ad (Ruobin, 2026-09-24): one TikTok launch promotes two titles,
// each Spark code row names its own and carries that title's own link, from
// step 3 through the preview and the confirm dialog to the Monitor (the
// title on every campaign and ad row, the Title filter, each ad's own
// numbers), the "By title" table and the title's own results page with the
// crazydramas dashboard link. And on staff /tiktok the link form opens under
// the row it belongs to.

const TWINS = "Revenge with My Twins";
const TWINS_LINK = "https://crazydramas.com/watch/fixture-film-partial?source=tiktok&campaign=__CAMPAIGN_ID__&adgroup=__AID__&creative=__CID__";
const SHOTS = "tmp/e2e-shots/launch-titles";

async function signIn(page: Page, kind: "producer" | "staff") {
  const base = test.info().project.use.baseURL ?? "http://localhost:3202";
  expect([200, 303]).toContain((await page.request.post("/api/auth/dev", { form: { kind }, maxRedirects: 0 })).status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
}
async function chooseAccount(page: Page, name: RegExp) {
  const picker = page.locator("details.launch-account-picker");
  if (await picker.count() && await picker.getAttribute("open") === null) await picker.locator("summary").click();
  await page.getByRole("checkbox", { name }).check();
}

test.describe.configure({ mode: "serial" });

test("one TikTok launch promotes two titles, each ad with its own title and link, through to the monitor and the title's results", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await signIn(page, "producer");
  expect((await page.request.post("/api/demo/reset", { data: { seed: "demo" } })).ok()).toBe(true);
  await page.goto("/producer/launch");
  await page.getByLabel(/^(Items|Spark codes|Ads) per campaign$/).fill("2");
  await chooseAccount(page, /Demo TikTok 1/);
  await page.getByLabel("Paste all Spark codes, one per line").fill("TITLES-SPARK-ONE\nTITLES-SPARK-TWO");
  await chooseTikTokTitle(page);

  // Step 3: one row per code, both on the launch's title until one is changed.
  const rows = page.getByTestId("launch-ad-titles");
  await expect(rows.locator("[data-ad-row]")).toHaveCount(2);
  await expect(rows.locator("[data-ad-row='1'] [data-testid='ad-row-url']")).toHaveText(WAR_GOD_LINK);
  await expect(rows.locator("[data-ad-row='2'] [data-testid='ad-row-url']")).toHaveText(WAR_GOD_LINK);
  const second = rows.getByLabel("Title for ad 2");
  const twinsId = await second.locator("option", { hasText: TWINS }).getAttribute("value");
  await second.selectOption(twinsId!);
  await expect(rows.locator("[data-ad-row='2'] [data-testid='ad-row-url']")).toHaveText(TWINS_LINK);
  await expect(rows.locator("[data-ad-row='1'] [data-testid='ad-row-url']")).toHaveText(WAR_GOD_LINK);
  await rows.screenshot({ path: `${SHOTS}/${test.info().project.name}-step3-rows.png` });

  // Preview: each ad names its title and its own link.
  await page.getByRole("button", { name: "Preview campaigns" }).click();
  const previewLines = page.getByTestId("preview-ad-title");
  await expect(previewLines).toHaveCount(2);
  await expect(previewLines.nth(0)).toContainText(WAR_GOD_TITLE);
  await expect(previewLines.nth(1)).toContainText(TWINS);
  await expect(previewLines.nth(1).locator("a")).toHaveAttribute("href", TWINS_LINK);

  // Confirm: two links, so the destination says so and each ad carries its own.
  await page.getByRole("button", { name: /Launch 1 campaign/ }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm launch" });
  await expect(confirm.getByTestId("confirm-destination-per-ad")).toBeVisible();
  const confirmLines = confirm.getByTestId("confirm-ad-title");
  await expect(confirmLines).toHaveCount(2);
  await expect(confirmLines.nth(0)).toContainText(WAR_GOD_LINK);
  await expect(confirmLines.nth(1)).toContainText(TWINS);
  await expect(confirmLines.nth(1)).toContainText(TWINS_LINK);
  await expect(confirm).not.toContainText("TITLES-SPARK-ONE");
  await confirm.screenshot({ path: `${SHOTS}/${test.info().project.name}-confirm.png` });
  await confirm.getByRole("button", { name: "Confirm launch", exact: true }).click();
  await expect(page).toHaveURL(/\/producer\/monitor\?run=/);
  await expect.poll(async () => {
    const data = await (await page.request.get("/api/producer/monitor?force=1")).json() as { runs: { draft: { content: { value: string }[] }; status: string }[] };
    return data.runs.find((r) => r.draft.content.some((c) => c.value === "TITLES-SPARK-ONE"))?.status;
  }, { timeout: 20_000 }).toBe("done");

  // Monitor: the campaign names both titles; switched on, every ad reads its own numbers.
  await page.goto("/producer/monitor");
  const run = page.locator(".lm-run").filter({ has: page.locator("[data-testid='run-titles']", { hasText: TWINS }) }).first();
  await expect(run.getByTestId("campaign-title")).toContainText(`${WAR_GOD_TITLE} · ${TWINS}`);
  await run.getByRole("button", { name: "Resume campaign" }).click();
  await expect.poll(async () => {
    const data = await (await page.request.get("/api/producer/monitor?force=1")).json() as { runs: { draft: { content: { value: string }[] }; campaigns: { snapshot: { ads?: { stats?: unknown }[] } | null }[] }[] };
    const mine = data.runs.find((r) => r.draft.content.some((c) => c.value === "TITLES-SPARK-ONE"));
    return mine?.campaigns[0]?.snapshot?.ads?.filter((ad) => ad.stats).length ?? 0;
  }, { timeout: 30_000 }).toBe(2);
  await page.reload();
  const campaign = page.locator(".lm-run").filter({ has: page.locator("[data-testid='run-titles']", { hasText: TWINS }) }).first();
  await campaign.getByRole("button", { name: "Details" }).first().click();
  const adTitles = campaign.getByTestId("ad-title");
  await expect(adTitles).toHaveCount(2);
  await expect(adTitles.nth(0)).toHaveText(WAR_GOD_TITLE);
  await expect(adTitles.nth(1)).toHaveText(TWINS);
  await expect(campaign.getByTestId("ad-stats")).toHaveCount(2);
  await expect(campaign.getByTestId("ad-stats").first()).toContainText("CTR");
  // Each ad's "Open landing page" is its own title's page.
  await expect(campaign.getByTestId("ad-landing-link").nth(1)).toHaveAttribute("href", /^https:\/\/crazydramas\.com\/watch\/fixture-film-partial\?source=tiktok&campaign=\d+&adgroup=\d+&creative=\d+$/);
  await campaign.screenshot({ path: `${SHOTS}/${test.info().project.name}-monitor-ads.png` });

  // The Title filter keeps a launch that promotes the title and drops one that does not.
  const filter = page.getByTestId("monitor-title-filter");
  await filter.selectOption({ label: TWINS });
  await expect(page.locator(".lm-run").first()).toBeVisible();
  expect((await page.getByTestId("run-titles").allTextContents()).every((names) => names.includes(TWINS))).toBe(true);
  expect(await page.locator(".lm-run").count()).toBe(await page.getByTestId("run-titles").count());
  await filter.selectOption("all");

  // By title: both titles, each opening its own results page.
  await page.getByRole("button", { name: "By title", exact: true }).click();
  const table = page.getByTestId("by-title-table");
  await expect(table.locator("tbody tr", { hasText: TWINS })).toHaveCount(1);
  await expect(table.locator("tbody tr", { hasText: WAR_GOD_TITLE })).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-by-title.png`, fullPage: true });
  await table.getByRole("link", { name: TWINS }).click();
  await expect(page).toHaveURL(/\/producer\/monitor\/titles\//);
  await expect(page.getByRole("heading", { name: TWINS, level: 1 })).toBeVisible();
  await expect(page.getByTestId("title-totals")).toBeVisible();
  await expect(page.getByTestId("title-ads").locator("tbody tr")).toHaveCount(1);
  await expect(page.getByTestId("title-campaigns")).toContainText("Shares the campaign with other titles");
  await expect(page.getByTestId("crazydramas-dashboard-link")).toHaveAttribute("href", "https://crazydramas.com/admin/dashboard");
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-title-results.png`, fullPage: true });

  // The title's own pages read the same launches: its Ad campaigns section and
  // its (otherwise empty) TikTok revenue & audience pages.
  for (const section of ["campaigns", "analytics"]) {
    await page.goto(`/producer/titles/${twinsId}/${section}`);
    const summary = page.getByTestId("title-launch-summary");
    await expect(summary).toContainText("Ad results from Studio launches");
    await expect(summary).toContainText("1 launch(es), 1 campaign(s), 1 ad(s)");
    await expect(summary.getByRole("link", { name: /Ad results/ })).toHaveAttribute("href", `/producer/monitor/titles/${twinsId}`);
  }
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-title-analytics.png`, fullPage: true });
});

test("staff /tiktok: the Link to company form opens under its Business Center row and takes the focus", async ({ page }) => {
  await signIn(page, "staff");
  await page.goto("/tiktok");
  const row = page.locator(".tk-bc-table .gt-row").first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /Link to company|Change company/ }).click();
  const form = page.getByTestId("tiktok-assign-form");
  await expect(form).toBeVisible();
  // Directly under the row it belongs to (not below the table), and on screen.
  await expect(row.locator("xpath=following-sibling::*[1]")).toHaveAttribute("data-testid", "tiktok-assign-form");
  await expect(form).toBeInViewport();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[data-testid='tiktok-assign-form']"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(form).toBeHidden();
});
