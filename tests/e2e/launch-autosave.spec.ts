import { test, expect } from "@playwright/test";

// A launch draft survives leaving the page (docs/launch-ux-round-2.md follow-up,
// 2026-09-17): edits are saved quietly a moment after they are made, the bare
// Launch page continues the draft this browser was editing, and Start over
// begins a new one while the old draft stays saved.

test("edits survive clicking away, the bare Launch page resumes them, and Start over begins a new draft", async ({ page }) => {
  const base = test.info().project.use.baseURL ?? "http://localhost:3200";
  const login = await page.request.post("/api/auth/dev", { form: { kind: "producer" }, maxRedirects: 0 });
  expect([200, 303]).toContain(login.status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);

  await page.goto("/producer/launch");
  const name = page.getByLabel("Launch name");
  await expect(name).toBeVisible();
  await name.fill("Autosave check");
  // The quiet save lands without a Save press and puts the draft id in the URL.
  await expect(page.locator(".launch-save-state")).toContainText(/Saved/, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/producer\/launch\/[^/?]+$/);
  const draftUrl = page.url();

  // Click away to Clips, then come back to the bare Launch page.
  await page.getByRole("link", { name: "Clips", exact: true }).first().click();
  await expect(page).toHaveURL(/\/producer\/clips/);
  await page.goto("/producer/launch");
  await expect(page).toHaveURL(draftUrl);
  await expect(page.getByLabel("Launch name")).toHaveValue("Autosave check");

  // Start over: a fresh draft, the old one untouched.
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Start over" }).click();
  await expect(page).toHaveURL(/\/producer\/launch$/);
  await expect(page.getByLabel("Launch name")).not.toHaveValue("Autosave check");
  const old = await page.request.get(`/api/producer/launch/${draftUrl.split("/").pop()}`);
  expect(old.ok()).toBe(true);
  expect((await old.json()).run.draft.name).toBe("Autosave check");
});

// The default name ("Xinghai Pictures · Sep 24") arrives with the workspace and
// replaces the placeholder "Launch". It could land while the person was already
// in the name field with "Launch" selected, and what they typed was then added
// after it: the full e2e run of 2026-09-24 saw "Xinghai Pictures · Sep
// 24Acceptance pacing" once, when Playwright's fill selected the field just
// before the workspace answered. Being in the field is now enough to keep the
// default out. The workspace is held until the field's text is selected, so the
// race happens every time instead of now and then.
test("the default launch name is offered on an untouched page, never in front of what is being typed", async ({ page }) => {
  const base = test.info().project.use.baseURL ?? "http://localhost:3200";
  const login = await page.request.post("/api/auth/dev", { form: { kind: "producer" }, maxRedirects: 0 });
  expect([200, 303]).toContain(login.status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
  expect((await page.request.post("/api/demo/reset", { data: { seed: "demo" } })).ok()).toBe(true);
  const name = page.getByLabel("Launch name");
  const workspaceShown = () => expect(page.getByText(/Demo TikTok 1/).first()).toBeAttached();

  // Untouched: the page offers the company and the day.
  await page.goto("/producer/launch");
  await workspaceShown();
  await expect(name).toHaveValue(/ · /);

  // In the field before the workspace answers: only what is typed.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/producer/launch/workspace*", async (route) => { await gate; await route.continue(); });
  await page.goto("/producer/launch");
  await expect(name).toBeVisible();
  await expect(name).not.toHaveValue(/ · /);
  await name.selectText();
  release();
  await workspaceShown();
  await page.keyboard.type("Typed while the workspace loaded");
  await expect(name).toHaveValue("Typed while the workspace loaded");
});

// Phase 6 review, finding 1 (2026-09-24): a draft's first save moves the page to
// /launch/<id>, a new page instance. An edit made while that first POST is still
// on its way must reach the draft: the old instance flushes it as it unmounts,
// and the new one waits for that write before it reads the run. Before the fix
// the new page read the run before the flush landed, lost the edit and sent every
// later save on a stale revision (409), so Preview failed. The first POST is held
// until the edit is made, and the old page's flush (a PUT) is slowed down, so the
// new page's read always comes before that write unless it waits for it: the race
// happens every time instead of now and then.
test("an edit made while the draft's first save is still on its way reaches the draft: no conflict, and Preview works", async ({ page }) => {
  const base = test.info().project.use.baseURL ?? "http://localhost:3200";
  const login = await page.request.post("/api/auth/dev", { form: { kind: "producer" }, maxRedirects: 0 });
  expect([200, 303]).toContain(login.status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
  expect((await page.request.post("/api/demo/reset", { data: { seed: "demo" } })).ok()).toBe(true);

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  await page.route("**/api/producer/launch", async (route) => {
    if (route.request().method() === "POST" && !held) { held = true; await gate; }
    await route.continue();
  });
  let putsSlowed = 0;
  await page.route("**/api/producer/launch/*", async (route) => {
    if (route.request().method() === "PUT" && putsSlowed === 0) { putsSlowed++; await new Promise((resolve) => setTimeout(resolve, 1500)); }
    await route.continue();
  });
  const conflicts: string[] = [];
  page.on("response", (response) => {
    if (response.status() === 409 && response.url().includes("/api/producer/launch")) conflicts.push(`${response.request().method()} ${response.url()}`);
  });

  await page.goto("/producer/launch");
  const name = page.getByLabel("Launch name");
  await expect(name).toBeVisible();
  await name.fill("Race: first words");
  await expect.poll(() => held, { timeout: 15_000 }).toBe(true);
  // The first save is on its way; this edit is made meanwhile, and the save lands at once.
  await name.fill("Race: edited while the first save was held");
  release();
  await expect(page).toHaveURL(/\/producer\/launch\/[^/?]+$/, { timeout: 15_000 });
  const id = page.url().split("/").pop()!;
  await expect.poll(async () => (await (await page.request.get(`/api/producer/launch/${id}`)).json()).run.draft.name, { timeout: 15_000 })
    .toBe("Race: edited while the first save was held");
  await expect(page.getByLabel("Launch name")).toHaveValue("Race: edited while the first save was held");

  // The page keeps working on the newest revision: a Preview goes through.
  const picker = page.locator("details.launch-account-picker");
  if (await picker.count() && await picker.getAttribute("open") === null) await picker.locator("summary").click();
  await page.getByRole("checkbox", { name: /Demo TikTok 1/ }).check();
  await page.getByLabel(/^(Items|Spark codes|Ads) per campaign$/).fill("1");
  await page.getByLabel("Paste all Spark codes, one per line").fill("RACE-SPARK-ONE");
  await page.getByLabel("Title on crazydramas").selectOption({ label: "The War God Returns" });
  await page.getByRole("button", { name: "Preview campaigns" }).click();
  await expect(page.getByText(/1 campaign across 1 ad account/)).toBeVisible();
  expect(conflicts).toEqual([]);
});
