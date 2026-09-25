import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { chooseTikTokTitle } from "./tiktok-title";

test("built-in Sales preset and saved Instant Page design reach the launch preview", async ({ page }) => {
  const base = test.info().project.use.baseURL ?? "http://localhost:3202";
  const staff = await page.context().browser()!.newContext({ baseURL: base });
  const name = `Launch page design ${Date.now()}`;
  mkdirSync("docs/demo/launch-v2", { recursive: true });
  try {
    expect((await staff.request.post("/api/auth/dev", { form: { kind: "staff" }, maxRedirects: 0 })).status()).toBe(303);
    await staff.addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
    const templates = await staff.newPage();
    await templates.goto("/tiktok/templates");
    // Website purchases is the TikTok default (decision 2026-09-23); the Instant Page built-in stays beside it.
    await expect(templates.locator(".tk-presets li").first()).toContainText("(default) · Website purchases · Purchase · $30/day");
    const builtIn = templates.locator(".tk-presets li").filter({ hasText: "(default) · 1 Geo Sales · $0.20 cost cap" });
    await expect(builtIn).toHaveCount(1);
    await expect(builtIn.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await templates.getByRole("link", { name: "Instant Page templates" }).click();
    await templates.getByRole("button", { name: "New template" }).click();
    await templates.getByLabel("Template name").fill(name);
    await templates.getByLabel("Button text").fill("See episodes");
    await templates.getByLabel("Background").selectOption("black");
    await templates.getByRole("checkbox", { name: "Show animated tap hint" }).check();
    await expect(templates.getByLabel("Page design preview")).toContainText("See episodes");
    await templates.screenshot({ path: `docs/demo/launch-v2/2026-09-16-${test.info().project.name}-instant-page-template-editor.png`, fullPage: true });

    expect([200, 303]).toContain((await page.request.post("/api/auth/dev", { form: { kind: "producer" }, maxRedirects: 0 })).status());
    await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
    await page.goto("/producer/launch");
    await page.getByLabel("Preset").selectOption({ label: "(default) · 1 Geo Sales · $0.20 cost cap" });
    // Website purchases is the default, so the Sales preset is a real edit: its first save moves the page to the
    // saved draft's own address, a new Launch instance. Edit only once that page holds the run.
    await page.waitForURL(/\/producer\/launch\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const pageTemplate = page.getByLabel("Instant Page template");
    await expect(pageTemplate).toBeVisible();
    await expect(pageTemplate.locator("option").filter({ hasText: name })).toHaveCount(0);

    const saved = templates.waitForResponse(response => response.url().endsWith("/api/admin/tiktok/instant-page-templates") && response.request().method() === "POST");
    await templates.getByRole("button", { name: "Save" }).click();
    expect((await saved).ok()).toBe(true);
    await expect(templates.locator(".tk-presets li").filter({ hasText: name })).toContainText("See episodes · Black");

    await page.bringToFront();
    const refreshed = page.waitForResponse(response => response.url().endsWith("/api/producer/tiktok/instant-page-templates") && response.request().method() === "GET");
    await pageTemplate.focus();
    expect((await refreshed).ok()).toBe(true);
    await expect(pageTemplate.locator("option").filter({ hasText: name })).toHaveCount(1);
    await pageTemplate.selectOption({ label: name });
    await page.getByLabel(/^(Items|Spark codes|Ads) per campaign$/).fill("1");
    const accounts = page.locator("details.launch-account-picker");
    if (await accounts.getAttribute("open") === null) await accounts.locator("summary").click();
    await accounts.getByRole("checkbox", { name: /Demo TikTok 1/ }).check();
    await page.getByLabel("Paste all Spark codes, one per line").fill("TEMPLATE-ACCEPTANCE-SPARK");
    await chooseTikTokTitle(page);
    const previewResponse = page.waitForResponse(response => response.url().endsWith("/preview") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Preview campaigns" }).click();
    expect((await previewResponse).ok()).toBe(true);
    const review = page.locator(".launch-flow > .rs-panel").last();
    await expect(review).toContainText(name);
    await expect(review).toContainText("See episodes");
    await expect(review).toContainText("Black");
    await expect(review).toContainText("Show animated tap hint");
    await expect(review).toContainText("Campid");
    await expect(review).toContainText("Tracking link");
    await page.screenshot({ path: `docs/demo/launch-v2/2026-09-16-${test.info().project.name}-sales-launch-preview.png`, fullPage: true });
    const runResponse = await page.request.get("/api/producer/launch/workspace");
    const data = await runResponse.json() as { workspace: { runs: { draft: { tiktok_settings: { objective_type?: string; bid_usd?: number | null; instant_page_template?: { name: string; button_text: string; background: string; hand_cursor: boolean } } } }[] } };
    const draft = data.workspace.runs.find(run => run.draft.tiktok_settings.instant_page_template?.name === name)?.draft;
    expect(draft?.tiktok_settings).toMatchObject({ objective_type: "WEB_CONVERSIONS", bid_usd: 0.2,
      instant_page_template: { name, button_text: "See episodes", background: "black", hand_cursor: true } });
  } finally {
    await staff.close();
  }
});
