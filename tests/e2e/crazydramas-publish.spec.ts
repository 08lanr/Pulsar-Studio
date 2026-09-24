import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

// "Upload to crazydramas", end to end on the fixture server (phase 5,
// publish spec §1–10). Fixture mode talks to lib/crazydramas/fake.ts — the
// Studio API of crazydramas docs/STUDIO_API.md and Mux's resumable upload
// behind it, in memory — so nothing leaves the machine: every test routes
// the browser's requests and fails on one to any host but the e2e server's.
//
// A series Studio may create needs an imported film whose slug crazydramas
// does not know, and the only importable fixture film (`fixture-film`) is
// live there, made in the CMS. So the spec copies it, before anything else,
// into a film of its own under the e2e server's WORKSPACE_ROOT with a slug
// and a title unique to this run and project (the fake remembers what an
// earlier project created in the same server), imports that copy, and
// removes the copy again at the end — the other specs list the fixture
// workspace's three films exactly. Then, in order: the Import row offers
// "Upload to CrazyDramas" and the form is prefilled (the slug editable, the
// series text drafted, the poster defaulting to the title's cover); a title
// another series has and a malformed IAP id are refused in their own words,
// and a pasted poster that answers 404 is not sent; the draft is created
// with Studio's own poster and the slug locks; every episode is
// uploaded in the background to "verified" with nothing published; Publish
// lists exactly the episodes that go live, free and paid apart, and a paid
// one needs its own confirm (the route refuses it without); Unpublish sets
// the series back to draft; the imported `fixture-film` itself reads
// "made in the CMS" with the hand-over note and no write control (its PUT is
// refused); with real writes off the banner names the missing setting and
// every write control is off; and the staff mirror shows the same flow.

const WORKSPACE = path.resolve(__dirname, "..", "fixtures", "workspace");
const SOURCE_FILM = "low-quality/fixture-film";

test.describe.configure({ mode: "serial" });

/** This run's own film: a slug and a title no series in the fake has (desktop and presentation run against one server). */
function ownFilm(project: string) {
  const suffix = `${project.slice(0, 1)}${Date.now().toString(36).slice(-6)}`;
  const slug = `e2e-up-${suffix}`;
  return { slug, ref: `low-quality/${slug}`, dir: path.join(WORKSPACE, "low-quality", slug), title: `E2E Upload ${suffix}`, iap: `cd.series.${slug.replace(/-/g, "_")}`, poster: `https://crazydramas.com/posters/${slug}.jpg` };
}

let film: ReturnType<typeof ownFilm>;
let titleId = "";

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

type FilmRow = { source_ref: string; imported: { title_id: string } | null; progress: { step: string; error: string | null } | null };

/** Imports a film from the producer's Import films page and answers the new title's id. */
async function importFilm(page: Page, ref: string): Promise<string> {
  await page.goto("/producer/films/import");
  const row = page.locator(`.gt-row[data-source-ref="${ref}"]`);
  await row.getByRole("button", { name: "Import", exact: true }).click();
  await expect(row.getByRole("link", { name: "Open", exact: true })).toBeVisible({ timeout: 60_000 });
  let found: FilmRow | undefined;
  await expect.poll(async () => {
    const films = ((await (await page.request.get("/api/producer/films")).json()) as { films: FilmRow[] }).films;
    found = films.find((f) => f.source_ref === ref);
    return found?.progress?.step ?? "none";
  }, { timeout: 60_000 }).toMatch(/^(done|failed)$/);
  expect(found!.progress!.error, "the import ran to the end").toBeNull();
  return found!.imported!.title_id;
}

type PublishState = { series_state: string; writes_enabled: boolean; paywall_live: boolean; episodes: { n: number; ledger_step: string | null; is_published: boolean; is_free: boolean }[] };

async function publishState(page: Page, id: string): Promise<PublishState> {
  const res = await page.request.get(`/api/titles/${id}/crazydramas/publish`);
  expect(res.ok(), `GET publish state: HTTP ${res.status()}`).toBe(true);
  return res.json();
}

const section = (page: Page) => page.locator("#cd-publish");
const form = (page: Page) => page.locator("#cd-publish form.cdp-form");
const rows = (page: Page) => page.locator("#cd-publish .cdp-table .gt-row");
const shot = (page: Page, name: string) => page.screenshot({ path: `docs/demo/e2e/${test.info().project.name}/crazydramas-publish-${name}.jpg`, type: "jpeg", quality: 72, fullPage: true });

// eslint-disable-next-line no-empty-pattern -- Playwright reads the fixtures from the first parameter's pattern; none are needed here
test.beforeAll(({}, testInfo) => {
  film = ownFilm(testInfo.project.name);
  // A copy left behind by a run that was killed before its afterAll would sit beside the three fixture films; remove any first.
  for (const name of readdirSync(path.join(WORKSPACE, "low-quality"))) {
    if (name.startsWith("e2e-up-")) rmSync(path.join(WORKSPACE, "low-quality", name), { recursive: true, force: true });
  }
  // A copy of the fixture film under its own slug and title; nothing of the checked-in folder changes.
  cpSync(path.join(WORKSPACE, SOURCE_FILM), film.dir, { recursive: true });
  const metaFile = path.join(film.dir, "cut", "film-meta.json");
  const meta = JSON.parse(readFileSync(metaFile, "utf8")) as Record<string, unknown>;
  writeFileSync(metaFile, JSON.stringify({ ...meta, display_title_en: film.title, source_title_en: `The ${film.title}`, crazydramas_slug: film.slug }, null, 1));
});

test.afterAll(() => {
  if (film && existsSync(film.dir)) rmSync(film.dir, { recursive: true, force: true });
});

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

test("an imported film not on crazydramas offers Upload to CrazyDramas on its Import row, and the series form opens prefilled", async ({ page }) => {
  await resetDemo(page);
  titleId = await importFilm(page, film.ref);
  // The Import page reads the chips when it renders: after the import's own check, the row is not on crazydramas yet.
  await page.goto("/producer/films/import");
  const row = page.locator(`.gt-row[data-source-ref="${film.ref}"]`);
  const upload = row.locator(".film-import-cd").getByRole("link", { name: "Upload to CrazyDramas" });
  await expect(upload).toHaveAttribute("href", `/producer/titles/${titleId}/crazydramas#cd-publish`);
  await upload.click();
  await expect(page).toHaveURL(new RegExp(`/producer/titles/${titleId}/crazydramas#cd-publish$`));

  await expect(section(page)).toHaveAttribute("data-series-state", "not_uploaded");
  await expect(section(page).locator("[data-cdp-state]")).toHaveText("Not on CrazyDramas yet");
  const f = form(page);
  // The slug is the film-meta's, still editable (no draft series yet): Studio checks a typed one before it saves it.
  await expect(f.locator('input[name="slug"]')).toHaveValue(film.slug);
  await expect(f.locator('input[name="title"]')).toHaveValue(film.title);
  await expect(f.locator('select[name="language"]')).toHaveValue("en");
  await expect(f.locator('input[name="free_episode_count"]')).toHaveValue("5");
  await expect(f.locator('input[name="series_price"]')).toHaveValue("9.99");
  await expect(f.locator('input[name="iap_product_id"]')).toHaveValue(film.iap);
  // The tagline, description and genres are drafted from the transcript as the form opens (fixture mode: the canned draft).
  await expect(f.locator("[data-series-text]")).toContainText("Demo mode: a sample draft");
  await expect(f.locator('input[name="tagline"]')).not.toHaveValue("");
  await expect(f.locator('input[name="genre"]')).toHaveValue("Romance, Billionaire");
  // The poster defaults to the title's own cover in Studio (its preview beside the choice); Studio hosts it on Create.
  await expect(f.locator('[data-poster-choice="cover"] input[type="radio"]')).toBeChecked();
  await expect(f.locator(".cdp-cover img")).toHaveAttribute("src", /^\/api\/media\//);
  await expect(f.locator(".cdp-cover")).toContainText("The title's cover in Studio");
  await expect(f).not.toContainText("Jayden");
  // Before the draft exists nothing can be uploaded or published; the three episodes are listed with their frame counts.
  await expect(rows(page)).toHaveCount(3);
  for (const stage of await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-stage")))) expect(stage).toBe("none");
  await expect(rows(page).first()).toContainText("120 frames");
  await expect(section(page).getByRole("button", { name: /^Upload all episodes/ })).toBeDisabled();
  await expect(section(page)).toContainText("Create the draft series first");
  await expect(section(page).getByRole("button", { name: "Publish episodes" })).toBeDisabled();
  await shot(page, "form");
});

test("a title another series has and a malformed IAP id are refused in their own words, and a poster that answers 404 is not sent", async ({ page }) => {
  await page.goto(`/producer/titles/${titleId}/crazydramas#cd-publish`);
  const f = form(page);
  const create = f.getByRole("button", { name: "Create draft series" });

  await f.locator('input[name="title"]').fill("Fixture Film");
  await create.click();
  // Studio's own guard (the working-name table and the public catalog) or crazydramas' series_title_exists: the words name the live series.
  await expect(f.locator(".cdp-refusal")).toContainText(/already (exists|live on crazydramas)/);
  await expect(f.locator(".cdp-refusal")).toContainText("fixture-film");
  await expect(section(page)).toHaveAttribute("data-series-state", "not_uploaded");
  const twin = await page.request.put(`/api/titles/${titleId}/crazydramas/series`, { data: { title: "Fixture Film" } });
  expect(twin.status()).toBe(409);
  expect((await twin.json()).code).toBe("series_title_exists");
  await f.locator('input[name="title"]').fill(film.title);

  await f.locator('input[name="iap_product_id"]').fill("CD.Series.Bad Name!");
  await expect(f.locator(".cdp-fields")).toContainText("Not the right form: at most 40 characters");
  await create.click();
  await expect(f.locator(".cdp-refusal")).toContainText(/iap_product_id: .*40 characters/);
  await expect(section(page)).toHaveAttribute("data-series-state", "not_uploaded");
  await f.getByRole("button", { name: `Use ${film.iap}` }).click();
  await expect(f.locator('input[name="iap_product_id"]')).toHaveValue(film.iap);

  // A pasted poster is checked (200, an image) before it is sent; fixture mode answers from the fake's rule and fetches nothing.
  await f.locator('[data-poster-choice="url"] input[type="radio"]').check();
  const poster = f.locator('input[name="poster_url"]');
  await poster.fill(`https://crazydramas.com/posters/${film.slug}-missing.jpg`);
  await f.getByRole("button", { name: "Check poster" }).click();
  await expect(f).toContainText("Not usable: It answers HTTP 404, not 200.");
  await create.click();
  await expect(f.locator(".cdp-refusal")).toContainText("The poster was not ready, so nothing was sent");
  await expect(section(page)).toHaveAttribute("data-series-state", "not_uploaded");
  await poster.fill(film.poster);
  await f.getByRole("button", { name: "Check poster" }).click();
  await expect(f).toContainText("Usable: answers 200 · image/jpeg");
  expect((await publishState(page, titleId)).series_state, "nothing was created by the refusals").toBe("not_uploaded");
});

test("Create draft series, then upload all: every episode walks to verified in the background and nothing is published", async ({ page }) => {
  await page.goto(`/producer/titles/${titleId}/crazydramas#cd-publish`);
  const f = form(page);
  // Two free episodes, so the third is paid for the publish step.
  await f.locator('input[name="free_episode_count"]').fill("2");
  // The default poster: the title's cover, stored by Studio as a 1200×1600 JPEG and checked before the series is sent.
  await expect(f.locator('[data-poster-choice="cover"] input[type="radio"]')).toBeChecked();
  await f.getByRole("button", { name: "Create draft series" }).click();
  await expect(f).toContainText("Draft series created.", { timeout: 60_000 });
  // The drafted text went with it (Create waits for the draft), and so did Studio's poster, which the page shows from
  // Studio's own route, never another host.
  await expect(f.locator('input[name="tagline"]')).toHaveValue("One contract. One lie. One marriage she never agreed to.");
  await expect(f.locator('input[name="genre"]')).toHaveValue("Romance, Billionaire");
  await expect(f.locator('[data-poster-choice="keep"] input[type="radio"]')).toBeChecked();
  await expect(f.locator(".cdp-cover img")).toHaveAttribute("src", /^\/api\/public-posters\/ttl_[a-z0-9]+\/[0-9a-f]{8}\.jpg$/);
  // The draft exists: the slug is locked, with the section's own reason (review fix, 2026-09-24).
  await expect(f.locator("[data-slug-locked]")).toHaveText(/^Locked: the series exists on crazydramas as e2e-up-[a-z0-9]+; ad links point at crazydramas\.com\/watch\/e2e-up-[a-z0-9]+, so the slug no longer changes\.$/);
  await expect(section(page)).toHaveAttribute("data-series-state", "draft");
  await expect(section(page).locator("[data-cdp-state]")).toHaveText("Draft on CrazyDramas");
  await expect(f.getByRole("button", { name: "Save series details" })).toBeVisible();

  const uploadAll = section(page).getByRole("button", { name: "Upload all episodes not on CrazyDramas (3)" });
  await expect(uploadAll).toBeEnabled();
  await uploadAll.click();
  await expect(section(page)).toContainText("Queued: episodes 1, 2, 3.");
  // The list polls while the uploader holds an episode: queued, uploading x%, processing, ready · checking, verified.
  await expect.poll(async () => (await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-stage")))).join(","), { timeout: 120_000, message: "every episode verified" }).toBe("verified,verified,verified");
  for (let i = 0; i < 3; i++) {
    await expect(rows(page).nth(i)).toContainText("Verified");
    await expect(rows(page).nth(i)).toContainText("ready");
    await expect(rows(page).nth(i)).toContainText("not published");
  }
  await expect(rows(page).nth(0)).toContainText("Free");
  await expect(rows(page).nth(2)).toContainText("Paid");
  const state = await publishState(page, titleId);
  expect(state.series_state).toBe("draft");
  expect(state.episodes.map((e) => e.is_published), "uploading never publishes").toEqual([false, false, false]);
  expect(state.episodes.map((e) => e.ledger_step)).toEqual(["verified", "verified", "verified"]);
  await shot(page, "uploaded");
});

test("Publish lists exactly the episodes that go live, free and paid apart; a paid episode needs its own confirm, and the route refuses it without", async ({ page }) => {
  await page.goto(`/producer/titles/${titleId}/crazydramas#cd-publish`);
  const paywallLive = (await publishState(page, titleId)).paywall_live;
  await section(page).getByRole("button", { name: "Publish episodes" }).click();
  const dialog = page.getByRole("dialog", { name: "Publish on CrazyDramas" });
  await expect(dialog).toBeVisible();
  // The free ones start ticked, the paid one never does.
  await expect(dialog.locator('input[data-episode="1"]')).toBeChecked();
  await expect(dialog.locator('input[data-episode="2"]')).toBeChecked();
  await expect(dialog.locator('input[data-episode="3"]')).not.toBeChecked();
  await expect(dialog.getByTestId("cdp-goes-live")).toHaveText("Episodes 1, 2");
  await expect(dialog).toContainText("2 free · 0 paid");
  await expect(dialog).toContainText("Goes live with these episodes");
  await shot(page, "publish-dialog");
  await dialog.getByRole("button", { name: "Publish 2 episodes" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(section(page)).toContainText("Published: episodes 1, 2. The series is live.");
  await expect(section(page)).toHaveAttribute("data-series-state", "published");
  await expect.poll(async () => (await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-stage")))).join(",")).toBe("published,published,verified");

  if (!paywallLive) {
    // The route itself refuses a paid episode without the confirm, before anything reaches crazydramas.
    const refused = await page.request.post(`/api/titles/${titleId}/crazydramas/publish`, { data: { episodes: [3], publish_series: false } });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).code).toBe("paid_needs_confirm");
  }

  await section(page).getByRole("button", { name: "Publish episodes" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input[data-episode="1"]')).toHaveCount(0);
  await dialog.locator('input[data-episode="3"]').check();
  await expect(dialog.getByTestId("cdp-goes-live")).toHaveText("Episodes 3");
  await expect(dialog).toContainText("0 free · 1 paid");
  const go = dialog.getByRole("button", { name: "Publish 1 episode" });
  if (!paywallLive) {
    await expect(dialog.locator(".cdp-paid")).toContainText("Paid episodes can be streamed free until the paywall fix is live on crazydramas (episodes 3).");
    await expect(go, "a paid episode needs its own confirm").toBeDisabled();
    await dialog.getByLabel("I understand; publish the paid episodes anyway").check();
  }
  await expect(go).toBeEnabled();
  await shot(page, "paid-confirm");
  await go.click();
  await expect(dialog).toHaveCount(0);
  await expect(section(page)).toContainText("Published: episodes 3.");
  await expect.poll(async () => (await publishState(page, titleId)).episodes.map((e) => e.is_published).join(",")).toBe("true,true,true");
});

test("Unpublish hides the ticked episodes and sets the series back to draft", async ({ page }) => {
  await page.goto(`/producer/titles/${titleId}/crazydramas#cd-publish`);
  await section(page).getByRole("button", { name: "Unpublish", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Unpublish from CrazyDramas" });
  for (const n of [1, 2, 3]) await dialog.locator(`input[data-episode="${n}"]`).check();
  await dialog.getByLabel("Also set the series back to draft").check();
  await expect(dialog).toContainText("Viewers lose episodes 1, 2, 3 at once.");
  await dialog.getByRole("button", { name: "Unpublish", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(section(page)).toContainText("Unpublished: episodes 1, 2, 3. The series is a draft again.");
  await expect(section(page)).toHaveAttribute("data-series-state", "draft");
  const state = await publishState(page, titleId);
  expect(state.episodes.map((e) => e.is_published)).toEqual([false, false, false]);
});

test("a series made in the CMS reads read-only with the hand-over note, and Studio's write is refused", async ({ page }) => {
  const cmsTitle = await importFilm(page, SOURCE_FILM);
  await page.goto(`/producer/titles/${cmsTitle}/crazydramas#cd-publish`);
  await expect(section(page)).toHaveAttribute("data-series-state", "cms_managed");
  await expect(section(page).locator("[data-cdp-state]")).toHaveText("Made in the CMS · read-only");
  await expect(section(page).locator(".cdp-handover")).toContainText("Made in the CMS — ask Jayden to hand it over (one SQL line) to manage it from Studio.");
  await expect(section(page).locator(".cdp-cms-facts")).toContainText("Fixture Film");
  await section(page).locator(".cdp-sql summary").click();
  await expect(section(page).locator(".cdp-sql code")).toHaveText("update dramas set managed_by = 'studio' where slug = 'fixture-film';");
  await expect(section(page).locator("form.cdp-form")).toHaveCount(0);
  await expect(section(page).getByRole("button", { name: /Upload|Publish|Unpublish|Create/ })).toHaveCount(0);
  const put = await page.request.put(`/api/titles/${cmsTitle}/crazydramas/series`, { data: { title: "Fixture Film" } });
  expect(put.status(), "a CMS series is never written").toBe(403);
  expect((await put.json()).code).toBe("series_not_studio");
  await shot(page, "cms");
});

test("with real writes off, the banner names the missing setting and every write control is off", async ({ page }) => {
  // The fixture server writes to the fake, so the off state is the live answer's shape, served to this page only.
  await page.route(`**/api/titles/${titleId}/crazydramas/publish`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ response: res, json: { ...body, writes_enabled: false, writes_disabled_reason: "CRAZYDRAMAS_LIVE_WRITES is not set to enabled" } });
  });
  await page.goto(`/producer/titles/${titleId}/crazydramas#cd-publish`);
  const banner = section(page).locator(".cdp-writes-off");
  await expect(banner).toContainText("Writes to CrazyDramas are off.");
  await expect(banner).toContainText("Missing setting: CRAZYDRAMAS_LIVE_WRITES is not set to enabled");
  await expect(form(page).getByRole("button", { name: "Save series details" })).toBeDisabled();
  await expect(form(page).locator('input[name="title"]')).toBeDisabled();
  await expect(section(page).getByRole("button", { name: /^Upload all episodes/ })).toHaveCount(0);
  await expect(section(page).getByRole("button", { name: "Publish episodes" })).toBeDisabled();
  await expect(section(page).getByRole("button", { name: "Unpublish", exact: true })).toBeDisabled();
  await shot(page, "writes-off");
});

test("the staff mirror shows the same flow for a staff administrator", async ({ page }) => {
  await signIn(page, "staff");
  await page.goto(`/titles/${titleId}/crazydramas#cd-publish`);
  await expect(section(page)).toHaveAttribute("data-series-state", "draft");
  await expect(rows(page)).toHaveCount(3);
  await expect(section(page).getByRole("button", { name: "Publish episodes" })).toBeEnabled();
  await expect(form(page).locator('input[name="title"]')).toHaveValue(film.title);
});
