import { test, expect } from "@playwright/test";

// The 60-second ad (decision 2026-09-24): on a title's clips page the producer
// presses "Build a 60 s ad"; the panel shows the pieces it joins while the
// server renders them with the real ffmpeg (PROMO_RENDER=on on the e2e
// server), then the finished ad with its file, and the Clips table lists it
// first as "Ad · 60 s". Pressing again with the same clips answers that ad.

type Clip = { id: string; title_id: string; kind: string };

test("a title's clips page builds a 60-second ad from its clips, and the Clips table lists it as Ad · 60 s", async ({ page }) => {
  test.setTimeout(300_000);
  const base = test.info().project.use.baseURL ?? "http://localhost:3202";
  const login = await page.request.post("/api/auth/dev", { form: { kind: "producer" }, maxRedirects: 0 });
  expect(login.status()).toBe(303);
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
  expect((await page.request.post("/api/demo/reset", { data: { seed: "demo" } })).ok()).toBe(true);

  // The demo title with the most finished clips.
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
  const panel = page.locator(".ad-montage");
  await expect(panel.getByText("Not built yet", { exact: true })).toBeVisible();
  await expect(panel.getByText(/nothing added to the picture/)).toBeVisible();
  await panel.getByRole("button", { name: "Build a 60 s ad", exact: true }).click();

  // While it builds: the pieces it joins, hook first and cliff last.
  await expect(page.locator('.ad-montage[data-montage-state="building"]')).toBeVisible();
  const building = panel.locator(".ad-montage-building .ad-montage-pieces li");
  await expect(building.first()).toContainText("Hook");
  await expect(building.last()).toContainText("Cliff");

  // Done: the ad with its file, and the Clips table below lists it first.
  await expect(page.locator('.ad-montage[data-montage-state="ready"]')).toBeVisible({ timeout: 240_000 });
  const row = panel.locator(".ad-montage-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByText("Ad · 60 s", { exact: true })).toBeVisible();
  const href = await row.getByRole("link", { name: "Download", exact: true }).getAttribute("href");
  const media = await page.request.get(href!);
  expect(media.ok()).toBe(true);
  expect(media.headers()["content-type"]).toContain("video/mp4");
  const bytes = await media.body();
  expect(bytes.subarray(4, 8).toString()).toBe("ftyp");
  await expect(page.locator(".clips-row").first()).toContainText("Ad · 60 s");

  // The same clips, the same ad.
  await panel.getByRole("button", { name: "Build from the current clips", exact: true }).click();
  await expect(panel.getByText(/already built from the current clips/)).toBeVisible();
  await expect(row).toHaveCount(1);
});
