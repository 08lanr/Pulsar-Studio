import { expect, type Page } from "@playwright/test";

// Every TikTok ad links to its title's crazydramas page with TikTok's own
// macros (decision 2026-09-23). In the demo seed "The War God Returns" is on
// the fake crazydramas as fixture-film-processing, a published series, so its
// launches pass the preview's live check.
export const WAR_GOD_TITLE = "The War God Returns";
export const WAR_GOD_LINK = "https://crazydramas.com/watch/fixture-film-processing?source=tiktok&campaign=__CAMPAIGN_ID__&adgroup=__AID__&creative=__CID__";

/** Choose the title a TikTok launch promotes; the screen then prints the exact link TikTok receives. */
export async function chooseTikTokTitle(page: Page, title = WAR_GOD_TITLE, link = WAR_GOD_LINK) {
  await page.getByLabel("Title on crazydramas").selectOption({ label: title });
  await expect(page.getByTestId("tiktok-ad-url")).toHaveText(link);
}
