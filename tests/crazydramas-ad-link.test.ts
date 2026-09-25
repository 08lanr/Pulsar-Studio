// The crazydramas landing link, per platform (decision 2026-09-25). The two
// contracts differ and must never be swapped: crazydramas reads `source` as a
// free string and stores it verbatim (its packages/shared/src/attribution.ts
// read(), apps/web/app/api/session/route.ts), so a TikTok link sent on Meta
// does not fail — it writes a real row claiming platform 'tiktok' with the
// literal text __CAMPAIGN_ID__ as its campaign id.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CRAZYDRAMAS_AD_QUERY, META_AD_QUERY, TIKTOK_AD_QUERY,
  crazydramasAdUrl, crazydramasAdUrlFor, crazydramasAdUrlParts, isCrazydramasAdUrl,
} from "@/lib/tiktok/ad-url";
import { trackingUrlForCampaign } from "@/lib/launch/plan";

const SLUG = "forced-to-marry-the-mafia-boss";

test("TikTok's bytes are frozen and carry its own macros", () => {
  assert.equal(TIKTOK_AD_QUERY, "source=tiktok&campaign=__CAMPAIGN_ID__&adgroup=__AID__&creative=__CID__");
  assert.equal(crazydramasAdUrl(SLUG), `https://crazydramas.com/watch/${SLUG}?${TIKTOK_AD_QUERY}`);
  assert.equal(crazydramasAdUrlFor(SLUG, "tiktok"), crazydramasAdUrl(SLUG), "the default builder is still TikTok's");
});

test("Meta's link says meta and carries no macro Studio cannot fill", () => {
  const url = crazydramasAdUrlFor(SLUG, "meta");
  assert.equal(url, `https://crazydramas.com/watch/${SLUG}?${META_AD_QUERY}`);
  assert.equal(META_AD_QUERY, "source=meta");
  for (const macro of ["__CAMPAIGN_ID__", "__AID__", "__CID__", "{{campaign.id}}", "{{ad.id}}"]) {
    assert.ok(!url.includes(macro), `a Meta link must not carry ${macro}: crazydramas stores it literally`);
  }
});

test("a link is read back as the platform it was built for, and never the other", () => {
  assert.deepEqual(crazydramasAdUrlParts(crazydramasAdUrlFor(SLUG, "tiktok")), { slug: SLUG, provider: "tiktok" });
  assert.deepEqual(crazydramasAdUrlParts(crazydramasAdUrlFor(SLUG, "meta")), { slug: SLUG, provider: "meta" });
  assert.ok(isCrazydramasAdUrl(crazydramasAdUrlFor(SLUG, "meta"), "meta"));
  assert.ok(!isCrazydramasAdUrl(crazydramasAdUrlFor(SLUG, "meta"), "tiktok"), "a Meta link is not a TikTok link");
  assert.ok(!isCrazydramasAdUrl(crazydramasAdUrlFor(SLUG, "tiktok"), "meta"), "a TikTok link is not a Meta link");
  // A query that differs by one byte is not ours at all.
  assert.equal(crazydramasAdUrlParts(`https://crazydramas.com/watch/${SLUG}?source=meta&x=1`), null);
  assert.equal(CRAZYDRAMAS_AD_QUERY.tiktok, TIKTOK_AD_QUERY);
});

test("a campaign's link names its campaign the way its own platform can", () => {
  // TikTok: untouched, because TikTok fills the macros itself.
  const tt = crazydramasAdUrlFor(SLUG, "tiktok");
  assert.equal(trackingUrlForCampaign(tt, "mafia-001", { provider: "tiktok" }), tt);
  // Meta: Studio's own campid in the slot crazydramas reads, since Meta has no
  // macro Studio trusts in a CTA link.
  const meta = trackingUrlForCampaign(crazydramasAdUrlFor(SLUG, "meta"), "mafia-001", { provider: "meta" });
  assert.equal(new URL(meta).searchParams.get("source"), "meta");
  assert.equal(new URL(meta).searchParams.get("campaign"), "mafia-001");
  assert.ok(!meta.includes("__CAMPAIGN_ID__"));
});

test("a Meta draft is refused when it carries the TikTok link for the same drama", async () => {
  const { metaDraftIssues } = await import("@/lib/launch/plan");
  const draft = {
    provider: "meta", name: "x", account_ids: [], campaigns_per_account: 1, content_per_campaign: 1,
    allocation: "unique", content: [], total_budget_cents: 2000, daily_budget_cents: 2000, start_paused: true,
    meta_settings: {
      countries: ["US"], placements: ["facebook"], optimization_goal: "LINK_CLICKS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP", bid_cents: null, call_to_action: "LEARN_MORE",
      start_time: new Date(Date.now() + 3_600_000).toISOString(),
      end_time: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    },
    tiktok_settings: {},
  } as never as Parameters<typeof metaDraftIssues>[0];

  const codes = (url: string) =>
    metaDraftIssues({ ...draft, destination_url: url }, []).map((i) => i.code);

  assert.ok(codes(crazydramasAdUrlFor(SLUG, "tiktok")).includes("crossPlatformLink"),
    "the TikTok link must be refused on Meta: its macros would reach crazydramas as literal text");
  assert.ok(!codes(crazydramasAdUrlFor(SLUG, "meta")).includes("crossPlatformLink"),
    "the Meta link is the right one and must pass");
  assert.ok(!codes("https://crazydramas.com/watch/x").includes("crossPlatformLink"),
    "a plain URL is not one of ours and is not a cross-platform mistake");
});
