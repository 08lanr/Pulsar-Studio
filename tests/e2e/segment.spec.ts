import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

// Segment a film, end to end on the fixture server (playwright.config.ts:
// WORKSPACE_ROOT=tests/fixtures/workspace, STUDIO_FAKE_PIPELINE=1 so the
// fake runner stands in for python, ffmpeg and the vision provider, and the
// worker runs inside the Next process): a staff administrator starts a run
// from a fixture source picked through the server-side picker, accepts the
// watermark box, reviews the boundaries (accepts every card that needs a
// person, applies), waits for the render and QA, writes film-meta, imports
// the film, and the title exists. Each wait polls the run through the API
// the screens read, so a stage that never arrives fails with the stage it
// got stuck at and the run's refusal text.

type Run = { id: string; slug: string; stage: string; error_text: string | null; title_id: string | null; stage_detail: { waiting?: { for: string } | null } | null; decisions: { action: string; boundary_s: number | null }[] };
type Detail = { run: Run; stage_view: { watermark: { box: unknown } | null; review: { boundaries: { boundary_s: number; status: string }[]; complete: boolean } | null; qa: { episodes: unknown[] } | null; joins: unknown[]; import: { title_id: string | null } } };

const FIXTURE_EPS = path.resolve(__dirname, "..", "fixtures", "workspace", "low-quality", "fixture-film", "cut", "eps");
const STAGE_TIMEOUT = 120_000;

test.describe.configure({ mode: "serial" });
test.setTimeout(600_000);

async function signIn(page: Page, kind: "producer" | "staff" = "staff") {
  const base = test.info().project.use.baseURL ?? "http://localhost:3202";
  const res = await page.request.post(`${base}/api/auth/dev`, { form: { kind }, maxRedirects: 0 });
  expect([200, 303]).toContain(res.status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
}

async function resetDemo(page: Page) {
  const res = await page.request.post("/api/demo/reset", { data: { seed: "demo" } });
  expect(res.ok(), "demo reset is available in fixture mode").toBeTruthy();
}

async function detail(page: Page, runId: string): Promise<Detail> {
  const res = await page.request.get(`/api/admin/films/runs/${runId}`);
  expect(res.ok(), `GET run ${runId}: ${res.status()}`).toBe(true);
  return res.json();
}

/** Waits until the run reaches one of `stages` (optionally waiting for a person there); a failed or cancelled run fails the test with its refusal. */
async function reach(page: Page, runId: string, stages: string[], opts: { timeout?: number; waitingFor?: string } = {}): Promise<Detail> {
  let last: Detail | null = null;
  await expect.poll(async () => {
    last = await detail(page, runId);
    const s = last.run.stage;
    if (s === "failed" || s === "cancelled") return `${s}: ${last.run.error_text ?? ""}`;
    const w = last.run.stage_detail?.waiting?.for ?? "";
    return opts.waitingFor ? `${s}+${w}` : s;
  }, { timeout: opts.timeout ?? STAGE_TIMEOUT, message: `waiting for ${stages.join(" | ")}${opts.waitingFor ? ` (waiting for ${opts.waitingFor})` : ""}` }).toMatch(new RegExp(`^(${stages.join("|")})${opts.waitingFor ? `\\+${opts.waitingFor}` : ""}$`));
  return last!;
}

let runId = "";
let slug = "";

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await signIn(page);
  await resetDemo(page);
  await page.close();
});

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("the desk lists runs and the intake starts one from a fixture source picked on the server", async ({ page }) => {
  await page.goto("/films/runs");
  await expect(page.getByRole("heading", { name: "Segment a film", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Segment a film" }).first()).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "New run" }).click();
  await expect(page).toHaveURL(/\/films\/runs\/new$/);
  await expect(page.getByRole("heading", { name: "New segmenting run", level: 1 })).toBeVisible();

  // The fixture film's episode files stand in for a downloaded source; the folder is inside the workspace root the picker allows.
  await page.getByRole("tab", { name: "Typed path" }).click();
  await page.getByRole("textbox", { name: "Typed path" }).fill(FIXTURE_EPS);
  await page.getByRole("button", { name: "List", exact: true }).click();
  const entry = page.locator('[data-source-name="ep01.mp4"]');
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await expect(entry).toContainText("720×1280");
  await entry.click();
  await expect(entry).toHaveAttribute("aria-pressed", "true");

  slug = `e2e-${Date.now().toString(36)}`;
  const slugInput = page.getByRole("textbox", { name: "Film folder" });
  await expect(slugInput).toHaveValue(/\S/);
  await slugInput.fill(slug);
  await expect(page.getByRole("radio", { name: /Narrated/ })).toBeDisabled();
  await page.getByRole("checkbox", { name: /First proof/ }).uncheck();
  await page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/segment-intake.jpg`, type: "jpeg", quality: 72, fullPage: true });
  await page.getByRole("button", { name: "Start the run" }).click();
  await expect(page).toHaveURL(/\/films\/runs\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  runId = page.url().split("/").pop()!;

  const first = await detail(page, runId);
  expect(first.run.slug).toBe(slug);
  await page.goto("/films/runs");
  const row = page.locator(`.gt-row[data-run-id="${runId}"]`);
  await expect(row).toContainText(slug);
  await expect(row.getByRole("link", { name: "Open" })).toHaveAttribute("href", `/films/runs/${runId}`);
});

test("the watermark step shows the detector's images and Accept moves the run on", async ({ page }) => {
  expect(runId, "the run from the intake test").not.toBe("");
  await reach(page, runId, ["watermark"], { waitingFor: "watermark" });
  await page.goto(`/films/runs/${runId}`);
  await expect(page.getByRole("heading", { name: slug, level: 1 })).toBeVisible();
  await expect(page.locator('.tl-step[data-stage="watermark"]')).toHaveAttribute("aria-current", "step");
  await expect(page.getByRole("heading", { name: "The logo box" })).toBeVisible();
  const accept = page.getByRole("button", { name: "Accept the box" });
  await expect(accept).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator("figure.sgm-wm-figure img").first()).toBeVisible();
  await page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/segment-watermark.jpg`, type: "jpeg", quality: 72, fullPage: true });
  await accept.click();
  const after = await reach(page, runId, ["index", "cards", "plan", "vision", "review"]);
  expect(after.run.decisions.some((d) => d.action.startsWith("watermark"))).toBe(true);
});

test("the boundary review lists every boundary, Accept settles the cards that need a person, Apply renders", async ({ page }) => {
  const at = await reach(page, runId, ["review"], { timeout: 240_000, waitingFor: "review" });
  const boundaries = at.stage_view.review?.boundaries.length ?? 0;
  expect(boundaries, "the fake plan emitted options").toBeGreaterThan(0);
  expect(at.stage_view.review!.boundaries.some((b) => b.status === "needs_decision"), "the fake pass leaves one boundary to a person").toBe(true);

  await page.goto(`/films/runs/${runId}`);
  await page.getByRole("link", { name: "Open the boundary review" }).click();
  await expect(page).toHaveURL(new RegExp(`/films/runs/${runId}/review$`));
  await expect(page.getByRole("heading", { name: `Boundary review · ${slug}`, level: 1 })).toBeVisible();

  // Every boundary is a card: the ones that need a person open, the agreed ones collapsed.
  const collapsed = page.locator("details.sgm-collapsed").filter({ hasText: "pre-accepted" });
  if (await collapsed.count()) await collapsed.locator("summary").click();
  await expect(page.locator("article.sgm-card")).toHaveCount(boundaries);
  await expect(page.locator("article.sgm-card img").first()).toBeVisible();
  await page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/segment-review.jpg`, type: "jpeg", quality: 72, fullPage: true });

  // Accept each card that needs a person, one by one, then apply.
  const apply = page.getByTestId("apply-review");
  const pending = page.locator('article.sgm-card[data-status="needs_decision"]');
  for (let guard = 0; guard < 50; guard++) {
    const left = await pending.count();
    if (left === 0) break;
    await pending.first().getByRole("button", { name: "Accept", exact: true }).click();
    await expect(pending).toHaveCount(left - 1, { timeout: 15_000 });
  }
  await expect(pending).toHaveCount(0);
  await expect(apply).toBeEnabled();
  await apply.click();
  const rendering = await reach(page, runId, ["render", "qa", "film_meta"], { timeout: 120_000 });
  expect(rendering.run.decisions.some((d) => d.action === "apply_review")).toBe(true);
});

test("the render and QA finish, the sheets show, film-meta ends the wait, and the join review plays the joins", async ({ page }) => {
  await reach(page, runId, ["film_meta"], { timeout: 240_000, waitingFor: "film_meta" });
  await page.goto(`/films/runs/${runId}`);
  await expect(page.getByRole("heading", { name: "QA sheets" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("figure.sgm-qa-sheet").first()).toBeVisible();
  await page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/segment-qa.jpg`, type: "jpeg", quality: 72, fullPage: true });

  // The same review URL is the join review once the episodes are built.
  await page.goto(`/films/runs/${runId}/review`);
  await expect(page.getByRole("heading", { name: `Join review · ${slug}`, level: 1 })).toBeVisible();
  await expect(page.locator("article.sgm-card[data-join]").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Move this join" }).first()).toBeEnabled();

  await page.goto(`/films/runs/${runId}`);
  const form = page.getByRole("form", { name: "Film meta (film-meta.json)" });
  await expect(form.getByRole("textbox", { name: "Display title (English)" })).toHaveValue(/\S/);
  await form.getByRole("textbox", { name: "Display title (English)" }).fill("E2E Segmented Film");
  await form.getByRole("button", { name: "Save film meta" }).click();
  await reach(page, runId, ["handoff", "done"], { timeout: 120_000 });
});

test("Import now makes the title and the run reads done", async ({ page }) => {
  const before = await reach(page, runId, ["handoff", "done"], { timeout: 120_000 });
  await page.goto(`/films/runs/${runId}`);
  if (!before.run.title_id && before.run.stage !== "done") {
    await reach(page, runId, ["handoff"], { timeout: 120_000, waitingFor: "import" });
    await page.reload();
    const importNow = page.getByRole("button", { name: "Import now" });
    await expect(importNow).toBeEnabled({ timeout: 60_000 });
    await importNow.click();
  }
  let titleId = "";
  await expect.poll(async () => {
    const d = await detail(page, runId);
    titleId = d.run.title_id ?? d.stage_view.import.title_id ?? "";
    return titleId;
  }, { timeout: 120_000 }).toMatch(/[0-9a-f-]{36}/);
  await reach(page, runId, ["done"], { timeout: 60_000 });
  await page.reload();
  await expect(page.getByTestId("open-title")).toHaveAttribute("href", `/titles/${titleId}`);
  await page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/segment-done.jpg`, type: "jpeg", quality: 72, fullPage: true });
  await page.getByTestId("open-title").click();
  await expect(page).toHaveURL(new RegExp(`/titles/${titleId}`));
  await expect(page.locator("h1").first()).toBeVisible();
});
