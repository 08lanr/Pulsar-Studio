// Test helper: a TikTok launch needs a title whose crazydramas series is live
// (decision 2026-09-23, "TikTok launch: crazydramas link contract + pixel +
// one account"). The fixture's fake crazydramas serves `fixture-film` as a
// published series, so a title on that slug passes the launch gate after the
// one public check the gate makes itself.

import { FIXTURE_PRODUCER_ID, fixtureSession, systemSession } from "@/lib/auth";
import { FAKE_SLUGS } from "@/lib/crazydramas/fake";
import { fixtureData } from "@/lib/data/fixture";
import { crazydramasAdUrl } from "@/lib/tiktok/ad-url";
import type { Title } from "@/lib/types";

export const LIVE_SLUG = FAKE_SLUGS.complete;
export const LIVE_AD_URL = crazydramasAdUrl(LIVE_SLUG);

let n = 0;
/** A title of the company on a crazydramas slug (live by default). */
export async function launchTitle(slug: string = LIVE_SLUG, producerId: string = FIXTURE_PRODUCER_ID): Promise<Title> {
  n += 1;
  return fixtureData.createImportedTitle(systemSession(), {
    producer_id: producerId, source_ref: `low-quality/launch-${slug}-${n}`, display_title_en: `Launch title ${n}`,
    crazydramas_slug: slug, created_by: fixtureSession("producer").userId,
  });
}
