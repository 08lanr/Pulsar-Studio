import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

// The CrazyDramas page (overnight spec items 10–14, 2026-09-24), end to end
// on the fixture server: one row per film or title with where it stands in
// Studio and on crazydramas and ONE next step — Import, then Upload to
// CrazyDramas (the series form opens in place, under the row), then Publish
// (its dialog opens at once, and the progress walks the episodes, the
// series, the public page and Live), then Open on site. The films that
// cannot be imported yet fold into "Not ready (2)". The title page names the
// imported film as imported (not "ingesting") and shows the flow strip. The
// phone width never scrolls sideways.
//
// Like crazydramas-publish.spec.ts, the spec copies the fixture film under a
// slug and a title crazydramas does not know (so Studio may create its
// series), and removes the copy at the end. Nothing leaves the e2e server:
// every request to another host fails the test.

const WORKSPACE = path.resolve(__dirname, "..", "fixtures", "workspace");
const SOURCE_FILM = "low-quality/fixture-film";
const DEMO_COMPANY = "Xinghai Pictures";

test.describe.configure({ mode: "serial" });

function ownFilm(project: string) {
  const suffix = `${project.slice(0, 1)}${Date.now().toString(36).slice(-6)}`;
  const slug = `e2e-hub-${suffix}`;
  return { slug, ref: `low-quality/${slug}`, dir: path.join(WORKSPACE, "low-quality", slug), title: `E2E Hub ${suffix}` };
}

let film: ReturnType<typeof ownFilm>;
const foreign: string[] = [];

async function signIn(page: Page, kind: "producer" | "staff" = "staff") {
  const base = test.info().project.use.baseURL ?? "http://localhost:3202";
  const res = await page.request.post(`${base}/api/auth/dev`, { form: { kind }, maxRedirects: 0 });
  expect([200, 303]).toContain(res.status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
}

const row = (page: Page) => page.locator(`.cdh-row[data-source-ref="${film.ref}"]`);
const panel = (page: Page) => page.locator(".cdh-panel");
const shot = (page: Page, name: string) => page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/crazydramas-hub-${name}.jpg`, type: "jpeg", quality: 72, fullPage: true });

// eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures from the first parameter's pattern; none are needed here
test.beforeAll(({}, testInfo) => {
  film = ownFilm(testInfo.project.name);
  for (const name of readdirSync(path.join(WORKSPACE, "low-quality"))) {
    if (name.startsWith("e2e-hub-")) rmSync(path.join(WORKSPACE, "low-quality", name), { recursive: true, force: true });
  }
  cpSync(path.join(WORKSPACE, SOURCE_FILM), film.dir, { recursive: true });
  const metaFile = path.join(film.dir, "cut", "film-meta.json");
  const meta = JSON.parse(readFileSync(metaFile, "utf8")) as Record<string, unknown>;
  writeFileSync(metaFile, JSON.stringify({ ...meta, display_title_en: film.title, source_title_en: `The ${film.title}`, crazydramas_slug: film.slug }, null, 1));
});

test.afterAll(() => {
  if (film && existsSync(film.dir)) rmSync(film.dir, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  const own = new URL(test.info().project.use.baseURL ?? "http://localhost:3202").hostname;
  await page.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === own) return route.continue();
    foreign.push(route.request().url());
    return route.abort();
  });
  await signIn(page);
});

test.afterEach(() => {
  const seen = foreign.splice(0);
  expect(seen, "fixture mode never fetches: no request left the e2e server").toEqual([]);
});

test("one row per film with one next step: Import runs in place, the not-ready films fold", async ({ page }) => {
  const reset = await page.request.post("/api/demo/reset", { data: { seed: "demo" } });
  expect(reset.ok()).toBeTruthy();
  await page.goto("/crazydramas");
  await expect(page.getByRole("heading", { name: "CrazyDramas", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "CrazyDramas", exact: true }).first()).toHaveAttribute("aria-current", "page");
  await expect(row(page)).toContainText("Not imported");
  await expect(row(page)).toContainText(film.title);
  // The films that cannot be imported yet are not rows: one folded line with their reasons.
  await expect(page.locator('.cdh-row[data-source-ref="low-quality/rendering-film"]')).toHaveCount(0);
  const fold = page.locator(".cdh-not-ready");
  await expect(fold.locator("summary")).toContainText("Not ready (2)");
  await fold.locator("summary").click();
  await expect(fold.locator('li[data-source-ref="low-quality/rendering-film"]')).toContainText("Rendering now: ep02.part.mp4");
  // Demo titles made in Studio are rows of their own, each with its one next step.
  await expect(page.locator('.cdh-row[data-kind="title"]').first()).toContainText("Made in Studio");

  await page.getByLabel("Import for").selectOption({ label: DEMO_COMPANY });
  await row(page).getByRole("button", { name: "Import", exact: true }).click();
  // The progress line sits on the row; once it settles the row is the title's: imported, not on crazydramas, Upload next.
  await expect(row(page).getByRole("button", { name: "Upload to CrazyDramas" })).toBeVisible({ timeout: 90_000 });
  await expect(row(page)).toHaveAttribute("data-action", "upload");
  await expect(row(page)).toContainText("Imported · 3 episodes");
  await expect(row(page)).toContainText("Not uploaded");
  await shot(page, "imported");
});

test("Upload opens the series form in place; Publish opens its dialog and shows the progress to Live", async ({ page }) => {
  await page.goto("/crazydramas");
  await row(page).getByRole("button", { name: "Upload to CrazyDramas" }).click();
  const section = panel(page).locator("#cd-publish");
  await expect(section).toBeVisible();
  await expect(section).toHaveAttribute("data-series-state", "not_uploaded");
  const form = section.locator("form.cdp-form");
  await expect(form.locator('input[name="slug"]')).toHaveValue(film.slug);
  await form.locator('input[name="title"]').fill(film.title);
  await form.locator('input[name="free_episode_count"]').fill("2");
  await form.getByRole("button", { name: "Create draft series" }).click();
  await expect(form).toContainText("Draft series created.", { timeout: 60_000 });
  await section.getByRole("button", { name: "Upload all episodes not on CrazyDramas (3)" }).click();
  // The whole upload at a glance: a bar with its counts, filling as the episodes are verified.
  const bar = section.locator(".cdp-upload-bar");
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("data-uploaded", "3", { timeout: 120_000 });
  await expect(bar).toContainText("3 of 3 episodes on CrazyDramas");
  await shot(page, "uploaded");

  // The hub's next step for the title is now Publish: its dialog opens at once, in place.
  await page.goto("/crazydramas");
  await expect(row(page)).toHaveAttribute("data-action", "publish");
  await expect(row(page)).toContainText("Draft · 3 of 3 uploaded");
  await row(page).getByRole("button", { name: "Publish 3" }).click();
  const dialog = page.getByRole("dialog", { name: "Publish on CrazyDramas" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("cdp-goes-live")).toHaveText("Episodes 1, 2");
  await dialog.getByRole("button", { name: "Publish 2 episodes" }).click();
  await expect(dialog).toHaveCount(0);
  const progress = panel(page).locator(".cdp-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute("data-finished", "true", { timeout: 120_000 });
  await expect(progress.locator('[data-step="episodes"]')).toContainText("2 of 2 episodes published.");
  await expect(progress.locator('[data-step="series"]')).toContainText("The series is live.");
  await expect(progress.locator('[data-step="public"]')).toHaveAttribute("data-state", "done");
  await expect(progress.locator('[data-step="live"]')).toContainText("Live on CrazyDramas.");
  await expect(progress.getByRole("link", { name: /Open on CrazyDramas/ })).toHaveAttribute("href", new RegExp(`/drama/${film.slug}$`));
  await shot(page, "published");
  // The open panel closes from its row, whatever the row's next step became under it (review r2).
  await row(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel(page)).toHaveCount(0);

  await page.goto("/crazydramas");
  await expect(row(page)).toContainText(/Live/);
  // Episode 3 (paid) is verified and waits: Studio's own live series still offers it.
  await expect(row(page)).toHaveAttribute("data-action", "publish");
});

test("the title page says imported, shows the flow strip, and names the CrazyDramas button plainly", async ({ page }) => {
  await page.goto("/crazydramas");
  const titleId = await row(page).getAttribute("data-title-id");
  expect(titleId).toBeTruthy();
  await page.goto(`/titles/${titleId}`);
  await expect(page.locator(".title-row [data-imported]")).toHaveText("Imported · 3 episodes");
  await expect(page.locator(".title-row .tw-chip-cd")).toBeVisible();
  await expect(page.locator(".stat-grid")).not.toContainText("Needs staff action");
  await expect(page.locator(".stat-grid")).not.toContainText("With producer");
  const flow = page.locator(".title-flow");
  await expect(flow.locator('[data-step="segment"]')).toHaveAttribute("data-state", "done");
  await expect(flow.locator('[data-step="import"]')).toHaveAttribute("data-state", "done");
  await expect(flow.locator('[data-step="upload"]')).toHaveAttribute("data-state", "done");
  await expect(flow.locator('[data-step="clips"]')).toHaveAttribute("data-state", "next");
  await expect(flow.locator('[data-step="clips"]')).toContainText("Short clips for ads, not episodes");
  await expect(flow.locator('[data-step="clips"] a')).toHaveAttribute("href", `/titles/${titleId}/clips`);
  await expect(page.locator(".title-actions").getByRole("link", { name: "CrazyDramas", exact: true })).toHaveAttribute("href", `/titles/${titleId}/crazydramas`);
  await expect(page.locator(".title-actions").getByRole("link", { name: "Ad clips" })).toBeVisible();
  await page.goto("/titles");
  await expect(page.locator(`a.gt-row[href="/titles/${titleId}"]`)).toContainText("Imported · 3 episodes");
  await shot(page, "title-page");
});

test("at phone width the page stacks: nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const url of ["/crazydramas", "/films/import"]) {
    await page.goto(url);
    await expect(page.locator("h1")).toBeVisible();
    if (url === "/crazydramas") {
      await expect(row(page)).toBeVisible();
      await expect(row(page).locator(".cdh-label").first()).toBeVisible();
      await shot(page, "phone");
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${url} scrolls sideways`).toBeLessThanOrEqual(0);
  }
});

test("the producer's CrazyDramas page lists the company's films and titles, never nobody's series", async ({ page }) => {
  await signIn(page, "producer");
  await page.goto("/producer/crazydramas");
  await expect(page.getByRole("heading", { name: "CrazyDramas", level: 1 })).toBeVisible();
  await expect(row(page)).toContainText("Imported · 3 episodes");
  await expect(page.locator('.cdh-row[data-kind="series"]')).toHaveCount(0);
});
