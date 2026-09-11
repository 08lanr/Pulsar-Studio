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
  const ceo = page.locator(".nx-board-row", { hasText: "CEO & billionaire" }).first();
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
  // The title workspace: Preparation keeps the full assessment; the campaign is one section away and comes back.
  await page.locator(".tw-nav a", { hasText: "US launch priority" }).click();
  await expect(page).toHaveURL(new RegExp(`/producer/titles/${T1}/preparation`));
  await expect(page.locator(".ps-score b").first()).toHaveText(/\d+/);
  await page.locator(".tw-nav a", { hasText: "Ad campaigns" }).click();
  await expect(page).toHaveURL(new RegExp(`/producer/titles/${T1}/campaigns`));
  await page.locator(".tw-table").getByRole("link", { name: "Review ad results" }).click();
  await expect(page).toHaveURL(new RegExp(`/producer/promote/${C1}`));
  await expect(page.locator(".studio-crumbs")).toContainText("Ad campaigns");
  await page.getByRole("link", { name: /Back to Ad campaigns/ }).click();
  await expect(page).toHaveURL(new RegExp(`/producer/titles/${T1}/campaigns`));
  // Old deep links still resolve.
  await page.goto(`/producer/titles/${T1}/potential`);
  await expect(page).toHaveURL(new RegExp(`/producer/titles/${T1}/preparation`));
  await page.goto(`/producer/promote/${C1}`);
  await expect(page.getByRole("heading", { name: "What the results say" })).toBeVisible();
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
  await expect(unlinked.getByRole("link", { name: /Start a campaign/ })).toBeVisible();
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
  await expect(firstAd).toContainText("Change requested — awaiting Pulsar review");
  await expect(firstAd).toContainText("Open on the wedding, not the forest.");

  await page.getByRole("button", { name: /Choose all \d+ ads/ }).click();
  await expect(page.locator(".fc-review-toolbar p")).toContainText("4 of 5 ads selected");
  await page.getByRole("button", { name: "Approve ads", exact: true }).click();
  await expect(page.locator(".ws-stages [aria-current=step]")).toContainText("Approve budget");
  await expect(page.getByText("Budget not approved")).toBeVisible();
  const budgetApproval = page.getByRole("button", { name: /Approve budget \$100/ });
  await page.getByLabel("Proposed budget (USD)").fill("150");
  await expect(budgetApproval).toBeDisabled();
  await expect(page.getByText("You have unsaved changes. Save the brief before approving its budget.")).toBeVisible();
  await page.getByLabel("Proposed budget (USD)").fill("100");
  await expect(budgetApproval).toBeEnabled();
  await budgetApproval.click();
  await expect(page.locator("#brief-record summary")).toContainText("Budget approved");
  await expect(page.locator(".ws-stages [aria-current=step]")).toContainText("Launch");
  await shot(page, "campaign-budget-approved");

  // Launch runs against the fake TikTok inside Studio: the campaign is created and sits in "TikTok's review".
  await page.getByRole("button", { name: "Launch on TikTok", exact: true }).click();
  await expect(page.locator(".ws-stages [aria-current=step]")).toContainText("Launch");
  await expect(page.getByText("Created on TikTok. The ads are in TikTok's review; results appear once they run.")).toBeVisible();
  await expect(page.locator("#launch-status")).toContainText(/17\d{15}/);
  await page.getByRole("button", { name: "Simulate demo results" }).click();
  await expect(page.getByRole("heading", { name: "What the results say" })).toBeVisible();
  await expect(page.locator(".rd-table tbody tr")).toHaveCount(4);
  await expect(page.locator(".rd-provenance")).toContainText("Demo results (simulated)");
  await expect(page.locator(".rd-verdict").first()).toBeVisible();
  await shot(page, "campaign-results");

  // Refresh persistence: the results and the stage survive a reload.
  await page.reload();
  await expect(page.locator(".ws-stages [aria-current=step]")).toContainText("Review ad results");
  await expect(page.locator(".rd-table tbody tr")).toHaveCount(4);
  const winnerRow = page.locator(".rd-table tr.is-winner");
  if (await winnerRow.count()) {
    await expect(page.locator(".rd-findings li.is-met").first()).toContainText(/met both/);
    await expect(page.getByRole("button", { name: /Draft a \$300 test/ })).toBeVisible();
  } else {
    await expect(page.getByText("No ad met both benchmarks")).toBeVisible();
  }

  await page.getByRole("button", { name: "Draft another test" }).click();
  await expect(page.getByRole("status")).toContainText("Round 2 created");
  await page.getByRole("link", { name: "Open round 2" }).click();
  await expect(page.getByRole("heading", { name: /round 2/ })).toBeVisible();
  await expect(page.locator(".ws-stages [aria-current=step]")).toContainText("Prepare");
  await shot(page, "campaign-round-2");

  // The campaigns queue shows the new round once and the finished round waits for no one.
  await page.goto("/producer/promote");
  await expect(page.locator(".cc-campaigns tbody tr", { hasText: "round 2" })).toHaveCount(1);
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
  // The new-campaign form answers an incomplete brief with the missing fields by name, never a dead button.
  await page.goto(`/producer/promote/new?title=${T1}`);
  const cta = page.locator(".promo-brief-side button.btn-primary");
  const err = page.locator(".promo-brief-side .err");
  await expect(cta).toBeEnabled();
  // The destination is prefilled with tiktok.com; clear it so the validation path is exercised.
  await page.getByLabel("Where viewers should go (required)").fill("");
  await cta.click();
  await expect(err).toContainText("the target audience");
  await expect(err).toContainText("the destination link");
  await expect(page.getByLabel("Target audience")).toBeFocused();
  await page.getByLabel("What do you want to test?").fill("Short");
  await page.getByLabel("Target audience").fill("US women 25-44");
  await cta.click();
  await expect(err).toContainText("the test idea");
  await expect(err).not.toContainText("the target audience");
  await page.getByLabel("What do you want to test?").fill("The rebirth opening beats the romance opening for US women 25-44.");
  await cta.click();
  await expect(err).toContainText("the destination link");
  await page.getByLabel("Where viewers should go (required)").fill("https://www.reelshort.com/");
  await expect(err).toHaveCount(0);
  await expect(page.url()).toContain("/producer/promote/new");
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
