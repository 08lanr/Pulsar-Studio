import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

// Plan §6, Builder B (docs/meta-organic-plan.md): a staff administrator opens
// Clips, narrows to one producer and one episode, posts a clip to Facebook and
// watches the row reach "Posted", then opens Launch for that producer, picks the
// same clip out of the Choose content popup and sees the clip named — never its
// id — in the counter, the preview table and the confirm dialog.
//
// The clips this drives are the fixture's real cuts: the seed rows arrive
// `pending` and ffmpeg turns them into `rendered` files in the background
// (lib/data/fixture.ts, `ensureDemoClips`), so the spec waits for the Clips
// route to answer with rows before it touches the screen. Without ffmpeg there
// are no rendered clips at all; the empty state and the Paste-an-id path are
// covered at the end either way.

type ClipRow = {
  id: string; producer_id: string; producer_name: string; title_id: string; title_name: string;
  episode_id: string | null; episode_label: string | null; label: string;
  posts: { id: string; platform: string; status: string }[];
};

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `docs/demo/launch-v2/2026-09-16-${test.info().project.name}-clips-posting-${name}.png`, fullPage: true });

async function signInAsStaff(page: Page) {
  const base = test.info().project.use.baseURL ?? "http://localhost:3213";
  expect((await page.request.post("/api/auth/dev", { form: { kind: "staff" }, maxRedirects: 0 })).status()).toBe(303);
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
}

test("staff posts a clip to Facebook from Clips and launches it by name", async ({ page }) => {
  test.setTimeout(180_000);
  await signInAsStaff(page);
  expect((await page.request.post("/api/demo/reset", { data: { seed: "demo" } })).ok()).toBe(true);

  // The fixture cuts its seed clips with ffmpeg in the background.
  let clips: ClipRow[] = [];
  await expect.poll(async () => {
    const response = await page.request.get("/api/promote/clips");
    if (!response.ok()) return -1;
    clips = ((await response.json()) as { clips: ClipRow[] }).clips ?? [];
    return clips.length;
  }, { timeout: 90_000, message: "the fixture never produced a rendered clip" }).toBeGreaterThan(0);

  const target = clips.find((clip) => clip.episode_id) ?? clips[0];
  expect(target.producer_id).toBeTruthy();

  await page.goto("/clips");
  await expect(page.getByRole("heading", { name: "Clips", exact: true })).toBeVisible();
  await expect(page.locator(".clips-row").first()).toBeVisible();

  // Filters live in the URL, so a narrowed desk is a link.
  await page.getByRole("combobox", { name: "Producer", exact: true }).selectOption(target.producer_id);
  await expect(page).toHaveURL(new RegExp(`producer=${encodeURIComponent(target.producer_id)}`));
  // Episodes are numbered per title, so with every title in view each option
  // names its title; once one title is chosen the list is that title's alone.
  const episodes = page.getByRole("combobox", { name: "Episode", exact: true });
  await expect(episodes.locator("option").nth(1)).toContainText(" · Episode ");
  await page.getByRole("combobox", { name: "Title", exact: true }).selectOption(target.title_id);
  await expect(page).toHaveURL(/title=/);
  await expect(episodes.locator("option").nth(1)).toHaveText(/^Episode \d+$/);
  if (target.episode_id) {
    await episodes.selectOption(target.episode_id);
    await expect(page).toHaveURL(/episode=/);
  }
  const row = page.locator(`[data-clip-id="${target.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('[data-platform="facebook"]')).toContainText("Not posted");
  await expect(row.locator('[data-platform="instagram"]')).toContainText("Not posted");
  mkdirSync("docs/demo/launch-v2", { recursive: true });
  await shot(page, "clips");

  // Publishing: one dialog, one plain sentence, then the row polls its own post.
  await row.getByRole("button", { name: "Post to Facebook", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Post to Facebook" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "Account" }).selectOption({ label: "Demo Meta 1" });
  await expect(dialog).toContainText("This publishes a public post on Demo Meta 1 now.");
  await expect(dialog.getByRole("textbox")).toHaveValue(new RegExp(target.title_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await dialog.getByRole("button", { name: "Publish now", exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(row.locator('[data-platform="facebook"]')).toContainText(/Posted ·/, { timeout: 60_000 });
  // Nothing was posted to Instagram, and the cell says so in words, not an id.
  await expect(row.locator('[data-platform="instagram"]')).toContainText("Not posted");
  await expect(row.locator('[data-platform="instagram"]')).not.toContainText("_");
  await shot(page, "posted");

  // Chinese chrome gets a Chinese date, not Sep 16.
  const filtered = page.url();
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "zh", url: test.info().project.use.baseURL ?? "http://localhost:3213" }]);
  await page.goto(filtered);
  await expect(page.locator(`[data-clip-id="${target.id}"] [data-platform="facebook"]`)).toContainText(/已发布 · \d+月\d+日/);
  await expect(page.locator(`[data-clip-id="${target.id}"] [data-platform="instagram"]`)).toContainText("未发布");
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: test.info().project.use.baseURL ?? "http://localhost:3213" }]);

  const posted = await page.request.get(`/api/promote/clips?producer_id=${encodeURIComponent(target.producer_id)}`);
  expect(posted.ok()).toBe(true);
  const publishedRow = ((await posted.json()) as { clips: ClipRow[] }).clips.find((clip) => clip.id === target.id)!;
  expect(publishedRow.posts.some((post) => post.platform === "facebook" && post.status === "published")).toBe(true);

  // The same clip, chosen for a launch by its name.
  await page.goto("/promote/launches");
  await page.getByRole("combobox", { name: "Producer", exact: true }).selectOption(target.producer_id);
  await page.getByRole("button", { name: /Meta · Facebook/ }).click();
  const picker = page.locator("details.launch-account-picker");
  if (await picker.count() && await picker.getAttribute("open") === null) await picker.locator("summary").click();
  await page.getByRole("checkbox", { name: /Demo Meta 1/ }).check();
  await page.getByLabel(/^(Items|Spark codes) per campaign$/).fill("1");
  await page.getByLabel("Destination URL").fill("https://example.com/watch");

  await page.getByRole("button", { name: "Choose content", exact: true }).click();
  const content = page.getByRole("dialog", { name: "Choose ad content" });
  await expect(content).toBeVisible();
  await expect(content.getByRole("tab", { name: "Studio clips" })).toHaveAttribute("aria-selected", "true");
  const pickRow = content.locator(`[data-clip-id="${target.id}"]`);
  // Each state cell names its own platform: the flex row has no column header.
  await expect(pickRow.locator(".content-pick-state").first()).toContainText("Facebook");
  await expect(pickRow.locator(".content-pick-state").first()).toContainText("Posted ·");
  await expect(pickRow.locator(".content-pick-state").nth(1)).toContainText("Instagram");
  await expect(pickRow.locator(".content-pick-state").nth(1)).toContainText("Not posted");
  await pickRow.getByRole("button", { name: "Add", exact: true }).click();
  await expect(content.locator(".content-chosen-row")).toHaveCount(1);
  await expect(content.locator(".content-chosen-row")).toContainText(target.title_name);
  await shot(page, "picker");
  await content.getByRole("button", { name: "Done", exact: true }).click();
  await expect(content).toBeHidden();

  await expect(page.locator(".launch-spark-count")).toContainText("1 / 1");
  await expect(page.locator(".launch-content-item")).toContainText(target.title_name);

  await page.getByRole("button", { name: "Preview campaigns" }).click();
  await expect(page.getByText(/1 campaign across 1 ad account/)).toBeVisible();
  // Round 2: the cell is the ad card. It leads with the clip's name and keeps
  // the post reference out of the words, in the card's title attribute.
  const previewCard = page.locator(".gt-row .launch-content-cell .ad-card").first();
  await expect(previewCard).toContainText(target.title_name);
  await expect(previewCard).toHaveAttribute("title", /_/);

  await page.getByRole("button", { name: /Launch 1 campaign/ }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm launch" });
  await expect(confirm).toBeVisible();
  await expect(confirm.locator(".launch-confirm-ads")).toContainText(target.title_name);
  await confirm.screenshot({ path: `docs/demo/launch-v2/2026-09-16-${test.info().project.name}-clips-posting-confirm.png` });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
});

test("the staff rail reads Clips · Launch · Monitor · Connections, and Connections carries Meta", async ({ page }) => {
  await signInAsStaff(page);
  await page.goto("/clips");
  const rail = page.locator("aside.sidebar nav");
  await expect(rail.locator("a")).toHaveText(["Clips", "Launch", "Monitor", "Connections", "Earlier campaigns", "Titles", "CrazyDramas", "Import films", "Segment a film", "Producers"]);
  await expect(rail.getByRole("link", { name: "Connections", exact: true })).toHaveAttribute("href", "/tiktok");
  await expect(page.locator(".apphead-title")).toHaveText("Clips");

  // One Connections entry covers both providers; /meta keeps working on its own.
  await page.goto("/tiktok");
  await expect(page.locator(".apphead-title")).toHaveText("Connections");
  await expect(page.getByRole("heading", { name: "Meta accounts", exact: true })).toBeVisible();
  await page.goto("/meta");
  await expect(page.getByRole("heading", { level: 1, name: "Meta accounts", exact: true })).toBeVisible();

  for (const [path, heading] of [["/promote/launches", "Launch"], ["/promote/monitor", "Monitor"]] as const) {
    await page.goto(path);
    await expect(page.locator(".apphead-title")).toHaveText(heading);
    await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
  }
});

test("the Paste an id tab still supplies content, and an unfiltered Clips desk explains itself", async ({ page }) => {
  await signInAsStaff(page);

  // Whatever the fixture managed to cut, the desk reads as words, never ids.
  await page.goto("/clips?state=failed&q=zzzz-no-such-hook");
  await expect(page.getByRole("heading", { name: "Clips", exact: true })).toBeVisible();
  await expect(page.getByText("No finished clip matches these filters.")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Posting state", exact: true })).toHaveValue("failed");
  await expect(page.getByRole("searchbox", { name: "Search hooks", exact: true })).toHaveValue("zzzz-no-such-hook");
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page).toHaveURL(/\/clips$/);

  const producers = await page.request.get("/api/promote/launches/workspace");
  expect(producers.ok()).toBe(true);
  const producerId = ((await producers.json()) as { workspace: { producers: { id: string }[] } }).workspace.producers[0].id;

  await page.goto("/promote/launches");
  await page.getByRole("combobox", { name: "Producer", exact: true }).selectOption(producerId);
  await page.getByRole("button", { name: /Meta · Facebook/ }).click();
  await page.getByRole("button", { name: "Choose content", exact: true }).click();
  const content = page.getByRole("dialog", { name: "Choose ad content" });

  // From the Page: posts made outside Studio, named by their opening line.
  await content.getByRole("tab", { name: "From the Page" }).click();
  await content.getByRole("combobox", { name: "Read posts from" }).selectOption({ label: "Demo Meta 1" });
  const pagePost = content.locator(".content-pick-row").filter({ hasText: "Behind the scenes from the set." });
  await expect(pagePost).toBeVisible();
  await pagePost.getByRole("button", { name: "Add", exact: true }).click();
  await expect(content.locator(".content-chosen-row")).toContainText("Behind the scenes from the set.");

  await content.getByRole("tab", { name: "Paste an id" }).click();
  await content.getByLabel("Existing post ID").fill("9000000000000010_9000000000009999");
  await content.getByRole("button", { name: "Add post", exact: true }).click();
  // The reference is no longer printed on the card; it lives in data-content-id.
  await expect(content.locator('.content-chosen-row[data-content-id="9000000000000010_9000000000009999"]')).toHaveCount(1);
  await content.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator('.launch-content-item:has([data-content-id="9000000000000010_9000000000009999"])')).toHaveCount(1);
  await expect(page.locator(".launch-content-item").filter({ hasText: "Behind the scenes from the set." })).toHaveCount(1);
});
