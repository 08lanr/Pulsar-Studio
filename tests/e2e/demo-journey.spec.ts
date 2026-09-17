import { test, expect, type Page } from "@playwright/test";

// The demo journey, end to end, on the fixture dataset (decision 2026-09-09):
// market signal → matching owned title → archived campaign history, then
// the unified Launch entry. Filters, record navigation, and retired API
// rejection are exercised along the way. Every step resets to the
// same rows, so the rehearsal is repeatable; screenshots are saved as
// evidence under docs/demo/e2e/<project>/.

const T1 = "00000030-0000-4000-8000-000000000001"; // Reborn as the CEO's First Love
const C1 = "00000037-0000-4000-8000-000000000001"; // round 1 on title 1, with demo results
const C2 = "00000037-0000-4000-8000-000000000002"; // Bride of the Wolf King, ads in review

test.describe.configure({ mode: "serial" });

let shotIndex = 0;
async function shot(page: Page, name: string) {
  const project = test.info().project.name;
  shotIndex += 1;
  await page.screenshot({ path: `docs/demo/e2e/${project}/${String(shotIndex).padStart(2, "0")}-${name}.jpg`, type: "jpeg", quality: 72, fullPage: true });
}

async function signIn(page: Page) {
  const base = test.info().project.use.baseURL ?? "http://localhost:3200";
  const res = await page.request.post(`${base}/api/auth/dev`, { form: { kind: "producer" }, maxRedirects: 0 });
  expect([200, 303]).toContain(res.status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
}

async function resetDemo(page: Page) {
  const res = await page.request.post("/api/demo/reset", { data: { seed: "demo" } });
  expect(res.ok(), "demo reset is available in fixture mode").toBeTruthy();
  expect((await res.json()).seed).toBe("demo");
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("the demo dataset resets to the same rows", async ({ page }) => {
  await resetDemo(page);
  const campaigns = await (await page.request.get("/api/producer/promote")).json();
  expect(campaigns.campaigns).toHaveLength(4);
  const names = campaigns.campaigns.map((c: { name: string }) => c.name).sort();
  expect(new Set(names).size, "no duplicate campaign names in the seed").toBe(4);
  const results = await (await page.request.get(`/api/producer/promote/${C1}/results`)).json();
  expect(results.results).toHaveLength(2);
  expect(results.results.every((r: { source: string }) => r.source === "demo"), "seeded results are labelled demo").toBeTruthy();
  const status = await (await page.request.get("/api/demo/reset")).json();
  expect(status).toEqual({ mode: "fixture", seed: "demo" });
});

test("status board → market signal → matching owned title → its campaign", async ({ page }) => {
  await resetDemo(page);
  // The workspace opens on My catalog: one row per title, both statuses and the US potential.
  await page.goto("/producer");
  await expect(page).toHaveURL(/\/producer\/titles$/);
  await expect(page.getByRole("heading", { name: "My catalog", level: 1 })).toBeVisible();
  await expect(page.locator(".pf-status tbody tr")).toHaveCount(14);
  await expect(page.getByText("Demo dataset", { exact: true })).toBeVisible();
  await shot(page, "catalog-status");

  // What to make next is a sidebar item under US market.
  await page.getByRole("link", { name: "What to make next" }).first().click();
  await expect(page).toHaveURL(/\/producer\/insights\/next/);
  // Match the row whose own title is the story type: another row may name it among its related types (today's market data does).
  const ceo = page.locator(".nx-board-row").filter({ has: page.locator("a.nx-board-title", { hasText: "CEO & billionaire" }) }).first();
  await expect(ceo).toBeVisible();
  await expect(ceo).toContainText("ReelShort");
  await shot(page, "what-to-make-next");

  // The story type opens Explore already filtered on it; the area tabs stay visible.
  await ceo.locator("a.nx-board-title").click();
  await expect(page).toHaveURL(/\/producer\/explore\/titles\?.*trope=ceo_billionaire/);
  await expect(page.getByRole("link", { name: "Explore listings" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".rs-meta")).toContainText(/\d+ listings/);
  // The filter form is a client component: a change before hydration is lost, so retry until the URL follows.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.locator("select[name=platform]").selectOption("reelshort");
    const followed = await page.waitForURL(/platform=reelshort/, { timeout: 4_000 }).then(() => true).catch(() => false);
    if (followed) break;
  }
  await expect(page).toHaveURL(/platform=reelshort/);
  await expect(page.locator(".brief-result").first()).toContainText("ReelShort");
  await page.reload();
  await expect(page.locator("select[name=platform]")).toHaveValue("reelshort");
  await expect(page.locator("select[name=trope]")).toHaveValue("ceo_billionaire");
  await shot(page, "explore-filtered");

  // From the status board into the owned title that carries the signal.
  await page.goto("/producer/titles?q=reborn");
  await page.locator(".pf-status tbody").getByRole("link", { name: "Reborn as the CEO's First Love", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/producer/titles/${T1}$`));
  await expect(page.locator(".tw-chips")).toContainText(/On TikTok/);
  await expect(page.locator(".tw-chips")).toContainText(/results in/);
  await shot(page, "title-overview");
  // Materials: the finalized episodes carry their auto-cut ad clips with a download (decision 2026-09-14).
  await page.goto(`/producer/titles/${T1}/materials`);
  const firstClips = page.locator(".ep-clips").first();
  await expect(firstClips).toContainText("Ad clips");
  await expect(firstClips.getByRole("status")).toContainText("3 ready");
  await expect(firstClips.locator(".ep-clip")).toHaveCount(3);
  await expect(firstClips.getByRole("link", { name: "Download" }).first()).toHaveAttribute("href", /\/api\/media\//);
  await expect(firstClips.getByRole("button", { name: "Cut clips again" })).toBeVisible();
  await shot(page, "materials-ad-clips");
  await page.goto(`/producer/titles/${T1}`);
  // The title workspace: Preparation keeps the full assessment; the campaign is one section away and comes back.
  await page.locator(".tw-nav a", { hasText: "US launch priority" }).click();
  await expect(page).toHaveURL(new RegExp(`/producer/titles/${T1}/preparation`));
  await expect(page.locator(".ps-score b").first()).toHaveText(/\d+/);
  await page.locator(".tw-nav a", { hasText: "Ad campaigns" }).click();
  await expect(page).toHaveURL(new RegExp(`/producer/titles/${T1}/campaigns`));
  await page.locator(".tw-table").getByRole("link", { name: "Review ad results" }).click();
  await expect(page).toHaveURL(new RegExp(`/producer/promote/${C1}`));
  await expect(page.locator(`.studio-crumbs a[href="/producer/titles/${T1}/campaigns"]`)).toContainText("Ad campaigns");
  await page.locator(`.page-head a[href="/producer/titles/${T1}/campaigns"]`).click();
  await expect(page).toHaveURL(new RegExp(`/producer/titles/${T1}/campaigns`));
  // Old deep links still resolve.
  await page.goto(`/producer/titles/${T1}/potential`);
  await expect(page).toHaveURL(new RegExp(`/producer/titles/${T1}/preparation`));
  await page.goto(`/producer/promote/${C1}`);
  await expect(page.getByRole("heading", { name: "Stored results" })).toBeVisible();
});

test("catalog: search, band filter and the zero-result recovery", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/producer/titles?q=reborn");
  await expect(page.locator(".pf-foot")).toContainText("Titles shown: 1");
  await expect(page.getByRole("link", { name: "Reborn as the CEO's First Love" }).first()).toBeVisible();
  await page.goto("/producer/titles");
  await expect(page.locator(".pf-table tbody tr")).toHaveCount(14);
  // Each row carries both statuses and the US potential; every cell links into the section that owns it.
  const reborn = page.locator(".pf-table tbody tr", { hasText: "Reborn as the CEO's First Love" });
  await expect(reborn).toContainText(/On TikTok/);
  await expect(reborn).toContainText(/results in/);
  await expect(reborn.getByRole("link", { name: /View TikTok data/ })).toHaveAttribute("href", new RegExp(`/producer/titles/${T1}/analytics$`));
  await expect(reborn.getByRole("link", { name: /View campaigns/ })).toHaveAttribute("href", new RegExp(`/producer/titles/${T1}/campaigns$`));
  const unlinked = page.locator(".pf-table tbody tr", { hasText: "Campus Sweetheart" });
  await expect(unlinked.getByRole("link", { name: /Link TikTok title/ })).toBeVisible();
  await expect(unlinked.getByRole("link", { name: /Start a campaign/ })).toHaveAttribute("href", "/producer/launch");
  // The recommendation bands filter the board.
  await page.getByRole("link", { name: /Higher priority/ }).first().click();
  await expect(page).toHaveURL(/band=test_first/);
  await expect(page.locator(".pf-table tbody tr").first()).toContainText("Higher priority");
  await page.goto("/producer/titles?q=zzzz-nothing");
  await expect(page.getByRole("heading", { name: "No titles match these filters" })).toBeVisible();
  await page.getByRole("link", { name: "Reset filters" }).click();
  await expect(page).toHaveURL(/\/producer\/titles$/);
  await shot(page, "catalog");
  // The former TikTok comparison view is its own area now; old links follow.
  await page.goto("/producer/titles?view=performance&range=7d");
  await expect(page).toHaveURL(/\/producer\/tiktok\?range=7d/);
  await expect(page.locator(".cc-performance tbody tr")).toHaveCount(14);
});

test("earlier campaign history is read-only and launches start in the unified workspace", async ({ page }) => {
  await resetDemo(page);
  await page.goto(`/producer/promote/${C2}`);
  await expect(page.getByRole("heading", { name: /Alpha bride hooks/ })).toBeVisible();
  await expect(page.locator(".fc-ads-section article.card")).toHaveCount(5);
  await expect(page.locator('.fc-campaign .page-head a[href="/producer/launch"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve ads", exact: true })).toHaveCount(0);
  await shot(page, "earlier-campaign-history");

  await page.goto(`/producer/promote/new?title=${T1}`);
  await expect(page).toHaveURL(/\/producer\/launch$/);
  const oldCreate = await page.request.post("/api/producer/promote", { data: { title_id: T1 } });
  expect(oldCreate.status()).toBe(409);
  const oldSubmit = await page.request.post(`/api/producer/promote/${C2}/submit`, { data: {} });
  expect(oldSubmit.status()).toBe(409);
});

test("no demo action reaches a model or a provider", async ({ page }) => {
  await resetDemo(page);
  // Reading earlier campaign results stays inside the fixture.
  const outbound: string[] = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (!["localhost", "127.0.0.1"].includes(u.hostname)) outbound.push(r.url()); });
  await page.goto(`/producer/promote/${C1}`);
  await expect(page.getByRole("heading", { name: "Stored results" })).toBeVisible();
  await expect(page.locator("#results")).toContainText("demo");
  expect(outbound, "no request left localhost").toEqual([]);
});
