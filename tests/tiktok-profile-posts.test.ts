// Studio clips on the profile (decision 2026-10-05). Ruobin: "I want to post on studio, without having to post it
// myself, copy a link / spark code, and paste in. I want this post to appear on my profile", then "build it, on by
// default". With @crazydramaus switched to "Show on TikTok profile and as ads" in Business Center, a launch's clips
// are created with dark_post_status OFF, so each is a post on the profile too. A new launch has it on; a launch saved
// before (no profile_posts) stays ads-only, auto-duplicate copies included; an account still "Only show as ads" is
// refused at preview, in words. Fixture mode only: nothing leaves the process.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { planIdentityLine } from "@/components/launch/plan-summary";
import { FIXTURE_PRODUCER_ID, fixtureSession } from "@/lib/auth";
import { FAKE_SLUGS } from "@/lib/crazydramas/fake";
import { getData } from "@/lib/data";
import { fixtureData, resetFixtureStore } from "@/lib/data/fixture";
import { resetLaunchFixture } from "@/lib/data/launch";
import { t } from "@/lib/i18n";
import { ingestEpisodeFile } from "@/lib/ingest";
import { defaultLaunchDraft } from "@/lib/launch/plan";
import { executeLaunch } from "@/lib/launch/service";
import { resetTikTokPostCaches } from "@/lib/launch/tiktok-posts";
import type { LaunchConnection, LaunchDraft } from "@/lib/launch/types";
import { fakeTikTokSnapshot, resetFakeTikTok } from "@/lib/tiktok/fake";
import { clipDarkPostStatus, defaultLaunchSettings, defaultSalesLaunchSettings, defaultTikTokLaunchSettings, normalizeLaunchSettings, summarizeLaunchSettings } from "@/lib/tiktok/settings";
import { launchTitle } from "./launch-title";
import { seedRenderedClips } from "./seed-minute";

const ADVERTISER = "7000000000000000001";
const producer = () => fixtureSession("producer");
const staff = () => fixtureSession("staff");

beforeEach(() => {
  process.env.DATA_SOURCE = "fixture"; process.env.FIXTURE_SEED = "empty"; process.env.FIXTURE_PERSIST = "off";
  for (const name of ["TIKTOK_LIVE", "TIKTOK_FAKE_IDENTITY", "TIKTOK_FAKE_COVER", "TIKTOK_FAKE_PIXEL", "TIKTOK_PIXEL_CODE"]) delete process.env[name];
  resetFixtureStore(); resetLaunchFixture(); resetFakeTikTok(); resetTikTokPostCaches();
});
afterEach(() => {
  delete process.env.TIKTOK_FAKE_IDENTITY;
  resetFakeTikTok();
});

async function account(): Promise<LaunchConnection> {
  return getData().assignLaunchConnection(staff(), {
    producer_id: FIXTURE_PRODUCER_ID, provider: "tiktok", advertiser_id: ADVERTISER, name: "TikTok 1",
    currency: "USD", timezone: "America/Los_Angeles", page_id: null, instagram_id: null, business_id: null, enabled: true,
  });
}
async function clipOf(slug: string) {
  const title = await launchTitle(slug);
  const ingest = ingestEpisodeFile(new Uint8Array(readFileSync(path.join(process.cwd(), "docs", "demo", "xiangyuan-ep1.srt"))), "xiangyuan-ep1.srt");
  const episode = await fixtureData.addEpisodeFromIngest(staff(), title.id, 1, ingest, { subtitlePath: null, videoPath: null });
  return { title, clip: (await seedRenderedClips(title.id, episode.id, 1))[0] };
}
/** A launch of one Studio clip with the settings given (a daily budget, paused, as the clip tests launch). */
function draftOf(titleId: string, accountId: string, clipId: string, settings: LaunchDraft["tiktok_settings"]): LaunchDraft {
  return { ...defaultLaunchDraft("tiktok"), name: "Profile posts", account_ids: [accountId], content_per_campaign: 1, allocation: "shared",
    content: [{ kind: "video", value: clipId, text: "He dared me to flirt with his biggest rival." }], title_id: titleId, destination_url: "",
    total_budget_cents: 20000, daily_budget_cents: 3000,
    tiktok_settings: { ...settings, budget_mode: "BUDGET_MODE_DAY", daily_budget_usd: 30, start_paused: true } };
}
const en = (k: string, v?: Record<string, string | number>) => t("en", k, v);

test("a new TikTok launch posts its clips to the profile; settings saved before stay ads-only", () => {
  assert.equal(defaultLaunchDraft("tiktok").tiktok_settings.profile_posts, true, "on by default (Ruobin: \"on by default\")");
  assert.equal(defaultTikTokLaunchSettings().profile_posts, true);
  assert.equal(defaultSalesLaunchSettings().profile_posts, true);
  // The base every older row is filled from never adds it: absent means ads-only.
  assert.equal(defaultLaunchSettings().profile_posts, undefined);
  assert.equal(normalizeLaunchSettings({ ...defaultLaunchSettings() }).profile_posts, undefined, "an old row stays without it");
  assert.equal(normalizeLaunchSettings({ ...defaultLaunchSettings(), profile_posts: true }).profile_posts, true);
  assert.equal(normalizeLaunchSettings({ ...defaultLaunchSettings(), profile_posts: false }).profile_posts, false);
  assert.equal(clipDarkPostStatus({ profile_posts: true }), "OFF");
  for (const s of [{}, { profile_posts: false }, null, undefined]) assert.equal(clipDarkPostStatus(s as never), "ON");
  assert.ok(summarizeLaunchSettings(defaultTikTokLaunchSettings()).includes("Studio clips also posted to the profile"));
  assert.ok(!summarizeLaunchSettings(defaultLaunchSettings()).some((p) => p.includes("profile")));
});

test("with the setting on, a clip's ad is also a post on the profile: OFF to TikTok, the preview says so, the Monitor links the public post", async () => {
  const one = await account();
  const { title, clip } = await clipOf(FAKE_SLUGS.complete);
  const saved = await getData().saveLaunchDraft(producer(), draftOf(title.id, one.id, clip.id, defaultTikTokLaunchSettings()));
  assert.equal(saved.draft.tiktok_settings.profile_posts, true, "the setting is saved with the draft the approver signs");
  const plan = await getData().previewLaunchRun(producer(), saved.id);
  assert.equal(plan.tiktok_identity?.profile, true);
  assert.equal(planIdentityLine(en, plan.tiktok_identity), "1 Studio clip runs as @pulsar.dramas and is also posted to its profile.");
  const run = await getData().submitLaunchRun(producer(), saved.id, saved.revision);
  await executeLaunch(run.id);
  const after = await getData().getLaunchRun(producer(), run.id);
  assert.equal(after.campaigns[0].status, "done", after.campaigns[0].error ?? "");
  const ads = fakeTikTokSnapshot().ads;
  assert.equal(ads.length, 1);
  assert.equal(ads[0].body.dark_post_status, "OFF", "on the profile as well as an ad");
  const seen = after.campaigns[0].snapshot?.ads?.[0];
  assert.equal(seen?.ads_only, false, "the Monitor reads it from TikTok's own ad record");
  assert.match(seen?.post_url ?? "", /^https:\/\/www\.tiktok\.com\/@pulsar\.dramas\/video\/\d+$/, "and links the post, now public");
});

test("unticked, or saved before the setting existed, a clip stays ads-only", async () => {
  const one = await account();
  const { title, clip } = await clipOf(FAKE_SLUGS.complete);
  for (const settings of [{ ...defaultTikTokLaunchSettings(), profile_posts: false }, defaultLaunchSettings()]) {
    resetFakeTikTok();
    const saved = await getData().saveLaunchDraft(producer(), draftOf(title.id, one.id, clip.id, settings));
    const plan = await getData().previewLaunchRun(producer(), saved.id);
    assert.equal(plan.tiktok_identity?.profile, undefined);
    assert.equal(planIdentityLine(en, plan.tiktok_identity), "1 Studio clip runs as @pulsar.dramas, shown only as an ad (not on the profile).");
    const run = await getData().submitLaunchRun(producer(), saved.id, saved.revision);
    await executeLaunch(run.id);
    assert.equal(fakeTikTokSnapshot().ads[0]?.body.dark_post_status, "ON", JSON.stringify(settings.profile_posts));
  }
});

test("an account still set to \"Only show as ads\" is refused at preview, in words, before anything is created", async () => {
  process.env.TIKTOK_FAKE_IDENTITY = "ads_only";
  const one = await account();
  const { title, clip } = await clipOf(FAKE_SLUGS.complete);
  const saved = await getData().saveLaunchDraft(producer(), draftOf(title.id, one.id, clip.id, defaultTikTokLaunchSettings()));
  await assert.rejects(getData().previewLaunchRun(producer(), saved.id), (e: unknown) => /Only show as ads.*Show on TikTok profile and as ads.*Also post Studio clips to the TikTok profile/s.test((e as Error).message));
  assert.equal(fakeTikTokSnapshot().ads.length, 0);
  // Unticked, the same account launches the clip ads-only, as before.
  const off = await getData().saveLaunchDraft(producer(), draftOf(title.id, one.id, clip.id, { ...defaultTikTokLaunchSettings(), profile_posts: false }));
  const plan = await getData().previewLaunchRun(producer(), off.id);
  assert.equal(plan.tiktok_identity?.accounts[0].ads_only, true);
});

test("the settings editor and the launch screen carry the choice (source)", () => {
  const editor = readFileSync(path.join(process.cwd(), "components/tiktok/LaunchSettingsEditor.tsx"), "utf8");
  assert.match(editor, /checked=\{value\.profile_posts === true\} onChange=\{\(e\) => set\("profile_posts", e\.target\.checked\)\}/);
  const studio = readFileSync(path.join(process.cwd(), "components/launch/LaunchStudio.tsx"), "utf8");
  assert.match(studio, /profile_posts: v\.profile_posts \?\? draft\.tiktok_settings\.profile_posts/, "a preset saved before the setting keeps the draft's choice");
  assert.equal(en("tk.profilePosts"), "Also post Studio clips to the TikTok profile");
});
