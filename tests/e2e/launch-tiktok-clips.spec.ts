import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { chooseTikTokTitle, WAR_GOD_TITLE } from "./tiktok-title";

// TikTok ads from Studio clips (decision 2026-09-25). Ruobin: "build it, it
// doesn't matter with me that it doesn't show up on the profile, but I need to
// know it exists", and "put ad previews here, a singular picture is fine so I
// know which title to match it to". One launch carries a Studio clip, a post of
// the linked TikTok account and a pasted Spark code: step 3 shows one picture
// per ad (a bad code says TikTok does not recognise it), preview and confirm
// say which account the ads run as, and the Monitor names that account, says
// the clip stays off the profile and opens TikTok's own preview of every ad.

const SHOTS = "tmp/e2e-shots/launch-tiktok-clips";
const HANDLE = "@pulsar.dramas";

async function signIn(page: Page) {
  const base = test.info().project.use.baseURL ?? "http://localhost:3202";
  expect([200, 303]).toContain((await page.request.post("/api/auth/dev", { form: { kind: "producer" }, maxRedirects: 0 })).status());
  await page.context().addCookies([{ name: "pulsar_studio_locale", value: "en", url: base }]);
}
async function chooseAccount(page: Page, name: RegExp) {
  const picker = page.locator("details.launch-account-picker");
  if (await picker.count() && await picker.getAttribute("open") === null) await picker.locator("summary").click();
  await page.getByRole("checkbox", { name }).check();
}

test("a Studio clip, a post of the linked account and a Spark code: a picture per ad, who they run as, and TikTok's preview of each", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await signIn(page);
  expect((await page.request.post("/api/demo/reset", { data: { seed: "demo" } })).ok()).toBe(true);
  await page.goto("/producer/launch");
  await page.getByLabel("Ads per campaign").fill("3");
  await chooseAccount(page, /Demo TikTok 1/);
  await chooseTikTokTitle(page);

  // A pasted code shows its post's words (and cover) before anything is launched; a bad one says so.
  await page.getByLabel("Paste all Spark codes, one per line").fill("E2E-CLIPS-SPARK-Rrgo4=\ninvalid-e2e-code");
  const rows = page.getByTestId("launch-ad-titles");
  await expect(rows.getByTestId("spark-post-text")).toHaveText("Fake post for code Rrgo4=");
  await expect(rows.getByTestId("spark-code-error")).toContainText("TikTok does not recognise this code");
  await page.getByLabel("Paste all Spark codes, one per line").fill("E2E-CLIPS-SPARK-Rrgo4=");

  // The picker: Studio clips run as the linked account, shown only as ads; its posts need no code.
  await page.getByTestId("tiktok-choose-content").click();
  const dialog = page.getByRole("dialog", { name: "Choose ad content" });
  await expect(dialog.getByTestId("tiktok-clips-hint")).toContainText(`runs it as ${HANDLE}, shown only as an ad`);
  await dialog.locator(".content-pick-row", { hasText: WAR_GOD_TITLE }).first().getByRole("button", { name: "Use this clip" }).click();
  await dialog.getByRole("tab", { name: `From ${HANDLE}` }).click();
  await dialog.locator(".content-pick-row", { hasText: "The night bus leaves at 11 sharp" }).getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog.locator(".content-chosen-row")).toHaveCount(2);
  await dialog.screenshot({ path: `${SHOTS}/${test.info().project.name}-picker.png` });
  await dialog.getByRole("button", { name: "Done" }).click();

  // Step 3: three rows, each with its picture; the clip carries its own text, the post and the code their titles.
  await expect(rows.locator("[data-ad-row]")).toHaveCount(3);
  expect(await rows.locator("[data-ad-row]").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.kind))).toEqual(["video", "tiktok_post", "spark"]);
  await expect(rows.getByTestId("ad-row-picture")).toHaveCount(3);
  await expect(rows.locator("[data-ad-row='1'] [data-testid='ad-row-picture'] video")).toHaveCount(1);
  await expect(rows.getByLabel("Text under the video of ad 1")).not.toHaveValue("");
  await rows.screenshot({ path: `${SHOTS}/${test.info().project.name}-step3-rows.png` });

  // Preview and confirm say who the ads run as. The quiet autosave first moves the page to the draft's own address.
  await expect(page).toHaveURL(/\/producer\/launch\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(page.locator("[data-save-state='saved']")).toBeVisible({ timeout: 30_000 });
  await expect(rows.locator("[data-ad-row]")).toHaveCount(3);
  await page.getByRole("button", { name: "Preview campaigns" }).click();
  // A cold dev server compiles the preview route on this first request.
  await expect(page.getByTestId("tiktok-runs-as")).toContainText(`1 Studio clip runs as ${HANDLE}, shown only as an ad (not on the profile)`, { timeout: 60_000 });
  await expect(page.getByTestId("tiktok-runs-as")).toContainText(`1 post of ${HANDLE} runs as an ad, with no Spark code`);
  await page.getByRole("button", { name: /Launch 1 campaign/ }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm launch" });
  await expect(confirm.getByTestId("confirm-runs-as")).toContainText(HANDLE);
  await confirm.screenshot({ path: `${SHOTS}/${test.info().project.name}-confirm.png` });
  await confirm.getByRole("button", { name: "Confirm launch", exact: true }).click();
  await expect(page).toHaveURL(/\/producer\/monitor\?run=/);
  const focused = page.url();
  await expect.poll(async () => {
    const data = await (await page.request.get("/api/producer/monitor?force=1")).json() as { runs: { draft: { content: { value: string }[] }; status: string }[] };
    return data.runs.find((r) => r.draft.content.some((c) => c.value === "E2E-CLIPS-SPARK-Rrgo4="))?.status;
  }, { timeout: 20_000 }).toBe("done");

  // Monitor: every ad opens TikTok's own preview; the clip and the post name the account, the clip stays off the profile.
  // The Monitor opened on this launch alone (?run=).
  await page.goto(focused);
  const run = page.locator(".lm-run").first();
  await run.getByRole("button", { name: "Details" }).first().click();
  const watch = run.getByTestId("ad-watch");
  await expect(watch).toHaveCount(3);
  const runsAs = run.getByTestId("ad-runs-as");
  await expect(runsAs).toHaveCount(2);
  await expect(runsAs.filter({ hasText: "only as an ad, not on the profile" })).toHaveCount(1);
  const preview = await page.request.get(await watch.first().getAttribute("href") ?? "", { maxRedirects: 0 });
  expect(preview.status()).toBe(302);
  expect(preview.headers().location).toMatch(/^https:\/\/fake\.tiktok\.invalid\/ad_preview_tool\?ad_preview_id=\d+$/);
  await run.screenshot({ path: `${SHOTS}/${test.info().project.name}-monitor.png` });
});
