import { test, expect, type Page } from "@playwright/test";

// The crazydramas connection, end to end on the fixture server (plan A8):
// fixture mode always reads lib/crazydramas/fake.ts, so no request leaves
// the machine — every test routes the browser's requests and fails on one
// to any host but the e2e server's (the fake's posters are same-origin
// SVGs for that reason). Five demo titles carry the fake's slugs
// (data/fixture/demo-catalog.ts), one per series state, and the READY
// fixture film imports as the complete one. The sweep is off on the e2e
// server (SCHEDULER_DISABLED=1), so the first test runs the check itself on
// every title that reads "not checked yet" through the same route Check now
// uses. Then: the catalog shows a chip per state and nothing else, the title
// header carries the third chip on the CrazyDramas section and on the
// overview, the section shows the series facts and the per-episode
// verdicts, Check now reads again and refuses a second read inside 30 s,
// the Import films rows carry the chip (an unlinked film says what to do),
// and only staff see the series that match no Studio title. Rows are found
// by the chip's data-cd-state, never by a title's name, so the seed may
// reorder titles without touching this file.

const FILM = "low-quality/fixture-film";
const SEEDED_STATES = ["live_partial", "live_differs", "live_unverified", "not_live", "read_failed", "not_linked"] as const;
/** The company the fixture film is imported for on the producer side (data/fixture/title.ts), which the staff desk's picker must choose. */
const DEMO_COMPANY = "Xinghai Pictures";

test.describe.configure({ mode: "serial" });

/** Requests the browser made to any host but the e2e server's, aborted as they were made; a test with one fails. */
const foreign: string[] = [];

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
  await expect(unlinked.getByRole("link", { name: /Link to CrazyDramas/ })).toHaveAttribute("href", `/producer/titles/${unlinkedId}/crazydramas`);
  await page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/crazydramas-catalog.jpg`, type: "jpeg", quality: 72, fullPage: true });
});

test("the imported fixture film is live and complete: the header chip on the section and the overview, the series facts, every episode the same length", async ({ page }) => {
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
  await expect(facts).toContainText("App store product");
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
  await expect(page.locator(".cd-panel")).toContainText("measured on one film only");
  // The fake's poster is the app's own SVG: drawn for a producer session too (the middleware serves it like the fonts, not a
  // redirect to /producer), and fetched from nowhere else (the route guard above would have failed the test).
  const poster = page.locator(".cd-poster img");
  await expect(poster).toHaveAttribute("src", /^\/crazydramas-fake\/poster\.svg$/);
  await expect.poll(() => poster.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0), { message: "the poster image loaded" }).toBe(true);
  await page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/crazydramas-section.jpg`, type: "jpeg", quality: 72, fullPage: true });

  // The third chip sits in the header of every section (plan A4.2), not only on the CrazyDramas one.
  for (const sub of ["", "/campaigns", "/materials", "/preparation", "/analytics"]) {
    await page.goto(`/producer/titles/${titleId}${sub}`);
    await expect(page.locator(".tw-chips .tw-chip-cd"), `the chip on ${sub || "the overview"}`).toHaveAttribute("data-cd-state", "live_complete");
  }
});

test("each other state's section shows the verdict or note that defines it, and Studio picks a slug for an unlinked title", async ({ page }) => {
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
  await expect(page.locator(".cd-panel .note")).toContainText("not even a draft");
  await expect(page.locator(".cd-checked")).toContainText(/Checked \d{4}-\d{2}-\d{2}/);

  const failed = await titleInState(page, "read_failed");
  await page.goto(`/producer/titles/${failed}/crazydramas`);
  await expect(page.locator(".tw-chips .tw-chip-cd")).toHaveAttribute("data-cd-state", "read_failed");
  await expect(page.locator(".cd-panel .note-warn").first()).toContainText("The last read failed");

  // A title with no slug (decision 2026-09-23 "Upload automation"): the section says Studio picks one, and it does, as the
  // upload section opens — derived from the title, checked on crazydramas (the fake), saved on the title. Nothing asks a
  // person to edit film-meta or run Update.
  const unlinked = await titleInState(page, "not_linked");
  await page.goto(`/producer/titles/${unlinked}/crazydramas`);
  await expect(page.locator("main")).not.toContainText("film-meta.json");
  await expect.poll(async () => ((await (await page.request.get(`/api/titles/${unlinked}/crazydramas/publish`)).json()) as { series_state: string }).series_state, { timeout: 30_000, message: "Studio picked a slug" }).not.toBe("not_linked");
  await page.reload();
  await expect(page.locator(".tw-chips .tw-chip-cd")).not.toHaveAttribute("data-cd-state", "not_linked");
  await expect(page.locator('#cd-publish input[name="slug"]')).toHaveValue(/^[a-z0-9]+(-[a-z0-9]+)*$/);
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
  // The films that cannot be imported yet fold into "Not ready (2)" (2026-09-24): no row, no chip, their reasons in the fold.
  await expect(page.locator('.gt-row[data-source-ref="low-quality/rendering-film"]')).toHaveCount(0);
  await expect(page.locator('.fi-not-ready li[data-source-ref="low-quality/rendering-film"]')).toHaveCount(1);
  await expect(page.locator('.fi-not-ready li[data-source-ref="low-quality/undelivered-film"]')).toHaveCount(1);
  await expect(ready.locator(".film-import-cd .tw-chip-cd")).toHaveAttribute("data-cd-state", "live_complete");
  await expect(ready.locator(".film-import-cd a")).toHaveAttribute("href", /^\/producer\/titles\/[0-9a-f-]{36}\/crazydramas$/);
  await expect(page.getByRole("heading", { name: "Unmatched on CrazyDramas" })).toHaveCount(0);
  await page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/crazydramas-import.jpg`, type: "jpeg", quality: 72, fullPage: true });
});

test("staff see the series live on crazydramas that match no Studio title, and the staff mirror of the section", async ({ page }) => {
  const titleId = await titleInState(page, "live_complete");
  await signIn(page, "staff");
  // The series live on crazydramas that match no Studio title are rows of the CrazyDramas page (2026-09-24); Import films points there.
  await page.goto("/films/import");
  await expect(page.getByRole("link", { name: /are listed on the CrazyDramas page/ })).toHaveAttribute("href", "/crazydramas");
  await page.goto("/crazydramas");
  await expect(page.getByRole("heading", { name: "CrazyDramas", level: 1 })).toBeVisible();
  // Only a sweep records the catalog's title-less rows, and the e2e server runs with SCHEDULER_DISABLED=1: until someone reads
  // CrazyDramas the page says so; once read, the rows name the real series and never a fixture or mock slug.
  const seriesRows = page.locator('.cdh-row[data-kind="series"]');
  if (!(await seriesRows.count())) await expect(page.locator(".cdh")).toContainText("once CrazyDramas' catalog is read");
  const readNow = page.getByRole("button", { name: "Read CrazyDramas now" });
  await readNow.click();
  await expect(page.locator(".cdh")).toContainText(/Read CrazyDramas: \d+ live series in its catalog\.|a moment ago/);
  // The other project may have read it seconds ago (the read is refused for fifteen seconds): read again once it may.
  if (!(await page.locator(".cdh").textContent())?.includes("live series in its catalog")) {
    await page.waitForTimeout(16_000);
    await readNow.click();
  }
  await expect.poll(async () => seriesRows.count(), { timeout: 20_000 }).toBeGreaterThan(0);
  const slugs = await seriesRows.evaluateAll((els) => els.map((e) => e.getAttribute("data-row")));
  for (const slug of slugs) expect(slug).not.toMatch(/^series:(mock-|fixture-film)/);
  expect(slugs).toContain("series:he-mocked-her-crush-on-him-and-sent-her");
  await expect(seriesRows.first().getByRole("link", { name: /Open on site/ })).toHaveAttribute("target", "_blank");
  await expect(seriesRows.first()).toContainText("Not in Studio");
  await page.goto("/films/import");
  // The staff desk's own rows carry the chip too, once the picker names the company the film was imported for (it opens on
  // the first company by name, whose row reads "import to check"), with the way into the staff mirror beside it.
  await page.getByLabel("Company", { exact: true }).selectOption({ label: DEMO_COMPANY });
  const staffRow = page.locator(`.gt-row[data-source-ref="${FILM}"]`);
  await expect(staffRow.locator(".film-import-cd .tw-chip-cd")).toHaveAttribute("data-cd-state", "live_complete");
  await expect(staffRow.locator(".film-import-cd a")).toHaveAttribute("href", `/titles/${titleId}/crazydramas`);

  // The staff title page links to the mirror, which shows the same panel with Check now for staff.
  await page.goto(`/titles/${titleId}`);
  await page.locator(".title-actions").getByRole("link", { name: "CrazyDramas", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/titles/${titleId}/crazydramas$`));
  await expect(page.locator(".title-row .tw-chip-cd")).toHaveAttribute("data-cd-state", "live_complete");
  await expect(page.locator(".cd-episodes tbody tr")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Check now" })).toBeVisible();
  await page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/crazydramas-staff.jpg`, type: "jpeg", quality: 72, fullPage: true });
});
