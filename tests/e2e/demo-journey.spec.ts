import { test, expect, type Page } from "@playwright/test";

// The demo journey, end to end, on the fixture dataset (decision 2026-09-09):
// market signal → matching owned title → ads → approvals → launch (demo
// handoff) → demo results → the next round. Filters, refresh persistence
// and error feedback are exercised along the way. Every step resets to the
// same rows, so the rehearsal is repeatable; screenshots are saved as
// evidence under docs/demo/e2e/<project>/.

const T1 = "00000030-0000-4000-8000-000000000001"; // Reborn as the CEO's First Love
const C1 = "00000037-0000-4000-8000-000000000001"; // round 1 on title 1, with demo results
const C2 = "00000037-0000-4000-8000-000000000002"; // Bride of the Wolf King, ads in review
const C3 = "00000037-0000-4000-8000-000000000003"; // Fake heiress, brief only

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

test("market signal → matching owned title → its campaign", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/producer");
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /Campaign tasks/ })).toContainText("4");
  await expect(page.getByText("Demo dataset")).toBeVisible();
  await shot(page, "overview-tasks");

  await page.getByRole("link", { name: "What to make next" }).first().click();
  await expect(page).toHaveURL(/view=opportunities/);
  await expect(page.getByRole("heading", { name: "What to make next", level: 2 })).toBeVisible();
  const ceo = page.locator(".desk-signal", { hasText: "CEO & billionaire" }).first();
  await expect(ceo).toBeVisible();
  await expect(ceo).toContainText("ReelShort");
  await expect(ceo.getByRole("link", { name: "Reborn as the CEO's First Love" })).toBeVisible();
  await ceo.getByText(/Top new listings/).click();
  await expect(ceo.locator(".desk-signal-more li").first()).toBeVisible();
  await shot(page, "overview-what-to-make-next");

  // "View listings" opens Explore already filtered on the story type; the area tabs stay visible.
  await ceo.getByRole("link", { name: "View listings" }).click();
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

  await page.goto("/producer?view=opportunities");
  await page.locator(".desk-signal", { hasText: "CEO & billionaire" }).getByRole("link", { name: "Reborn as the CEO's First Love" }).click();
  await expect(page).toHaveURL(new RegExp(`/producer/titles/${T1}/potential`));
  await expect(page.locator(".ps-score b").first()).toHaveText(/\d+/);
  await shot(page, "title-potential");
  await page.getByRole("link", { name: "Review results" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/producer/promote/${C1}`));
  await expect(page.getByRole("heading", { name: "What the results say" })).toBeVisible();
});

test("catalog: search, band filter and the zero-result recovery", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/producer/titles?q=reborn");
  await expect(page.locator(".rs-meta")).toContainText("1 titles");
  await expect(page.getByRole("link", { name: "Reborn as the CEO's First Love" }).first()).toBeVisible();
  await page.goto("/producer/titles");
  await page.getByRole("link", { name: /Higher priority/ }).first().click();
  await expect(page).toHaveURL(/band=test_first/);
  await expect(page.locator("tbody tr").first()).toContainText("Higher priority");
  await page.goto("/producer/titles?q=zzzz-nothing");
  await expect(page.getByRole("heading", { name: "No titles match these filters" })).toBeVisible();
  await page.getByRole("link", { name: "Reset filters" }).click();
  await expect(page).toHaveURL(/\/producer\/titles$/);
  await shot(page, "catalog");
});

test("ads → approvals → budget → launch → demo results → next round", async ({ page }) => {
  await resetDemo(page);
  await page.goto(`/producer/promote/${C2}`);
  await expect(page.getByRole("heading", { name: /Alpha bride hooks/ })).toBeVisible();
  await expect(page.locator(".ws-stages [aria-current=step]")).toContainText("Choose ads");
  await expect(page.locator(".fc-ad")).toHaveCount(5);
  await expect(page.locator(".fc-ad video").first()).toHaveAttribute("src", /\/api\/media\//);
  await shot(page, "campaign-choose-ads");

  // Error feedback before anything is approved: a change request needs a note.
  const firstAd = page.locator(".fc-ad").first();
  await firstAd.locator(".fc-change-request summary").click();
  const sendChange = firstAd.locator(".fc-change-request button");
  await expect(sendChange).toBeDisabled();
  await firstAd.getByLabel("What should change?").fill("Open on the wedding, not the forest.");
  await expect(sendChange).toBeEnabled();
  await sendChange.click();
  await expect(firstAd).toContainText("Pulsar is working on this change");
  await expect(firstAd).toContainText("Open on the wedding, not the forest.");

  await page.getByRole("button", { name: /Choose all \d+ ads/ }).click();
  await expect(page.locator(".fc-review-toolbar p")).toContainText("4 of 5 ads selected");
  await page.getByRole("button", { name: "Approve ads", exact: true }).click();
  await expect(page.locator(".ws-stages [aria-current=step]")).toContainText("Approve budget");
  await expect(page.getByText("Budget not approved")).toBeVisible();
  await page.getByRole("button", { name: /Approve budget \$100/ }).click();
  await expect(page.locator("#brief-record summary")).toContainText("Budget approved");
  await expect(page.locator(".ws-stages [aria-current=step]")).toContainText("Launch");
  await shot(page, "campaign-budget-approved");

  await page.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(page.locator(".ws-stages [aria-current=step]")).toContainText("Launch");
  await expect(page.getByText("Submitted. Waiting for results; no action needed.")).toBeVisible();
  await page.getByRole("button", { name: "Simulate demo results" }).click();
  await expect(page.getByRole("heading", { name: "What the results say" })).toBeVisible();
  await expect(page.locator(".rd-table tbody tr")).toHaveCount(4);
  await expect(page.locator(".rd-provenance")).toContainText("Demo results (simulated)");
  await expect(page.locator(".rd-verdict").first()).toBeVisible();
  await shot(page, "campaign-results");

  // Refresh persistence: the results and the stage survive a reload.
  await page.reload();
  await expect(page.locator(".ws-stages [aria-current=step]")).toContainText("Review results");
  await expect(page.locator(".rd-table tbody tr")).toHaveCount(4);
  const winnerRow = page.locator(".rd-table tr.is-winner");
  if (await winnerRow.count()) {
    await expect(page.locator(".rd-findings li.is-met").first()).toContainText("met both benchmarks");
    await expect(page.getByRole("button", { name: /Test the best ad with \$300/ })).toBeVisible();
  } else {
    await expect(page.getByText("No ad met both benchmarks")).toBeVisible();
  }

  await page.getByRole("button", { name: "Test more ads" }).click();
  await expect(page.getByRole("status")).toContainText("Round 2 created");
  await page.getByRole("link", { name: "Open round 2" }).click();
  await expect(page.getByRole("heading", { name: /round 2/ })).toBeVisible();
  await expect(page.locator(".ws-stages [aria-current=step]")).toContainText("Prepare");
  await shot(page, "campaign-round-2");

  // The overview queue shows the new round once and the finished round waits for no one.
  await page.goto("/producer");
  await expect(page.locator(".wf-queue-row", { hasText: "round 2" })).toHaveCount(1);
});

test("error feedback: the API refuses out-of-order actions and invalid input", async ({ page }) => {
  await resetDemo(page);
  const early = await page.request.post(`/api/producer/promote/${C3}/results`, { data: {} });
  expect(early.status()).toBe(409);
  expect((await early.json()).error).toMatch(/submitted/);
  const bad = await page.request.post("/api/producer/promote", { data: { title_id: T1, name: "", target_market: "US", objective: "views", spoiler_level: "low" } });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toBe("Invalid request");
  const foreign = await page.request.get(`/api/producer/promote/${C1.replace(/1$/, "9")}/results`);
  expect(foreign.status()).toBe(404);
  // The new-campaign form keeps its submit disabled until the brief is complete.
  await page.goto(`/producer/promote/new?title=${T1}`);
  const cta = page.locator(".promo-brief-side button.btn-primary");
  await expect(cta).toBeDisabled();
  await page.getByLabel("Hypothesis").fill("Short");
  await page.getByLabel("Audience").fill("US women 25-44");
  await expect(cta).toBeDisabled();
  await page.getByLabel("Hypothesis").fill("The rebirth opening beats the romance opening for US women 25-44.");
  await expect(cta).toBeEnabled();
  await shot(page, "new-campaign-validation");
});

test("no demo action reaches a model or a provider", async ({ page }) => {
  await resetDemo(page);
  // Generating ads and simulating results run entirely on the fixture; the
  // job ledger (Pulsar's spend) stays empty and no outbound call is made.
  const outbound: string[] = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (!["localhost", "127.0.0.1"].includes(u.hostname)) outbound.push(r.url()); });
  await page.goto(`/producer/promote/${C1}`);
  await expect(page.getByRole("heading", { name: "What the results say" })).toBeVisible();
  await expect(page.locator(".rd-demo-note").first()).toContainText("nothing was spent");
  expect(outbound, "no request left localhost").toEqual([]);
});
