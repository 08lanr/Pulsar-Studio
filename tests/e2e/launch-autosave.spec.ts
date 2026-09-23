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
