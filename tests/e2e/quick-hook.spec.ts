import { test, expect } from "@playwright/test";

// Quick hook ads (decision 2026-10-01): on a title's clips page the producer
// writes the text to show and presses "Make the ads"; the server renders every
// bait × scene × text with the real ffmpeg (PROMO_RENDER=on on the e2e
// server), the panel counts them in, then lists each with its code
// (H1-B1-X1) and its file, and the Clips table labels them "Quick hook ·
// <code>". Pressing again with the same text makes nothing new.

type Clip = { id: string; title_id: string; kind: string };

test("a title's clips page makes quick hook ads with text on screen, each with its code, and the Clips table lists them", async ({ page }) => {
  test.setTimeout(600_000);
  const base = test.info().project.use.baseURL ?? "http://localhost:3202";
  const login = await page.request.post("/api/auth/dev", { form: { kind: "producer" }, maxRedirects: 0 });
  expect(login.status()).toBe(303);
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
  expect((await page.request.post("/api/demo/reset", { data: { seed: "demo" } })).ok()).toBe(true);

  let clips: Clip[] = [];
  await expect.poll(async () => {
    const response = await page.request.get("/api/producer/launch/workspace");
    clips = ((await response.json()).workspace.library as Clip[]).filter((clip) => clip.kind === "video");
    return clips.length;
  }, { timeout: 60_000 }).toBeGreaterThan(5);
  const counts = new Map<string, number>();
  for (const clip of clips) counts.set(clip.title_id, (counts.get(clip.title_id) ?? 0) + 1);
  const titleId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

  await page.goto(`/producer/titles/${titleId}/clips`);
  const panel = page.locator(".quick-hooks");
  await expect(panel.getByText("None made yet", { exact: true })).toBeVisible();
  const inputs = panel.locator(".quick-hook-text input");
  await expect(inputs).toHaveCount(3);
  for (let i = 0; i < 3; i++) await inputs.nth(i).fill("");
  const make = panel.getByRole("button", { name: "Make the ads", exact: true });
  await expect(make).toBeDisabled();
  await inputs.nth(0).fill("x".repeat(80));
  await expect(panel.getByText(/Keep it to 72 characters/)).toBeVisible();
  await expect(make).toBeDisabled();
  await inputs.nth(0).fill("She was the maid. He didn't know.");
  await make.click();

  await expect(page.locator('.quick-hooks[data-quick-hook-state="building"]')).toBeVisible();
  await expect(page.locator('.quick-hooks[data-quick-hook-state="ready"]')).toBeVisible({ timeout: 540_000 });
  const rows = panel.locator(".ad-montage-row");
  expect(await rows.count()).toBeGreaterThan(0);
  const first = rows.first();
  await expect(first.locator(".pill").first()).toHaveText(/^H\d+-B\d+-X1$/);
  await expect(first).toContainText("She was the maid. He didn't know.");
  const href = await first.getByRole("link", { name: "Download", exact: true }).getAttribute("href");
  const media = await page.request.get(href!);
  expect(media.ok()).toBe(true);
  expect((await media.body()).subarray(4, 8).toString()).toBe("ftyp");
  await expect(page.locator(".clips-row").filter({ hasText: /Quick hook · H\d+-B\d+-X1/ }).first()).toBeVisible();

  // The same text, nothing new.
  const before = await rows.count();
  await make.click();
  await expect(panel.getByText(/were made already/)).toBeVisible();
  await expect(rows).toHaveCount(before);
});
