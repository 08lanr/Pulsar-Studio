import { test, expect, type Page } from "@playwright/test";

// The workspace import, end to end on the fixture workspace the e2e server
// reads (playwright.config.ts: WORKSPACE_ROOT=tests/fixtures/workspace, its
// own local tier under .uploads-e2e, no quiet period): the desk lists the
// three fixture films with their states, Import makes a title with three
// hardlinked episodes whose video plays through the media route from the
// local tier and whose transcript is the script, Materials cuts nothing on
// its own (auto_cut false), and an update of the same bytes reports three
// unchanged. The rows are found by their source ref (data-source-ref).

const FILM = "low-quality/fixture-film";

type Row = {
  source_ref: string;
  state: string;
  reason: { code: string; file?: string } | null;
  imported: { title_id: string; name: string } | null;
  progress: { step: string; result: { counts: Record<string, number>; changed_during_import: boolean } | null; error: string | null } | null;
};
type Listing = { configured: boolean; films: Row[] };

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

async function listing(page: Page): Promise<Listing> {
  const res = await page.request.get("/api/producer/films");
  expect(res.ok()).toBe(true);
  return res.json();
}

/** The film's row once its import finished (done or failed). */
async function settled(page: Page, ref: string): Promise<Row> {
  let row: Row | undefined;
  await expect.poll(async () => {
    row = (await listing(page)).films.find((f) => f.source_ref === ref);
    return row?.progress?.step ?? "none";
  }, { timeout: 60_000 }).toMatch(/^(done|failed)$/);
  expect(row!.progress!.error, "the import ran to the end").toBeNull();
  expect(row!.progress!.step).toBe("done");
  return row!;
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await resetDemo(page);
});

test("the import desk lists the fixture films: one ready, one rendering with the .part name, one not delivered", async ({ page }) => {
  const films = (await listing(page)).films;
  expect(films.map((f) => [f.source_ref, f.state, f.reason?.code ?? null])).toEqual([
    [FILM, "READY", null],
    ["low-quality/rendering-film", "RENDERING", "part_file"],
    ["low-quality/undelivered-film", "NOT_DELIVERED", "no_delivered"],
  ]);

  await page.goto("/producer/films/import");
  await expect(page.getByRole("heading", { name: "Import films", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Import films" }).first()).toHaveAttribute("aria-current", "page");
  const ready = page.locator(`.gt-row[data-source-ref="${FILM}"]`);
  await expect(ready).toContainText("Ready");
  await expect(ready.getByRole("textbox", { name: "Display title" })).toHaveValue("Fixture Film");
  await expect(ready).toContainText("Source title: The Fixture Film");
  await expect(ready).toContainText("720×1280 · 30 fps");
  await expect(ready.getByRole("button", { name: "Import", exact: true })).toBeEnabled();
  // The two that cannot be imported yet fold into one line with their reasons (2026-09-24), below the rows that can.
  await expect(page.locator('.gt-row[data-source-ref="low-quality/rendering-film"]')).toHaveCount(0);
  const fold = page.locator(".fi-not-ready");
  await expect(fold.locator("summary")).toContainText("Not ready (2)");
  await fold.locator("summary").click();
  const rendering = fold.locator('li[data-source-ref="low-quality/rendering-film"]');
  await expect(rendering).toContainText("Rendering now: ep02.part.mp4");
  await expect(rendering.getByRole("button")).toHaveCount(0);
  const undelivered = fold.locator('li[data-source-ref="low-quality/undelivered-film"]');
  await expect(undelivered).toContainText("Not delivered");
  await expect(undelivered).toContainText("No delivered plan yet");
  // The poster thumbnail comes from the workspace before the film is imported.
  const poster = ready.locator("img");
  await expect(poster).toHaveAttribute("src", /\/api\/producer\/films\/poster\?ref=/);
  await expect.poll(() => poster.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/film-import-desk.jpg`, type: "jpeg", quality: 72, fullPage: true });
});

test("Import makes the title with three episodes; the video plays from the local tier; Materials cuts nothing; an update reports three unchanged", async ({ page }) => {
  await page.goto("/producer/films/import");
  const ready = page.locator(`.gt-row[data-source-ref="${FILM}"]`);
  await ready.getByRole("button", { name: "Import", exact: true }).click();
  await expect(ready.getByRole("link", { name: "Open", exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(ready).toContainText("Imported: 3 added, 0 updated, 0 unchanged, 0 flagged.");
  await expect(ready).toContainText("3 transcripts attached.");
  const row = await settled(page, FILM);
  expect(row.state).toBe("IMPORTED");
  expect(row.progress!.result!.counts).toMatchObject({ added: 3, updated: 0, unchanged: 0, flagged: 0, transcripts: 3 });
  const titleId = row.imported!.title_id;
  await expect(ready.getByRole("link", { name: "Open", exact: true })).toHaveAttribute("href", `/producer/titles/${titleId}`);
  await expect(ready.locator("img")).toHaveAttribute("src", /^\/api\/media\/local\//);
  await page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/film-import-done.jpg`, type: "jpeg", quality: 72, fullPage: true });

  // The title is in the catalog with its three episodes and nothing was cut automatically.
  await page.goto(`/producer/titles/${titleId}/materials`);
  await expect(page.locator(".episode-row")).toHaveCount(3);
  await expect(page.locator(".ep-clips")).toHaveCount(3);
  for (const block of await page.locator(".ep-clips").all()) {
    await expect(block).toContainText("No clips yet");
    await expect(block.locator(".ep-clip")).toHaveCount(0);
  }
  await expect(page.locator(".episode-row").first()).toContainText("English lines ready: 0 / 1");

  // The title overview counts the three videos. The producer's episode page opens on the generate card until
  // a first pass exists (no player there yet), so the video is checked on the staff workbench, which plays the
  // hardlink through the media route from the local tier beside the transcript lines.
  await page.goto(`/producer/titles/${titleId}`);
  await expect(page.locator("dd", { hasText: /^3 eps$/ })).toBeVisible();
  await signIn(page, "staff");
  await page.goto(`/titles/${titleId}/episodes/1`);
  const video = page.locator("video").first();
  await expect(video).toHaveAttribute("src", /^\/api\/media\/local\//);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => ({ ready: v.readyState >= 1, width: v.videoWidth, duration: Math.round(v.duration) })), { timeout: 20_000 }).toEqual({ ready: true, width: 720, duration: 4 });
  await expect(page.getByText("Where is she?").first()).toBeVisible();
  const media = await page.request.get((await video.getAttribute("src"))!, { headers: { Range: "bytes=0-99" } });
  expect(media.status()).toBe(206);
  expect(media.headers()["content-type"]).toContain("video/mp4");
  await signIn(page, "producer");

  // A second import of the same film is refused; an update of the same bytes reports three unchanged.
  const dup = await page.request.post("/api/producer/films/import", { data: { source_ref: FILM, mode: "import" } });
  expect(dup.status()).toBe(409);
  const update = await page.request.post("/api/producer/films/import", { data: { source_ref: FILM, mode: "update" } });
  expect(update.status()).toBe(202);
  expect((await update.json()).title_id).toBe(titleId);
  const after = await settled(page, FILM);
  expect(after.state).toBe("IMPORTED");
  expect(after.imported!.title_id).toBe(titleId);
  expect(after.progress!.result!.counts).toMatchObject({ added: 0, updated: 0, unchanged: 3, transcripts: 0, transcripts_skipped: 3 });
  await page.goto("/producer/films/import");
  await expect(ready).toContainText("Imported: 0 added, 0 updated, 3 unchanged, 0 flagged.");
});
