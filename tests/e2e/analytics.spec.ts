import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

// Title Analytics end-to-end pass against the running fixture-mode server.
// Signs in as the demo producer (approver), resets the demo store, then
// walks: catalog performance view → link a demo listing → overview →
// revenue → episodes → acquisition → the related campaign → back; the
// no-campaign and no-analytics titles; range persistence; zero-result
// search; screenshots at three widths; an axe-core pass on the four views.
// Role switching is not possible in the browser (one producer persona), so
// the viewer read-only rendering is asserted in tests/analytics.test.ts.

const T = (n: number) => `00000030-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const SHOTS = path.join(process.cwd(), "docs", "analytics", "screenshots");
const AXE = path.join(process.cwd(), "tmp", "browser-check", "node_modules", "axe-core", "axe.min.js");

async function signIn(page: Page) {
  const res = await page.request.post("/api/auth/dev", { form: { kind: "producer" }, maxRedirects: 0 });
  expect([303, 302]).toContain(res.status());
  const reset = await page.request.post("/api/demo/reset", { data: { seed: "demo" } });
  expect(reset.ok()).toBeTruthy();
}

async function axeCheck(page: Page, label: string) {
  await page.addScriptTag({ content: readFileSync(AXE, "utf8") });
  const result = await page.evaluate(async () => {
    // @ts-expect-error axe is injected
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
    return r.violations.map((v: { id: string; impact: string; nodes: { target: string[] }[] }) => ({ id: v.id, impact: v.impact, targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
  });
  const serious = (result as { id: string; impact: string; targets: string[] }[]).filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `${label}: ${JSON.stringify(result)}`).toEqual([]);
}

test.describe("title analytics", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("catalog performance view → link a demo listing → four views → campaign → back", async ({ page }) => {
    await page.goto("/producer/tiktok?range=30d");
    await expect(page.locator(".cc-performance")).toBeVisible();
    await expect(page.locator(".cc-performance tbody tr")).toHaveCount(14);
    // The unmapped title 3 says it needs a listing link.
    const row3 = page.locator(`.cc-performance tr:has(a[href^="/producer/titles/${T(3)}/analytics"])`);
    await expect(row3.locator(".state")).toContainText(/Needs listing link|需关联平台条目/);
    await row3.locator(".cc-next a").click();
    await expect(page).toHaveURL(new RegExp(`/producer/titles/${T(3)}/analytics\\?range=30d`));
    await expect(page.locator(".an-empty h2")).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, "state-needs-link-1440.png"), fullPage: true });

    // Linking workflow: pick → preview (ambiguous pair surfaced) → confirm.
    await page.locator(".an-empty a.btn-primary").click();
    await expect(page).toHaveURL(/\/analytics\/link\?range=30d/);
    // Conflict: a listing already linked to title 1 cannot be confirmed.
    await page.locator('.an-listings a[href*="listing=lst_demo_reborn_ceo"]').click();
    await expect(page.locator(".note[role=alert]")).toBeVisible();
    await expect(page.locator(".an-link-actions button")).toBeDisabled();
    // Ambiguous pair: the two flash-marriage listings.
    await page.locator('.an-listings a[href*="listing=lst_demo_flash_marriage_a"]').click();
    await expect(page.locator(".note-warn")).toContainText(/near-identical|几乎相同/);
    await page.screenshot({ path: path.join(SHOTS, "link-preview-1440.png"), fullPage: true });
    await page.locator(".an-link-actions button").click();
    await expect(page).toHaveURL(new RegExp(`/producer/titles/${T(3)}/analytics\\?range=30d$`));
    await expect(page.locator(".an-headlines")).toBeVisible();
    await expect(page.locator(".an-chips .state").first()).toContainText(/data available|数据可用/);

    // The demo journey title: overview → revenue → episodes → acquisition → campaign → back.
    await page.goto(`/producer/titles/${T(1)}/analytics?range=30d`);
    await expect(page.locator(".an-headlines .an-headline")).toHaveCount(5);
    await expect(page.locator(".an-takeaways li")).toHaveCount(4);
    await expect(page.locator(".an-chart-svg").first()).toBeVisible();
    await page.locator(".an-table-alt summary").first().click();
    await expect(page.locator(".an-table-alt table tbody tr").first()).toBeVisible();
    await axeCheck(page, "overview");
    await page.screenshot({ path: path.join(SHOTS, "overview-1440.png"), fullPage: true });

    await page.locator(".an-nav a", { hasText: /Revenue|收入/ }).click();
    await expect(page).toHaveURL(/\/analytics\/revenue\?range=30d/);
    await expect(page.locator(".an-waterfall li")).toHaveCount(6);
    await expect(page.locator(".an-cohort")).toHaveCount(2);
    await axeCheck(page, "revenue");
    await page.screenshot({ path: path.join(SHOTS, "revenue-1440.png"), fullPage: true });

    await page.locator(".an-nav a", { hasText: /Episodes|分集/ }).click();
    await expect(page).toHaveURL(/\/analytics\/episodes\?range=30d/);
    await expect(page.locator(".an-ep-table tbody tr")).toHaveCount(6);
    await expect(page.locator(".an-flag-continuation_loss").first()).toBeVisible();
    await axeCheck(page, "episodes");
    await page.screenshot({ path: path.join(SHOTS, "episodes-1440.png"), fullPage: true });
    // A row links to the episode workspace with a return link.
    const ws = page.locator(".an-ep-table tbody tr").first().locator('a[href*="/episodes/1"]');
    await expect(ws).toHaveAttribute("href", /returnTo=/);

    await page.locator(".an-nav a", { hasText: /Ad attribution|广告归因|Acquisition/ }).click();
    await expect(page).toHaveURL(/\/analytics\/acquisition\?range=30d/);
    await expect(page.locator(".an-campaign")).toHaveCount(1);
    await expect(page.locator(".an-campaign")).toContainText(/ROAS/);
    await axeCheck(page, "acquisition");
    await page.screenshot({ path: path.join(SHOTS, "acquisition-1440.png"), fullPage: true });
    await page.locator(".an-campaign .rs-panel-head a.btn").click();
    await expect(page).toHaveURL(/\/producer\/promote\//);
    await page.goBack();
    await expect(page).toHaveURL(/\/analytics\/acquisition\?range=30d/);
  });

  test("a title with analytics but no campaign, and a title with no analytics", async ({ page }) => {
    await page.goto(`/producer/titles/${T(7)}/analytics/acquisition?range=7d`);
    await expect(page.locator(".rs-empty h2")).toContainText(/No campaign|尚未投放/);
    await expect(page.locator(`a[href="/producer/promote/new?title=${T(7)}"]`).first()).toBeVisible();
    await page.goto(`/producer/titles/${T(5)}/analytics`);
    await expect(page.locator(".an-chips .state").first()).toContainText(/Needs listing link|需关联平台条目/);
    await expect(page.locator(".an-headlines")).toHaveCount(0);
    // Awaiting data and stale states render their notes.
    await page.goto(`/producer/titles/${T(12)}/analytics`);
    await expect(page.locator(".an-chips .state").first()).toContainText(/awaiting data|等待数据/);
    await page.goto(`/producer/titles/${T(10)}/analytics`);
    await expect(page.locator(".note-warn[role=status]")).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, "state-stale-1440.png"), fullPage: true });
    await page.goto(`/producer/titles/${T(2)}/analytics/episodes`);
    await expect(page.locator(".rs-empty h2")).toContainText(/not delivered|不提供/);
  });

  test("range changes persist across views and refresh", async ({ page }) => {
    await page.goto(`/producer/titles/${T(8)}/analytics`);
    await page.locator(".an-range a", { hasText: /90/ }).click();
    await expect(page).toHaveURL(/range=90d/);
    await page.locator(".an-nav a", { hasText: /Episodes|分集/ }).click();
    await expect(page).toHaveURL(/\/episodes\?range=90d/);
    await page.reload();
    await expect(page).toHaveURL(/\/episodes\?range=90d/);
    await expect(page.locator(".an-range a.on")).toContainText(/90/);
    await page.locator(".studio-crumbs a").first().click();
    await expect(page).toHaveURL(/\/producer\/tiktok\?range=90d/);
  });

  test("performance view search with zero results keeps the view usable", async ({ page }) => {
    await page.goto("/producer/tiktok?q=zzzz-no-such-title");
    await expect(page.locator(".ps-catalog-empty")).toBeVisible();
    await expect(page.locator(".cc-performance")).toHaveCount(0);
    await page.goto("/producer/tiktok?sort=viewers&range=7d");
    const first = page.locator(".cc-performance tbody tr").first();
    await expect(first).toContainText(/Son-in-Law|赘婿/);
  });

  test("screenshots at medium and narrow widths", async ({ page }) => {
    for (const [w, h, tag] of [[1024, 768, "1024"], [390, 844, "390"]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`/producer/titles/${T(1)}/analytics?range=30d`);
      await expect(page.locator(".an-headlines")).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow at ${w}`).toBeLessThanOrEqual(1);
      await page.screenshot({ path: path.join(SHOTS, `overview-${tag}.png`), fullPage: true });
      await page.goto(`/producer/titles/${T(1)}/analytics/episodes?range=30d`);
      await page.screenshot({ path: path.join(SHOTS, `episodes-${tag}.png`), fullPage: true });
      await page.goto("/producer/tiktok");
      await page.screenshot({ path: path.join(SHOTS, `catalog-performance-${tag}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/producer/tiktok");
    await page.screenshot({ path: path.join(SHOTS, "catalog-performance-1440.png"), fullPage: true });
  });
});
