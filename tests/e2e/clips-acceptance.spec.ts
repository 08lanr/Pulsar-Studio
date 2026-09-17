import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

type Clip = { id: string; title_id: string; title_name: string; media_url: string; kind: string };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("Clips previews real video and downloads selected/all files intact", async ({ page }) => {
  const base = test.info().project.use.baseURL ?? "http://localhost:3200";
  const login = await page.request.post("/api/auth/dev", { form: { kind: "producer" }, maxRedirects: 0 });
  expect(login.status()).toBe(303);
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
  expect((await page.request.post("/api/demo/reset", { data: { seed: "demo" } })).ok()).toBe(true);
  let clips: Clip[] = [];
  await expect.poll(async () => {
    const response = await page.request.get("/api/producer/launch/workspace");
    expect(response.ok()).toBe(true);
    clips = ((await response.json()).workspace.library as Clip[]).filter(clip => clip.kind === "video");
    return clips.length;
  }, { timeout: 30_000 }).toBeGreaterThan(30);
  const titleId = clips[0].title_id;
  const titleClips = clips.filter(clip => clip.title_id === titleId);
  expect(titleClips.length).toBeGreaterThan(1);
  expect(titleClips.length).toBeLessThanOrEqual(30);

  await page.goto("/producer/clips");
  await expect(page.getByText("Loading finished clips…")).toHaveCount(0);
  await expect(page.getByText(/Each ZIP holds up to 30 clips/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download all ZIP", exact: true })).toBeDisabled();
  await page.getByRole("combobox", { name: "Title", exact: true }).selectOption(titleId);
  await expect(page.locator(".clips-row")).toHaveCount(titleClips.length);
  await expect(page.getByRole("button", { name: "Download all ZIP", exact: true })).toBeEnabled();

  const cards = page.locator(".clips-row");
  await expect.poll(() => cards.first().locator("video").evaluate((video: HTMLVideoElement) => ({ ready: video.readyState >= 1, width: video.videoWidth > 0, duration: Number.isFinite(video.duration) && video.duration > 0 }))).toEqual({ ready: true, width: true, duration: true });
  const expectedFiles: Buffer[] = [];
  for (const clip of titleClips) {
    const media = await page.request.get(clip.media_url);
    expect(media.ok()).toBe(true);
    expect(media.headers()["content-type"]).toContain("video/mp4");
    const bytes = await media.body();
    expect(bytes.length).toBeGreaterThan(1024);
    expect(bytes.subarray(4, 8).toString()).toBe("ftyp");
    expectedFiles.push(bytes);
  }
  const singleEvent = page.waitForEvent("download");
  await cards.first().getByRole("link", { name: "Download", exact: true }).click();
  const single = await singleEvent;
  expect(await single.failure()).toBeNull();
  expect(digest(await readFile((await single.path())!))).toBe(digest(expectedFiles[0]));

  for (const index of [0, 1]) await cards.nth(index).getByRole("checkbox").check();
  for (const [button, expected] of [["Download chosen ZIP", expectedFiles.slice(0, 2)], ["Download all ZIP", expectedFiles]] as const) {
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: button, exact: true }).click();
    const download = await downloadEvent;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toBe("studio-clips.zip");
    const zip = await readFile((await download.path())!);
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 3, 4]));
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 12)).toBe(expected.length);
    for (const bytes of expected) expect(zip.includes(bytes)).toBe(true);
  }
  // A mixed selection with an inaccessible clip must fail as a whole.
  const rejected = await page.request.post("/api/producer/clips/download", { data: { clip_ids: [titleClips[0].id, "ffffffff-ffff-4fff-8fff-ffffffffffff"] } });
  expect(rejected.status()).toBe(404);
  expect(rejected.headers()["content-type"]).toContain("application/json");
  await page.goto(`/producer/titles/${titleId}/clips`);
  await expect(page.locator(".clips-row")).toHaveCount(titleClips.length);
  await expect(page.getByRole("combobox", { name: "Title", exact: true })).toHaveCount(0);
  await page.screenshot({ path: `docs/demo/launch-v2/2026-09-16-${test.info().project.name}-clips-acceptance.png`, fullPage: true });
});
