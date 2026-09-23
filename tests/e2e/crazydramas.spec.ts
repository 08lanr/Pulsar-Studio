import { test, expect, type Page } from "@playwright/test";

// The crazydramas connection, end to end on the fixture server (plan A8):
// fixture mode always reads lib/crazydramas/fake.ts, so no request leaves
// the machine. Five demo titles carry the fake's slugs (data/fixture/
// demo-catalog.ts), one per series state, and the READY fixture film
// imports as the complete one. The sweep is off on the e2e server
// (SCHEDULER_DISABLED=1), so the first test runs the check itself on every
// title that reads "not checked yet" through the same route Check now
// uses. Then: the catalog shows a chip per state and nothing else, the title
// header carries the third chip and the CrazyDramas section shows the
// series facts and the per-episode verdicts, Check now reads again and
// refuses a second read inside 30 s, the Import films rows carry the chip
// (an unlinked film says what to do), and only staff see the series that
// match no Studio title. Rows are found by the chip's data-cd-state, never
// by a title's name, so the seed may reorder titles without touching this
// file.

const FILM = "low-quality/fixture-film";
const SEEDED_STATES = ["live_partial", "live_differs", "live_unverified", "not_live", "read_failed", "not_linked"] as const;

test.describe.configure({ mode: "serial" });

async function signIn(page: Page, kind: "producer" | "staff" = "producer") {
  const base = test.info().project.use.baseURL ?? "http://localhost:3202";
  const res = await page.request.post(`${base}/api/auth/dev`, { form: { kind }, maxRedirects: 0 });
  expect([200, 303]).toContain(res.status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
}

async function resetDemo(page: Page) {
  const res = await page.request.post("/api/demo/reset", { data: { seed: "demo" } });
  expect(res.ok(), "demo reset is available in fixture mode").toBeTruthy();
}

/** The catalog's chip states with the title id each row's Open link names. */
async function catalogStates(page: Page): Promise<{ titleId: string; state: string }[]> {
  await page.goto("/producer/titles");
  await expect(page.locator(".pf-table .tw-chip-cd").first()).toBeVisible();
  return page.locator(".pf-table tbody tr").evaluateAll((rows) =>
    rows.map((r) => ({
      titleId: (r.querySelector('a[aria-label^="Open"]') as HTMLAnchorElement | null)?.getAttribute("href")?.replace("/producer/titles/", "") ?? "",
      state: r.querySelector(".tw-chip-cd")?.getAttribute("data-cd-state") ?? "",
    })),
  );
}

/** One title id in `state`, from the catalog. */
async function titleInState(page: Page, state: string): Promise<string> {
  const row = (await catalogStates(page)).find((r) => r.state === state);
  expect(row, `a catalog row in state ${state}`).toBeTruthy();
  return row!.titleId;
}

/** Reads the series for a title through the route Check now uses; a failed read is a recorded answer, not a test failure. */
async function check(page: Page, titleId: string): Promise<number> {
  const res = await page.request.post(`/api/titles/${titleId}/crazydramas/check`, { data: {} });
  return res.status();
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("My catalog shows one chip per crazydramas state, in words only, each cell opening the section", async ({ page }) => {
  await resetDemo(page);
  // Before any read, a slugged title reads "not checked yet" and the rest are not linked; then the check runs for each.
  const before = await catalogStates(page);
  expect(before.map((r) => r.state)).toContain("not_checked");
  expect(before.map((r) => r.state)).toContain("not_linked");
  for (const r of before.filter((r) => r.state === "not_checked")) await check(page, r.titleId);

  const states = new Set((await catalogStates(page)).map((r) => r.state));
  for (const s of SEEDED_STATES) expect(states, `a title in state ${s}`).toContain(s);
  await expect(page.getByRole("columnheader", { name: "CrazyDramas" })).toBeVisible();
  const chips = page.locator(".pf-table .tw-chip-cd");
  for (const text of await chips.allInnerTexts()) expect(text, "no number on the status board").not.toMatch(/\d/);
  await expect(page.locator('.tw-chip-cd[data-cd-state="live_partial"]').first()).toHaveText("On CrazyDramas · episodes missing");
  await expect(page.locator('.tw-chip-cd[data-cd-state="live_differs"]').first()).toHaveText("On CrazyDramas · lengths differ");
  await expect(page.locator('.tw-chip-cd[data-cd-state="not_live"]').first()).toContainText("Not live on CrazyDramas");
  await expect(page.locator('.tw-chip-cd[data-cd-state="read_failed"]').first()).toContainText("check failed");
  await expect(page.locator('.tw-chip-cd[data-cd-state="not_linked"]').first()).toHaveText("Not linked to CrazyDramas");

  const partial = page.locator('.pf-table tbody tr:has(.tw-chip-cd[data-cd-state="live_partial"])').first();
  const partialId = (await partial.getByRole("link", { name: /^Open/ }).getAttribute("href"))!.replace("/producer/titles/", "");
  await expect(partial.getByRole("link", { name: /View series check/ })).toHaveAttribute("href", `/producer/titles/${partialId}/crazydramas`);
  const unlinked = page.locator('.pf-table tbody tr:has(.tw-chip-cd[data-cd-state="not_linked"])').first();
  const unlinkedId = (await unlinked.getByRole("link", { name: /^Open/ }).getAttribute("href"))!.replace("/producer/titles/", "");
  await expect(unlinked.getByRole("link", { name: /How to link/ })).toHaveAttribute("href", `/producer/titles/${unlinkedId}/crazydramas`);
  await page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/crazydramas-catalog.jpg`, type: "jpeg", quality: 72, fullPage: true });
});

test("the imported fixture film is live and complete: the header chip, the series facts, every episode the same length", async ({ page }) => {
  await page.goto("/producer/films/import");
  const ready = page.locator(`.gt-row[data-source-ref="${FILM}"]`);
  await ready.getByRole("button", { name: "Import", exact: true }).click();
  await expect(ready.getByRole("link", { name: "Open", exact: true })).toBeVisible({ timeout: 60_000 });
  const titleId = (await ready.getByRole("link", { name: "Open", exact: true }).getAttribute("href"))!.replace("/producer/titles/", "");
  // The import runs one check when it set a slug (plan A5); if that read has not landed, read it here.
  const row = (await catalogStates(page)).find((r) => r.titleId === titleId);
  if (row?.state !== "live_complete") await check(page, titleId);
  expect(await titleInState(page, "live_complete")).toBe(titleId);
  await expect(page.locator('.tw-chip-cd[data-cd-state="live_complete"]').first()).toHaveText("On CrazyDramas · complete");

  await page.goto(`/producer/titles/${titleId}/crazydramas`);
  await expect(page.locator(".tw-chips .tw-chip-cd")).toHaveAttribute("data-cd-state", "live_complete");
  await expect(page.locator(".tw-nav a[aria-current=page]")).toHaveText("CrazyDramas");
  const facts = page.locator(".cd-series .tw-facts");
  await expect(facts).toContainText("Fixture Film");
  await expect(facts.locator("a[target=_blank]")).toHaveAttribute("href", /\/drama\/fixture-film$/);
  await expect(facts).toContainText("Studio 3 · CrazyDramas 3");
  await expect(facts).toContainText("Free 3 · paid 0");
  await expect(facts).toContainText("$9.99");
  await expect(facts).toContainText("IAP product");
  await expect(facts.locator(".pill", { hasText: "set" }).first()).toBeVisible();
  // The checked time carries the observed label; the table's verdicts are all "Same length" with the frame counts the import measured.
  await expect(page.locator(".cd-checked")).toContainText(/Checked \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  await expect(page.locator(".cd-checked .ev-observed")).toHaveText("Observed");
  const rows = page.locator(".cd-episodes tbody tr");
  await expect(rows).toHaveCount(3);
  for (const v of await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-verdict")))) expect(v).toBe("same_length");
  await expect(rows.first()).toContainText("120 frames");
  await expect(rows.first()).toContainText("4 s");
  await expect(rows.first()).toContainText("Same length");
  await expect(rows.first()).toContainText("Free");
  await expect(page.locator(".cd-panel")).toContainText("Calibrated on one film only");
  await page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/crazydramas-section.jpg`, type: "jpeg", quality: 72, fullPage: true });
});

test("each other state's section shows the verdict or note that defines it, and an unlinked title has no Check now", async ({ page }) => {
  const partial = await titleInState(page, "live_partial");
  await page.goto(`/producer/titles/${partial}/crazydramas`);
  await expect(page.locator(".tw-chips .tw-chip-cd")).toHaveAttribute("data-cd-state", "live_partial");
  await expect(page.locator('.cd-episodes tbody tr[data-verdict="not_ready"]').first()).toContainText("Not ready");

  const differs = await titleInState(page, "live_differs");
  await page.goto(`/producer/titles/${differs}/crazydramas`);
  await expect(page.locator('.cd-episodes tbody tr[data-verdict="extra"]').first()).toContainText("Only on CrazyDramas");

  const unverified = await titleInState(page, "live_unverified");
  await page.goto(`/producer/titles/${unverified}/crazydramas`);
  await expect(page.locator('.cd-episodes tbody tr[data-verdict="unknown"]').first()).toContainText("Unknown · no frame count");
  await expect(page.locator(".cd-panel .note")).toContainText("no frame count");

  const notLive = await titleInState(page, "not_live");
  await page.goto(`/producer/titles/${notLive}/crazydramas`);
  await expect(page.locator(".cd-panel .note")).toContainText("answers 404");
  await expect(page.locator(".cd-checked")).toContainText(/Checked \d{4}-\d{2}-\d{2}/);

  const failed = await titleInState(page, "read_failed");
  await page.goto(`/producer/titles/${failed}/crazydramas`);
  await expect(page.locator(".tw-chips .tw-chip-cd")).toHaveAttribute("data-cd-state", "read_failed");
  await expect(page.locator(".cd-panel .note-warn").first()).toContainText("The last read failed");

  const unlinked = await titleInState(page, "not_linked");
  await page.goto(`/producer/titles/${unlinked}/crazydramas`);
  await expect(page.locator(".tw-chips .tw-chip-cd")).toHaveAttribute("data-cd-state", "not_linked");
  await expect(page.locator(".cd-panel .note")).toContainText(/no crazydramas slug|not imported from the film workspace/);
  await expect(page.getByRole("button", { name: "Check now" })).toHaveCount(0);
  await expect(page.locator(".cd-episodes")).toHaveCount(0);
});

test("Check now reads the series again and a second read inside 30 s is refused", async ({ page }) => {
  const titleId = await titleInState(page, "live_complete");
  await page.goto(`/producer/titles/${titleId}/crazydramas`);
  const button = page.getByRole("button", { name: "Check now" });
  await expect(button).toBeEnabled();
  const box = page.locator(".cd-check");
  await button.click();
  await expect(box).toContainText(/Checked\.|Checked less than 30 s ago/);
  if ((await box.innerText()).includes("less than 30 s")) {
    // The previous test's read was younger than 30 s: the rule held; wait it out and read for real.
    await page.waitForTimeout(31_000);
    await button.click();
    await expect(box).toContainText("Checked.");
  }
  await expect(page.locator(".cd-checked")).toContainText(/Checked \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  await button.click();
  await expect(box).toContainText("Checked less than 30 s ago");
  // The route refuses the same way without the page.
  expect([409, 429]).toContain(await check(page, titleId));
});

test("the Import films rows carry the chip: an unlinked film says what to do, an imported film shows its state, no staff list", async ({ page }) => {
  await page.goto("/producer/films/import");
  const ready = page.locator(`.gt-row[data-source-ref="${FILM}"]`);
  await expect(ready).toBeVisible();
  await expect(page.locator('.gt-row[data-source-ref="low-quality/rendering-film"] .tw-chip-cd')).toHaveText("Not linked: add a crazydramas slug");
  await expect(page.locator('.gt-row[data-source-ref="low-quality/undelivered-film"] .tw-chip-cd')).toHaveText("Not linked: add a crazydramas slug");
  await expect(ready.locator(".film-import-cd .tw-chip-cd")).toHaveAttribute("data-cd-state", "live_complete");
  await expect(page.getByRole("heading", { name: "Unmatched on CrazyDramas" })).toHaveCount(0);
  await page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/crazydramas-import.jpg`, type: "jpeg", quality: 72, fullPage: true });
});

test("staff see the series live on crazydramas that match no Studio title, and the staff mirror of the section", async ({ page }) => {
  const titleId = await titleInState(page, "live_complete");
  await signIn(page, "staff");
  await page.goto("/films/import");
  await expect(page.getByRole("heading", { name: "Unmatched on CrazyDramas" })).toBeVisible();
  // Only the sweep records the catalog's title-less rows, and the e2e server runs with SCHEDULER_DISABLED=1: until a staff
  // "read the catalog now" exists the list says the catalog has not been read; when a sweep did run, it names the three
  // real series and never a fixture or mock slug.
  const section = page.locator(".cd-unmatched");
  const rows = section.locator(".gt-row[data-cd-slug]");
  if (await rows.count()) {
    const slugs = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-cd-slug")));
    for (const slug of slugs) expect(slug).not.toMatch(/^(mock-|fixture-film)/);
    expect(slugs).toContain("he-mocked-her-crush-on-him-and-sent-her");
    await expect(rows.first().getByRole("link", { name: "Open public page" })).toHaveAttribute("target", "_blank");
    await expect(rows.first()).toContainText("Observed");
  } else {
    await expect(section).toContainText("has not been read yet");
  }
  // The staff desk's own rows carry the chip too.
  await expect(page.locator(`.gt-row[data-source-ref="${FILM}"] .film-import-cd .tw-chip-cd`)).toHaveAttribute("data-cd-state", "live_complete");

  // The staff mirror shows the same panel with Check now for staff.
  await page.goto(`/titles/${titleId}/crazydramas`);
  await expect(page.locator(".title-row .tw-chip-cd")).toHaveAttribute("data-cd-state", "live_complete");
  await expect(page.locator(".cd-episodes tbody tr")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Check now" })).toBeVisible();
  await page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/crazydramas-staff.jpg`, type: "jpeg", quality: 72, fullPage: true });
});
